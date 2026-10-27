import type { BookingService } from '../booking/service.js';
import type { Db } from '../db/client.js';
import {
  addMessage,
  getConversation,
  messagesAfter,
  updateConversation,
  upcomingAppointmentsByPhone,
} from '../db/repos.js';
import type { Message } from '../db/schema.js';
import type { TenantConfig } from '../tenants/schema.js';
import { log } from '../util/log.js';
import { checkReply, toWhatsApp } from './guard.js';
import type { ChatMessage, LLMProvider } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import { TOOL_DEFINITIONS, runTool } from './tools/index.js';

const MAX_STEPS = 8;
const MAX_NUDGES = 2;
const BOOKING_OK = /"(creada|cancelada|reprogramada)":true/;
const FALLBACK =
  'Perdona, ahora mismo no puedo atenderte bien. Le paso tu mensaje al responsable y te contestará en breve.';
const ASK_AGAIN =
  'Perdona, déjame comprobarlo bien: ¿me confirmas qué servicio, qué día y a qué hora te vendría bien?';

// EU AI Act art. 50: people must be told they are talking to an AI.
const DISCLOSED = /asistente virtual|inteligencia artificial|\bIA\b|\bbot\b/i;

export function withAiDisclosure(text: string, businessName: string): string {
  return DISCLOSED.test(text)
    ? text
    : `_Te atiende el asistente virtual (IA) de ${businessName}._\n\n${text}`;
}

export type AgentDeps = { db: Db; llm: LLMProvider; booking: BookingService; historyMessages: number };

function toChat(m: Message): ChatMessage {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.toolName ?? '' };
  if (m.role === 'assistant')
    return {
      role: 'assistant',
      content: m.content,
      ...(m.toolCalls && { tool_calls: m.toolCalls.map((f) => ({ function: f })) }),
    };
  return { role: 'user', content: m.content };
}

function recentHistory(all: Message[], limit: number): Message[] {
  const recent = all.slice(-limit);
  const firstUser = recent.findIndex((m) => m.role === 'user');
  return firstUser < 0 ? [] : recent.slice(firstUser);
}

export async function runAgent(
  deps: AgentDeps,
  input: {
    tenant: TenantConfig;
    conversationId: number;
    phone: string;
    text: string;
    handoff: (reason: string) => Promise<void>;
  },
): Promise<string> {
  const { db, llm, booking } = deps;
  const { tenant, conversationId, phone } = input;
  addMessage(db, { conversationId, role: 'user', content: input.text });

  const conv = getConversation(db, conversationId)!;
  const now = booking.now(tenant);
  const system = buildSystemPrompt(tenant, {
    now,
    clientName: conv.clientName,
    phone,
    citas: upcomingAppointmentsByPhone(db, tenant.id, phone, now.toUTC().toISO()!),
  });
  const history = recentHistory(messagesAfter(db, conversationId, conv.summarizedUpTo), deps.historyMessages);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: conv.summary ? `${system}\n\nResumen de la conversación anterior: ${conv.summary}` : system,
    },
    ...history.map(toChat),
  ];
  const ctx = { tenant, db, booking, conversationId, phone, userText: input.text, handoff: input.handoff };
  const firstReply = !conv.summary && !history.some((m) => m.role === 'assistant');
  const disclose = (text: string) => (firstReply ? withAiDisclosure(text, tenant.nombre) : text);
  let nudges = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await llm.chat(messages, TOOL_DEFINITIONS);
    if (!reply.toolCalls.length) {
      const toolMsgs = messages.filter((m) => m.role === 'tool');
      const problem = reply.content
        ? checkReply({
            reply: reply.content,
            toolResults: toolMsgs.map((m) => m.content),
            scheduleText: system,
            bookingDone: toolMsgs.some((m) => BOOKING_OK.test(m.content)),
          })
        : null;
      if (problem && nudges < MAX_NUDGES) {
        nudges++;
        log.debug(
          { problem, draft: reply.content.slice(0, 300) },
          'Respuesta del modelo rechazada por el validador',
        );
        messages.push({ role: 'user', content: `[Mensaje interno del sistema, no del cliente] ${problem}` });
        continue;
      }
      const content = disclose(problem ? ASK_AGAIN : toWhatsApp(reply.content) || FALLBACK);
      addMessage(db, { conversationId, role: 'assistant', content });
      return content;
    }
    addMessage(db, { conversationId, role: 'assistant', content: reply.content, toolCalls: reply.toolCalls });
    messages.push({
      role: 'assistant',
      content: reply.content,
      tool_calls: reply.toolCalls.map((f) => ({ function: f })),
    });
    for (const call of reply.toolCalls) {
      const result = await runTool(call.name, call.arguments, ctx);
      addMessage(db, { conversationId, role: 'tool', content: result, toolName: call.name });
      messages.push({ role: 'tool', content: result, tool_name: call.name });
    }
  }
  const fallback = disclose(FALLBACK);
  addMessage(db, { conversationId, role: 'assistant', content: fallback });
  await input.handoff('El asistente no consiguió completar la respuesta tras varios intentos.');
  return fallback;
}

export async function summarizeIfNeeded(deps: AgentDeps, conversationId: number): Promise<void> {
  const conv = getConversation(deps.db, conversationId);
  if (!conv) return;
  const pending = messagesAfter(deps.db, conversationId, conv.summarizedUpTo);
  if (pending.length <= deps.historyMessages * 2) return;
  const old = pending.slice(0, pending.length - deps.historyMessages).filter((m) => m.role !== 'tool');
  const transcript = old
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Asistente'}: ${m.content}`)
    .join('\n');
  const reply = await deps.llm.chat([
    {
      role: 'system',
      content:
        'Resume en 5 líneas como máximo esta conversación de WhatsApp entre un cliente y el asistente de un negocio. Conserva nombre del cliente, qué necesita, citas acordadas (ID, día y hora) y temas pendientes.',
    },
    { role: 'user', content: `${conv.summary ? `Resumen previo: ${conv.summary}\n\n` : ''}${transcript}` },
  ]);
  updateConversation(deps.db, conversationId, {
    summary: reply.content,
    summarizedUpTo: pending[pending.length - deps.historyMessages - 1]!.id,
  });
}
