/**
 * Contratos V3 — validación de los pasos del asistente (Entrega 3, diseño §5.5).
 *
 * Todo objeto es .strict(): un campo que el contrato no lleva (p. ej. un
 * depósito, B5) no puede ni llegar. Los textos se rechazan si el motor no los
 * puede imprimir. Mensajes en español: validate() los muestra tal cual.
 */

import { z } from 'zod';
import { dosDecimales, noImprimible } from './asistente.reglas';
import { MAX_CAMPOS } from './clausulas.reglas';

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
    ruta: z.enum(['A', 'B'], { error: 'Elige la ruta del contrato' }),
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

// Paso 4 (Entrega 4, §5.3): omitir, o las cláusulas elegidas + la aceptación del aviso.
// Lo que dicen las cláusulas lo juzga el service con las reglas; aquí solo forma.
// El valor de un [[campo]] es un solo párrafo, como la cláusula (D11).
const valorCampo = z
  .string({ error: 'Completa los datos de la cláusula' })
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Completa los datos de la cláusula').max(200, 'Cada dato de la cláusula admite máximo 200 caracteres'));

const clausulasPaso4 = z
  .object({
    omitir: z.undefined().optional(), // discrimina contra { omitir: true } con mensajes propios
    clausulas: z
      .array(
        z
          .object({
            clausulaId: z.string().uuid('Cláusula inválida'),
            valores: z
              .record(z.string().regex(/^[\p{L}\d ]{1,40}$/u, 'Dato de la cláusula inválido'), valorCampo)
              .refine((v) => Object.keys(v).length <= MAX_CAMPOS, `Máximo ${MAX_CAMPOS} datos por cláusula`)
              .optional(),
          })
          .strict(),
        { error: 'Elige las cláusulas adicionales' },
      )
      .min(1, 'Agrega al menos una cláusula o continúa sin ellas')
      .max(25, 'Máximo 25 cláusulas adicionales por contrato')
      .refine((cs) => new Set(cs.map((c) => c.clausulaId)).size === cs.length, 'Una cláusula está repetida'),
    // Solo se exige con propias o con datos en los modelos (Adenda 1 contratos, resp. 13): lo decide el service.
    aceptoResponsabilidad: z
      .literal(true, {
        error: 'Acepta el aviso de responsabilidad para incorporar tus cláusulas propias y los datos que completaste',
      })
      .optional(),
    avisoVersion: z.string({ error: 'Falta la versión del aviso de responsabilidad' }).min(1).max(40),
  })
  .strict();

export const paso4Schema = z.discriminatedUnion(
  'omitir',
  [z.object({ omitir: z.literal(true) }).strict(), clausulasPaso4],
  { error: 'Paso 4 inválido' },
);

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

/** La huella (sha256) del conjunto exacto de adicionales que el administrador autoriza (D6). */
export const autorizarExcesoSchema = z
  .object({ huella: z.string({ error: 'Falta la huella' }).regex(/^[0-9a-f]{64}$/, 'Huella inválida') })
  .strict();

/** Tope de marcas de firma sobre el PDF propio (firma e iniciales en varias páginas caben de sobra). */
export const MAX_MARCAS_FIRMA = 30;

const coordenada = z
  .number({ error: 'Coordenada inválida' })
  .min(0, 'La firma queda fuera de la página')
  .max(1, 'La firma queda fuera de la página');

/**
 * Ruta B: dónde firma cada parte sobre el PDF propio (Adenda 1 contratos,
 * respuesta 6), ligado al PDF por su sha256. Que la página exista y que la
 * parte firme este contrato lo revisa el service.
 */
export const firmasPropioSchema = z
  .object({
    propioSha256: z.string().regex(/^[0-9a-f]{64}$/, 'Huella del PDF inválida'),
    firmas: z
      .array(
        z
          .object({
            parte: z.enum(['arrendatario', 'coarrendatario', 'arrendador'], { error: 'Parte inválida' }),
            indice: z.number().int().min(0).max(9).optional(),
            pagina: z.number({ error: 'Página inválida' }).int('Página inválida').min(1, 'Página inválida'),
            x: coordenada,
            y: coordenada,
          })
          .strict()
          .refine((m) => (m.parte === 'coarrendatario') === (m.indice !== undefined), {
            message: 'Solo la firma del coarrendatario lleva su número',
            path: ['indice'],
          }),
        { error: 'Faltan las firmas' },
      )
      .max(MAX_MARCAS_FIRMA, `Máximo ${MAX_MARCAS_FIRMA} firmas sobre el contrato`),
  })
  .strict();

/** Enviar a firma: la vista previa que se revisó y, en la Ruta B, el PDF propio que se vio. */
export const enviarSchema = z
  .object({
    generacion: z.number({ error: 'Falta la vista previa' }).int().min(1),
    propioSha256: z.string().regex(/^[0-9a-f]{64}$/, 'Huella del PDF inválida').optional(),
  })
  .strict();
