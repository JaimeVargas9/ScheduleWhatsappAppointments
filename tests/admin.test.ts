import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { createAdminApp } from '../src/admin/server.js';
import { BookingService } from '../src/booking/service.js';
import { deleteClientData, getOrCreateConversation, updateConversation } from '../src/db/repos.js';
import type { SessionManager } from '../src/whatsapp/manager.js';
import { fakeGoogle } from './fakes.js';
import { exampleTenant, testDb } from './helpers.js';

function setup() {
  const tenant = exampleTenant({ google: { calendar_id: 'cal', spreadsheet_id: 'sheet', pestana: 'Citas' } });
  const db = testDb(tenant);
  const g = fakeGoogle();
  const booking = new BookingService(db, g.google, () =>
    DateTime.fromISO('2026-10-27T08:00', { zone: 'Europe/Madrid' }),
  );
  const synced: string[] = [];
  const notified: { phone: string; text: string }[] = [];
  const notifyResult: { value: { sent: boolean; reason?: string } } = { value: { sent: true } };
  const sessions = {
    notify: async (_t: string, phone: string, text: string) => {
      notified.push({ phone, text });
      return notifyResult.value;
    },
    sync: async (ts: { id: string }[]) => void synced.push(...ts.map((t) => t.id)),
    status: async () => ({
      status: 'esperando_qr',
      qr: 'data:image/png;base64,xx',
      phone: null,
      needsRescan: false,
    }),
    logout: async () => {},
  } as unknown as SessionManager;
  const llm = {
    chat: async () => ({ content: '', toolCalls: [] }),
    check: async () => ({ ok: true, message: 'ok' }),
  };
  const app = createAdminApp({
    db,
    google: g.google,
    booking,
    llm,
    sessions,
    user: 'admin',
    password: 'secreto123',
    model: 'qwen',
  });
  let cookie = '';
  const login = async (user: string, password: string) => {
    const res = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ user, password }),
    });
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    return res;
  };
  const req = async (path: string, init: RequestInit = {}) => {
    if (!cookie) await login('admin', 'secreto123');
    return app.request(path, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  };
  return { app, req, login, db, tenant, booking, synced, notified, notifyResult, ...g };
}

describe('panel de control', () => {
  it('pide usuario y contraseña', async () => {
    const s = setup();
    expect((await s.app.request('/api/overview')).status).toBe(401);
    expect((await s.app.request('/')).headers.get('location')).toBe('/login');
    const bad = await s.login('admin', 'mal');
    expect(bad.headers.get('location')).toBe('/login?error=1');
    expect(bad.headers.get('set-cookie')).toBeNull();
    expect(
      (await s.app.request('/api/overview', { headers: { cookie: 'panel_session=admin' } })).status,
    ).toBe(401);
    expect((await s.req('/api/overview')).status).toBe(200);
  });

  it('el resumen incluye estado de WhatsApp, IA, Google y contadores', async () => {
    const s = setup();
    const o = (await (await s.req('/api/overview')).json()) as {
      tenants: { id: string; whatsapp: { status: string }; stats: object }[];
      ollama: { ok: boolean };
    };
    expect(o.ollama.ok).toBe(true);
    expect(o.tenants[0]).toMatchObject({ id: 'mi-estudio-web', whatsapp: { status: 'esperando_qr' } });
  });

  it('valida la configuración al guardar y sincroniza la sesión', async () => {
    const s = setup();
    const bad = await s.req('/api/tenants/mi-estudio-web', {
      method: 'PUT',
      body: JSON.stringify({ ...s.tenant, servicios: [] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/servicios/);
    const ok = await s.req('/api/tenants/mi-estudio-web', {
      method: 'PUT',
      body: JSON.stringify({ ...s.tenant, modo: 'live' }),
    });
    expect(ok.status).toBe(200);
    expect(s.synced).toEqual(['mi-estudio-web']);
  });

  it('muestra citas en el calendario y la hoja, y permite cancelar', async () => {
    const s = setup();
    const r = await s.booking.create(s.tenant, {
      service: s.tenant.servicios[0]!,
      location: s.tenant.ubicaciones[0]!,
      phone: '34600111222',
      clientName: 'Ana',
      start: DateTime.fromISO('2026-10-29T10:00', { zone: 'Europe/Madrid' }),
    });
    if (!r.creada) throw new Error('debería crearse');
    s.calendar.block('cal', '2026-10-30T09:00:00+01:00', '2026-10-30T10:00:00+01:00');

    const ev = (await (
      await s.req('/api/tenants/mi-estudio-web/events?start=2026-10-26&end=2026-11-02')
    ).json()) as {
      events: { id: string; classNames: string[] }[];
    };
    expect(ev.events.map((e) => e.classNames[0]).sort()).toEqual(['ev-confirmada', 'ev-google']);

    const sheet = (await (await s.req('/api/tenants/mi-estudio-web/sheet')).json()) as {
      source: string;
      rows: string[][];
    };
    expect(sheet.source).toBe('google');
    expect(sheet.rows[1]![2]).toBe('Ana');

    const cancel = await s.req(`/api/tenants/mi-estudio-web/appointments/${r.cita.id}/cancel`, {
      method: 'POST',
    });
    expect(cancel.status).toBe(200);
    expect(s.sheets.rows[1]![10]).toBe('Cancelada');
  });

  it('reactiva el bot en una conversación derivada', async () => {
    const s = setup();
    const conv = getOrCreateConversation(s.db, 'mi-estudio-web', '34600111222', '34600111222@s.whatsapp.net');
    updateConversation(s.db, conv.id, { handoff: true, handoffReason: 'enfadado' });
    await s.req(`/api/conversations/${conv.id}/reactivate`, { method: 'POST' });
    const list = (await (await s.req('/api/tenants/mi-estudio-web/conversations')).json()) as {
      handoff: boolean;
    }[];
    expect(list[0]!.handoff).toBe(false);
  });
});

describe('cambiar y cancelar citas desde la agenda', () => {
  const at = (iso: string) => DateTime.fromISO(iso, { zone: 'Europe/Madrid' });
  async function withAppointment() {
    const s = setup();
    getOrCreateConversation(s.db, 'mi-estudio-web', '34600111222', '34600111222@s.whatsapp.net');
    const r = await s.booking.create(s.tenant, {
      service: s.tenant.servicios[0]!,
      location: s.tenant.ubicaciones[0]!,
      phone: '34600111222',
      clientName: 'Marta Ruiz',
      start: at('2026-10-29T10:00'),
    });
    if (!r.creada) throw new Error('debería crearse');
    return { ...s, cita: r.cita, base: `/api/tenants/mi-estudio-web/appointments/${r.cita.id}` };
  }

  it('lista las horas libres de un día contando como libre el hueco de la propia cita', async () => {
    const s = await withAppointment();
    const slots = (await (await s.req(`${s.base}/slots?date=2026-10-29`)).json()) as { hora: string }[];
    expect(slots.map((x) => x.hora)).toContain('10:00');
    expect(slots[0]).toMatchObject({ hora: '09:00' });
    expect((await s.req(`${s.base}/slots?date=29-10-2026`)).status).toBe(400);
  });

  it('al cambiarla queda pendiente de confirmar y se pregunta al cliente por WhatsApp', async () => {
    const s = await withAppointment();
    const res = await s.req(`${s.base}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ inicio: '2026-10-30T12:00', nota: 'Nos ha surgido un imprevisto.' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cita: { pendingConfirmation: boolean; start: string };
      aviso: unknown;
    };
    expect(body.cita).toMatchObject({ pendingConfirmation: true, start: '2026-10-30T11:00:00.000Z' });
    expect(body.aviso).toEqual({ sent: true });
    expect(s.notified).toHaveLength(1);
    expect(s.notified[0]!.phone).toBe('34600111222');
    expect(s.notified[0]!.text).toContain('Hola Marta');
    expect(s.notified[0]!.text).toContain('era el jueves 29 de octubre a las 10:00');
    expect(s.notified[0]!.text).toContain('*viernes 30 de octubre a las 12:00*');
    expect(s.notified[0]!.text).toContain('Nos ha surgido un imprevisto.');
    expect(s.notified[0]!.text).toContain('¿Te viene bien?');
    expect(s.sheets.rows[1]![10]).toBe('Pendiente de confirmar');
    expect([...s.calendar.events.values()][0]!.summary).toContain('(pendiente de confirmar)');
  });

  it('si el nuevo hueco está ocupado no cambia nada y devuelve alternativas', async () => {
    const s = await withAppointment();
    s.calendar.block('cal', '2026-10-30T12:00:00+01:00', '2026-10-30T13:00:00+01:00');
    const res = await s.req(`${s.base}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ inicio: '2026-10-30T12:00' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { alternativas: unknown[] }).alternativas.length).toBeGreaterThan(0);
    expect(s.notified).toHaveLength(0);
  });

  it('si el aviso no llega (WhatsApp desconectado), el cambio no queda pendiente de confirmar', async () => {
    const s = await withAppointment();
    s.notifyResult.value = { sent: false, reason: 'el WhatsApp del negocio no está conectado' };
    const res = await s.req(`${s.base}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ inicio: '2026-10-30T12:00' }),
    });
    const body = (await res.json()) as { cita: { pendingConfirmation: boolean }; aviso: { sent: boolean } };
    expect(body.aviso.sent).toBe(false);
    expect(body.cita.pendingConfirmation).toBe(false);
    expect(s.sheets.rows[1]![10]).toBe('Reprogramada');
  });

  it('sin avisar al cliente, el cambio no queda pendiente de confirmar', async () => {
    const s = await withAppointment();
    const res = await s.req(`${s.base}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ inicio: '2026-10-30T12:00', avisar: false }),
    });
    expect(((await res.json()) as { cita: { pendingConfirmation: boolean } }).cita.pendingConfirmation).toBe(
      false,
    );
    expect(s.notified).toHaveLength(0);
  });

  it('al cancelarla se avisa al cliente con el motivo', async () => {
    const s = await withAppointment();
    const res = await s.req(`${s.base}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ nota: 'Estamos de baja.' }),
    });
    expect(res.status).toBe(200);
    expect(s.notified[0]!.text).toContain(
      '*cancelar* tu cita de Reunión inicial gratuita del jueves 29 de octubre a las 10:00',
    );
    expect(s.notified[0]!.text).toContain('Estamos de baja.');
    expect(s.sheets.rows[1]![10]).toBe('Cancelada');
    expect((await s.req(`${s.base}/cancel`, { method: 'POST' })).status).toBe(400);
  });
});

describe('borrado GDPR', () => {
  it('borra conversaciones y citas de la BD y anonimiza Google sin borrar la fila', async () => {
    const s = setup();
    const phone = '34600111222';
    getOrCreateConversation(s.db, 'mi-estudio-web', phone, `${phone}@s.whatsapp.net`);
    const r = await s.booking.create(s.tenant, {
      service: s.tenant.servicios[0]!,
      location: s.tenant.ubicaciones[0]!,
      phone,
      clientName: 'Ana López',
      start: DateTime.fromISO('2026-10-29T10:00', { zone: 'Europe/Madrid' }),
    });
    if (!r.creada) throw new Error('debería crearse');

    const deleted = deleteClientData(s.db, 'mi-estudio-web', phone);
    expect(deleted).toMatchObject({ conversations: 1 });
    for (const cita of deleted.appointments) await s.booking.anonymize(s.tenant, cita);

    expect(s.sheets.rows).toHaveLength(2);
    expect(s.sheets.rows[1]!.slice(2, 4)).toEqual(['[borrado]', '[borrado]']);
    const ev = [...s.calendar.events.values()][0]!;
    expect(ev.summary).not.toContain('Ana');
    expect(ev.description).not.toContain(phone);
    expect(deleteClientData(s.db, 'mi-estudio-web', phone)).toEqual({ appointments: [], conversations: 0 });
  });
});
