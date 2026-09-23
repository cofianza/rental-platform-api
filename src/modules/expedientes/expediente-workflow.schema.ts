import { z } from 'zod';
import { ESTADOS_EXPEDIENTE } from './expediente-state-machine';
import { OPCIONES_V7, OPCIONES_V9, type OpcionV7, type OpcionV9 } from '@/modules/estudios/motor/scorecard';

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

export const transitionBodySchema = z.object({
  nuevo_estado: z.enum(ESTADOS_EXPEDIENTE, {
    error: `Estado inválido. Valores permitidos: ${ESTADOS_EXPEDIENTE.join(', ')}`,
  }),
  // 10 y no 1: por la tarjeta de revision manual el fundamento ya exige 10
  // (expediente-habilitacion.routes.ts) y es la misma decision de la Adenda 2
  // §5.1. Un solo caracter no es un fundamento escrito.
  comentario: z.string().trim().min(10, { error: 'Escribe el motivo (mínimo 10 caracteres).' }).max(1000),
  motivo: z.string().max(500).optional(),
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
});

/** Adenda 1 contratos (respuesta 21): el motivo del cierre sin acta queda registrado. */
export const cerrarSinActaBodySchema = z.object({
  motivo: z.string().trim().min(10, { error: 'Escribe el motivo (mínimo 10 caracteres).' }).max(1000),
});

export type TransitionInput = z.infer<typeof transitionBodySchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
