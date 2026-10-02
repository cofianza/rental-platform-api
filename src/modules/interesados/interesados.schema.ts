import { z } from 'zod';
import { esNombrePersona, sinEnlaces } from '@/lib/textoSinEnlaces';

/**
 * Formulario público "Me interesa este inmueble" para visitantes SIN cuenta.
 * Solo datos de contacto (no sensibles) + autorización de tratamiento de datos.
 */
// Nombre y mensaje llegan tal cual al WhatsApp y al correo del dueño: sin
// etiquetas ni enlaces (el formulario anónimo servía para mandar phishing con la
// marca de Cofianza).

export const registrarInteresSchema = z.object({
  nombre: z
    .string()
    .trim()
    .min(2, 'Ingrese su nombre')
    .max(150)
    .refine(esNombrePersona, 'Escriba solo su nombre, sin enlaces ni números'),
  // Mismo patrón que whatsapp.schema.ts: dígitos, espacios o guiones y '+' inicial.
  telefono: z.string().trim().min(7, 'Ingrese un teléfono válido').max(30).regex(/^\+?[\d\s-]+$/, 'Ingrese un teléfono válido'),
  // Opcional: el celular basta para que el dueño contacte al interesado.
  // Vacío, solo espacios o null cuentan como «sin correo».
  email: z.preprocess(
    (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    z.string().trim().email('Correo inválido').max(255).optional(),
  ),
  // Mensaje opcional del interesado (contexto para el dueño). No sensible.
  mensaje: z.string().trim().max(500, 'Mensaje muy largo').refine(sinEnlaces, 'Quite los enlaces del mensaje').optional(),
  // Debe venir true: es la autorización para compartir el contacto con el
  // anunciante + aceptación de la política de tratamiento de datos.
  acepta: z.boolean().refine((v) => v === true, {
    message: 'Debe autorizar el tratamiento de sus datos para continuar',
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
