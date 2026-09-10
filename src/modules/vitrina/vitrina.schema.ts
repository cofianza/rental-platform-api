// ============================================================
// Vitrina Publica — Schemas (HP-368)
// Zod validation for solicitante registration & interest
// ============================================================

import { z } from 'zod';

export const registerSolicitanteSchema = z.object({
  nombre: z.string().min(1, 'Nombre es requerido').max(100),
  apellido: z.string().min(1, 'Apellido es requerido').max(100),
  email: z.string().email('Email inválido'),
  telefono: z.string().min(10, 'Teléfono debe tener al menos 10 dígitos').max(20, 'Teléfono muy largo'),
  tipo_documento: z.enum(['cc', 'ce', 'pasaporte', 'nit']),
  numero_documento: z.string().min(1, 'Número de documento es requerido').max(20),
  // Municipio (código DANE 5 dígitos). Opcional en el registro: se pide
  // al momento de facturar el estudio crediticio (form de pago) para no
  // alargar el formulario de alta. Cuando se envía debe respetar el formato.
  municipio_id: z
    .string()
    .regex(/^\d{5}$/, 'Código DANE debe tener 5 dígitos')
    .optional(),
  municipio_nombre: z.string().min(1).max(120).optional(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  confirm_password: z.string().min(8),
  accept_terms: z.literal(true, {
    message: 'Debe aceptar los terminos y condiciones',
  }),
  accept_data_treatment: z.literal(true, {
    message: 'Debe aceptar el tratamiento de datos',
  }),
  property_interest_id: z.string().uuid().optional(),
  // Si true, el registro proviene del flujo de invitación externa.
  // Setea registration_source='invitacion_externa' para distinguir estadísticas
  // de origen (vitrina pública vs invitación directa de inmobiliaria).
  from_invitation: z.boolean().optional(),
}).refine((data) => data.password === data.confirm_password, {
  message: 'Las contraseñas no coinciden',
  path: ['confirm_password'],
});

export const interestSchema = z.object({
  property_id: z.string().uuid('ID de inmueble inválido'),
});

export type RegisterSolicitanteInput = z.infer<typeof registerSolicitanteSchema>;
export type InterestInput = z.infer<typeof interestSchema>;
