import { z } from 'zod';
import { passwordSchema } from '../registration/registration.schema';

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

// ── Administración de plataforma (rol administrador) ──────────
export const adminOrgParamSchema = z.object({
  orgId: z.string().uuid({ message: 'ID de inmobiliaria inválido' }),
});
export type AdminOrgParam = z.infer<typeof adminOrgParamSchema>;

// Contratos V3 §7.2: modalidad de la fianza que fija el convenio (null = no fija).
export const adminActualizarOrgSchema = z
  .object({
    modalidad_fianza_defecto: z.enum(['trasladada', 'tradicional']).nullable(),
  })
  .strict();
export type AdminActualizarOrgInput = z.infer<typeof adminActualizarOrgSchema>;

export const adminOrgMiembroParamsSchema = z.object({
  orgId: z.string().uuid({ message: 'ID de inmobiliaria inválido' }),
  miembroId: z.string().uuid({ message: 'ID de miembro inválido' }),
});
export type AdminOrgMiembroParams = z.infer<typeof adminOrgMiembroParamsSchema>;

// Registro de un invitado que aún NO tiene cuenta. El email NO se pide: sale
// de la invitación (token), para que no se pueda registrar con otro correo.
export const setVenTodoSchema = z.object({
  miembros_ven_todo: z.boolean(),
});
export type SetVenTodoInput = z.infer<typeof setVenTodoSchema>;

export const registrarMiembroSchema = z.object({
  nombre: z.string().trim().min(1, { message: 'El nombre es obligatorio' }).max(100),
  apellido: z.string().trim().min(1, { message: 'El apellido es obligatorio' }).max(100),
  password: passwordSchema.max(72),
  // El telefono es obligatorio: es el WhatsApp de contacto del miembro y el
  // respaldo para la firma de contratos. Sin el, el perfil queda incompleto.
  telefono: z
    .string()
    .trim()
    .min(7, { message: 'El teléfono es obligatorio (con código de país, ej. +57…)' })
    .max(20),
});
export type RegistrarMiembroInput = z.infer<typeof registrarMiembroSchema>;
