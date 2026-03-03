import { z } from 'zod';

const passwordSchema = z
  .string()
  .min(8, 'La contrasena debe tener al menos 8 caracteres')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    'La contrasena debe contener al menos 1 mayuscula, 1 minuscula y 1 numero',
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

const colombianPhoneSchema = z
  .string()
  .regex(/^\+57\s?3\d{9}$/, 'Telefono invalido. Formato: +57 3XXXXXXXXX');

export const registerPropietarioSchema = z.object({
  nombre: z.string().min(1, 'Nombre requerido').max(100, 'Nombre muy largo'),
  apellido: z.string().min(1, 'Apellido requerido').max(100, 'Apellido muy largo'),
  email: z.email({ error: 'Email invalido' }),
  telefono: colombianPhoneSchema,
  tipo_documento: z.enum(['cc', 'ce', 'pasaporte'], {
    error: 'Tipo de documento invalido',
  }),
  numero_documento: z.string().min(1, 'Numero de documento requerido').max(20, 'Numero muy largo'),
  direccion: z.string().min(1, 'Direccion requerida').max(300, 'Direccion muy larga'),
  password: passwordSchema,
  confirm_password: z.string().min(1, 'Confirmacion de contrasena requerida'),
  accept_terms: z.literal(true, {
    error: 'Debes aceptar los terminos y condiciones',
  }),
  accept_data_treatment: z.literal(true, {
    error: 'Debes autorizar el tratamiento de datos personales',
  }),
}).refine((data) => data.password === data.confirm_password, {
  error: 'Las contrasenas no coinciden',
  path: ['confirm_password'],
});

export const registerInmobiliariaSchema = z.object({
  razon_social: z.string().min(1, 'Razon social requerida').max(300, 'Razon social muy larga'),
  nit: z
    .string()
    .min(1, 'NIT requerido')
    .max(20, 'NIT muy largo')
    .regex(/^\d{1,15}-\d$/, 'NIT invalido. Formato: digitos-digito verificacion')
    .refine(validateNitModulo11, 'Digito de verificacion del NIT invalido'),
  direccion_comercial: z.string().min(1, 'Direccion comercial requerida').max(300, 'Direccion muy larga'),
  ciudad: z.string().min(1, 'Ciudad requerida').max(100, 'Ciudad muy larga'),
  nombre_representante_nombre: z.string().min(1, 'Nombre del representante requerido').max(100, 'Nombre muy largo'),
  nombre_representante_apellido: z.string().min(1, 'Apellido del representante requerido').max(100, 'Apellido muy largo'),
  email: z.email({ error: 'Email invalido' }),
  telefono: colombianPhoneSchema,
  password: passwordSchema,
  confirm_password: z.string().min(1, 'Confirmacion de contrasena requerida'),
  accept_terms: z.literal(true, {
    error: 'Debes aceptar los terminos y condiciones',
  }),
  accept_data_treatment: z.literal(true, {
    error: 'Debes autorizar el tratamiento de datos personales',
  }),
}).refine((data) => data.password === data.confirm_password, {
  error: 'Las contrasenas no coinciden',
  path: ['confirm_password'],
});

export const verifyEmailParamsSchema = z.object({
  token: z.string().min(1, 'Token requerido'),
});

export const resendVerificationSchema = z.object({
  email: z.email({ error: 'Email invalido' }),
});

export type RegisterPropietarioInput = z.infer<typeof registerPropietarioSchema>;
export type RegisterInmobiliariaInput = z.infer<typeof registerInmobiliariaSchema>;
export type VerifyEmailParams = z.infer<typeof verifyEmailParamsSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
