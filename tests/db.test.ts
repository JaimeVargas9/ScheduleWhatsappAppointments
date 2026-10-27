import { describe, expect, it } from 'vitest';
import {
  addMessage,
  getOrCreateConversation,
  markProcessed,
  rememberSent,
  wasSentByBot,
  messagesAfter,
} from '../src/db/repos.js';
import { testDb } from './helpers.js';

describe('repositorios', () => {
  it('markProcessed devuelve false para un ID repetido (deduplicación)', () => {
    const db = testDb();
    expect(markProcessed(db, 'mi-estudio-web', 'ABC')).toBe(true);
    expect(markProcessed(db, 'mi-estudio-web', 'ABC')).toBe(false);
    expect(markProcessed(db, 'otro', 'ABC')).toBe(true);
  });

  it('recuerda los IDs enviados por el bot', () => {
    const db = testDb();
    rememberSent(db, 'mi-estudio-web', 'OUT1');
    expect(wasSentByBot(db, 'mi-estudio-web', 'OUT1')).toBe(true);
    expect(wasSentByBot(db, 'mi-estudio-web', 'IN1')).toBe(false);
  });

  it('una conversación por teléfono y negocio, con su historial', () => {
    const db = testDb();
    const a = getOrCreateConversation(db, 'mi-estudio-web', '34600111222', '34600111222@s.whatsapp.net');
    const b = getOrCreateConversation(db, 'mi-estudio-web', '34600111222', '34600111222@s.whatsapp.net');
    expect(a.id).toBe(b.id);
    addMessage(db, { conversationId: a.id, role: 'user', content: 'hola' });
    expect(messagesAfter(db, a.id, 0).map((m) => m.content)).toEqual(['hola']);
  });
});
