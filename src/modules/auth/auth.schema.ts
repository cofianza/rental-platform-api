import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Email invalido'),
  password: z.string().min(1, 'Contrasena requerida'),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token requerido'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Email invalido'),
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

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ResetTokenParams = z.infer<typeof resetTokenParamsSchema>;
