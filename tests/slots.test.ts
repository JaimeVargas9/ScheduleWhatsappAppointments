import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  alternativas,
  comprobarHueco,
  huecosDelDia,
  huecosEnRango,
  type Busy,
  type SlotContext,
} from '../src/scheduling/slots.js';
import type { TenantConfig } from '../src/tenants/schema.js';
import { exampleTenant } from './helpers.js';

const TZ = 'Europe/Madrid';
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
const busy = (a: string, b: string): Busy => ({ start: at(a).toMillis(), end: at(b).toMillis() });
const hora = (iso: string) => DateTime.fromISO(iso).setZone(TZ).toFormat('ccc HH:mm', { locale: 'en' });

function ctx(now: string, busyList: Busy[] = [], tenant: TenantConfig = exampleTenant()): SlotContext {
  return {
    tenant,
    service: tenant.servicios[0]!,
    location: tenant.ubicaciones[0]!,
    resources: [{ id: null, busy: busyList }],
    now: at(now),
  };
}

describe('huecos', () => {
  it('respeta el horario partido de lunes a viernes y no da citas el fin de semana', () => {
    const c = ctx('2026-10-27T08:00');
    const miercoles = huecosDelDia(c, at('2026-10-28'));
    expect(miercoles).toHaveLength(19 + 11);
    expect(hora(miercoles[0]!.inicio)).toBe('Wed 09:00');
    expect(miercoles.map((h) => hora(h.inicio))).toContain('Wed 13:30');
    expect(miercoles.map((h) => hora(h.inicio))).not.toContain('Wed 13:45');
    expect(miercoles.map((h) => hora(h.inicio))).toContain('Wed 16:00');
    expect(hora(miercoles.at(-1)!.inicio)).toBe('Wed 18:30');
    expect(huecosDelDia(c, at('2026-10-31'))).toEqual([]);
    expect(huecosDelDia(c, at('2026-11-01'))).toEqual([]);
  });

  it('aplica la antelación mínima de 2 horas', () => {
    const c = ctx('2026-10-27T10:00');
    expect(hora(huecosDelDia(c, at('2026-10-27'))[0]!.inicio)).toBe('Tue 12:00');
    const r = comprobarHueco(c, at('2026-10-27T11:00'));
    expect(r).toMatchObject({ libre: false, motivo: 'antelacion_insuficiente' });
    if (!r.libre) expect(hora(r.alternativas[0]!.inicio)).toBe('Tue 12:00');
  });

  it('no da citas en festivos ni en cierres', () => {
    const t = exampleTenant({
      festivos: [{ fecha: '2026-10-28', motivo: 'Fiesta local' }],
      cierres: [{ desde: '2026-11-02', hasta: '2026-11-03', motivo: 'Vacaciones' }],
    });
    const c = ctx('2026-10-27T08:00', [], t);
    expect(huecosDelDia(c, at('2026-10-28'))).toEqual([]);
    expect(huecosDelDia(c, at('2026-11-03'))).toEqual([]);
    const r = comprobarHueco(c, at('2026-10-28T10:00'));
    expect(r).toMatchObject({ libre: false, motivo: 'festivo' });
    if (!r.libre) expect(hora(r.alternativas[0]!.inicio)).toBe('Thu 09:00');
  });

  it('detecta solapes respetando el margen de 15 minutos entre citas', () => {
    const c = ctx('2026-10-27T08:00', [busy('2026-10-28T10:00', '2026-10-28T10:30')]);
    const libres = huecosDelDia(c, at('2026-10-28')).map((h) => hora(h.inicio));
    expect(libres).toContain('Wed 09:15');
    expect(libres).toContain('Wed 10:45');
    for (const bloqueada of ['09:30', '09:45', '10:00', '10:15', '10:30'])
      expect(libres).not.toContain(`Wed ${bloqueada}`);
    expect(comprobarHueco(c, at('2026-10-28T10:45'))).toMatchObject({ libre: true });
    const r = comprobarHueco(c, at('2026-10-28T10:00'));
    expect(r).toMatchObject({ libre: false, motivo: 'ocupado' });
    if (!r.libre)
      expect(r.alternativas.map((h) => hora(h.inicio))).toEqual([
        'Wed 09:15',
        'Wed 10:45',
        'Wed 09:00',
        'Wed 11:00',
        'Wed 11:15',
      ]);
  });

  it('ofrece primero huecos del mismo día y después de los días siguientes', () => {
    const c = ctx('2026-10-27T08:00', [
      busy('2026-10-28T09:00', '2026-10-28T13:15'),
      busy('2026-10-28T16:00', '2026-10-28T19:00'),
    ]);
    const r = comprobarHueco(c, at('2026-10-28T10:00'));
    expect(r.libre).toBe(false);
    if (!r.libre) {
      expect(r.alternativas.map((h) => hora(h.inicio))).toEqual([
        'Wed 13:30',
        'Thu 09:00',
        'Thu 09:15',
        'Thu 09:30',
        'Thu 09:45',
      ]);
      expect(r.alternativas[0]!.texto).toBe('miércoles 28/10/2026 a las 13:30');
    }
  });

  it('marca fuera de horario y respeta el máximo de días vista', () => {
    const c = ctx('2026-10-27T08:00');
    expect(comprobarHueco(c, at('2026-10-28T13:45'))).toMatchObject({
      libre: false,
      motivo: 'fuera_de_horario',
    });
    expect(comprobarHueco(c, at('2026-10-31T10:00'))).toMatchObject({
      libre: false,
      motivo: 'fuera_de_horario',
    });
    expect(comprobarHueco(c, at('2026-12-15T10:00'))).toMatchObject({
      libre: false,
      motivo: 'fuera_de_horario',
    });
    expect(huecosEnRango(c, at('2026-10-27'), at('2027-01-31')).at(-1)!.inicio < '2026-11-27').toBe(true);
  });

  it('nunca devuelve huecos ni alternativas fuera de horario', () => {
    const c = ctx('2026-10-27T08:00', [busy('2026-10-29T09:00', '2026-10-29T12:00')]);
    const todos = [
      ...huecosEnRango(c, at('2026-10-27'), at('2026-11-27')),
      ...alternativas(c, at('2026-10-31T10:00')),
      ...alternativas(c, at('2026-10-29T22:00')),
    ];
    expect(todos.length).toBeGreaterThan(100);
    for (const h of todos) {
      const d = DateTime.fromISO(h.inicio).setZone(TZ);
      const fin = d.plus({ minutes: 30 }).toFormat('HH:mm');
      const ini = d.toFormat('HH:mm');
      expect(d.weekday).toBeLessThanOrEqual(5);
      expect((ini >= '09:00' && fin <= '14:00') || (ini >= '16:00' && fin <= '19:00')).toBe(true);
    }
  });

  it('gestiona el cambio de hora de octubre y de marzo en España', () => {
    const c = ctx('2026-10-23T08:00');
    expect(huecosDelDia(c, at('2026-10-23'))[0]!.inicio).toBe('2026-10-23T10:00:00+02:00');
    expect(huecosDelDia(c, at('2026-10-26'))[0]!.inicio).toBe('2026-10-26T09:00:00+01:00');
    expect(DateTime.fromISO('2026-10-26T09:00:00+01:00').toUTC().hour).toBe(8);

    const marzo = ctx('2027-03-26T08:00');
    expect(huecosDelDia(marzo, at('2027-03-29'))[0]!.inicio).toBe('2027-03-29T09:00:00+02:00');
    const r = comprobarHueco(marzo, DateTime.fromISO('2027-03-29T07:00:00Z'));
    expect(r).toMatchObject({ libre: true, inicio: '2027-03-29T09:00:00+02:00' });
  });

  it('con varios profesionales, un hueco está libre si alguno lo está', () => {
    const c = ctx('2026-10-27T08:00');
    c.resources = [
      { id: 'ana', busy: [busy('2026-10-28T10:00', '2026-10-28T11:00')] },
      { id: 'luis', busy: [] },
    ];
    expect(comprobarHueco(c, at('2026-10-28T10:00'))).toMatchObject({ libre: true, recurso: 'luis' });
  });
});
