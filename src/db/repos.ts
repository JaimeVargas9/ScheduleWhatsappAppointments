import { and, asc, desc, eq, gt, gte, lt, ne, sql } from 'drizzle-orm';
import type { TenantConfig } from '../tenants/schema.js';
import type { Db } from './client.js';
import {
  appointments,
  conversations,
  logs,
  messages,
  processedMessages,
  sentMessages,
  tenants,
  type Appointment,
  type ToolCall,
} from './schema.js';

const nowIso = () => new Date().toISOString();

export function listTenants(db: Db): TenantConfig[] {
  return db
    .select()
    .from(tenants)
    .orderBy(asc(tenants.id))
    .all()
    .map((t) => t.config);
}

export function getTenant(db: Db, id: string): TenantConfig | undefined {
  return db.select().from(tenants).where(eq(tenants.id, id)).get()?.config;
}

export function saveTenant(db: Db, config: TenantConfig): void {
  db.insert(tenants)
    .values({ id: config.id, config })
    .onConflictDoUpdate({ target: tenants.id, set: { config, updatedAt: nowIso() } })
    .run();
}

export function getOrCreateConversation(db: Db, tenantId: string, phone: string, jid: string) {
  db.insert(conversations).values({ tenantId, phone, jid }).onConflictDoNothing().run();
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.phone, phone)))
    .get()!;
  if (conv.jid !== jid) db.update(conversations).set({ jid }).where(eq(conversations.id, conv.id)).run();
  return { ...conv, jid };
}

export function getConversation(db: Db, id: number) {
  return db.select().from(conversations).where(eq(conversations.id, id)).get();
}

export function listConversations(db: Db, tenantId: string) {
  return db
    .select({
      id: conversations.id,
      phone: conversations.phone,
      clientName: conversations.clientName,
      handoff: conversations.handoff,
      handoffReason: conversations.handoffReason,
      updatedAt: conversations.updatedAt,
      lastMessage: sql<string>`(select content from messages m where m.conversation_id = ${conversations.id} and m.role != 'tool' order by m.id desc limit 1)`,
    })
    .from(conversations)
    .where(eq(conversations.tenantId, tenantId))
    .orderBy(desc(conversations.updatedAt))
    .all();
}

export function updateConversation(
  db: Db,
  id: number,
  patch: Partial<{
    clientName: string;
    summary: string;
    summarizedUpTo: number;
    handoff: boolean;
    handoffReason: string | null;
    handoffAt: string | null;
  }>,
): void {
  db.update(conversations)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(conversations.id, id))
    .run();
}

export function addMessage(
  db: Db,
  m: {
    conversationId: number;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: ToolCall[];
    toolName?: string;
  },
): number {
  const id = db
    .insert(messages)
    .values({ ...m, toolCalls: m.toolCalls ?? null, toolName: m.toolName ?? null })
    .returning({ id: messages.id })
    .get().id;
  db.update(conversations).set({ updatedAt: nowIso() }).where(eq(conversations.id, m.conversationId)).run();
  return id;
}

export function messagesAfter(db: Db, conversationId: number, afterId: number) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), gt(messages.id, afterId)))
    .orderBy(asc(messages.id))
    .all();
}

export function userMessagesText(db: Db, conversationId: number): string {
  return db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
    .all()
    .map((m) => m.content)
    .join('\n');
}

export function markProcessed(db: Db, tenantId: string, messageId: string): boolean {
  return (
    db.insert(processedMessages).values({ tenantId, messageId }).onConflictDoNothing().run().changes === 1
  );
}

export function rememberSent(db: Db, tenantId: string, messageId: string): void {
  db.insert(sentMessages).values({ tenantId, messageId }).onConflictDoNothing().run();
}

export function wasSentByBot(db: Db, tenantId: string, messageId: string): boolean {
  return !!db
    .select()
    .from(sentMessages)
    .where(and(eq(sentMessages.tenantId, tenantId), eq(sentMessages.messageId, messageId)))
    .get();
}

export function insertAppointment(db: Db, a: typeof appointments.$inferInsert): void {
  db.insert(appointments).values(a).run();
}

export function updateAppointment(
  db: Db,
  id: string,
  patch: Partial<typeof appointments.$inferInsert>,
): void {
  db.update(appointments)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(appointments.id, id))
    .run();
}

export function getAppointment(db: Db, tenantId: string, id: string): Appointment | undefined {
  return db
    .select()
    .from(appointments)
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, id)))
    .get();
}

export function upcomingAppointmentsByPhone(db: Db, tenantId: string, phone: string, fromIso: string) {
  return db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.phone, phone),
        ne(appointments.status, 'cancelada'),
        gte(appointments.end, fromIso),
      ),
    )
    .orderBy(asc(appointments.start))
    .all();
}

export function appointmentsInRange(
  db: Db,
  tenantId: string,
  fromIso: string,
  toIso: string,
  includeCancelled = true,
) {
  return db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        lt(appointments.start, toIso),
        gt(appointments.end, fromIso),
        includeCancelled ? undefined : ne(appointments.status, 'cancelada'),
      ),
    )
    .orderBy(asc(appointments.start))
    .all();
}

export function addLog(
  db: Db,
  level: 'info' | 'warn' | 'error',
  event: string,
  tenantId: string | null = null,
  data: Record<string, unknown> | null = null,
): void {
  db.insert(logs).values({ level, event, tenantId, data }).run();
}

export function listLogs(db: Db, tenantId: string | null, limit = 200) {
  return db
    .select()
    .from(logs)
    .where(tenantId ? eq(logs.tenantId, tenantId) : undefined)
    .orderBy(desc(logs.id))
    .limit(limit)
    .all();
}

export function deleteClientData(db: Db, tenantId: string, phone: string) {
  return db.transaction((tx) => {
    const appts = tx
      .delete(appointments)
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.phone, phone)))
      .returning()
      .all();
    const convs = tx
      .delete(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.phone, phone)))
      .returning({ id: conversations.id })
      .all();
    return { appointments: appts, conversations: convs.length };
  });
}
