// ============================================================
// Vitrina Publica — Schemas (HP-368)
// Zod validation for solicitante registration & interest
// ============================================================

import { z } from 'zod';

export const registerSolicitanteSchema = z.object({
  nombre: z.string().min(1, 'Nombre es requerido').max(100),
  apellido: z.string().min(1, 'Apellido es requerido').max(100),
  email: z.string().email('Email invalido'),
  telefono: z.string().min(10, 'Telefono debe tener al menos 10 digitos').max(15),
  tipo_documento: z.enum(['cc', 'ce', 'ti', 'pasaporte', 'nit']),
  numero_documento: z.string().min(1, 'Numero de documento es requerido').max(20),
  password: z.string().min(8, 'La contrasena debe tener al menos 8 caracteres'),
  confirm_password: z.string().min(8),
  accept_terms: z.literal(true, {
    message: 'Debe aceptar los terminos y condiciones',
  }),
  accept_data_treatment: z.literal(true, {
    message: 'Debe aceptar el tratamiento de datos',
  }),
  property_interest_id: z.string().uuid().optional(),
}).refine((data) => data.password === data.confirm_password, {
  message: 'Las contrasenas no coinciden',
  path: ['confirm_password'],
});

export const interestSchema = z.object({
  property_id: z.string().uuid('ID de inmueble invalido'),
});

export type RegisterSolicitanteInput = z.infer<typeof registerSolicitanteSchema>;
export type InterestInput = z.infer<typeof interestSchema>;
