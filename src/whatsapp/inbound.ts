import { runAgent, summarizeIfNeeded, type AgentDeps } from '../ai/agent.js';
import {
  addLog,
  addMessage,
  findConversation,
  getOrCreateConversation,
  markProcessed,
  rememberSent,
  updateConversation,
  wasSentByBot,
} from '../db/repos.js';
import type { TenantConfig } from '../tenants/schema.js';
import { log, maskPhone } from '../util/log.js';
import { runExclusive } from '../util/queue.js';
import type { Inbound } from './jid.js';

export interface Transport {
  newMessageId(): string;
  sendText(jid: string, text: string, messageId: string): Promise<void>;
  typing(jid: string, on: boolean): Promise<void>;
}

export type Outcome =
  'respondido' | 'propio' | 'eco_del_bot' | 'duplicado' | 'no_permitido' | 'inactivo' | 'derivado' | 'error';

export type PipelineDeps = AgentDeps & {
  allowedTestNumbers: string[];
  humanDelay: () => Promise<void>;
};

const SORRY = 'Perdona, ahora mismo no puedo responderte. Te contestamos en un momento.';

export const randomHumanDelay =
  (min = 1500, max = 4000) =>
  () =>
    new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));

export async function sendTracked(
  deps: Pick<PipelineDeps, 'db'>,
  tenantId: string,
  t: Transport,
  jid: string,
  text: string,
) {
  const id = t.newMessageId();
  rememberSent(deps.db, tenantId, id);
  await t.sendText(jid, text, id);
}

function isAllowed(deps: Pick<PipelineDeps, 'allowedTestNumbers'>, tenant: TenantConfig, phone: string) {
  return tenant.modo === 'live' || new Set([...deps.allowedTestNumbers, ...tenant.numeros_prueba]).has(phone);
}

export type NotifyResult = { sent: true } | { sent: false; reason: string };

export async function notifyClient(
  deps: Pick<PipelineDeps, 'db' | 'allowedTestNumbers'>,
  tenant: TenantConfig,
  phone: string,
  text: string,
  transport: Transport | undefined,
): Promise<NotifyResult> {
  if (!transport) return { sent: false, reason: 'el WhatsApp del negocio no está conectado' };
  if (!isAllowed(deps, tenant, phone)) {
    return {
      sent: false,
      reason: 'el negocio está en modo pruebas y este cliente no es un número de prueba',
    };
  }
  return runExclusive(`conv:${tenant.id}:${phone}`, async () => {
    const conv =
      findConversation(deps.db, tenant.id, phone) ??
      getOrCreateConversation(deps.db, tenant.id, phone, `${phone}@s.whatsapp.net`);
    await sendTracked(deps, tenant.id, transport, conv.jid, text);
    addMessage(deps.db, { conversationId: conv.id, role: 'assistant', content: text });
    addLog(deps.db, 'info', 'cliente_avisado', tenant.id, { telefono: maskPhone(phone) });
    return { sent: true } as const;
  });
}

export async function handleInbound(
  deps: PipelineDeps,
  tenant: TenantConfig,
  msg: Inbound,
  transport: Transport,
): Promise<Outcome> {
  const { db } = deps;
  if (msg.fromMe && !msg.selfChat) return 'propio';
  if (msg.fromMe && wasSentByBot(db, tenant.id, msg.id)) return 'eco_del_bot';
  if (!markProcessed(db, tenant.id, msg.id)) return 'duplicado';
  if (!tenant.activo) return 'inactivo';

  if (!isAllowed(deps, tenant, msg.phone)) {
    log.info(
      { tenant: tenant.id, from: maskPhone(msg.phone) },
      'Modo test: mensaje ignorado de un número no permitido',
    );
    addLog(db, 'info', 'ignorado_modo_test', tenant.id, { telefono: maskPhone(msg.phone) });
    return 'no_permitido';
  }

  return runExclusive(`conv:${tenant.id}:${msg.phone}`, async () => {
    const conv = getOrCreateConversation(db, tenant.id, msg.phone, msg.chatJid);
    if (conv.handoff) {
      addMessage(db, { conversationId: conv.id, role: 'user', content: msg.text });
      return 'derivado';
    }

    const handoff = async (reason: string) => {
      updateConversation(db, conv.id, {
        handoff: true,
        handoffReason: reason,
        handoffAt: new Date().toISOString(),
      });
      addLog(db, 'warn', 'derivado_a_humano', tenant.id, { telefono: maskPhone(msg.phone), motivo: reason });
      const owner = tenant.responsable.telefono;
      if (!owner) {
        log.warn(
          { tenant: tenant.id },
          'Conversación derivada, pero el negocio no tiene teléfono de responsable',
        );
        return;
      }
      const aviso = `🔔 Conversación derivada a ti\nCliente: +${msg.phone}\nMotivo: ${reason}\nEl bot no responderá en ese chat hasta que lo reactives desde el panel.`;
      await sendTracked(deps, tenant.id, transport, `${owner}@s.whatsapp.net`, aviso).catch((e) =>
        log.error({ err: (e as Error).message }, 'No se pudo avisar al responsable'),
      );
    };

    await transport.typing(msg.chatJid, true).catch(() => undefined);
    try {
      const [reply] = await Promise.all([
        runAgent(deps, { tenant, conversationId: conv.id, phone: msg.phone, text: msg.text, handoff }),
        deps.humanDelay(),
      ]);
      await sendTracked(deps, tenant.id, transport, msg.chatJid, reply);
      await summarizeIfNeeded(deps, conv.id).catch((e) =>
        log.warn({ err: (e as Error).message }, 'No se pudo resumir la conversación'),
      );
      return 'respondido';
    } catch (e) {
      log.error({ tenant: tenant.id, err: (e as Error).message }, 'Error procesando mensaje');
      addLog(db, 'error', 'error_respuesta', tenant.id, { error: (e as Error).message });
      await sendTracked(deps, tenant.id, transport, msg.chatJid, SORRY).catch(() => undefined);
      return 'error';
    } finally {
      await transport.typing(msg.chatJid, false).catch(() => undefined);
    }
  });
}
