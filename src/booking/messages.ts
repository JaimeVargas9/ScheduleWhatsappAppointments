import { DateTime } from 'luxon';
import type { Appointment } from '../db/schema.js';
import { huecoTexto } from '../scheduling/format.js';
import type { TenantConfig } from '../tenants/schema.js';

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const when = (tenant: TenantConfig, iso: string) =>
  huecoTexto(DateTime.fromISO(iso).setZone(tenant.zona_horaria));
const withNote = (note?: string) => (note?.trim() ? `\n\n${note.trim()}` : '');

export function cancellationMessage(tenant: TenantConfig, cita: Appointment, note?: string): string {
  return (
    `Hola ${firstName(cita.clientName)}, te escribimos de ${tenant.nombre}. ` +
    `Lo sentimos, hemos tenido que *cancelar* tu cita de ${cita.serviceName} del ${when(tenant, cita.start)}.` +
    withNote(note) +
    `\n\nSi quieres, dime qué día y hora te vendrían bien y te busco otro hueco.`
  );
}

export function rescheduleMessage(
  tenant: TenantConfig,
  before: Appointment,
  after: Appointment,
  note?: string,
): string {
  return (
    `Hola ${firstName(after.clientName)}, te escribimos de ${tenant.nombre}. ` +
    `Hemos tenido que cambiar tu cita de ${after.serviceName}: era el ${when(tenant, before.start)} ` +
    `y ahora sería el *${when(tenant, after.start)}* (${after.locationName}).` +
    withNote(note) +
    `\n\n¿Te viene bien? Si no puedes, dime qué día y hora prefieres y te busco otro hueco.`
  );
}
