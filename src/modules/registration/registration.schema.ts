import { z } from 'zod';

// Regla única de contraseña: la reutilizan el registro de miembros y de solicitantes.
export const passwordSchema = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    'La contraseña debe contener al menos 1 mayúscula, 1 minúscula y 1 número',
  );

/** Dígito de verificación DIAN (módulo 11) de los dígitos de un NIT, sin el DV. */
export function digitoVerificacionNit(digits: string): number {
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

  let sum = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    sum += parseInt(reversed[i], 10) * weights[i];
  }

  const remainder = sum % 11;
  return remainder >= 2 ? 11 - remainder : remainder;
}

/**
 * Valida el digito de verificacion del NIT colombiano con algoritmo modulo-11.
 * Formato esperado: "XXXXXXXXX-D" donde D es el digito de verificacion.
 */
export function validateNitModulo11(nit: string): boolean {
  const match = nit.match(/^(\d{1,15})-(\d)$/);
  return !!match && digitoVerificacionNit(match[1]) === parseInt(match[2], 10);
}

const phoneSchema = z
  .string()
  .min(10, 'Teléfono muy corto')
  .max(20, 'Teléfono muy largo')
  .regex(/^\+\d{1,4}\s?\d{7,15}$/, 'Teléfono inválido. Debe incluir lada internacional (ej: +57 3001234567)');

// ¿Cómo nos conoció? Una sola lista para los dos registros.
const ORIGENES = ['inmobiliaria', 'redes', 'recomendacion', 'google', 'evento', 'otro'] as const;

export const registerPropietarioSchema = z.object({
  nombre: z.string().min(1, 'Nombre requerido').max(100, 'Nombre muy largo'),
  apellido: z.string().min(1, 'Apellido requerido').max(100, 'Apellido muy largo'),
  email: z.email({ error: 'Email inválido' }),
  telefono: phoneSchema,
  tipo_documento: z.enum(['cc', 'ce', 'pasaporte'], {
    error: 'Tipo de documento inválido',
  }),
  // Se guarda sin puntos, espacios ni guiones («1.040.567.890» → «1040567890»),
  // igual que el documento del representante legal.
  numero_documento: z
    .string()
    .max(20, 'Número muy largo')
    .transform((s) => s.replace(/[.\s-]/g, ''))
    .refine((s) => s.length > 0, 'Número de documento requerido'),
  // Opcional: el contrato usa domicilio_direccion, que se pide en «Datos para contrato».
  direccion: z.string().min(1, 'Dirección requerida').max(300, 'Dirección muy larga').optional(),
  origen: z.enum(ORIGENES, { error: 'Opción inválida' }).optional(),
  password: passwordSchema,
  confirm_password: z.string().min(1, 'Confirmacion de contraseña requerida'),
  accept_terms: z.literal(true, {
    error: 'Debe aceptar los terminos y condiciones',
  }),
  accept_data_treatment: z.literal(true, {
    error: 'Debe autorizar el tratamiento de datos personales',
  }),
}).refine((data) => data.password === data.confirm_password, {
  error: 'Las contraseñas no coinciden',
  path: ['confirm_password'],
});

export const registerInmobiliariaSchema = z.object({
  razon_social: z.string().min(1, 'Razón social requerida').max(300, 'Razón social muy larga'),
  nit: z
    .string()
    .min(1, 'NIT requerido')
    .max(20, 'NIT muy largo')
    .regex(/^\d{1,15}-\d$/, 'NIT inválido. Formato: dígitos-dígito verificación')
    .refine(validateNitModulo11, 'Dígito de verificación del NIT inválido'),
  direccion_comercial: z.string().min(1, 'Dirección comercial requerida').max(300, 'Dirección muy larga'),
  ciudad: z.string().min(1, 'Ciudad requerida').max(100, 'Ciudad muy larga'),
  nombre_representante_nombre: z.string().min(1, 'Nombre del representante requerido').max(100, 'Nombre muy largo'),
  nombre_representante_apellido: z.string().min(1, 'Apellido del representante requerido').max(100, 'Apellido muy largo'),
  cargo_representante: z.string().max(100, 'Cargo muy largo').optional(),
  // ¿Qué afianzadora/aseguradora usan hoy? (opcional, tarea 1.6)
  afianzadora_actual: z.string().max(200, 'Nombre muy largo').optional(),
  afianzadora_tipo: z.enum(['afianzadora', 'aseguradora', 'ninguna']).optional(),
  // Registro v2: opcionales para no romper la web anterior; la web nueva los exige en cliente.
  inmuebles_gestionados: z.enum(['1-20', '21-50', '51-100', '101-300', '300+'], { error: 'Opción inválida' }).optional(),
  sitio_web: z.url({ protocol: /^https?$/, error: 'Sitio web inválido. Incluya https://' }).max(300, 'Sitio web muy largo').optional(),
  representante_tipo_documento: z.enum(['cc', 'ce', 'pasaporte'], { error: 'Tipo de documento inválido' }).optional(),
  // Mismo saneo y formato que perfil-arrendador.schema.ts (CHECK perfiles_rep_legal_doc_chk).
  representante_documento: z
    .string()
    .transform((s) => s.replace(/[.\s-]/g, ''))
    .refine((s) => /^[A-Za-z0-9]{3,30}$/.test(s), 'Número de documento inválido')
    .optional(),
  origen: z.enum(ORIGENES, { error: 'Opción inválida' }).optional(),
  email: z.email({ error: 'Email inválido' }),
  telefono: phoneSchema,
  password: passwordSchema,
  confirm_password: z.string().min(1, 'Confirmacion de contraseña requerida'),
  accept_terms: z.literal(true, {
    error: 'Debe aceptar los terminos y condiciones',
  }),
  accept_data_treatment: z.literal(true, {
    error: 'Debe autorizar el tratamiento de datos personales',
  }),
}).refine((data) => data.password === data.confirm_password, {
  error: 'Las contraseñas no coinciden',
  path: ['confirm_password'],
}).refine((data) => !data.representante_tipo_documento === !data.representante_documento, {
  error: 'Indique el tipo y el número de documento del representante',
  path: ['representante_documento'],
});

export const verifyEmailParamsSchema = z.object({
  token: z.string().min(1, 'Token requerido'),
});

export const resendVerificationSchema = z.object({
  email: z.email({ error: 'Email inválido' }),
});

export type RegisterPropietarioInput = z.infer<typeof registerPropietarioSchema>;
export type RegisterInmobiliariaInput = z.infer<typeof registerInmobiliariaSchema>;
export type VerifyEmailParams = z.infer<typeof verifyEmailParamsSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
