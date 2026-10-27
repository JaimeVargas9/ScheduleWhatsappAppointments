import { z } from 'zod';

export const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'] as const;
export type Dia = (typeof DIAS)[number];

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:MM');
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Solo minúsculas, números y guiones');
const telefono = z
  .string()
  .transform((s) => s.replace(/\D/g, ''))
  .pipe(z.string().min(8, 'Teléfono en formato internacional, p. ej. 34600111222'));

const tramo = z
  .tuple([hora, hora])
  .refine(([a, b]) => a < b, 'La hora de inicio debe ser anterior a la de fin');

const horarioSemanal = z.object(
  Object.fromEntries(DIAS.map((d) => [d, z.array(tramo).default([])])) as Record<
    Dia,
    z.ZodDefault<z.ZodArray<typeof tramo>>
  >,
);
export type HorarioSemanal = z.infer<typeof horarioSemanal>;

const ubicacion = z.object({
  id: slug,
  nombre: z.string().min(1),
  tipo: z.enum(['videollamada', 'telefono', 'presencial']),
  direccion: z.string().default(''),
  detalles: z.string().default(''),
  activa: z.boolean().default(true),
  horario: horarioSemanal.optional(),
});

const servicio = z.object({
  id: slug,
  nombre: z.string().min(1),
  duracion_min: z.number().int().min(5).max(600),
  precio: z.string().optional(),
  descripcion: z.string().default(''),
  restriccion: z.string().optional(),
  ubicaciones: z.array(slug).min(1),
  activo: z.boolean().default(true),
});

const profesional = z.object({
  id: slug,
  nombre: z.string().min(1),
  servicios: z.array(slug).min(1),
  calendar_id: z.string().optional(),
});

export const tenantConfigSchema = z
  .object({
    id: slug,
    nombre: z.string().min(1),
    descripcion: z.string().min(1),
    tono: z.string().min(1),
    idioma: z.string().default('es-ES'),
    bienvenida: z.string().default(''),
    zona_horaria: z
      .string()
      .default('Europe/Madrid')
      .refine(
        (tz) => Intl.supportedValuesOf('timeZone').includes(tz) || tz === 'UTC',
        'Zona horaria desconocida',
      ),
    activo: z.boolean().default(true),
    modo: z.enum(['test', 'live']).default('test'),
    numeros_prueba: z.array(telefono).default([]),
    responsable: z.object({
      nombre: z.string().default(''),
      telefono: telefono.or(z.literal('')).default(''),
    }),
    ubicaciones: z.array(ubicacion).min(1),
    servicios: z.array(servicio).min(1),
    profesionales: z.array(profesional).default([]),
    horario: horarioSemanal,
    festivos: z.array(z.object({ fecha, motivo: z.string().default('Festivo') })).default([]),
    cierres: z
      .array(z.object({ desde: fecha, hasta: fecha, motivo: z.string().default('Cerrado') }))
      .default([]),
    reglas: z.object({
      antelacion_minima_min: z.number().int().min(0).default(120),
      max_dias_vista: z.number().int().min(1).max(365).default(30),
      margen_entre_citas_min: z.number().int().min(0).max(240).default(15),
    }),
    google: z.object({
      calendar_id: z.string().default(''),
      spreadsheet_id: z
        .string()
        .default('')
        .transform((s) => s.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] ?? s.trim()),
      pestana: z.string().default('Citas'),
    }),
    info_extra: z.array(z.string()).default([]),
    politica_cancelacion: z.string().default(''),
    pendientes: z.array(z.string()).default([]),
  })
  .superRefine((t, ctx) => {
    const ubic = new Set(t.ubicaciones.map((u) => u.id));
    const serv = new Set(t.servicios.map((s) => s.id));
    t.ubicaciones.forEach((u, i) => {
      if (u.tipo === 'presencial' && u.activa && !u.direccion.trim())
        ctx.addIssue({
          code: 'custom',
          path: ['ubicaciones', i, 'direccion'],
          message: 'para atender en persona hace falta poner la dirección',
        });
    });
    t.servicios.forEach((s, i) =>
      s.ubicaciones.forEach((u) => {
        if (!ubic.has(u))
          ctx.addIssue({
            code: 'custom',
            path: ['servicios', i, 'ubicaciones'],
            message: `Ubicación "${u}" no existe`,
          });
      }),
    );
    t.profesionales.forEach((p, i) =>
      p.servicios.forEach((s) => {
        if (!serv.has(s))
          ctx.addIssue({
            code: 'custom',
            path: ['profesionales', i, 'servicios'],
            message: `Servicio "${s}" no existe`,
          });
      }),
    );
  });

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
export type Ubicacion = TenantConfig['ubicaciones'][number];
export type Servicio = TenantConfig['servicios'][number];
export type Profesional = TenantConfig['profesionales'][number];

export function parseTenantConfig(input: unknown): TenantConfig {
  const r = tenantConfigSchema.safeParse(input);
  if (!r.success) {
    throw new Error(
      'Configuración de negocio inválida:\n' +
        r.error.issues.map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`).join('\n'),
    );
  }
  return r.data;
}
