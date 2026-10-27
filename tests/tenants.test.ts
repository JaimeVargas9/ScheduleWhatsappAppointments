import { describe, expect, it } from 'vitest';
import { getTenant, saveTenant } from '../src/db/repos.js';
import { parseTenantConfig } from '../src/tenants/schema.js';
import { exampleTenant, testDb } from './helpers.js';

describe('configuración de negocio', () => {
  it('el ejemplo es válido y contiene los datos del negocio de prueba', () => {
    const t = exampleTenant();
    expect(t.nombre).toBe('Mi Estudio Web');
    expect(t.modo).toBe('test');
    expect(t.servicios.map((s) => [s.nombre, s.duracion_min])).toEqual([
      ['Reunión inicial gratuita', 30],
      ['Presentación de presupuesto', 45],
      ['Revisión de proyecto en curso', 30],
    ]);
    expect(t.horario.lunes).toEqual([
      ['09:00', '14:00'],
      ['16:00', '19:00'],
    ]);
    expect(t.horario.sabado).toEqual([]);
    expect(t.reglas).toEqual({ antelacion_minima_min: 120, max_dias_vista: 30, margen_entre_citas_min: 15 });
    expect(t.ubicaciones.find((u) => u.id === 'presencial')?.activa).toBe(false);
  });

  it('rechaza una ubicación presencial activa sin dirección', () => {
    const t = exampleTenant();
    const ubicaciones = t.ubicaciones.map((u) => (u.id === 'presencial' ? { ...u, activa: true } : u));
    expect(() => parseTenantConfig({ ...t, ubicaciones })).toThrow(/hace falta poner la dirección/);
  });

  it('rechaza servicios que apuntan a ubicaciones inexistentes', () => {
    const t = exampleTenant();
    const servicios = [{ ...t.servicios[0]!, ubicaciones: ['marte'] }];
    expect(() => parseTenantConfig({ ...t, servicios })).toThrow(/marte/);
  });

  it('acepta la URL completa de la hoja y guarda solo el ID', () => {
    const t = exampleTenant();
    const url = 'https://docs.google.com/spreadsheets/d/1AbC_d-EF23/edit#gid=0';
    expect(
      parseTenantConfig({ ...t, google: { ...t.google, spreadsheet_id: url } }).google.spreadsheet_id,
    ).toBe('1AbC_d-EF23');
  });

  it('guarda y actualiza un negocio en la BD', () => {
    const db = testDb();
    const t = getTenant(db, 'mi-estudio-web')!;
    saveTenant(db, { ...t, modo: 'live' });
    expect(getTenant(db, 'mi-estudio-web')?.modo).toBe('live');
  });
});
