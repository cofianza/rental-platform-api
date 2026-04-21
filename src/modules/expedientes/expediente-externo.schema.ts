import { z } from 'zod';

// ============================================================
// Crear Expediente Externo (invitacion)
// ============================================================

export const crearExpedienteExternoSchema = z.object({
  inmueble_id: z.string().uuid({ message: 'ID de inmueble invalido' }),
  email_invitacion: z.string().email({ message: 'Email de invitacion invalido' }),
  notas: z.string().max(500, { message: 'Notas no deben exceder 500 caracteres' }).optional(),
});

export type CrearExpedienteExternoInput = z.infer<typeof crearExpedienteExternoSchema>;

// ============================================================
// Vincular Expediente Externo (token)
// ============================================================

export const vincularExpedienteExternoSchema = z.object({
  token: z.string().min(1, { message: 'Token es requerido' }),
});

export type VincularExpedienteExternoInput = z.infer<typeof vincularExpedienteExternoSchema>;
