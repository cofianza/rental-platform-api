import { z } from 'zod';

// HH:MM 24h
const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const horarioDiaSchema = z
  .object({
    dia_semana: z.number().int().min(0).max(6),
    hora_inicio: z.string().regex(HORA_REGEX, 'hora_inicio debe ser HH:MM (24h)'),
    hora_fin: z.string().regex(HORA_REGEX, 'hora_fin debe ser HH:MM (24h)'),
    activo: z.boolean().optional().default(true),
  })
  .refine((v) => v.hora_fin > v.hora_inicio, {
    message: 'hora_fin debe ser mayor que hora_inicio',
    path: ['hora_fin'],
  });

export const upsertDisponibilidadSchema = z
  .object({
    slot_duracion_minutos: z.union([z.literal(30), z.literal(60), z.literal(120)]).default(60),
    antelacion_minima_horas: z.number().int().min(0).max(168).default(24),
    horarios: z.array(horarioDiaSchema).max(7),
  })
  .refine(
    (v) => {
      const dias = v.horarios.map((h) => h.dia_semana);
      return new Set(dias).size === dias.length;
    },
    { message: 'dia_semana duplicado en horarios', path: ['horarios'] },
  );

// Params para /:propietarioId (admin)
export const propietarioIdParamsSchema = z.object({
  propietarioId: z.string().uuid('propietarioId inválido'),
});

// Query para /slots
export const slotsQuerySchema = z
  .object({
    inmueble_id: z.string().uuid('inmueble_id inválido'),
    desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'desde debe ser YYYY-MM-DD'),
    hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'hasta debe ser YYYY-MM-DD'),
  })
  .refine(
    (v) => {
      const d = new Date(v.desde + 'T00:00:00Z');
      const h = new Date(v.hasta + 'T00:00:00Z');
      const diff = (h.getTime() - d.getTime()) / 86_400_000;
      return diff >= 0 && diff <= 30;
    },
    { message: 'Rango inválido: hasta >= desde, máximo 30 días', path: ['hasta'] },
  );

export type UpsertDisponibilidadInput = z.infer<typeof upsertDisponibilidadSchema>;
export type PropietarioIdParams = z.infer<typeof propietarioIdParamsSchema>;
export type SlotsQuery = z.infer<typeof slotsQuerySchema>;
