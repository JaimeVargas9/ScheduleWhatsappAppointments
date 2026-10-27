import { describe, expect, it } from 'vitest';
import { checkReply, toWhatsApp } from '../src/ai/guard.js';

const schedule =
  'Calendario:\n- jueves 29 de octubre = 2026-10-29\nHorario: Lunes a viernes: 09:00-14:00 y 16:00-19:00';
const tool =
  '{"libre":false,"alternativas":[{"inicio":"2026-10-29T09:15","texto":"jueves 29 de octubre a las 09:15"}]}';

describe('validador de respuestas del modelo', () => {
  it('rechaza horas que no ha devuelto ninguna herramienta', () => {
    const r = checkReply({
      reply: 'Te reservo el jueves 29 a las 10:00, ¿vale?',
      toolResults: [],
      scheduleText: schedule,
      bookingDone: false,
    });
    expect(r).toMatch(/10:00/);
    expect(
      checkReply({
        reply: 'Te puedo ofrecer a las 10',
        toolResults: [],
        scheduleText: schedule,
        bookingDone: false,
      }),
    ).toMatch(/10:00/);
  });

  it('rechaza fechas que no cuadran con el calendario (día de la semana mal calculado)', () => {
    const r = checkReply({
      reply: 'Perfecto, el jueves 26 de octubre',
      toolResults: [],
      scheduleText: schedule,
      bookingDone: false,
    });
    expect(r).toMatch(/jueves 26/);
  });

  it('rechaza dar una cita por confirmada sin haberla creado', () => {
    const r = checkReply({
      reply: '¡Listo! Tu cita queda confirmada.',
      toolResults: [],
      scheduleText: schedule,
      bookingDone: false,
    });
    expect(r).toMatch(/crear_cita/);
    expect(
      checkReply({
        reply: '¡Listo! Tu cita queda confirmada.',
        toolResults: [],
        scheduleText: schedule,
        bookingDone: true,
      }),
    ).toBeNull();
  });

  it('acepta horas devueltas por herramientas y el horario del negocio', () => {
    expect(
      checkReply({
        reply: 'Ocupado, pero tengo el jueves 29 a las 9:15. Abrimos de 09:00 a 14:00.',
        toolResults: [tool],
        scheduleText: schedule,
        bookingDone: false,
      }),
    ).toBeNull();
  });

  it('rechaza prometer opciones sin escribir ninguna', () => {
    const empty = { toolResults: [tool], scheduleText: schedule, bookingDone: false };
    expect(checkReply({ ...empty, reply: '¿Te funciona alguno de estos horarios el lunes?' })).toMatch(
      /no has escrito ninguna/,
    );
    expect(checkReply({ ...empty, reply: 'Tengo estos huecos: jueves 29 a las 9:15. ¿Te va?' })).toBeNull();
  });

  it('convierte markdown a formato de WhatsApp', () => {
    expect(toWhatsApp('## Hola\n**Reunión** el [enlace](https://x.y)')).toBe(
      'Hola\n*Reunión* el enlace: https://x.y',
    );
    expect(
      toWhatsApp('*Lo siento, no puedo dar precios cerrados por WhatsApp. ¿Te reservo una reunión?* 😊'),
    ).toBe('Lo siento, no puedo dar precios cerrados por WhatsApp. ¿Te reservo una reunión? 😊');
    expect(toWhatsApp('Tu cita es el *jueves 29* a las 10:00')).toBe('Tu cita es el *jueves 29* a las 10:00');
  });
});
