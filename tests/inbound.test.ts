import type { WAMessage } from '@whiskeysockets/baileys';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { LLMProvider } from '../src/ai/llm.js';
import { BookingService } from '../src/booking/service.js';
import { getOrCreateConversation, updateConversation } from '../src/db/repos.js';
import type { TenantConfig } from '../src/tenants/schema.js';
import { handleInbound, type Outcome, type PipelineDeps, type Transport } from '../src/whatsapp/inbound.js';
import { normalizeMessage, type Inbound } from '../src/whatsapp/jid.js';
import { fakeGoogle } from './fakes.js';
import { exampleTenant, testDb } from './helpers.js';

const OWN = '34611000000';
const ALLOWED = '34600111222';
const STRANGER = '34699999999';

class CountingLLM implements LLMProvider {
  calls = 0;
  active = 0;
  maxActive = 0;
  async chat() {
    this.calls++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 10));
    this.active--;
    return { content: `respuesta ${this.calls}`, toolCalls: [] };
  }
  async check() {
    return { ok: true, message: 'ok' };
  }
}

function setup(tenant: TenantConfig = exampleTenant(), allowed = [ALLOWED, OWN]) {
  const db = testDb(tenant);
  const llm = new CountingLLM();
  const booking = new BookingService(db, fakeGoogle().google, () =>
    DateTime.fromISO('2026-10-27T10:00', { zone: 'Europe/Madrid' }),
  );
  const deps: PipelineDeps = {
    db,
    llm,
    booking,
    historyMessages: 20,
    allowedTestNumbers: allowed,
    humanDelay: async () => {},
  };
  const sent: { jid: string; text: string; id: string }[] = [];
  const echoes: Promise<Outcome>[] = [];
  let seq = 0;
  const transport: Transport = {
    newMessageId: () => `BOT${++seq}`,
    typing: async () => {},
    sendText: async (jid, text, id) => {
      sent.push({ jid, text, id });
      if (jid.startsWith(OWN)) {
        echoes.push(
          handleInbound(
            deps,
            tenant,
            { id, chatJid: jid, phone: OWN, fromMe: true, selfChat: true, text },
            transport,
          ),
        );
      }
    },
  };
  const msg = (over: Partial<Inbound>): Inbound => ({
    id: `IN${Math.random()}`,
    chatJid: `${ALLOWED}@s.whatsapp.net`,
    phone: ALLOWED,
    fromMe: false,
    selfChat: false,
    text: 'hola',
    ...over,
  });
  return {
    db,
    llm,
    deps,
    tenant,
    sent,
    echoes,
    transport,
    msg,
    handle: (m: Inbound) => handleInbound(deps, tenant, m, transport),
  };
}

describe('filtro del modo test', () => {
  it('un número no permitido no recibe respuesta', async () => {
    const s = setup();
    const out = await s.handle(s.msg({ phone: STRANGER, chatJid: `${STRANGER}@s.whatsapp.net` }));
    expect(out).toBe('no_permitido');
    expect(s.sent).toEqual([]);
    expect(s.llm.calls).toBe(0);
  });

  it('un número permitido sí recibe respuesta, y los números del negocio se suman a los globales', async () => {
    const s = setup(exampleTenant({ numeros_prueba: [STRANGER] }), [ALLOWED]);
    expect(await s.handle(s.msg({}))).toBe('respondido');
    expect(await s.handle(s.msg({ phone: STRANGER, chatJid: `${STRANGER}@s.whatsapp.net` }))).toBe(
      'respondido',
    );
    expect(s.sent).toHaveLength(2);
  });

  it('en modo live responde a cualquiera', async () => {
    const s = setup(exampleTenant({ modo: 'live' }), []);
    expect(await s.handle(s.msg({ phone: STRANGER, chatJid: `${STRANGER}@s.whatsapp.net` }))).toBe(
      'respondido',
    );
  });
});

describe('chat propio ("Mensajes para ti")', () => {
  it('responde a lo que escribo yo, pero no se responde a sí mismo (sin bucle)', async () => {
    const s = setup();
    const out = await s.handle(
      s.msg({ phone: OWN, chatJid: `${OWN}@s.whatsapp.net`, fromMe: true, selfChat: true }),
    );
    expect(out).toBe('respondido');
    expect(await Promise.all(s.echoes)).toEqual(['eco_del_bot']);
    expect(s.sent).toHaveLength(1);
    expect(s.llm.calls).toBe(1);
  });

  it('ignora los mensajes que envío yo a otros chats desde el móvil', async () => {
    const s = setup();
    expect(await s.handle(s.msg({ fromMe: true }))).toBe('propio');
    expect(s.sent).toEqual([]);
  });
});

describe('deduplicación y colas', () => {
  it('un mismo ID de mensaje solo se procesa una vez', async () => {
    const s = setup();
    const m = s.msg({ id: 'DUP1' });
    const outs = await Promise.all([s.handle(m), s.handle(m)]);
    expect(outs.sort()).toEqual(['duplicado', 'respondido']);
    expect(s.sent).toHaveLength(1);
  });

  it('dos mensajes seguidos del mismo cliente no se procesan a la vez', async () => {
    const s = setup();
    await Promise.all([s.handle(s.msg({ text: 'uno' })), s.handle(s.msg({ text: 'dos' }))]);
    expect(s.llm.maxActive).toBe(1);
    expect(s.sent.map((x) => x.text)).toEqual([
      '_Te atiende el asistente virtual (IA) de Mi Estudio Web._\n\nrespuesta 1',
      'respuesta 2',
    ]);
  });

  it('no responde en conversaciones derivadas a un humano', async () => {
    const s = setup();
    const conv = getOrCreateConversation(s.db, s.tenant.id, ALLOWED, `${ALLOWED}@s.whatsapp.net`);
    updateConversation(s.db, conv.id, { handoff: true, handoffReason: 'pidió una persona' });
    expect(await s.handle(s.msg({}))).toBe('derivado');
    expect(s.sent).toEqual([]);
  });
});

describe('normalizeMessage', () => {
  const own = { pn: OWN, lid: '99887766' };
  const base = (key: Partial<WAMessage['key']>, text = 'hola'): WAMessage =>
    ({
      key: { id: 'X1', fromMe: false, ...key },
      message: { conversation: text },
      messageTimestamp: 2000,
    }) as WAMessage;
  const opts = { type: 'notify', connectedAt: 1000, lidToPn: async () => `${ALLOWED}@s.whatsapp.net` };

  it('ignora grupos, estados, historial sincronizado y mensajes antiguos', async () => {
    expect(await normalizeMessage(base({ remoteJid: '123-456@g.us' }), own, opts)).toEqual({
      skip: 'grupo_estado_difusion',
    });
    expect(await normalizeMessage(base({ remoteJid: 'status@broadcast' }), own, opts)).toEqual({
      skip: 'grupo_estado_difusion',
    });
    expect(await normalizeMessage(base({ remoteJid: '1@newsletter' }), own, opts)).toEqual({
      skip: 'grupo_estado_difusion',
    });
    expect(
      await normalizeMessage(base({ remoteJid: `${ALLOWED}@s.whatsapp.net` }), own, {
        ...opts,
        type: 'append',
      }),
    ).toEqual({ skip: 'historial' });
    expect(
      await normalizeMessage(base({ remoteJid: `${ALLOWED}@s.whatsapp.net` }), own, {
        ...opts,
        connectedAt: 5000,
      }),
    ).toEqual({ skip: 'antiguo' });
  });

  it('traduce LID a número de teléfono y detecta el chat propio', async () => {
    const lid = await normalizeMessage(base({ remoteJid: '1234567@lid' }), own, opts);
    expect(lid).toMatchObject({ phone: ALLOWED, chatJid: '1234567@lid', selfChat: false });
    const alt = await normalizeMessage(
      base({ remoteJid: '1234567@lid', remoteJidAlt: `${STRANGER}@s.whatsapp.net` }),
      own,
      opts,
    );
    expect(alt).toMatchObject({ phone: STRANGER });
    const self = await normalizeMessage(base({ remoteJid: '99887766@lid', fromMe: true }), own, opts);
    expect(self).toMatchObject({ phone: OWN, selfChat: true, fromMe: true });
    const selfPn = await normalizeMessage(
      base({ remoteJid: `${OWN}@s.whatsapp.net`, fromMe: true }),
      own,
      opts,
    );
    expect(selfPn).toMatchObject({ phone: OWN, selfChat: true });
  });
});
