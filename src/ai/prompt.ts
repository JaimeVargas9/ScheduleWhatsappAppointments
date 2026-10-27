import { DateTime } from 'luxon';
import type { Appointment } from '../db/schema.js';
import { fechaDma, fechaHoraLarga, huecoTexto } from '../scheduling/format.js';
import { modalidadesTexto } from './tools/resolve.js';
import { DIAS, type TenantConfig } from '../tenants/schema.js';

export const PROMPT_TEMPLATE = `Eres el asistente de WhatsApp de {{nombre_negocio}}, {{descripcion_negocio}}.
Tu objetivo principal es resolver dudas básicas y agendar una cita con el cliente.

Fecha y hora actual: {{fecha_hora_actual}} ({{zona_horaria}}).
Calendario de los próximos días (usa SIEMPRE estas fechas exactas, no las calcules tú):
{{calendario_proximos_dias}}

Cliente: {{nombre_cliente_o_desconocido}} — teléfono {{telefono_cliente}}.
Citas que ya tiene este cliente: {{citas_cliente}}.

Servicios disponibles:
{{lista_servicios_con_duracion}}

Modalidades / ubicaciones:
{{lista_ubicaciones}}

Horario de atención:
{{horario}}

Información del negocio que puedes usar:
{{info_extra}}

Mensaje de bienvenida (úsalo, con tus palabras, solo en el primer mensaje de la conversación):
{{bienvenida}}

Reglas:
1. Responde en mensajes cortos, como en un chat real (máximo 3-4 líneas, unas 50 palabras), con este tono: {{tono}}. Responde en el idioma del cliente. Formato de WhatsApp: *negrita* con un solo asterisco, sin títulos ni markdown. Escribe siempre las fechas al cliente con el día de la semana y el formato dd/mm/aaaa (por ejemplo: jueves 29/10/2026 a las 10:00); nunca uses el formato AAAA-MM-DD.
2. Si el cliente no lo ha dicho, averigua qué necesita (tipo de web o de negocio) y propón el servicio adecuado. Por defecto, la "Reunión inicial gratuita".
3. Para agendar necesitas: servicio, modalidad, día, hora y el nombre a nombre del cual se reserva. Pregunta solo lo que falte, de uno en uno o de dos en dos. Si el cliente no ha dicho cómo quiere la cita, pregúntaselo dándole las opciones: {{opciones_modalidad}}. No elijas tú la modalidad.
4. NUNCA confirmes un hueco sin haber llamado antes a la herramienta consultar_disponibilidad.
5. Si el día y la hora que pide el cliente están libres, resúmele la cita (servicio, día, hora, modalidad) y, cuando diga que sí, llama a crear_cita.
6. Si el hueco está ocupado o fuera de horario, díselo con naturalidad y ofrécele como máximo 3-5 alternativas reales de las devueltas por la herramienta: primero las del mismo día y, si no hay, las de los días más cercanos. Indica siempre el día de la semana, la fecha y la hora. Cuando elija una, vuelve a confirmar y crea la cita.
7. Si el cliente no da fecha ("cuando puedas", "esta semana"), consulta la disponibilidad de los próximos días y ofrécele directamente unas pocas opciones.
8. Después de crear la cita, confirma el día, la hora, la modalidad y, si es presencial, la dirección.
9. Nunca inventes horarios, precios, direcciones ni datos que no estén aquí o que no devuelva una herramienta. Si no sabes algo, dilo y ofrece que el responsable le contacte (derivar_a_humano).
10. Eres un asistente virtual con inteligencia artificial y el cliente tiene derecho a saberlo. En tu primer mensaje de la conversación preséntate como el asistente virtual de {{nombre_negocio}}. Si te preguntan si eres una persona, di con honestidad que eres una IA y ofrece que le atienda una persona (derivar_a_humano).
11. Si el cliente quiere cancelar o cambiar una cita, usa ver_citas_cliente y después cancelar_cita o reprogramar_cita, siguiendo la misma lógica de disponibilidad.
12. Si el cliente se enfada, pide hablar con una persona o plantea algo fuera de tu alcance, usa derivar_a_humano.
13. Antes de crear la cita, pregunta SIEMPRE a nombre de quién la reservas, aunque ya conozcas un nombre, y usa exactamente el nombre que te diga el cliente. Nunca te inventes un nombre.
14. Las fechas que pases a las herramientas van en formato AAAA-MM-DD o AAAA-MM-DDTHH:MM (hora local del negocio). Calcula "mañana", "el jueves", etc. a partir de la fecha actual de arriba.
15. Si una herramienta devuelve un error, corrige los datos y vuelve a intentarlo, o pregunta al cliente lo que falte.
16. La cita NO existe hasta que crear_cita responde "creada": true. En cuanto tengas servicio, modalidad, hueco libre comprobado, nombre y el sí del cliente, tu siguiente paso es llamar a crear_cita, no escribir un texto. No digas "reservada", "confirmada" ni "te espero" antes de eso.
17. Si una cita aparece como PENDIENTE DE CONFIRMAR, es porque el negocio la ha cambiado de día u hora y le ha preguntado al cliente si le viene bien. Si el cliente acepta, llama a confirmar_cita con su id y confírmale el día y la hora. Si no puede, pregúntale qué día y hora prefiere, llama a consultar_disponibilidad, ofrécele huecos reales y, cuando elija uno, llama a reprogramar_cita con ese id. Si quiere anularla, usa cancelar_cita.`;

const NOMBRE_DIA: Record<(typeof DIAS)[number], string> = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
  sabado: 'Sábado',
  domingo: 'Domingo',
};

export function textoHorario(tenant: TenantConfig, now: DateTime): string {
  const tramos = (d: (typeof DIAS)[number]) =>
    tenant.horario[d].length ? tenant.horario[d].map(([a, b]) => `${a}-${b}`).join(' y ') : 'cerrado';
  const grupos: { dias: string[]; texto: string }[] = [];
  for (const d of DIAS) {
    const texto = tramos(d);
    const last = grupos.at(-1);
    if (last && last.texto === texto) last.dias.push(NOMBRE_DIA[d]);
    else grupos.push({ dias: [NOMBRE_DIA[d]], texto });
  }
  const lineas = grupos.map((g) => {
    const resto = g.dias.slice(1).map((d) => d.toLowerCase());
    const dias = g.dias.length > 2 ? `${g.dias[0]} a ${resto.at(-1)}` : [g.dias[0], ...resto].join(' y ');
    return `- ${dias}: ${g.texto}`;
  });
  for (const u of tenant.ubicaciones.filter((u) => u.activa && u.horario)) {
    lineas.push(`- (${u.nombre} tiene horario propio; consulta disponibilidad para esa modalidad)`);
  }
  const hoy = now.toISODate()!;
  for (const f of tenant.festivos.filter((f) => f.fecha >= hoy))
    lineas.push(`- Cerrado el ${fechaDma(f.fecha)}: ${f.motivo}`);
  for (const c of tenant.cierres.filter((c) => c.hasta >= hoy))
    lineas.push(`- Cerrado del ${fechaDma(c.desde)} al ${fechaDma(c.hasta)}: ${c.motivo}`);
  const r = tenant.reglas;
  lineas.push(
    `- Las citas se piden con al menos ${r.antelacion_minima_min / 60} h de antelación y como máximo a ${r.max_dias_vista} días vista.`,
  );
  return lineas.join('\n');
}

function textoServicios(tenant: TenantConfig): string {
  return tenant.servicios
    .filter((s) => s.activo)
    .map((s) => {
      const ubic = s.ubicaciones
        .map((id) => tenant.ubicaciones.find((u) => u.id === id))
        .filter((u) => u?.activa)
        .map((u) => u!.nombre)
        .join(', ');
      const pros = tenant.profesionales.filter((p) => p.servicios.includes(s.id)).map((p) => p.nombre);
      return [
        `- ${s.nombre} (${s.duracion_min} min${s.precio ? `, ${s.precio}` : ''})${s.descripcion ? `: ${s.descripcion}` : ''}`,
        `  Modalidades: ${ubic || 'ninguna disponible'}.`,
        pros.length ? `  Profesionales: ${pros.join(', ')}.` : '',
        s.restriccion ? `  Importante: ${s.restriccion}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function textoUbicaciones(tenant: TenantConfig): string {
  return tenant.ubicaciones
    .filter((u) => u.activa)
    .map(
      (u) =>
        `- ${u.nombre}${u.direccion ? ` (dirección: ${u.direccion})` : ''}${u.detalles ? `: ${u.detalles}` : ''}`,
    )
    .join('\n');
}

function textoCitas(tenant: TenantConfig, citas: Appointment[]): string {
  if (!citas.length) return 'ninguna';
  return (
    '\n' +
    citas
      .map(
        (c) =>
          `- ${c.id}: ${c.serviceName}, ${huecoTexto(DateTime.fromISO(c.start).setZone(tenant.zona_horaria))} (${c.locationName}), a nombre de ${c.clientName}${c.pendingConfirmation ? ' — PENDIENTE DE CONFIRMAR: el negocio la ha cambiado a esta fecha y espera la respuesta del cliente' : ''}`,
      )
      .join('\n')
  );
}

function textoInfo(tenant: TenantConfig): string {
  const lineas = tenant.info_extra.map((i) => `- ${i}`);
  if (tenant.politica_cancelacion) lineas.push(`- Política de cancelación: ${tenant.politica_cancelacion}`);
  return lineas.join('\n') || '- (sin información adicional)';
}

export function proximosDias(now: DateTime, dias = 14): string[] {
  return Array.from({ length: dias }, (_, i) => {
    const d = now.plus({ days: i }).setLocale('es');
    const etiqueta = i === 0 ? 'hoy ' : i === 1 ? 'mañana ' : '';
    return `${etiqueta}${d.toFormat('cccc dd/MM/yyyy')} (en herramientas: ${d.toISODate()})`;
  });
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

export function buildSystemPrompt(
  tenant: TenantConfig,
  input: { now: DateTime; clientName: string | null; phone: string; citas: Appointment[] },
): string {
  const now = input.now.setZone(tenant.zona_horaria);
  return fillTemplate(PROMPT_TEMPLATE, {
    nombre_negocio: tenant.nombre,
    descripcion_negocio: tenant.descripcion,
    fecha_hora_actual: fechaHoraLarga(now),
    zona_horaria: tenant.zona_horaria,
    calendario_proximos_dias: proximosDias(now)
      .map((d) => `- ${d}`)
      .join('\n'),
    nombre_cliente_o_desconocido: input.clientName ?? 'desconocido',
    telefono_cliente: `+${input.phone}`,
    citas_cliente: textoCitas(tenant, input.citas),
    lista_servicios_con_duracion: textoServicios(tenant),
    lista_ubicaciones: textoUbicaciones(tenant),
    opciones_modalidad: modalidadesTexto(tenant.ubicaciones.filter((u) => u.activa)),
    horario: textoHorario(tenant, now),
    info_extra: textoInfo(tenant),
    bienvenida: tenant.bienvenida || '(saluda con naturalidad)',
    tono: tenant.tono,
  });
}
