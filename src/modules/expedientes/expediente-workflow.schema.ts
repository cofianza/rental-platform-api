import { z } from 'zod';
import { ESTADOS_EXPEDIENTE } from './expediente-state-machine';
import { OPCIONES_V7, OPCIONES_V9, type OpcionV7, type OpcionV9 } from '@/modules/estudios/motor/scorecard';
import { camposMotivos, internoConEscrito, MAX_INTERNO, refinarMotivos, rellenarDesdeMotivos, type TipoDecision } from '@/modules/estudios/motivos-decision';

// H58/H103: la decisión según el destino de la transición.
const tipoDeTransicion = (e: unknown): TipoDecision | null =>
  e === 'rechazado' ? 'rechazar' : e === 'aprobado' ? 'aprobar' : e === 'condicionado' ? 'condicionar' : null;

export const expedienteIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de estudio inválido' }),
});

/** Adenda 2 §4.3: estabilidad laboral (V7) e historial de arrendamiento (V9)
 *  puntuados por el analista al aprobar una revisión manual. */
export const evaluacionRevisionManualSchema = z.object({
  estabilidad_laboral: z.enum(Object.keys(OPCIONES_V7) as [OpcionV7, ...OpcionV7[]], {
    error: 'Elige la estabilidad laboral del solicitante',
  }),
  arrendamiento_previo: z.enum(Object.keys(OPCIONES_V9) as [OpcionV9, ...OpcionV9[]], {
    error: 'Elige el historial de arrendamiento del solicitante',
  }),
});

export const transitionBodySchema = z.preprocess(
  rellenarDesdeMotivos(
    (b) => tipoDeTransicion(b.nuevo_estado),
    (b, t) => {
      // P34: `motivo` es el que ve la inmobiliaria; `comentario`, el fundamento interno.
      if (b.nuevo_estado === 'rechazado') b.motivo ||= t.visible;
      // M4: con motivos el comentario siempre los lleva (lo escrito va al final).
      b.comentario = internoConEscrito(t.interno, b.comentario);
    },
  ),
  z.object({
  ...camposMotivos,
  nuevo_estado: z.enum(ESTADOS_EXPEDIENTE, {
    error: `Estado inválido. Valores permitidos: ${ESTADOS_EXPEDIENTE.join(', ')}`,
  }),
  // 10 y no 1: por la tarjeta de revision manual el fundamento ya exige 10
  // (expediente-habilitacion.routes.ts) y es la misma decision de la Adenda 2
  // §5.1. Un solo caracter no es un fundamento escrito.
  // M6: MAX_INTERNO (3000) y no 1000: con motivos se arma con todas las líneas + el detalle.
  comentario: z.string().trim().min(10, { error: 'Escribe el motivo (mínimo 10 caracteres).' }).max(MAX_INTERNO),
  /** P34: al rechazar, el motivo corto para la inmobiliaria o el propietario
   *  (el comentario es el fundamento interno). Obligatorio para 'rechazado'. */
  motivo: z.string().trim().max(500).optional(),
  /** Etiqueta de la transicion elegida (eg. "Cerrar expediente",
   *  "Cancelar expediente"). Permite distinguir intenciones cuando dos
   *  transiciones convergen al mismo destino (aprobado → cerrado tiene
   *  ambas etiquetas). El service la usa para decidir si poblar las
   *  columnas de cancelacion en expedientes. */
  etiqueta: z.string().max(100).optional(),
  /** Adenda 2 §5.1: documentos que el analista consulto al resolver un caso
   *  en revision manual (condicionado). El comentario es el fundamento. */
  documentos_consultados: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  /** Obligatoria para condicionado → aprobado (la exige el service). */
  evaluacion: evaluacionRevisionManualSchema.optional(),
}).superRefine((d, ctx) => {
  if (d.nuevo_estado === 'rechazado' && (d.motivo ?? '').length < 10) {
    ctx.addIssue({
      code: 'custom',
      path: ['motivo'],
      message: 'Escribe el motivo para la inmobiliaria o el propietario (mínimo 10 caracteres).',
    });
  }
  refinarMotivos(tipoDeTransicion(d.nuevo_estado), d, ctx);
}),
);

// H58: el fundamento sale de los motivos de la lista (+ texto opcional) si vienen.
export const aprobarCondicionadoBody = z.preprocess(
  rellenarDesdeMotivos(
    () => 'aprobar',
    (b, t) => {
      b.fundamento = internoConEscrito(t.interno, b.fundamento);
    },
  ),
  z.object({
  ...camposMotivos,
  duracion_contrato_meses: z.coerce.number().int().min(1).max(120).optional(),
  fecha_inicio_contrato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato fecha invalido (YYYY-MM-DD)').optional(),
  // Adenda 2 §5.1: "toda decision manual debe registrar [...] el fundamento
  // escrito y los documentos que consulto".
  fundamento: z.string().trim().min(10, 'Escribe el fundamento de la decisión (mínimo 10 caracteres).').max(MAX_INTERNO),
  documentos_consultados: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  // Adenda 2 §4.3: el puntaje se recalcula con V7 y V9 que puntúa el analista.
  evaluacion: evaluacionRevisionManualSchema,
  // Política §15 (thin-file sin ingreso de la central): el analista verificó una fuente de capacidad.
  fuente_capacidad_verificada: z.boolean().optional(),
}).superRefine((d, ctx) => refinarMotivos('aprobar', d, ctx)),
);

/** Adenda 1 contratos (respuesta 21): el motivo del cierre sin acta queda registrado. */
export const cerrarSinActaBodySchema = z.object({
  motivo: z.string().trim().min(10, { error: 'Escribe el motivo (mínimo 10 caracteres).' }).max(1000),
});

export type TransitionInput = z.infer<typeof transitionBodySchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
