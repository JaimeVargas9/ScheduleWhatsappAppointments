import { DateTime } from 'luxon';
import { z } from 'zod';
import type { BookingService } from '../../booking/service.js';
import type { Db } from '../../db/client.js';
import {
  messagesAfter,
  updateConversation,
  upcomingAppointmentsByPhone,
  userMessagesText,
} from '../../db/repos.js';
import type { Appointment } from '../../db/schema.js';
import { huecoTexto } from '../../scheduling/format.js';
import type { Hueco } from '../../scheduling/slots.js';
import type { TenantConfig } from '../../tenants/schema.js';
import type { ToolDefinition } from '../llm.js';
import {
  ToolError,
  checkClientName,
  checkModalityChosen,
  checkTimeAgreed,
  checkWeekday,
  parseFecha,
  resolveLocation,
  resolveProfessional,
  requestedTime,
  resolveService,
} from './resolve.js';

export type ToolContext = {
  tenant: TenantConfig;
  db: Db;
  booking: BookingService;
  conversationId: number;
  phone: string;
  userText: string;
  handoff: (reason: string) => Promise<void>;
};

const empty = (v: unknown) => v === '' || v === null || v === 'null' || v === 'None';
const optional = z.preprocess((v) => (empty(v) ? undefined : v), z.string().optional());
const optionalBool = z.preprocess(
  (v) => (empty(v) ? undefined : v === 'true' ? true : v === 'false' ? false : v),
  z.boolean().optional(),
);

type Tool = { definition: ToolDefinition; run: (args: unknown, ctx: ToolContext) => Promise<unknown> };

function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>,
): Tool {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return {
    definition: { type: 'function', function: { name, description, parameters } },
    run: async (args, ctx) => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolError(
          'Argumentos no válidos: ' +
            parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      return run(parsed.data, ctx);
    },
  };
}

const huecoPublico = ({ inicio, texto }: Pick<Hueco, 'inicio' | 'texto'>) => ({
  inicio: inicio.slice(0, 16),
  texto,
});

function citaPublica(tenant: TenantConfig, c: Appointment) {
  return {
    id: c.id,
    servicio: c.serviceName,
    cuando: huecoTexto(DateTime.fromISO(c.start).setZone(tenant.zona_horaria)),
    modalidad: c.locationName,
    direccion: c.address || undefined,
    profesional: c.professionalName ?? undefined,
    a_nombre_de: c.clientName,
    estado: c.pendingConfirmation
      ? 'cambiada por el negocio, pendiente de que el cliente confirme'
      : c.status,
  };
}

function repartir(huecos: Hueco[], porDia = 3, maxDias = 4): Hueco[] {
  const dias = new Map<string, Hueco[]>();
  for (const h of huecos) {
    const d = h.inicio.slice(0, 10);
    dias.set(d, [...(dias.get(d) ?? []), h]);
  }
  return [...dias.values()].slice(0, maxDias).flatMap((list) => {
    if (list.length <= porDia) return list;
    return Array.from(
      { length: porDia },
      (_, i) => list[Math.round((i * (list.length - 1)) / (porDia - 1))]!,
    );
  });
}

export const TOOLS: Tool[] = [
  tool(
    'listar_servicios',
    'Lista los servicios con su duración, precio y modalidades.',
    z.object({}),
    async (_a, { tenant }) =>
      tenant.servicios
        .filter((s) => s.activo)
        .map((s) => ({
          servicio: s.nombre,
          duracion_min: s.duracion_min,
          precio: s.precio,
          descripcion: s.descripcion,
          restriccion: s.restriccion,
          modalidades: s.ubicaciones
            .map((id) => tenant.ubicaciones.find((u) => u.id === id && u.activa)?.nombre)
            .filter(Boolean),
        })),
  ),

  tool(
    'consultar_disponibilidad',
    'Consulta huecos libres. Si fecha_desde incluye hora (AAAA-MM-DDTHH:MM) comprueba ese hueco exacto y, si no está libre, devuelve alternativas. Si es solo una fecha (AAAA-MM-DD), devuelve opciones libres entre fecha_desde y fecha_hasta.',
    z.object({
      servicio: z.string().describe('Nombre del servicio'),
      ubicacion: optional.describe('Modalidad o ubicación (opcional)'),
      profesional: optional.describe('Profesional (opcional)'),
      fecha_desde: z.string().describe('AAAA-MM-DD o AAAA-MM-DDTHH:MM en hora local'),
      fecha_hasta: optional.describe('AAAA-MM-DD (opcional)'),
    }),
    async (a, { tenant, booking, userText }) => {
      const now = booking.now(tenant);
      const service = resolveService(tenant, a.servicio);
      const req = {
        service,
        location: resolveLocation(tenant, service, a.ubicacion),
        professional: resolveProfessional(tenant, service, a.profesional),
      };
      const desde = parseFecha(a.fecha_desde, tenant, now);
      checkWeekday(desde.dt, userText);
      const hora = !desde.conHora && !a.fecha_hasta ? requestedTime(userText) : null;
      if (hora) {
        const [h, m] = hora.split(':').map(Number);
        desde.dt = desde.dt.set({ hour: h, minute: m });
        desde.conHora = true;
      }
      if (desde.conHora) {
        const r = await booking.check(tenant, req, desde.dt);
        return r.libre
          ? { libre: true, ...huecoPublico(r), servicio: service.nombre, modalidad: req.location.nombre }
          : {
              libre: false,
              pedido: huecoTexto(desde.dt),
              motivo: r.motivo,
              detalle: r.detalle,
              alternativas: r.alternativas.map(huecoPublico),
            };
      }
      const hasta = a.fecha_hasta ? parseFecha(a.fecha_hasta, tenant, now).dt : desde.dt.plus({ days: 6 });
      const fin = DateTime.min(hasta, desde.dt.plus({ days: 31 }));
      const huecos = await booking.list(tenant, req, desde.dt, fin);
      if (huecos.length) return { huecos: repartir(huecos).map(huecoPublico), total_libres: huecos.length };
      const siguientes = await booking.list(tenant, req, fin.plus({ days: 1 }), fin.plus({ days: 14 }));
      return {
        huecos: [],
        mensaje: 'No hay huecos libres en esas fechas.',
        siguientes_disponibles: repartir(siguientes, 2, 3).map(huecoPublico),
      };
    },
  ),

  tool(
    'crear_cita',
    'Crea la cita cuando el cliente ya ha confirmado servicio, modalidad, día, hora y el nombre a nombre del cual se reserva.',
    z.object({
      servicio: z.string(),
      ubicacion: z.string().describe('Modalidad o ubicación'),
      profesional: optional,
      inicio: z.string().describe('AAAA-MM-DDTHH:MM en hora local'),
      nombre_cliente: z.string().describe('Nombre que ha dicho el cliente para la reserva'),
      notas: optional,
      adicional: optionalBool.describe('true solo si el cliente quiere otra cita además de la que ya tiene'),
    }),
    async (a, { tenant, booking, db, conversationId, phone, userText }) => {
      const now = booking.now(tenant);
      const service = resolveService(tenant, a.servicio);
      const location = resolveLocation(tenant, service, a.ubicacion);
      const professional = resolveProfessional(tenant, service, a.profesional);
      const { dt, conHora } = parseFecha(a.inicio, tenant, now);
      if (!conHora) throw new ToolError('Falta la hora en "inicio". Usa AAAA-MM-DDTHH:MM.');
      checkWeekday(dt, userText);
      const existing = upcomingAppointmentsByPhone(db, tenant.id, phone, now.toUTC().toISO()!).find(
        (c) => c.serviceId === service.id,
      );
      if (existing?.pendingConfirmation && !a.adicional) {
        const r = await booking.reschedule(tenant, existing, dt);
        return r.creada
          ? {
              reprogramada: true,
              cita: citaPublica(tenant, r.cita),
              nota: 'Era la cita que el negocio había cambiado: se ha movido a la hora que ha elegido el cliente, no se ha creado otra.',
            }
          : { reprogramada: false, pedido: huecoTexto(dt), ...r };
      }
      const said = userMessagesText(db, conversationId);
      const options = tenant.ubicaciones.filter((u) => u.activa && service.ubicaciones.includes(u.id));
      checkModalityChosen(service, location, options, said);
      const clientName = checkClientName(a.nombre_cliente, said);
      checkTimeAgreed(dt, messagesAfter(db, conversationId, 0));
      if (existing && !a.adicional) {
        const c = citaPublica(tenant, existing);
        throw new ToolError(
          `El cliente ya tiene la cita ${c.id} (${c.servicio}, ${c.cuando}). Si quiere cambiarla, usa reprogramar_cita con id ${c.id}. Si de verdad quiere otra cita además de esa, confírmalo con él y vuelve a llamar a crear_cita con adicional=true.`,
        );
      }
      const r = await booking.create(tenant, {
        service,
        location,
        professional,
        start: dt,
        phone,
        clientName,
        notes: a.notas,
      });
      if (!r.creada) return { ...r, pedido: huecoTexto(dt) };
      updateConversation(db, conversationId, { clientName });
      return {
        creada: true,
        cita: citaPublica(tenant, r.cita),
        aviso:
          location.tipo === 'videollamada'
            ? 'Dile que el enlace de la videollamada se le enviará antes de la reunión.'
            : undefined,
      };
    },
  ),

  tool(
    'ver_citas_cliente',
    'Muestra las próximas citas de este cliente (por su teléfono).',
    z.object({}),
    async (_a, ctx) => {
      const now = ctx.booking.now(ctx.tenant).toUTC().toISO()!;
      const citas = upcomingAppointmentsByPhone(ctx.db, ctx.tenant.id, ctx.phone, now);
      return { citas: citas.map((c) => citaPublica(ctx.tenant, c)) };
    },
  ),

  tool(
    'cancelar_cita',
    'Cancela una cita del cliente. Usa antes ver_citas_cliente para saber el id.',
    z.object({ id: z.string().describe('ID de la cita, p. ej. C-AB12CD') }),
    async (a, { tenant, booking, phone }) => {
      const cita = await booking.cancel(tenant, booking.findForClient(tenant, phone, a.id));
      return { cancelada: true, cita: citaPublica(tenant, cita) };
    },
  ),

  tool(
    'reprogramar_cita',
    'Mueve una cita del cliente a otra fecha y hora. Comprueba antes la disponibilidad.',
    z.object({ id: z.string(), nuevo_inicio: z.string().describe('AAAA-MM-DDTHH:MM en hora local') }),
    async (a, { tenant, booking, phone, userText }) => {
      const cita = booking.findForClient(tenant, phone, a.id);
      const { dt, conHora } = parseFecha(a.nuevo_inicio, tenant, booking.now(tenant));
      if (!conHora) throw new ToolError('Falta la hora en "nuevo_inicio". Usa AAAA-MM-DDTHH:MM.');
      checkWeekday(dt, userText);
      const r = await booking.reschedule(tenant, cita, dt);
      return r.creada
        ? { reprogramada: true, cita: citaPublica(tenant, r.cita) }
        : { reprogramada: false, pedido: huecoTexto(dt), ...r };
    },
  ),

  tool(
    'confirmar_cita',
    'El cliente acepta la nueva fecha y hora de una cita que el negocio le ha cambiado (estado pendiente de confirmar).',
    z.object({ id: z.string().describe('ID de la cita, p. ej. C-AB12CD') }),
    async (a, { tenant, booking, phone }) => {
      const cita = booking.findForClient(tenant, phone, a.id);
      if (!cita.pendingConfirmation)
        return { confirmada: true, cita: citaPublica(tenant, cita), nota: 'Ya estaba confirmada.' };
      return { confirmada: true, cita: citaPublica(tenant, await booking.confirm(tenant, cita)) };
    },
  ),

  tool(
    'derivar_a_humano',
    'Pasa la conversación al responsable del negocio. El bot dejará de responder en este chat.',
    z.object({ motivo: z.string() }),
    async (a, ctx) => {
      await ctx.handoff(a.motivo);
      return { derivado: true, instrucciones: 'Dile al cliente que el responsable le contactará en breve.' };
    },
  ),
];

export const TOOL_DEFINITIONS = TOOLS.map((t) => t.definition);

export async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<string> {
  const t = TOOLS.find((x) => x.definition.function.name === name);
  try {
    if (!t) throw new ToolError(`La herramienta "${name}" no existe.`);
    return JSON.stringify(await t.run(args, ctx));
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}
