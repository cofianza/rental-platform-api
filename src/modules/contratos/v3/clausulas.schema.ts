/**
 * Contratos V3 — validación de las rutas del catálogo de cláusulas adicionales
 * (Entrega 4, diseño §5.1 y D11). El contenido (depósitos, mascotas, lo que no
 * se imprime…) lo juzgan las reglas en el service; aquí solo forma y largo.
 */

import { z } from 'zod';

/** Un solo párrafo: todo espacio en blanco (saltos, tabs) se colapsa al guardar (D11). */
const parrafo = (min: number, max: number, campo: string) =>
  z
    .string({ error: `${campo}: campo obligatorio` })
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(min, `${campo}: mínimo ${min} caracteres`)
        .max(max, `${campo}: máximo ${max.toLocaleString('es-CO')} caracteres`),
    );

export const clausulaSchema = z
  .object({ titulo: parrafo(3, 120, 'Título'), texto: parrafo(20, 4000, 'Texto') })
  .strict();

/** `version` = la que el usuario editó: el CAS del service la compara con la vigente. */
export const editarClausulaSchema = z
  .object({
    titulo: parrafo(3, 120, 'Título'),
    texto: parrafo(20, 4000, 'Texto'),
    version: z.number({ error: 'Falta la versión de la cláusula' }).int().min(1),
  })
  .strict();

export const cambiarEstadoSchema = z.discriminatedUnion(
  'estado',
  [
    z.object({ estado: z.literal('inhabilitada'), motivo: parrafo(3, 500, 'Motivo') }).strict(),
    z.object({ estado: z.literal('activa') }).strict(),
  ],
  { error: 'Estado inválido' },
);

export const clausulaIdParamsSchema = z.object({ id: z.string().uuid('Identificador de cláusula inválido') });

/**
 * `q` va a un `.or()` de PostgREST: se quitan los caracteres de su sintaxis de
 * filtros (y los comodines) para que no se pueda inyectar otro filtro.
 */
export const registroQuerySchema = z.object({
  origen: z.enum(['biblioteca', 'propia']).optional(),
  estado: z.enum(['activa', 'inhabilitada', 'eliminada']).optional(),
  q: z
    .string()
    .transform((s) => s.replace(/[,()%*\\"]/g, '').trim().slice(0, 80))
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export type ClausulaBody = z.infer<typeof clausulaSchema>;
export type EditarClausulaBody = z.infer<typeof editarClausulaSchema>;
export type CambiarEstadoBody = z.infer<typeof cambiarEstadoSchema>;
export type RegistroQuery = z.infer<typeof registroQuerySchema>;
