import { z } from 'zod';

// ============================================================
// Enums matching DB
// ============================================================

const TIPOS_ESTUDIO = ['individual', 'con_coarrendatario'] as const;
const PROVEEDORES_ESTUDIO = ['transunion', 'sifin', 'datacredito'] as const;
const PAGO_POR_OPTIONS = ['inmobiliaria', 'arrendatario'] as const;

// ============================================================
// Param schemas
// ============================================================

export const estudioIdParamsSchema = z.object({
  estudioId: z.string().uuid('ID de estudio invalido'),
});

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.string().uuid('ID de expediente invalido'),
});

export const tokenParamsSchema = z.object({
  token: z.string().min(32, 'Token invalido').max(64, 'Token invalido'),
});

// ============================================================
// POST /expedientes/:expedienteId/estudios
// ============================================================

export const createEstudioSchema = z.object({
  tipo: z.enum(TIPOS_ESTUDIO, {
    message: `Tipo de estudio invalido. Valores permitidos: ${TIPOS_ESTUDIO.join(', ')}`,
  }),
  proveedor: z.enum(PROVEEDORES_ESTUDIO, {
    message: `Proveedor invalido. Valores permitidos: ${PROVEEDORES_ESTUDIO.join(', ')}`,
  }),
  duracion_contrato_meses: z.coerce
    .number()
    .int('Debe ser un numero entero')
    .min(1, 'Minimo 1 mes')
    .max(60, 'Maximo 60 meses'),
  pago_por: z.enum(PAGO_POR_OPTIONS, {
    message: `Pago por invalido. Valores permitidos: ${PAGO_POR_OPTIONS.join(', ')}`,
  }),
  observaciones: z.string().max(2000, 'Observaciones no deben exceder 2000 caracteres').optional(),
});

// ============================================================
// GET /expedientes/:expedienteId/estudios
// ============================================================

export const listEstudiosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

// ============================================================
// POST /public/estudios/:token/formulario
// ============================================================

export const submitFormularioSchema = z.object({
  nombre_completo: z.string().min(2, 'Nombre es requerido').max(200),
  tipo_documento: z.string().min(2, 'Tipo de documento es requerido').max(20),
  numero_documento: z.string().min(3, 'Numero de documento es requerido').max(30),
  email: z.string().email('Email invalido'),
  telefono: z.string().min(7, 'Telefono invalido').max(20),
  ingresos_mensuales: z.coerce.number().positive('Ingresos deben ser positivos').optional(),
  ocupacion: z.string().max(100).optional(),
  empresa: z.string().max(200).optional(),
  direccion_residencia: z.string().max(300).optional(),
  acepta_terminos: z.literal(true, { message: 'Debe aceptar los terminos y condiciones' }),
});

// ============================================================
// PATCH /estudios/:estudioId/resultado
// ============================================================

const RESULTADOS_FINALES = ['aprobado', 'rechazado', 'condicionado'] as const;

export const registrarResultadoSchema = z.object({
  resultado: z.enum(RESULTADOS_FINALES, {
    message: `Resultado invalido. Valores permitidos: ${RESULTADOS_FINALES.join(', ')}`,
  }),
  score: z.coerce
    .number()
    .int('El score debe ser un numero entero')
    .min(0, 'El score minimo es 0')
    .max(999, 'El score maximo es 999')
    .optional(),
  observaciones: z
    .string()
    .min(10, 'Las observaciones deben tener al menos 10 caracteres')
    .max(3000, 'Las observaciones no deben exceder 3000 caracteres'),
  motivo_rechazo: z.string().min(10, 'El motivo debe tener al menos 10 caracteres').max(2000).optional(),
  condiciones: z.string().min(10, 'Las condiciones deben tener al menos 10 caracteres').max(2000).optional(),
  certificado_storage_key: z.string().max(500).optional(),
}).superRefine((data, ctx) => {
  if (data.resultado === 'rechazado' && !data.motivo_rechazo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['motivo_rechazo'],
      message: 'El motivo de rechazo es requerido cuando el resultado es rechazado',
    });
  }
  if (data.resultado === 'condicionado' && !data.condiciones) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['condiciones'],
      message: 'Las condiciones son requeridas cuando el resultado es condicionado',
    });
  }
});

// ============================================================
// POST /estudios/:estudioId/certificado/presigned-url
// ============================================================

export const certificadoPresignedUrlSchema = z.object({
  nombre_original: z.string().min(1, 'Nombre es requerido').max(255),
  tamano_bytes: z.coerce.number().int().positive().max(20 * 1024 * 1024, 'Maximo 20MB'),
});

// ============================================================
// Type exports
// ============================================================

export type EstudioIdParams = z.infer<typeof estudioIdParamsSchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type TokenParams = z.infer<typeof tokenParamsSchema>;
export type CreateEstudioInput = z.infer<typeof createEstudioSchema>;
export type ListEstudiosQuery = z.infer<typeof listEstudiosQuerySchema>;
export type SubmitFormularioInput = z.infer<typeof submitFormularioSchema>;
export type RegistrarResultadoInput = z.infer<typeof registrarResultadoSchema>;
export type CertificadoPresignedUrlInput = z.infer<typeof certificadoPresignedUrlSchema>;
