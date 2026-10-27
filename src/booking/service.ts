import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Db } from '../db/client.js';
import {
  addLog,
  appointmentsInRange,
  getAppointment,
  insertAppointment,
  updateAppointment,
} from '../db/repos.js';
import type { Appointment } from '../db/schema.js';
import type { Google } from '../google/index.js';
import {
  comprobarHueco,
  huecosEnRango,
  type Busy,
  type Hueco,
  type Resource,
  type SlotContext,
} from '../scheduling/slots.js';
import type { Profesional, Servicio, TenantConfig, Ubicacion } from '../tenants/schema.js';
import { log } from '../util/log.js';
import { runExclusive } from '../util/queue.js';

export type Clock = () => DateTime;

export type SlotRequest = {
  service: Servicio;
  location: Ubicacion;
  professional?: Profesional;
};

export type BookingResult =
  | { creada: true; cita: Appointment }
  | { creada: false; motivo: string; detalle: string; alternativas: Omit<Hueco, 'recurso'>[] };

const ESTADO_HOJA: Record<Appointment['status'], string> = {
  confirmada: 'Confirmada',
  reprogramada: 'Reprogramada',
  cancelada: 'Cancelada',
};

export function newAppointmentId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'C-' + [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join('');
}

const publicHueco = ({ inicio, texto }: Hueco) => ({ inicio, texto });

function subtract(busy: Busy[], hole: Busy | undefined): Busy[] {
  if (!hole) return busy;
  return busy.flatMap((b) => {
    if (b.end <= hole.start || b.start >= hole.end) return [b];
    const parts: Busy[] = [];
    if (b.start < hole.start) parts.push({ start: b.start, end: hole.start });
    if (b.end > hole.end) parts.push({ start: hole.end, end: b.end });
    return parts;
  });
}

export class BookingService {
  constructor(
    private db: Db,
    private google: Google,
    private clock: Clock = () => DateTime.now(),
  ) {}

  now(tenant: TenantConfig): DateTime {
    return this.clock().setZone(tenant.zona_horaria);
  }

  private professionalsFor(
    tenant: TenantConfig,
    service: Servicio,
    professional?: Profesional,
  ): (Profesional | null)[] {
    if (professional) return [professional];
    const pros = tenant.profesionales.filter((p) => p.servicios.includes(service.id));
    return pros.length ? pros : [null];
  }

  // ponytail: when rescheduling, the old appointment's interval is cut out of Google busy blocks; an unrelated event at exactly the same time would be freed too.
  private async context(tenant: TenantConfig, req: SlotRequest, ignore?: Appointment): Promise<SlotContext> {
    const now = this.now(tenant);
    const from = now.startOf('day');
    const to = now.plus({ days: tenant.reglas.max_dias_vista + 1 }).endOf('day');
    const pros = this.professionalsFor(tenant, req.service, req.professional);
    const calendarIds = [
      ...new Set([tenant.google.calendar_id, ...pros.map((p) => p?.calendar_id ?? '')].filter(Boolean)),
    ];
    const google = calendarIds.length
      ? await this.google.calendar.freeBusy(calendarIds, from.toJSDate(), to.toJSDate())
      : {};
    const hole = ignore ? { start: Date.parse(ignore.start), end: Date.parse(ignore.end) } : undefined;
    const appts = appointmentsInRange(
      this.db,
      tenant.id,
      from.toUTC().toISO()!,
      to.toUTC().toISO()!,
      false,
    ).filter((a) => a.id !== ignore?.id);

    const resources: Resource[] = pros.map((p) => {
      const sharedCalendar = subtract(google[tenant.google.calendar_id] ?? [], hole);
      const ownCalendar = p?.calendar_id ? subtract(google[p.calendar_id] ?? [], hole) : [];
      const dbBusy = appts
        .filter((a) => !p || a.professionalId === p.id || !a.professionalId)
        .map((a) => ({ start: Date.parse(a.start), end: Date.parse(a.end) }));
      return { id: p?.id ?? null, busy: [...(p?.calendar_id ? ownCalendar : sharedCalendar), ...dbBusy] };
    });
    return { tenant, service: req.service, location: req.location, resources, now };
  }

  async check(tenant: TenantConfig, req: SlotRequest, start: DateTime, ignore?: Appointment) {
    return comprobarHueco(await this.context(tenant, req, ignore), start);
  }

  async list(tenant: TenantConfig, req: SlotRequest, from: DateTime, to: DateTime, ignore?: Appointment) {
    return huecosEnRango(await this.context(tenant, req, ignore), from, to);
  }

  requestFor(tenant: TenantConfig, cita: Appointment): SlotRequest {
    const service = tenant.servicios.find((s) => s.id === cita.serviceId);
    const location = tenant.ubicaciones.find((u) => u.id === cita.locationId);
    if (!service || !location) throw new Error('El servicio o la ubicación de esta cita ya no existen.');
    return {
      service,
      location,
      professional: tenant.profesionales.find((p) => p.id === cita.professionalId),
    };
  }

  async create(
    tenant: TenantConfig,
    input: SlotRequest & { phone: string; clientName: string; start: DateTime; notes?: string },
  ): Promise<BookingResult> {
    return runExclusive(`booking:${tenant.id}`, async () => {
      const r = await this.check(tenant, input, input.start);
      if (!r.libre)
        return {
          creada: false,
          motivo: r.motivo,
          detalle: r.detalle,
          alternativas: r.alternativas.map(publicHueco),
        };

      const professional = r.recurso ? tenant.profesionales.find((p) => p.id === r.recurso) : undefined;
      const start = DateTime.fromISO(r.inicio, { zone: tenant.zona_horaria });
      const cita: Appointment = {
        id: newAppointmentId(),
        tenantId: tenant.id,
        phone: input.phone,
        clientName: input.clientName,
        serviceId: input.service.id,
        serviceName: input.service.nombre,
        professionalId: professional?.id ?? null,
        professionalName: professional?.nombre ?? null,
        locationId: input.location.id,
        locationName: input.location.nombre,
        address: input.location.tipo === 'presencial' ? input.location.direccion : '',
        start: start.toUTC().toISO()!,
        end: start.plus({ minutes: input.service.duracion_min }).toUTC().toISO()!,
        status: 'confirmada',
        notes: input.notes ?? '',
        calendarEventId: null,
        pendingConfirmation: false,
        createdAt: this.clock().toUTC().toISO()!,
        updatedAt: this.clock().toUTC().toISO()!,
      };

      const calendarId = professional?.calendar_id || tenant.google.calendar_id;
      if (calendarId)
        cita.calendarEventId = await this.google.calendar.createEvent(
          calendarId,
          this.eventFor(tenant, cita),
        );
      insertAppointment(this.db, cita);
      await this.syncSheet(tenant, cita, 'append');
      addLog(this.db, 'info', 'cita_creada', tenant.id, { id: cita.id, inicio: cita.start });
      return { creada: true, cita };
    });
  }

  async cancel(tenant: TenantConfig, cita: Appointment): Promise<Appointment> {
    return runExclusive(`booking:${tenant.id}`, async () => {
      const updated: Appointment = { ...cita, status: 'cancelada', pendingConfirmation: false };
      const calendarId = this.calendarOf(tenant, cita);
      if (calendarId && cita.calendarEventId) {
        await this.google.calendar.updateEvent(calendarId, cita.calendarEventId, {
          summary: `[CANCELADA] ${cita.serviceName} — ${cita.clientName}`,
          cancelled: true,
        });
      }
      updateAppointment(this.db, cita.id, { status: 'cancelada', pendingConfirmation: false });
      await this.syncSheet(tenant, updated, 'update');
      addLog(this.db, 'info', 'cita_cancelada', tenant.id, { id: cita.id });
      return updated;
    });
  }

  async reschedule(
    tenant: TenantConfig,
    cita: Appointment,
    newStart: DateTime,
    opts: { byBusiness?: boolean } = {},
  ): Promise<BookingResult> {
    return runExclusive(`booking:${tenant.id}`, async () => {
      const req = this.requestFor(tenant, cita);
      const r = await this.check(tenant, req, newStart, cita);
      if (!r.libre)
        return {
          creada: false,
          motivo: r.motivo,
          detalle: r.detalle,
          alternativas: r.alternativas.map(publicHueco),
        };

      const start = DateTime.fromISO(r.inicio, { zone: tenant.zona_horaria });
      const updated: Appointment = {
        ...cita,
        start: start.toUTC().toISO()!,
        end: start.plus({ minutes: req.service.duracion_min }).toUTC().toISO()!,
        status: 'reprogramada',
        pendingConfirmation: !!opts.byBusiness,
      };
      const calendarId = this.calendarOf(tenant, cita);
      if (calendarId && cita.calendarEventId) {
        const ev = this.eventFor(tenant, updated);
        await this.google.calendar.updateEvent(calendarId, cita.calendarEventId, {
          summary: ev.summary,
          start: ev.start,
          end: ev.end,
          timeZone: ev.timeZone,
          description: ev.description,
        });
      }
      updateAppointment(this.db, cita.id, {
        start: updated.start,
        end: updated.end,
        status: 'reprogramada',
        pendingConfirmation: updated.pendingConfirmation,
      });
      await this.syncSheet(tenant, updated, 'update');
      addLog(
        this.db,
        'info',
        opts.byBusiness ? 'cita_cambiada_por_negocio' : 'cita_reprogramada',
        tenant.id,
        {
          id: cita.id,
          inicio: updated.start,
        },
      );
      return { creada: true, cita: updated };
    });
  }

  async confirm(
    tenant: TenantConfig,
    cita: Appointment,
    opts: { byClient?: boolean } = { byClient: true },
  ): Promise<Appointment> {
    return runExclusive(`booking:${tenant.id}`, async () => {
      const updated: Appointment = { ...cita, pendingConfirmation: false };
      const calendarId = this.calendarOf(tenant, cita);
      if (calendarId && cita.calendarEventId) {
        await this.google.calendar.updateEvent(calendarId, cita.calendarEventId, {
          summary: this.eventFor(tenant, updated).summary,
        });
      }
      updateAppointment(this.db, cita.id, { pendingConfirmation: false });
      await this.syncSheet(tenant, updated, 'update');
      if (opts.byClient) addLog(this.db, 'info', 'cita_confirmada_por_cliente', tenant.id, { id: cita.id });
      return updated;
    });
  }

  async anonymize(tenant: TenantConfig, cita: Appointment): Promise<void> {
    const anon: Appointment = { ...cita, clientName: '[borrado]', phone: '[borrado]', notes: '' };
    const calendarId = this.calendarOf(tenant, cita);
    if (calendarId && cita.calendarEventId) {
      await this.google.calendar.updateEvent(calendarId, cita.calendarEventId, {
        summary: `${cita.serviceName} — [borrado]`,
        description: `ID cita: ${cita.id}`,
      });
    }
    await this.syncSheet(tenant, anon, 'update');
  }

  findForClient(tenant: TenantConfig, phone: string, id: string): Appointment {
    const cita = getAppointment(this.db, tenant.id, id.trim().toUpperCase());
    if (!cita || cita.phone !== phone)
      throw new Error(`No existe ninguna cita ${id} de este cliente. Usa ver_citas_cliente.`);
    if (cita.status === 'cancelada') throw new Error(`La cita ${id} ya está cancelada.`);
    return cita;
  }

  private calendarOf(tenant: TenantConfig, cita: Appointment): string {
    const pro = tenant.profesionales.find((p) => p.id === cita.professionalId);
    return pro?.calendar_id || tenant.google.calendar_id;
  }

  eventFor(tenant: TenantConfig, cita: Appointment) {
    const zone = tenant.zona_horaria;
    return {
      summary: `${cita.serviceName} — ${cita.clientName}${cita.pendingConfirmation ? ' (pendiente de confirmar)' : ''}`,
      location: cita.address || cita.locationName,
      description: [`Teléfono: +${cita.phone}`, cita.notes && `Notas: ${cita.notes}`, `ID cita: ${cita.id}`]
        .filter(Boolean)
        .join('\n'),
      start: DateTime.fromISO(cita.start).setZone(zone).toISO()!,
      end: DateTime.fromISO(cita.end).setZone(zone).toISO()!,
      timeZone: zone,
    };
  }

  sheetRow(tenant: TenantConfig, cita: Appointment): string[] {
    const local = (iso: string) =>
      DateTime.fromISO(iso).setZone(tenant.zona_horaria).toFormat('dd/MM/yyyy HH:mm');
    return [
      cita.id,
      local(cita.createdAt),
      cita.clientName,
      cita.phone === '[borrado]' ? cita.phone : `+${cita.phone}`,
      cita.serviceName,
      cita.professionalName ?? '',
      cita.locationName,
      cita.address,
      local(cita.start),
      local(cita.end),
      cita.pendingConfirmation ? 'Pendiente de confirmar' : ESTADO_HOJA[cita.status],
      cita.notes,
    ];
  }

  private async syncSheet(tenant: TenantConfig, cita: Appointment, mode: 'append' | 'update'): Promise<void> {
    if (!tenant.google.spreadsheet_id) return;
    const target = { spreadsheetId: tenant.google.spreadsheet_id, tab: tenant.google.pestana };
    const row = this.sheetRow(tenant, cita);
    try {
      if (mode === 'append') await this.google.sheets.appendRow(target, row);
      else await this.google.sheets.updateRow(target, cita.id, row);
    } catch (e) {
      log.error({ err: (e as Error).message, cita: cita.id }, 'No se pudo actualizar Google Sheets');
      addLog(this.db, 'error', 'sheets_error', tenant.id, { cita: cita.id, error: (e as Error).message });
    }
  }
}
