import { z } from 'zod';
import { esNombrePersona } from '@/lib/textoSinEnlaces';

// Tipos de documento aceptados — alineado con tipo_documento_id del DB.
// Incluye 'ti': el form web la ofrece y TransUnion la soporta (map tipo '4').
// ppt/pep (A13): poblacion migrante; DataCredito los consulta (6/9), TransUnion no.
const TIPO_DOCUMENTO = ['cc', 'ce', 'ppt', 'pep', 'ti', 'pasaporte', 'nit'] as const;

// El nombre va en el correo y en el WhatsApp que Cofianza le manda a un tercero:
// solo letras y sin dominios (esNombrePersona), o sería phishing con su marca.

export const invitarCoarrendatarioSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(100).refine(esNombrePersona, 'El nombre solo puede tener letras'),
  apellido: z.string().trim().min(1, 'Apellido requerido').max(100).refine(esNombrePersona, 'El apellido solo puede tener letras'),
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

// Reenviar la invitación pendiente, corrigiendo lo que venía mal escrito: el
// contacto y, desde P4 (2026-09-24), también el nombre y el documento. Todo
// opcional: sin body = reenviar a la misma persona.
export const reenviarCoarrendatarioSchema = invitarCoarrendatarioSchema.partial();

// P18: desde el enlace del prospecto, solo documentos de persona natural mayor
// de edad: cédula de ciudadanía o de extranjería, y PPT/PEP (A13, migrantes).
export const invitarCoarrendatarioPublicoSchema = invitarCoarrendatarioSchema.extend({
  tipo_documento: z.enum(['cc', 'ce', 'ppt', 'pep']),
});

export const tokenParamSchema = z.object({
  token: z.string().min(32, 'Token inválido').max(128),
});

export const aceptarCoarrendatarioSchema = z.object({
  // Confirmación explícita de cada checkbox para auditoría legal.
  acepta_terminos: z.literal(true, { message: 'Debe aceptar los términos y condiciones' }),
  acepta_datos: z.literal(true, { message: 'Debe autorizar el tratamiento de datos' }),
  // Contratos V3 §8.7.2: sus datos de notificación para el contrato. Opcionales
  // aquí (la pantalla los pide) para no romper una aceptación a medio deploy.
  direccion: z.string().trim().min(5, 'Escribe tu dirección completa').max(300, 'Máximo 300 caracteres').optional(),
  municipio: z.string().trim().min(2, 'Escribe tu municipio').max(120, 'Máximo 120 caracteres').optional(),
});

export type InvitarCoarrendatarioInput = z.infer<typeof invitarCoarrendatarioSchema>;
export type ReenviarCoarrendatarioInput = z.infer<typeof reenviarCoarrendatarioSchema>;
export type TokenParam = z.infer<typeof tokenParamSchema>;
export type AceptarCoarrendatarioInput = z.infer<typeof aceptarCoarrendatarioSchema>;
