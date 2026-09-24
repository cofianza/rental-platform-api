import { z } from 'zod';

/**
 * Formulario público "Me interesa este inmueble" para visitantes SIN cuenta.
 * Solo datos de contacto (no sensibles) + autorización de tratamiento de datos.
 */
// Nombre y mensaje llegan tal cual al WhatsApp y al correo del dueño: sin
// etiquetas ni enlaces. Cualquier punto (también ．。｡) pegado a dos o más letras
// es un dominio («pago-seguro.info», «is.gd/x», «FALSO．CO»), sea cual sea la
// terminación; los de «J.R.», «8 a.m.» o «No.301» no lo son. El formulario
// anónimo servía para mandar phishing con la marca de Cofianza.
const CON_ENLACE = /[<>]|h(?:tt|xx)ps?:|[\p{L}\d-][.．。｡]\p{L}{2,}/iu;
const sinEnlaces = (v: string) => !CON_ENLACE.test(v);
// El nombre, además, solo con letras, espacios, puntos, guiones y apóstrofos
// (también el ’ que ponen los teclados de celular).
const SOLO_NOMBRE = /^[\p{L}\p{M}'’ .-]+$/u;

export const registrarInteresSchema = z.object({
  nombre: z
    .string()
    .trim()
    .min(2, 'Ingresa tu nombre')
    .max(150)
    .refine((v) => SOLO_NOMBRE.test(v) && sinEnlaces(v), 'Escribe solo tu nombre, sin enlaces ni números'),
  // Mismo patrón que whatsapp.schema.ts: dígitos, espacios o guiones y '+' inicial.
  telefono: z.string().trim().min(7, 'Ingresa un teléfono válido').max(30).regex(/^\+?[\d\s-]+$/, 'Ingresa un teléfono válido'),
  email: z.string().trim().email('Correo inválido').max(255),
  // Mensaje opcional del interesado (contexto para el dueño). No sensible.
  mensaje: z.string().trim().max(500, 'Mensaje muy largo').refine(sinEnlaces, 'Quita los enlaces del mensaje').optional(),
  // Debe venir true: es la autorización para compartir el contacto con el
  // anunciante + aceptación de la política de tratamiento de datos.
  acepta: z.boolean().refine((v) => v === true, {
    message: 'Debes autorizar el tratamiento de tus datos para continuar',
  }),
});

const ESTADOS = ['nuevo', 'contactado', 'descartado'] as const;

export const listInteresadosQuerySchema = z.object({
  estado: z.enum(ESTADOS).optional(),
  inmueble_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const interesadoIdParamsSchema = z.object({
  id: z.string().uuid('Id inválido'),
});

export const updateInteresadoSchema = z.object({
  estado: z.enum(ESTADOS),
});

export type RegistrarInteresInput = z.infer<typeof registrarInteresSchema>;
export type ListInteresadosQuery = z.infer<typeof listInteresadosQuerySchema>;
export type UpdateInteresadoInput = z.infer<typeof updateInteresadoSchema>;
