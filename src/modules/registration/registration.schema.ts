import { z } from 'zod';

const passwordSchema = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    'La contraseña debe contener al menos 1 mayúscula, 1 minúscula y 1 número',
  );

/**
 * Valida el digito de verificacion del NIT colombiano con algoritmo modulo-11.
 * Formato esperado: "XXXXXXXXX-D" donde D es el digito de verificacion.
 */
function validateNitModulo11(nit: string): boolean {
  const match = nit.match(/^(\d{1,15})-(\d)$/);
  if (!match) return false;

  const digits = match[1];
  const expectedCheck = parseInt(match[2], 10);

  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

  let sum = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    sum += parseInt(reversed[i], 10) * weights[i];
  }

  const remainder = sum % 11;
  const checkDigit = remainder >= 2 ? 11 - remainder : remainder;

  return checkDigit === expectedCheck;
}

const phoneSchema = z
  .string()
  .min(10, 'Teléfono muy corto')
  .max(20, 'Teléfono muy largo')
  .regex(/^\+\d{1,4}\s?\d{7,15}$/, 'Teléfono inválido. Debe incluir lada internacional (ej: +57 3001234567)');

export const registerPropietarioSchema = z.object({
  nombre: z.string().min(1, 'Nombre requerido').max(100, 'Nombre muy largo'),
  apellido: z.string().min(1, 'Apellido requerido').max(100, 'Apellido muy largo'),
  email: z.email({ error: 'Email inválido' }),
  telefono: phoneSchema,
  tipo_documento: z.enum(['cc', 'ce', 'pasaporte'], {
    error: 'Tipo de documento inválido',
  }),
  numero_documento: z.string().min(1, 'Número de documento requerido').max(20, 'Número muy largo'),
  direccion: z.string().min(1, 'Dirección requerida').max(300, 'Dirección muy larga'),
  password: passwordSchema,
  confirm_password: z.string().min(1, 'Confirmacion de contraseña requerida'),
  accept_terms: z.literal(true, {
    error: 'Debes aceptar los terminos y condiciones',
  }),
  accept_data_treatment: z.literal(true, {
    error: 'Debes autorizar el tratamiento de datos personales',
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
  email: z.email({ error: 'Email inválido' }),
  telefono: phoneSchema,
  password: passwordSchema,
  confirm_password: z.string().min(1, 'Confirmacion de contraseña requerida'),
  accept_terms: z.literal(true, {
    error: 'Debes aceptar los terminos y condiciones',
  }),
  accept_data_treatment: z.literal(true, {
    error: 'Debes autorizar el tratamiento de datos personales',
  }),
}).refine((data) => data.password === data.confirm_password, {
  error: 'Las contraseñas no coinciden',
  path: ['confirm_password'],
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
