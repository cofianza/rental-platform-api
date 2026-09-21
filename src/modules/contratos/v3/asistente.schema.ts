/**
 * Contratos V3 — validación de los pasos del asistente (Entrega 3, diseño §5.5).
 *
 * Todo objeto es .strict(): un campo que el contrato no lleva (p. ej. un
 * depósito, B5) no puede ni llegar. Los textos se rechazan si el motor no los
 * puede imprimir. Mensajes en español: validate() los muestra tal cual.
 */

import { z } from 'zod';
import { dosDecimales, noImprimible } from './asistente.reglas';

const texto = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Campo obligatorio')
    .max(max, `Máximo ${max} caracteres`)
    .refine(
      (s) => !noImprimible(s, true),
      'Este texto no se puede imprimir en el contrato: quita XXX, ___, llaves, «NO APLICA», «null» o la palabra «coarrendatario».',
    );

const entero = (min: number, max: number, campo: string) =>
  z
    .number({ error: `${campo}: escribe un número` })
    .int(`${campo}: debe ser un número entero`)
    .min(min, `${campo}: mínimo ${min.toLocaleString('es-CO')}`)
    .max(max, `${campo}: máximo ${max.toLocaleString('es-CO')}`);

const pct = z
  .number({ error: 'Escribe un porcentaje' })
  .min(0, 'El porcentaje no puede ser negativo')
  .max(100, 'El porcentaje no puede pasar de 100')
  .refine(dosDecimales, 'Máximo dos decimales');

// Fecha real (2026-02-30 no pasa): el motor la imprime y suma meses sobre ella.
const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)')
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Fecha inválida');

const telefono = z
  .string()
  .transform((s) => s.replace(/[\s()-]/g, ''))
  .refine((s) => /^\+?\d{7,15}$/.test(s), 'Celular inválido');

const contacto = z
  .object({
    direccion: texto(300),
    municipio: texto(120),
    email: z.email({ error: 'Correo electrónico inválido' }).max(254, 'Máximo 254 caracteres'),
    telefono,
  })
  .strict();

export const paso1Schema = z
  .object({
    ruta: z.literal('A', { error: 'La Ruta B todavía no está disponible' }),
    modalidad: z.enum(['trasladada', 'tradicional'], { error: 'Elige la modalidad de la fianza' }),
    canonCop: entero(1, 100_000_000, 'Canon'),
  })
  .strict();

export const paso2Schema = z
  .object({
    usos: z
      .object({ carro: texto(40).nullable(), moto: texto(40).nullable(), util: texto(40).nullable() })
      .strict(),
    amoblado: z.boolean({ error: 'Indica si el inmueble está amoblado' }),
    ocupantes: entero(1, 30, 'Ocupantes'),
    propiedadHorizontal: z.boolean({ error: 'Indica si el inmueble es de propiedad horizontal' }),
    nombreCopropiedad: texto(150).nullable(),
  })
  .strict()
  .refine((d) => !d.propiedadHorizontal || d.nombreCopropiedad !== null, {
    message: 'Escribe el nombre de la copropiedad',
    path: ['nombreCopropiedad'],
  })
  .refine((d) => d.propiedadHorizontal || d.nombreCopropiedad === null, {
    message: 'Sin propiedad horizontal no va nombre de copropiedad',
    path: ['nombreCopropiedad'],
  });

export const paso3Schema = z
  .object({
    vigenciaMeses: entero(2, 120, 'Vigencia'),
    fechaInicio: fecha,
    fechaEntrega: fecha,
    comisionPct: pct,
    administracion: z
      .object({
        aCargoDe: z.enum(['arrendador', 'arrendatario'], {
          error: 'Indica a cargo de quién está la administración',
        }),
        valorCop: entero(0, 100_000_000, 'Administración'),
        incluidaEnCanon: z.boolean({ error: 'Indica si la administración está incluida en el canon' }),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const paso4Schema = z.object({ omitir: z.literal(true) }).strict();

export const paso5Schema = z
  .object({
    ciudadFirma: texto(120),
    contactos: z
      .object({ arrendador: contacto, arrendatario: contacto, coarrendatario: contacto.nullable() })
      .strict(),
  })
  .strict();

export const guardarPasoSchema = z.discriminatedUnion(
  'paso',
  [
    z.object({ paso: z.literal(1), datos: paso1Schema }).strict(),
    z.object({ paso: z.literal(2), datos: paso2Schema }).strict(),
    z.object({ paso: z.literal(3), datos: paso3Schema }).strict(),
    z.object({ paso: z.literal(4), datos: paso4Schema }).strict(),
    z.object({ paso: z.literal(5), datos: paso5Schema }).strict(),
  ],
  { error: 'Paso inválido' },
);
