import { DateTime } from 'luxon';
import {
  DIAS,
  type HorarioSemanal,
  type Servicio,
  type TenantConfig,
  type Ubicacion,
} from '../tenants/schema.js';
import { huecoTexto } from './format.js';

export const PASO_MIN = 15;

export type Busy = { start: number; end: number };
export type Resource = { id: string | null; busy: Busy[] };

export type SlotContext = {
  tenant: TenantConfig;
  service: Servicio;
  location: Ubicacion;
  resources: Resource[];
  now: DateTime;
};

export type Hueco = { inicio: string; texto: string; recurso: string | null };

export type Motivo = 'ocupado' | 'fuera_de_horario' | 'festivo' | 'antelacion_insuficiente';

export type Comprobacion =
  | { libre: true; recurso: string | null; inicio: string; texto: string }
  | { libre: false; motivo: Motivo; detalle: string; alternativas: Hueco[] };

const MAX_ALTERNATIVAS = 5;

export function horarioDe(tenant: TenantConfig, location: Ubicacion): HorarioSemanal {
  return location.horario ?? tenant.horario;
}

function diaCerrado(tenant: TenantConfig, isoDate: string): string | null {
  const festivo = tenant.festivos.find((f) => f.fecha === isoDate);
  if (festivo) return festivo.motivo;
  const cierre = tenant.cierres.find((c) => c.desde <= isoDate && isoDate <= c.hasta);
  return cierre ? cierre.motivo : null;
}

function tramosDelDia(ctx: SlotContext, day: DateTime): { start: DateTime; end: DateTime }[] {
  const isoDate = day.toISODate()!;
  const dia = DIAS[day.weekday - 1]!;
  return horarioDe(ctx.tenant, ctx.location)[dia].map(([a, b]) => ({
    start: DateTime.fromISO(`${isoDate}T${a}`, { zone: ctx.tenant.zona_horaria }),
    end: DateTime.fromISO(`${isoDate}T${b}`, { zone: ctx.tenant.zona_horaria }),
  }));
}

function limites(ctx: SlotContext) {
  const { antelacion_minima_min, max_dias_vista } = ctx.tenant.reglas;
  return {
    earliest: ctx.now.plus({ minutes: antelacion_minima_min }),
    latest: ctx.now.setZone(ctx.tenant.zona_horaria).plus({ days: max_dias_vista }).endOf('day'),
  };
}

function recursoLibre(ctx: SlotContext, start: DateTime): string | null | undefined {
  const margin = ctx.tenant.reglas.margen_entre_citas_min * 60_000;
  const s = start.toMillis();
  const e = s + ctx.service.duracion_min * 60_000;
  const free = ctx.resources.find((r) => r.busy.every((b) => !(s < b.end + margin && e + margin > b.start)));
  return free ? free.id : undefined;
}

function hueco(start: DateTime, recurso: string | null): Hueco {
  return { inicio: start.toISO({ suppressMilliseconds: true })!, texto: huecoTexto(start), recurso };
}

export function huecosDelDia(ctx: SlotContext, day: DateTime): Hueco[] {
  const local = day.setZone(ctx.tenant.zona_horaria).startOf('day');
  if (diaCerrado(ctx.tenant, local.toISODate()!)) return [];
  const { earliest, latest } = limites(ctx);
  const out: Hueco[] = [];
  for (const tramo of tramosDelDia(ctx, local)) {
    for (
      let s = tramo.start;
      s.plus({ minutes: ctx.service.duracion_min }) <= tramo.end;
      s = s.plus({ minutes: PASO_MIN })
    ) {
      if (s < earliest || s > latest) continue;
      const recurso = recursoLibre(ctx, s);
      if (recurso !== undefined) out.push(hueco(s, recurso));
    }
  }
  return out;
}

export function huecosEnRango(ctx: SlotContext, desde: DateTime, hasta: DateTime): Hueco[] {
  const out: Hueco[] = [];
  const last = hasta.setZone(ctx.tenant.zona_horaria).startOf('day');
  for (let d = desde.setZone(ctx.tenant.zona_horaria).startOf('day'); d <= last; d = d.plus({ days: 1 })) {
    out.push(...huecosDelDia(ctx, d));
  }
  return out;
}

export function alternativas(ctx: SlotContext, pedido: DateTime): Hueco[] {
  const day = pedido.setZone(ctx.tenant.zona_horaria).startOf('day');
  const mismoDia = huecosDelDia(ctx, day).sort(
    (a, b) =>
      Math.abs(DateTime.fromISO(a.inicio).toMillis() - pedido.toMillis()) -
      Math.abs(DateTime.fromISO(b.inicio).toMillis() - pedido.toMillis()),
  );
  const out = mismoDia.slice(0, MAX_ALTERNATIVAS);
  const { latest } = limites(ctx);
  for (let d = day.plus({ days: 1 }); out.length < MAX_ALTERNATIVAS && d <= latest; d = d.plus({ days: 1 })) {
    out.push(...huecosDelDia(ctx, d).slice(0, MAX_ALTERNATIVAS - out.length));
  }
  return out;
}

export function comprobarHueco(ctx: SlotContext, pedido: DateTime): Comprobacion {
  const start = pedido.setZone(ctx.tenant.zona_horaria);
  const end = start.plus({ minutes: ctx.service.duracion_min });
  const { earliest, latest } = limites(ctx);
  const no = (motivo: Motivo, detalle: string): Comprobacion => ({
    libre: false,
    motivo,
    detalle,
    alternativas: alternativas(ctx, start),
  });

  if (start < earliest) {
    const horas = ctx.tenant.reglas.antelacion_minima_min / 60;
    return no('antelacion_insuficiente', `Las citas se piden con al menos ${horas} h de antelación.`);
  }
  if (start > latest) {
    return no(
      'fuera_de_horario',
      `Solo se dan citas con un máximo de ${ctx.tenant.reglas.max_dias_vista} días vista.`,
    );
  }
  const cerrado = diaCerrado(ctx.tenant, start.toISODate()!);
  if (cerrado) return no('festivo', `Ese día está cerrado: ${cerrado}.`);
  const dentro = tramosDelDia(ctx, start.startOf('day')).some((t) => start >= t.start && end <= t.end);
  if (!dentro) return no('fuera_de_horario', 'Esa hora está fuera del horario de atención.');
  const recurso = recursoLibre(ctx, start);
  if (recurso === undefined) return no('ocupado', 'Ese hueco ya está ocupado.');
  return { libre: true, ...hueco(start, recurso) };
}
