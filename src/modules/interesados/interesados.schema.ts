import { z } from 'zod';

/**
 * Formulario público "Me interesa este inmueble" para visitantes SIN cuenta.
 * Solo datos de contacto (no sensibles) + autorización de tratamiento de datos.
 */
export const registrarInteresSchema = z.object({
  nombre: z.string().trim().min(2, 'Ingresa tu nombre').max(150),
  telefono: z.string().trim().min(7, 'Ingresa un teléfono válido').max(30),
  email: z.string().trim().email('Correo inválido').max(255),
  // Mensaje opcional del interesado (contexto para el dueño). No sensible.
  mensaje: z.string().trim().max(500, 'Mensaje muy largo').optional(),
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
