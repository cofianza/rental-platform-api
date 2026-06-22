import { z } from 'zod';

// Token opaco de invitación: 64 hex (crypto.randomBytes(32).toString('hex')).
// Mismo patrón que invitacion/autorizaciones/coarrendatarios.
export const tokenParamSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, { message: 'Token de invitación inválido' }),
});
export type TokenParam = z.infer<typeof tokenParamSchema>;

export const miembroIdParamSchema = z.object({
  id: z.string().uuid({ message: 'ID de miembro inválido' }),
});
export type MiembroIdParam = z.infer<typeof miembroIdParamSchema>;

export const invitarMiembroSchema = z.object({
  email: z
    .string()
    .email({ message: 'Email inválido' })
    .transform((s) => s.toLowerCase().trim()),
  // Se invita como 'miembro' (staff operativo) o 'solo_lectura' (viewer).
  // 'owner' (co-titular) NO se invita: se promueve a un miembro ya activo
  // mediante PATCH /:id/rol, para no crear co-titulares antes de que entren.
  rol_miembro: z.enum(['miembro', 'solo_lectura']).optional().default('miembro'),
});
export type InvitarMiembroInput = z.infer<typeof invitarMiembroSchema>;

// Cambio de rol de un miembro ACTIVO (owner-only). Permite promover a
// co-titular ('owner'), degradar, o pasar a sólo lectura.
export const cambiarRolMiembroSchema = z.object({
  rol_miembro: z.enum(['owner', 'miembro', 'solo_lectura']),
});
export type CambiarRolMiembroInput = z.infer<typeof cambiarRolMiembroSchema>;

// Registro de un invitado que aún NO tiene cuenta. El email NO se pide: sale
// de la invitación (token), para que no se pueda registrar con otro correo.
export const setVenTodoSchema = z.object({
  miembros_ven_todo: z.boolean(),
});
export type SetVenTodoInput = z.infer<typeof setVenTodoSchema>;

export const registrarMiembroSchema = z.object({
  nombre: z.string().trim().min(1, { message: 'El nombre es obligatorio' }).max(100),
  apellido: z.string().trim().min(1, { message: 'El apellido es obligatorio' }).max(100),
  password: z.string().min(8, { message: 'La contraseña debe tener al menos 8 caracteres' }).max(72),
  telefono: z.string().trim().max(20).optional(),
});
export type RegistrarMiembroInput = z.infer<typeof registrarMiembroSchema>;
