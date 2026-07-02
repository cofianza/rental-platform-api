import { z } from 'zod';

// Tipos de documento aceptados — alineado con tipo_documento_id del DB.
// Incluye 'ti': el form web la ofrece y TransUnion la soporta (map tipo '4').
const TIPO_DOCUMENTO = ['cc', 'ce', 'ti', 'pasaporte', 'nit'] as const;

export const invitarCoarrendatarioSchema = z.object({
  nombre: z.string().min(1, 'Nombre requerido').max(100),
  apellido: z.string().min(1, 'Apellido requerido').max(100),
  tipo_documento: z.enum(TIPO_DOCUMENTO),
  numero_documento: z.string().min(1, 'Documento requerido').max(20),
  email: z.email('Email inválido'),
  telefono: z
    .string()
    .min(10, 'Teléfono debe tener al menos 10 dígitos')
    .max(20)
    .regex(/^\+\d{1,4}[\s-]?\d{7,15}$/, 'Formato internacional requerido (+57…)')
    .optional(),
});

// Reenviar la invitación pendiente, corrigiendo el contacto si venía mal
// escrito. Ambos campos opcionales: sin body = reenviar al mismo contacto.
export const reenviarCoarrendatarioSchema = z.object({
  email: z.email('Email inválido').optional(),
  telefono: z
    .string()
    .min(10, 'Teléfono debe tener al menos 10 dígitos')
    .max(20)
    .regex(/^\+\d{1,4}[\s-]?\d{7,15}$/, 'Formato internacional requerido (+57…)')
    .optional(),
});

export const tokenParamSchema = z.object({
  token: z.string().min(32, 'Token inválido').max(128),
});

export const aceptarCoarrendatarioSchema = z.object({
  // Confirmación explícita de cada checkbox para auditoría legal.
  acepta_terminos: z.literal(true, { message: 'Debe aceptar los términos y condiciones' }),
  acepta_datos: z.literal(true, { message: 'Debe autorizar el tratamiento de datos' }),
});

export type InvitarCoarrendatarioInput = z.infer<typeof invitarCoarrendatarioSchema>;
export type ReenviarCoarrendatarioInput = z.infer<typeof reenviarCoarrendatarioSchema>;
export type TokenParam = z.infer<typeof tokenParamSchema>;
export type AceptarCoarrendatarioInput = z.infer<typeof aceptarCoarrendatarioSchema>;
