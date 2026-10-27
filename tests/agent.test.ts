import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/ai/agent.js';
import type { ChatMessage, LLMProvider, LLMReply } from '../src/ai/llm.js';
import { buildSystemPrompt } from '../src/ai/prompt.js';
import { BookingService } from '../src/booking/service.js';
import { appointmentsInRange, getOrCreateConversation } from '../src/db/repos.js';
import { SHEET_HEADER } from '../src/google/sheets.js';
import { fakeGoogle } from './fakes.js';
import { exampleTenant, testDb } from './helpers.js';

const TZ = 'Europe/Madrid';
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
const PHONE = '34600111222';

type Step = (messages: ChatMessage[]) => LLMReply;

class ScriptedLLM implements LLMProvider {
  seen: ChatMessage[][] = [];
  constructor(private steps: Step[]) {}
  async chat(messages: ChatMessage[]) {
    this.seen.push(structuredClone(messages));
    const step = this.steps.shift();
    if (!step) throw new Error('El guion del LLM se ha agotado');
    return step(messages);
  }
  async check() {
    return { ok: true, message: 'ok' };
  }
}

const call =
  (name: string, args: Record<string, unknown>): Step =>
  () => ({ content: '', toolCalls: [{ name, arguments: args }] });
const say =
  (content: string): Step =>
  () => ({ content, toolCalls: [] });
const lastTool = (messages: ChatMessage[]) =>
  JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.content);

function setup(now = '2026-10-27T08:00') {
  const tenant = exampleTenant({
    google: { calendar_id: 'cal@test', spreadsheet_id: 'sheet1', pestana: 'Citas' },
  });
  const db = testDb(tenant);
  const g = fakeGoogle();
  const clock = { now: at(now) };
  const booking = new BookingService(db, g.google, () => clock.now);
  const conv = getOrCreateConversation(db, tenant.id, PHONE, `${PHONE}@s.whatsapp.net`);
  const handoffs: string[] = [];
  const send = (llm: LLMProvider, text: string) =>
    runAgent(
      { db, llm, booking, historyMessages: 20 },
      { tenant, conversationId: conv.id, phone: PHONE, text, handoff: async (r) => void handoffs.push(r) },
    );
  return { tenant, db, booking, clock, send, handoffs, ...g };
}

describe('system prompt', () => {
  it('incluye la fecha actual en formato largo y los datos del negocio', () => {
    const tenant = exampleTenant();
    const p = buildSystemPrompt(tenant, {
      now: at('2026-10-27T12:35'),
      clientName: null,
      phone: PHONE,
      citas: [],
    });
    expect(p).toContain('martes 27 de octubre de 2026, 12:35 (Europe/Madrid)');
    expect(p).toContain('Eres el asistente de WhatsApp de Mi Estudio Web');
    expect(p).toContain('Cliente: desconocido — teléfono +34600111222');
    expect(p).toContain('- Reunión inicial gratuita (30 min, Gratis)');
    expect(p).toContain('- Lunes a viernes: 09:00-14:00 y 16:00-19:00');
    expect(p).toContain('- Sábado y domingo: cerrado');
    expect(p).toContain('No damos precios cerrados por WhatsApp.');
    expect(p).not.toContain('Presencial');
    expect(p).not.toMatch(/\{\{\w+\}\}/);
  });

  it('se regenera con la hora actual en cada mensaje', async () => {
    const s = setup('2026-10-27T09:00');
    const llm = new ScriptedLLM([say('¡Hola!'), say('Claro')]);
    await s.send(llm, 'hola');
    s.clock.now = at('2026-10-28T17:20');
    await s.send(llm, '¿sigues ahí?');
    expect(llm.seen[0]![0]!.content).toContain('martes 27 de octubre de 2026, 09:00');
    expect(llm.seen[1]![0]!.content).toContain('miércoles 28 de octubre de 2026, 17:20');
  });
});

describe('flujo de reserva', () => {
  it('hora pedida libre → se crea la cita en Calendar, Sheets y BD', async () => {
    const s = setup();
    const llm = new ScriptedLLM([
      call('consultar_disponibilidad', {
        servicio: 'reunión inicial',
        ubicacion: 'videollamada',
        fecha_desde: '2026-10-29T10:00',
      }),
      (m) => {
        expect(lastTool(m)).toMatchObject({ libre: true, texto: 'jueves 29 de octubre a las 10:00' });
        return { content: 'Está libre. ¿A nombre de quién la reservo?', toolCalls: [] };
      },
      call('crear_cita', {
        servicio: 'Reunión inicial gratuita',
        ubicacion: 'Videollamada',
        inicio: '2026-10-29T10:00',
        nombre_cliente: 'Laura Gómez',
      }),
      (m) => {
        expect(lastTool(m)).toMatchObject({
          creada: true,
          cita: { cuando: 'jueves 29 de octubre a las 10:00' },
        });
        return { content: '¡Hecho! Te espero el jueves 29 a las 10:00 por videollamada.', toolCalls: [] };
      },
    ]);

    await s.send(llm, 'Hola, quiero una reunión para mi web el jueves a las 10');
    const reply = await s.send(llm, 'Sí, a nombre de Laura Gómez');

    expect(reply).toContain('Hecho');
    const [ev] = [...s.calendar.events.values()];
    expect(ev).toMatchObject({
      summary: 'Reunión inicial gratuita — Laura Gómez',
      start: '2026-10-29T10:00:00.000+01:00',
      timeZone: TZ,
    });
    expect(ev!.description).toContain('+34600111222');
    expect(s.sheets.rows[0]).toEqual(SHEET_HEADER);
    expect(s.sheets.rows[1]).toMatchObject({
      2: 'Laura Gómez',
      4: 'Reunión inicial gratuita',
      8: '29/10/2026 10:00',
      10: 'Confirmada',
    });
    const citas = appointmentsInRange(s.db, s.tenant.id, '2026-10-01', '2026-12-01');
    expect(citas).toHaveLength(1);
    expect(citas[0]!.calendarEventId).toBeTruthy();
  });

  it('hora pedida ocupada → se ofrecen alternativas, el cliente elige una y se crea', async () => {
    const s = setup();
    s.calendar.block('cal@test', '2026-10-29T10:00:00+01:00', '2026-10-29T11:00:00+01:00');
    let ofrecidas: { inicio: string; texto: string }[] = [];
    const llm = new ScriptedLLM([
      call('consultar_disponibilidad', {
        servicio: 'Reunión inicial gratuita',
        fecha_desde: '2026-10-29T10:00',
      }),
      (m) => {
        const r = lastTool(m);
        expect(r).toMatchObject({ libre: false, motivo: 'ocupado' });
        ofrecidas = r.alternativas;
        return {
          content: `Ocupado. Te puedo ofrecer: ${ofrecidas.map((a) => a.texto).join(', ')}`,
          toolCalls: [],
        };
      },
      () => ({
        content: '',
        toolCalls: [
          {
            name: 'crear_cita',
            arguments: {
              servicio: 'Reunión inicial gratuita',
              ubicacion: 'Llamada telefónica',
              inicio: ofrecidas[0]!.inicio,
              nombre_cliente: 'Pedro',
            },
          },
        ],
      }),
      (m) => {
        expect(lastTool(m)).toMatchObject({ creada: true });
        return { content: 'Reservado.', toolCalls: [] };
      },
    ]);

    const offer = await s.send(llm, 'Quiero una reunión el jueves a las 10');
    expect(ofrecidas.map((a) => a.texto)).toEqual([
      'jueves 29 de octubre a las 09:15',
      'jueves 29 de octubre a las 09:00',
      'jueves 29 de octubre a las 11:15',
      'jueves 29 de octubre a las 11:30',
      'jueves 29 de octubre a las 11:45',
    ]);
    expect(offer).toContain('jueves 29 de octubre a las 09:15');
    await s.send(llm, 'Me va bien la primera, por teléfono. Soy Pedro');

    const citas = appointmentsInRange(s.db, s.tenant.id, '2026-10-01', '2026-12-01');
    expect(citas).toHaveLength(1);
    expect(citas[0]).toMatchObject({
      clientName: 'Pedro',
      locationName: 'Llamada telefónica',
      start: '2026-10-29T08:15:00.000Z',
    });
  });

  it('no crea la cita si el cliente no ha dicho el nombre', async () => {
    const s = setup();
    const llm = new ScriptedLLM([
      call('crear_cita', {
        servicio: 'Reunión inicial gratuita',
        ubicacion: 'Videollamada',
        inicio: '2026-10-29T10:00',
        nombre_cliente: 'Juan',
      }),
      (m) => {
        expect(lastTool(m).error).toMatch(/no ha dicho el nombre/);
        return { content: '¿A nombre de quién la reservo?', toolCalls: [] };
      },
    ]);
    await s.send(llm, 'Resérvame el jueves a las 10 por videollamada');
    expect(s.calendar.events.size).toBe(0);
  });

  it('valida en código fechas pasadas y servicios inexistentes y devuelve el error al modelo', async () => {
    const s = setup();
    const llm = new ScriptedLLM([
      call('consultar_disponibilidad', { servicio: 'Diseño de logos', fecha_desde: '2026-10-29' }),
      (m) => {
        expect(lastTool(m).error).toMatch(/no existe.*Reunión inicial gratuita/);
        return {
          content: '',
          toolCalls: [
            {
              name: 'consultar_disponibilidad',
              arguments: { servicio: 'presupuesto', fecha_desde: '2026-10-20T10:00' },
            },
          ],
        };
      },
      (m) => {
        expect(lastTool(m).error).toMatch(/ya ha pasado/);
        return { content: 'Solo hago webs.', toolCalls: [] };
      },
    ]);
    await s.send(llm, '¿Hacéis logos?');
  });
});

describe('aviso de IA (Ley de IA de la UE)', () => {
  it('el primer mensaje siempre dice que es un asistente virtual, los siguientes no se repiten', async () => {
    const s = setup();
    const llm = new ScriptedLLM([say('¡Hola! ¿En qué te ayudo?'), say('Claro, dime.')]);
    expect(await s.send(llm, 'hola')).toBe(
      '_Te atiende el asistente virtual (IA) de Mi Estudio Web._\n\n¡Hola! ¿En qué te ayudo?',
    );
    expect(await s.send(llm, 'tengo una duda')).toBe('Claro, dime.');
  });

  it('no duplica el aviso si el modelo ya se presenta como asistente virtual', async () => {
    const s = setup();
    const llm = new ScriptedLLM([say('Hola, soy el asistente virtual de Mi Estudio Web.')]);
    expect(await s.send(llm, 'hola')).toBe('Hola, soy el asistente virtual de Mi Estudio Web.');
  });
});

describe('validaciones en código de lo que pide el modelo', () => {
  it('rechaza una fecha cuyo día de la semana no coincide con el que dijo el cliente', async () => {
    const s = setup();
    const llm = new ScriptedLLM([
      call('consultar_disponibilidad', {
        servicio: 'Reunión inicial gratuita',
        fecha_desde: '2026-10-31T17:00',
      }),
      (m) => {
        expect(lastTool(m).error).toMatch(/ha dicho "viernes", pero 2026-10-31 es sabado/);
        return {
          content: '',
          toolCalls: [
            {
              name: 'consultar_disponibilidad',
              arguments: { servicio: 'Reunión inicial gratuita', fecha_desde: '2026-10-30T17:00' },
            },
          ],
        };
      },
      (m) => {
        expect(lastTool(m)).toMatchObject({ libre: true, texto: 'viernes 30 de octubre a las 17:00' });
        return { content: 'Libre el viernes 30 a las 17:00.', toolCalls: [] };
      },
    ]);
    await s.send(llm, '¿Tenéis hueco el viernes a las 17:00?');
  });

  it('no crea una segunda cita del mismo servicio: obliga a reprogramar', async () => {
    const s = setup();
    const crear = {
      servicio: 'Reunión inicial gratuita',
      ubicacion: 'Videollamada',
      nombre_cliente: 'Jorge',
    };
    const llm = new ScriptedLLM([
      call('crear_cita', { ...crear, inicio: '2026-10-29T10:00' }),
      say('Hecho.'),
      call('crear_cita', { ...crear, inicio: '2026-10-30T10:00' }),
      (m) => {
        expect(lastTool(m).error).toMatch(/ya tiene la cita C-\w+.*reprogramar_cita/);
        return say('¿Quieres cambiarla o una más?')(m);
      },
    ]);
    await s.send(llm, 'Soy Jorge, el jueves a las 10 por videollamada');
    await s.send(llm, 'Pásamela al viernes a las 10');
    expect(appointmentsInRange(s.db, s.tenant.id, '2026-10-01', '2026-12-01')).toHaveLength(1);
  });
});

describe('doble reserva', () => {
  it('dos peticiones simultáneas al mismo hueco crean una sola cita', async () => {
    const s = setup();
    const service = s.tenant.servicios[0]!;
    const location = s.tenant.ubicaciones[0]!;
    const req = (phone: string, clientName: string) =>
      s.booking.create(s.tenant, { service, location, phone, clientName, start: at('2026-10-29T10:00') });
    const results = await Promise.all([req('34600000001', 'Ana'), req('34600000002', 'Luis')]);

    expect(results.filter((r) => r.creada)).toHaveLength(1);
    const fallida = results.find((r) => !r.creada);
    expect(fallida).toMatchObject({ creada: false, motivo: 'ocupado' });
    if (fallida && !fallida.creada) expect(fallida.alternativas.length).toBeGreaterThan(0);
    expect(s.calendar.events.size).toBe(1);
    expect(appointmentsInRange(s.db, s.tenant.id, '2026-10-01', '2026-12-01')).toHaveLength(1);
  });

  it('cancelar y reprogramar actualizan Calendar, Sheets (sin borrar la fila) y BD', async () => {
    const s = setup();
    const service = s.tenant.servicios[0]!;
    const location = s.tenant.ubicaciones[0]!;
    const r = await s.booking.create(s.tenant, {
      service,
      location,
      phone: PHONE,
      clientName: 'Ana',
      start: at('2026-10-29T10:00'),
    });
    if (!r.creada) throw new Error('debería crearse');

    const moved = await s.booking.reschedule(s.tenant, r.cita, at('2026-10-29T10:15'));
    expect(moved).toMatchObject({
      creada: true,
      cita: { status: 'reprogramada', start: '2026-10-29T09:15:00.000Z' },
    });
    expect(s.sheets.rows[1]![10]).toBe('Reprogramada');

    await s.booking.cancel(s.tenant, s.booking.findForClient(s.tenant, PHONE, r.cita.id));
    expect(s.sheets.rows).toHaveLength(2);
    expect(s.sheets.rows[1]![10]).toBe('Cancelada');
    expect([...s.calendar.events.values()][0]).toMatchObject({ cancelled: true });
    expect(() => s.booking.findForClient(s.tenant, '34999999999', r.cita.id)).toThrow(/No existe/);
  });
});
