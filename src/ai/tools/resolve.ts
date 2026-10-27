import { DateTime } from 'luxon';
import {
  DIAS,
  type Profesional,
  type Servicio,
  type TenantConfig,
  type Ubicacion,
} from '../../tenants/schema.js';

export class ToolError extends Error {}

export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

function findByName<T extends { id: string; nombre: string }>(items: T[], query: string, label: string): T {
  const q = norm(query);
  const exact = items.find((i) => norm(i.id) === q || norm(i.nombre) === q);
  if (exact) return exact;
  const partial = items.filter(
    (i) => norm(i.nombre).includes(q) || q.includes(norm(i.nombre)) || q.includes(norm(i.id)),
  );
  if (partial.length === 1) return partial[0]!;
  throw new ToolError(
    `${label} "${query}" no existe. Opciones válidas: ${items.map((i) => i.nombre).join(', ')}.`,
  );
}

export function resolveService(tenant: TenantConfig, query: string): Servicio {
  return findByName(
    tenant.servicios.filter((s) => s.activo),
    query,
    'El servicio',
  );
}

export function resolveLocation(tenant: TenantConfig, service: Servicio, query?: string): Ubicacion {
  const allowed = tenant.ubicaciones.filter((u) => u.activa && service.ubicaciones.includes(u.id));
  if (!allowed.length)
    throw new ToolError(`El servicio "${service.nombre}" no tiene ninguna modalidad disponible.`);
  if (!query) return allowed[0]!;
  return findByName(allowed, query, `La modalidad para "${service.nombre}"`);
}

export function resolveProfessional(
  tenant: TenantConfig,
  service: Servicio,
  query?: string,
): Profesional | undefined {
  if (!query) return undefined;
  const allowed = tenant.profesionales.filter((p) => p.servicios.includes(service.id));
  if (!allowed.length) return undefined;
  return findByName(allowed, query, `El profesional para "${service.nombre}"`);
}

export function parseFecha(
  input: string,
  tenant: TenantConfig,
  now: DateTime,
): { dt: DateTime; conHora: boolean } {
  const s = input.trim().replace(' ', 'T');
  const conHora = /T\d{1,2}:\d{2}/.test(s);
  const parsed = DateTime.fromISO(s, { zone: tenant.zona_horaria, setZone: /[+-]\d{2}:?\d{2}$|Z$/.test(s) });
  if (!parsed.isValid)
    throw new ToolError(`Fecha "${input}" no válida. Usa AAAA-MM-DD o AAAA-MM-DDTHH:MM (hora local).`);
  const dt = parsed.setZone(tenant.zona_horaria);
  if (dt.startOf('day') < now.startOf('day')) {
    throw new ToolError(`La fecha ${dt.toISODate()} ya ha pasado. Hoy es ${now.toISODate()}.`);
  }
  return { dt, conHora };
}

export function checkWeekday(dt: DateTime, userText: string): void {
  const said = [
    ...new Set(norm(userText).match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/g) ?? []),
  ];
  if (said.length !== 1) return;
  const actual = DIAS[dt.weekday - 1]!;
  if (said[0] !== actual) {
    throw new ToolError(
      `El cliente ha dicho "${said[0]}", pero ${dt.toISODate()} es ${actual}. Busca "${said[0]}" en el calendario de próximos días y usa esa fecha.`,
    );
  }
}

const PLACEHOLDERS = new Set(['cliente', 'desconocido', 'usuario', 'nombre', 'unknown', 'n/a']);

export function checkClientName(name: string, userText: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  const tokens = norm(clean)
    .split(/[^\p{L}]+/u)
    .filter((t) => t.length >= 2);
  if (!tokens.length || tokens.every((t) => PLACEHOLDERS.has(t))) {
    throw new ToolError('Falta el nombre. Pregunta al cliente a nombre de quién quiere la cita.');
  }
  const said = new Set(norm(userText).split(/[^\p{L}]+/u));
  if (!tokens.some((t) => said.has(t))) {
    throw new ToolError(
      `El cliente no ha dicho el nombre "${clean}" en la conversación. Pregúntale a nombre de quién quiere la cita y usa exactamente lo que diga.`,
    );
  }
  return clean;
}
