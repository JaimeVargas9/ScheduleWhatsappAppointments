import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { cancellationMessage, rescheduleMessage } from '../booking/messages.js';
import type { LLMProvider } from '../ai/llm.js';
import type { BookingService } from '../booking/service.js';
import type { Db } from '../db/client.js';
import {
  appointmentsInRange,
  getAppointment,
  getConversation,
  getTenant,
  listConversations,
  listLogs,
  listTenants,
  messagesAfter,
  saveTenant,
  updateConversation,
} from '../db/repos.js';
import type { Google } from '../google/index.js';
import { SHEET_HEADER } from '../google/sheets.js';
import { parseTenantConfig, type TenantConfig } from '../tenants/schema.js';
import { log } from '../util/log.js';
import type { SessionManager } from '../whatsapp/manager.js';

export type AdminDeps = {
  db: Db;
  google: Google;
  booking: BookingService;
  llm: LLMProvider;
  sessions: SessionManager;
  user: string;
  password: string;
  model: string;
};

const PUBLIC = 'src/admin/public';
const SESSION = 'panel_session';
const vendor = (path: string) => readFileSync(new URL(`../../node_modules/${path}`, import.meta.url), 'utf8');

export function createAdminApp(deps: AdminDeps) {
  const { db, google, booking, sessions } = deps;
  const app = new Hono();
  const secret = createHash('sha256').update(`panel:${deps.user}:${deps.password}`).digest('hex');
  const same = (a: string, b: string) => {
    const x = createHash('sha256').update(a).digest();
    const y = createHash('sha256').update(b).digest();
    return timingSafeEqual(x, y);
  };

  app.get('/login', serveStatic({ path: `${PUBLIC}/login.html` }));
  app.get('/login.css', serveStatic({ path: `${PUBLIC}/app.css` }));
  app.get('/logo.svg', serveStatic({ path: `${PUBLIC}/logo.svg` }));

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const ok = same(String(form.user ?? ''), deps.user) && same(String(form.password ?? ''), deps.password);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600));
      return c.redirect('/login?error=1');
    }
    await setSignedCookie(c, SESSION, deps.user, secret, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    return c.redirect('/');
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION, { path: '/' });
    return c.redirect('/login');
  });

  app.use('*', async (c, next) => {
    if ((await getSignedCookie(c, secret, SESSION)) === deps.user) return next();
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Sesión caducada: vuelve a entrar' }, 401);
    return c.redirect('/login');
  });

  app.onError((err, c) => {
    const message = err instanceof z.ZodError ? err.issues.map((i) => i.message).join(', ') : err.message;
    log.error({ err: message, path: c.req.path }, 'Error en el panel');
    return c.json({ error: message }, 400);
  });

  const tenantOr404 = (c: Context): TenantConfig => {
    const t = getTenant(db, c.req.param('id') ?? '');
    if (!t) throw new Error('Negocio no encontrado');
    return t;
  };

  app.get('/vendor/fullcalendar.js', (c) =>
    c.body(
      vendor('fullcalendar/index.global.min.js') +
        '\n' +
        vendor('@fullcalendar/core/locales/es.global.min.js'),
      200,
      { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400' },
    ),
  );

  app.get('/api/overview', async (c) => {
    const ollama = await deps.llm.check();
    const now = DateTime.now();
    const tenants = await Promise.all(
      listTenants(db).map(async (t) => {
        const local = now.setZone(t.zona_horaria);
        const week = appointmentsInRange(
          db,
          t.id,
          local.startOf('day').toUTC().toISO()!,
          local.plus({ days: 7 }).endOf('day').toUTC().toISO()!,
          false,
        );
        const today = week.filter((a) =>
          DateTime.fromISO(a.start).setZone(t.zona_horaria).hasSame(local, 'day'),
        );
        const convs = listConversations(db, t.id);
        return {
          id: t.id,
          nombre: t.nombre,
          descripcion: t.descripcion,
          modo: t.modo,
          activo: t.activo,
          zona_horaria: t.zona_horaria,
          pendientes: t.pendientes,
          google: { calendar: !!t.google.calendar_id, sheet: !!t.google.spreadsheet_id },
          whatsapp: await sessions.status(t.id),
          hoy: today,
          proximas: week.filter((a) => a.start >= now.toUTC().toISO()!).slice(0, 8),
          stats: {
            citasHoy: today.length,
            citasSemana: week.length,
            conversaciones: convs.length,
            derivadas: convs.filter((x) => x.handoff).length,
          },
        };
      }),
    );
    return c.json({
      ollama: { ...ollama, model: deps.model },
      google: { configured: !!google.serviceAccountEmail, email: google.serviceAccountEmail },
      tenants,
    });
  });

  app.get('/api/tenants/:id', (c) => c.json(tenantOr404(c)));

  app.post('/api/tenants', async (c) => {
    const config = parseTenantConfig(await c.req.json());
    if (getTenant(db, config.id)) throw new Error(`Ya existe un negocio con id "${config.id}"`);
    saveTenant(db, config);
    await sessions.sync([config]);
    return c.json(config, 201);
  });

  app.put('/api/tenants/:id', async (c) => {
    const current = tenantOr404(c);
    const config = parseTenantConfig(await c.req.json());
    if (config.id !== current.id) throw new Error('No se puede cambiar el id de un negocio');
    saveTenant(db, config);
    await sessions.sync([config]);
    return c.json(config);
  });

  app.get('/api/tenants/:id/whatsapp', async (c) => c.json(await sessions.status(tenantOr404(c).id)));

  app.post('/api/tenants/:id/whatsapp/relink', async (c) => {
    await sessions.logout(tenantOr404(c).id);
    return c.json({ ok: true });
  });

  app.get('/api/tenants/:id/events', async (c) => {
    const t = tenantOr404(c);
    const start = new Date(c.req.query('start') ?? Date.now());
    const end = new Date(c.req.query('end') ?? Date.now() + 7 * 864e5);
    const appts = appointmentsInRange(db, t.id, start.toISOString(), end.toISOString());
    const events: unknown[] = appts.map((a) => ({
      id: a.id,
      title: `${a.clientName} · ${a.serviceName}`,
      start: a.start,
      end: a.end,
      classNames: [a.pendingConfirmation ? 'ev-pendiente' : `ev-${a.status}`],
      extendedProps: { kind: 'cita', ...a },
    }));
    let warning: string | null = null;
    if (t.google.calendar_id) {
      try {
        const own = new Set(appts.map((a) => a.calendarEventId));
        for (const e of await google.calendar.listEvents(t.google.calendar_id, start, end)) {
          if (own.has(e.id) || e.transparent) continue;
          events.push({
            id: `g-${e.id}`,
            title: e.summary,
            start: e.start,
            end: e.end,
            allDay: e.start.length === 10,
            classNames: ['ev-google'],
            extendedProps: { kind: 'google' },
          });
        }
      } catch (e) {
        warning = (e as Error).message;
      }
    } else {
      warning = 'Este negocio aún no tiene calendar_id: solo se muestran las citas guardadas en local.';
    }
    return c.json({ events, warning });
  });

  const activeAppointment = (c: Context, t: TenantConfig) => {
    const cita = getAppointment(db, t.id, c.req.param('aid') ?? '');
    if (!cita) throw new Error('Cita no encontrada');
    if (cita.status === 'cancelada') throw new Error('La cita ya está cancelada');
    return cita;
  };
  const changeBody = z.object({
    nota: z.string().max(500).optional(),
    avisar: z.boolean().default(true),
  });

  app.get('/api/tenants/:id/appointments/:aid/slots', async (c) => {
    const t = tenantOr404(c);
    const cita = activeAppointment(c, t);
    const date = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida')
      .parse(c.req.query('date'));
    const day = DateTime.fromISO(date, { zone: t.zona_horaria });
    const slots = await booking.list(t, booking.requestFor(t, cita), day, day, cita);
    return c.json(
      slots.map((s) => ({ inicio: s.inicio.slice(0, 16), hora: s.inicio.slice(11, 16), texto: s.texto })),
    );
  });

  app.post('/api/tenants/:id/appointments/:aid/cancel', async (c) => {
    const t = tenantOr404(c);
    const cita = activeAppointment(c, t);
    const body = changeBody.parse(await c.req.json().catch(() => ({})));
    const updated = await booking.cancel(t, cita);
    const aviso = body.avisar
      ? await sessions.notify(t.id, cita.phone, cancellationMessage(t, cita, body.nota))
      : null;
    return c.json({ cita: updated, aviso });
  });

  app.post('/api/tenants/:id/appointments/:aid/reschedule', async (c) => {
    const t = tenantOr404(c);
    const cita = activeAppointment(c, t);
    const body = changeBody
      .extend({ inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Fecha y hora no válidas') })
      .parse(await c.req.json());
    const start = DateTime.fromISO(body.inicio, { zone: t.zona_horaria });
    const r = await booking.reschedule(t, cita, start, { byBusiness: body.avisar });
    if (!r.creada) return c.json(r, 409);
    const aviso = body.avisar
      ? await sessions.notify(t.id, cita.phone, rescheduleMessage(t, cita, r.cita, body.nota))
      : null;
    const final = aviso && !aviso.sent ? await booking.confirm(t, r.cita, { byClient: false }) : r.cita;
    return c.json({ cita: final, aviso });
  });

  app.get('/api/tenants/:id/sheet', async (c) => {
    const t = tenantOr404(c);
    const local = () => [
      SHEET_HEADER,
      ...appointmentsInRange(db, t.id, '0000', '9999').map((a) => booking.sheetRow(t, a)),
    ];
    if (!t.google.spreadsheet_id) {
      return c.json({
        source: 'local',
        rows: local(),
        url: null,
        warning:
          'Este negocio aún no tiene spreadsheet_id: se muestran las citas guardadas en local con el mismo formato.',
      });
    }
    const url = `https://docs.google.com/spreadsheets/d/${t.google.spreadsheet_id}`;
    try {
      const rows = await google.sheets.readAll({
        spreadsheetId: t.google.spreadsheet_id,
        tab: t.google.pestana,
      });
      return c.json({ source: 'google', rows, url, warning: null });
    } catch (e) {
      return c.json({
        source: 'local',
        rows: local(),
        url,
        warning: `No se pudo leer Google Sheets: ${(e as Error).message}`,
      });
    }
  });

  app.get('/api/tenants/:id/conversations', (c) => c.json(listConversations(db, tenantOr404(c).id)));

  app.get('/api/conversations/:cid/messages', (c) => {
    const conv = getConversation(db, Number(c.req.param('cid')));
    if (!conv) throw new Error('Conversación no encontrada');
    return c.json({ conversation: conv, messages: messagesAfter(db, conv.id, 0) });
  });

  app.post('/api/conversations/:cid/reactivate', (c) => {
    const id = Number(c.req.param('cid'));
    if (!getConversation(db, id)) throw new Error('Conversación no encontrada');
    updateConversation(db, id, { handoff: false, handoffReason: null, handoffAt: null });
    return c.json({ ok: true });
  });

  app.get('/api/logs', (c) => c.json(listLogs(db, c.req.query('tenant') || null)));

  app.use('/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-cache');
  });
  app.use('/*', serveStatic({ root: PUBLIC }));
  return app;
}

export function startAdmin(deps: AdminDeps, port: number) {
  const app = createAdminApp(deps);
  const v6 = serve({ fetch: app.fetch, port, hostname: '::1' });
  v6.on('error', (e) => log.debug({ err: e.message }, 'Panel sin IPv6 local'));
  return serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
}
