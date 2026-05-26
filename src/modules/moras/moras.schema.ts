import { z } from 'zod';

// ============================================================
// Schemas Zod del módulo de Moras (Mario 12-may-2026).
// ============================================================

// Reportar una nueva mora
export const reportarMoraSchema = z.object({
  contrato_id: z.uuid({ error: 'contrato_id inválido' }),
  fecha_vencimiento_canon: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado: YYYY-MM-DD'),
  monto_mora: z.number().int().nonnegative('Monto inválido'),
  descripcion: z.string().max(2000).optional(),
});
export type ReportarMoraInput = z.infer<typeof reportarMoraSchema>;

// Listado / filtros
export const listMorasQuerySchema = z.object({
  estado: z
    .enum(['todas', 'fase_1', 'fase_2', 'fase_3', 'pagada', 'cancelada'])
    .optional()
    .default('todas'),
  contrato_id: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListMorasQuery = z.infer<typeof listMorasQuerySchema>;

// Params
export const moraIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID inválido' }),
});

// Escalar manualmente
export const escalarMoraSchema = z.object({
  // Opcional: notas internas del asesor para la transición
  notas: z.string().max(1000).optional(),
});
export type EscalarMoraInput = z.infer<typeof escalarMoraSchema>;

// Marcar como pagada
export const marcarPagadaSchema = z.object({
  fecha_pago: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado: YYYY-MM-DD')
    .optional(),
  notas: z.string().max(1000).optional(),
});
export type MarcarPagadaInput = z.infer<typeof marcarPagadaSchema>;

// Cancelar
export const cancelarMoraSchema = z.object({
  motivo: z.string().min(1, 'Motivo requerido').max(500),
});
export type CancelarMoraInput = z.infer<typeof cancelarMoraSchema>;

// Mensaje en el chat
export const agregarMensajeSchema = z.object({
  mensaje: z.string().min(1, 'Mensaje requerido').max(2000),
  via_whatsapp: z.boolean().optional().default(false),
});
export type AgregarMensajeInput = z.infer<typeof agregarMensajeSchema>;
