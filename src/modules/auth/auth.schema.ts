import { z } from 'zod';
import { registerSolicitanteBase } from '../vitrina/vitrina.schema';

export const loginSchema = z.object({
  email: z.email({ error: 'Email inválido' }),
  password: z.string().min(1, 'Contraseña requerida'),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token requerido'),
});

export const forgotPasswordSchema = z.object({
  email: z.email({ error: 'Email inválido' }),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token requerido'),
  password: z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'La contraseña debe contener al menos 1 mayúscula, 1 minúscula y 1 número',
    ),
});

// Enlace mágico (H44). `datos` solo se usa si el invitado aún no tiene cuenta
// (se le crea como arrendatario, sin contraseña); si ya la tiene, se ignora.
// Sin documento (M7): quien pide el enlace aún no probó que el correo es suyo;
// el documento se pide después, como en el registro liviano (H43). Si llega,
// zod lo descarta.
export const enlaceMagicoSchema = z.object({
  email: z.email({ error: 'Email inválido' }).max(255),
  datos: registerSolicitanteBase
    .pick({
      nombre: true, apellido: true, telefono: true,
      municipio_id: true, municipio_nombre: true, accept_terms: true, accept_data_treatment: true,
    })
    .optional(),
});

// token_hash de Supabase (hex). Solo llega por POST, nunca en la URL de la API.
export const verificarEnlaceMagicoSchema = z.object({
  token_hash: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, 'Enlace inválido'),
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
  tipo_documento: z.enum(['cc', 'ce', 'ppt', 'pep', 'ti', 'nit', 'pasaporte']).nullish(),
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
export type EnlaceMagicoInput = z.infer<typeof enlaceMagicoSchema>;
export type VerificarEnlaceMagicoInput = z.infer<typeof verificarEnlaceMagicoSchema>;
export type ResetTokenParams = z.infer<typeof resetTokenParamsSchema>;
export type UpdateMyProfileInput = z.infer<typeof updateMyProfileSchema>;
