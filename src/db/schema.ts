import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { TenantConfig } from '../tenants/schema.js';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  config: text('config', { mode: 'json' }).$type<TenantConfig>().notNull(),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const conversations = sqliteTable(
  'conversations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    jid: text('jid').notNull(),
    clientName: text('client_name'),
    summary: text('summary').notNull().default(''),
    summarizedUpTo: integer('summarized_up_to').notNull().default(0),
    handoff: integer('handoff', { mode: 'boolean' }).notNull().default(false),
    handoffReason: text('handoff_reason'),
    handoffAt: text('handoff_at'),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('conversations_tenant_phone').on(t.tenantId, t.phone)],
);

export type ToolCall = { name: string; arguments: Record<string, unknown> };

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    content: text('content').notNull(),
    toolCalls: text('tool_calls', { mode: 'json' }).$type<ToolCall[]>(),
    toolName: text('tool_name'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('messages_conversation').on(t.conversationId)],
);

export const appointments = sqliteTable(
  'appointments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    clientName: text('client_name').notNull(),
    serviceId: text('service_id').notNull(),
    serviceName: text('service_name').notNull(),
    professionalId: text('professional_id'),
    professionalName: text('professional_name'),
    locationId: text('location_id').notNull(),
    locationName: text('location_name').notNull(),
    address: text('address').notNull().default(''),
    start: text('start').notNull(),
    end: text('end').notNull(),
    status: text('status', { enum: ['confirmada', 'reprogramada', 'cancelada'] })
      .notNull()
      .default('confirmada'),
    notes: text('notes').notNull().default(''),
    calendarEventId: text('calendar_event_id'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('appointments_tenant_start').on(t.tenantId, t.start),
    index('appointments_phone').on(t.tenantId, t.phone),
  ],
);

export const processedMessages = sqliteTable(
  'processed_messages',
  {
    tenantId: text('tenant_id').notNull(),
    messageId: text('message_id').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.messageId] })],
);

export const sentMessages = sqliteTable(
  'sent_messages',
  {
    tenantId: text('tenant_id').notNull(),
    messageId: text('message_id').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.messageId] })],
);

export const logs = sqliteTable(
  'logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenantId: text('tenant_id'),
    level: text('level', { enum: ['info', 'warn', 'error'] }).notNull(),
    event: text('event').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('logs_created').on(t.createdAt)],
);

export type Tenant = typeof tenants.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type LogEntry = typeof logs.$inferSelect;
