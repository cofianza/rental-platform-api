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
// POST /expedientes/:expedienteId/autorizacion-riesgo/enviar-enlace
// ============================================================

// Body opcional: corrige el contacto del solicitante si estaba mal escrito.
// Se persiste en `solicitantes` server-side (así también sirve para el rol
// propietario, que no tiene PATCH de solicitantes) y el enlace va al corregido.
export const enviarEnlaceAutorizacionSchema = z
  .object({
    email: z.string().email('Email invalido').optional(),
    telefono: z.string().max(20).optional(),
  })
  .optional();

// ============================================================
// POST /public/autorizar/:token/firmar
// ============================================================

export const firmarSchema = z.object({
  metodo_firma: z.enum(['canvas', 'otp'], {
    message: 'Metodo de firma invalido. Valores permitidos: canvas, otp',
  }),
  datos_firma: z.string().min(100, 'Firma invalida').max(500000, 'Firma demasiado grande').optional(),
  codigo_otp: z.string().length(6, 'Codigo OTP debe ser de 6 digitos').optional(),
  // Consentimientos opcionales (Paso 2 "Beneficios"). No condicionan el servicio.
  consentimientos_opcionales: z
    .object({
      analitica: z.boolean().optional(),
      comercial: z.boolean().optional(),
      historial_referencia: z.boolean().optional(),
    })
    .optional(),
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
export type EnviarEnlaceAutorizacionInput = z.infer<typeof enviarEnlaceAutorizacionSchema>;
export type FirmarInput = z.infer<typeof firmarSchema>;
export type RevocarInput = z.infer<typeof revocarSchema>;
export type VerificarOtpInput = z.infer<typeof verificarOtpSchema>;
