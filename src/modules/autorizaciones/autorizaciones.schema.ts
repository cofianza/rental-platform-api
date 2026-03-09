import { z } from 'zod';

// ============================================================
// Param schemas
// ============================================================

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.string().uuid('ID de expediente invalido'),
});

export const tokenParamsSchema = z.object({
  token: z.string().min(32, 'Token invalido').max(64, 'Token invalido'),
});

// ============================================================
// POST /public/autorizar/:token/firmar
// ============================================================

export const firmarSchema = z.object({
  metodo_firma: z.enum(['canvas', 'otp'], {
    message: 'Metodo de firma invalido. Valores permitidos: canvas, otp',
  }),
  datos_firma: z.string().min(100, 'Firma invalida').max(500000, 'Firma demasiado grande').optional(),
  codigo_otp: z.string().length(6, 'Codigo OTP debe ser de 6 digitos').optional(),
}).superRefine((data, ctx) => {
  if (data.metodo_firma === 'canvas' && !data.datos_firma) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['datos_firma'],
      message: 'La firma es requerida para el metodo canvas',
    });
  }
  if (data.metodo_firma === 'otp' && !data.codigo_otp) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['codigo_otp'],
      message: 'El codigo OTP es requerido para verificacion por OTP',
    });
  }
});

// ============================================================
// PATCH /expedientes/:expedienteId/autorizacion-riesgo/revocar
// ============================================================

export const revocarSchema = z.object({
  motivo: z.string()
    .min(10, 'El motivo debe tener al menos 10 caracteres')
    .max(1000, 'El motivo no debe exceder 1000 caracteres'),
});

// ============================================================
// POST /public/autorizar/:token/verificar-otp
// ============================================================

export const verificarOtpSchema = z.object({
  codigo: z.string().length(6, 'Codigo debe ser de 6 digitos'),
});

// ============================================================
// Type exports
// ============================================================

export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type TokenParams = z.infer<typeof tokenParamsSchema>;
export type FirmarInput = z.infer<typeof firmarSchema>;
export type RevocarInput = z.infer<typeof revocarSchema>;
export type VerificarOtpInput = z.infer<typeof verificarOtpSchema>;
