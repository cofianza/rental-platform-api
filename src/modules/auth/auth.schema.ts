import { z } from 'zod';

export const loginSchema = z.object({
  email: z.email({ error: 'Email invalido' }),
  password: z.string().min(1, 'Contrasena requerida'),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token requerido'),
});

export const forgotPasswordSchema = z.object({
  email: z.email({ error: 'Email invalido' }),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token requerido'),
  password: z
    .string()
    .min(8, 'La contrasena debe tener al menos 8 caracteres')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'La contrasena debe contener al menos 1 mayuscula, 1 minuscula y 1 numero',
    ),
});

export const resetTokenParamsSchema = z.object({
  token: z.string().min(1, 'Token requerido'),
});

// Mi cuenta — el usuario edita su propio perfil. Si rol='solicitante', tambien
// se sincronizan los campos correspondientes en la tabla `solicitantes`.
// Email es read-only (cambiarlo requiere flow de re-verificacion de Supabase
// Auth, fuera del MVP).
export const updateMyProfileSchema = z.object({
  nombre: z.string().trim().min(2, 'Mínimo 2 caracteres').max(100, 'Máximo 100 caracteres'),
  apellido: z.string().trim().min(2, 'Mínimo 2 caracteres').max(100, 'Máximo 100 caracteres'),
  // E.164 simple: opcional `+`, 7-15 digitos. La UI compone +<lada><numero>.
  telefono: z
    .string()
    .trim()
    .regex(/^\+?\d{7,15}$/, 'Teléfono inválido (incluye lada, ej: +573001234567)')
    .nullish()
    .transform((v) => (v == null || v === '' ? null : v)),
  tipo_documento: z.enum(['cc', 'ce', 'nit', 'pasaporte']).nullish(),
  numero_documento: z
    .string()
    .trim()
    .min(3, 'Mínimo 3 caracteres')
    .max(20, 'Máximo 20 caracteres')
    .nullish()
    .transform((v) => (v == null || v === '' ? null : v)),
  // Solo aplica para rol='inmobiliaria'. Se ignora si llega de otros roles.
  nombre_representante: z
    .string()
    .trim()
    .max(200, 'Máximo 200 caracteres')
    .nullish()
    .transform((v) => (v == null || v === '' ? null : v)),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ResetTokenParams = z.infer<typeof resetTokenParamsSchema>;
export type UpdateMyProfileInput = z.infer<typeof updateMyProfileSchema>;
