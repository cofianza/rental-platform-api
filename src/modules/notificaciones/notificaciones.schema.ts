import { z } from 'zod';

export const listNotificacionesQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  // Filtra solo no-leidas. Util para renderizar el dropdown del campanario
  // sin traer el historial completo.
  solo_no_leidas: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export type ListNotificacionesQuery = z.infer<typeof listNotificacionesQuerySchema>;

export const notificacionIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type NotificacionIdParams = z.infer<typeof notificacionIdParamsSchema>;
