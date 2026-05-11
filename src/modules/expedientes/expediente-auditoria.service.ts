/**
 * Auditoría de decisión por score — solo para administradores.
 *
 * Compara la decisión que tomo el sistema sobre el estudio crediticio
 * contra la POLITICA DE EVALUACION Y APROBACION POR SCORE de Cofianza
 * (ver /docs/POLITICA DE EVALUACION Y APROBACION POR SCORE.docx).
 *
 * Modelo v0.1 — simplificado:
 *  - Solo se evalua el factor "Score externo" (CREDITVISION de TransUnion).
 *  - Los otros 5 factores (endeudamiento, experiencia, comportamiento,
 *    estabilidad laboral, antiguedad del historial) NO estan capturados
 *    aun. El reporte los muestra como "pendiente_de_captura" para que
 *    quede transparente.
 *
 * Por eso la decision real del sistema usa una logica simplificada
 * (score >=600 aprobado, 400-599 condicionado, <400 rechazado) que no
 * coincide exactamente con la politica oficial. Esto se hace explicito
 * en el reporte para que el admin entienda el gap.
 */

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

// ============================================================
// Tipos
// ============================================================

export type ScoreRangoId =
  | 'rango_800_mas'
  | 'rango_700_799'
  | 'rango_650_699'
  | 'rango_599_649'
  | 'rango_450_598'
  | 'rango_menor_450';

export interface ScoreRango {
  id: ScoreRangoId;
  etiqueta: string;
  puntos: number;
  observacion: string;
}

export type DecisionPolitica = 'aprobado_automatico' | 'revision_manual' | 'rechazado';
export type ResultadoSistema = 'aprobado' | 'condicionado' | 'rechazado' | 'pendiente';

export type FactorId =
  | 'score_externo'
  | 'endeudamiento'
  | 'experiencia_crediticia'
  | 'comportamiento_reciente'
  | 'estabilidad_laboral'
  | 'antiguedad_historial';

export interface FactorAuditado {
  id: FactorId;
  nombre: string;
  maximo: number;
  capturado: boolean;
  puntos: number | null;
  detalle: string;
}

export interface AuditoriaScoreReporte {
  estudio: {
    id: string;
    score: number | null;
    resultado: ResultadoSistema;
    fecha_solicitud: string | null;
    fecha_completado: string | null;
    proveedor: string;
  };
  scoreExterno: {
    valor: number | null;
    rango: ScoreRango | null;
    cumple_regla_dura: boolean;
    motivo_regla_dura: string | null;
  };
  decisionPolitica: {
    resultado: DecisionPolitica;
    explicacion: string;
  };
  decisionSistema: {
    resultado: ResultadoSistema;
    logica_aplicada: string;
  };
  cumplimiento: {
    coincide: boolean;
    observacion: string;
  };
  factores: FactorAuditado[];
  modelo: {
    version: string;
    referencia_politica: string;
    nota: string;
  };
}

// ============================================================
// Constantes de la politica
// ============================================================

const POLITICA_VERSION = '0.1-simplificado';
const POLITICA_REF = 'docs/POLITICA DE EVALUACION Y APROBACION POR SCORE.docx';

const SCORE_RANGOS: ScoreRango[] = [
  { id: 'rango_800_mas',  etiqueta: '≥ 800',     puntos: 50, observacion: 'Aprobacion posible' },
  { id: 'rango_700_799',  etiqueta: '700 – 799', puntos: 45, observacion: 'Aprobacion posible' },
  { id: 'rango_650_699',  etiqueta: '650 – 699', puntos: 40, observacion: 'Aprobacion posible' },
  { id: 'rango_599_649',  etiqueta: '599 – 649', puntos: 30, observacion: 'Aprobacion posible' },
  { id: 'rango_450_598',  etiqueta: '450 – 598', puntos: 10, observacion: 'Solo revision manual' },
  { id: 'rango_menor_450', etiqueta: '< 450',     puntos: 0,  observacion: 'Rechazo automatico' },
];

function clasificarScore(score: number): ScoreRango {
  if (score >= 800) return SCORE_RANGOS[0];
  if (score >= 700) return SCORE_RANGOS[1];
  if (score >= 650) return SCORE_RANGOS[2];
  if (score >= 599) return SCORE_RANGOS[3];
  if (score >= 450) return SCORE_RANGOS[4];
  return SCORE_RANGOS[5];
}

// ============================================================
// Calculo de la decision esperada por la politica
// ============================================================

/**
 * Que decision dictaria la politica, considerando SOLO el score externo
 * (los otros 5 factores no estan capturados). Esto da una vision parcial
 * pero ya filtra los casos extremos (rechazo automatico por score < 450,
 * solo-revision para score 450-598).
 *
 * Cuando se implementen los demas factores, esta funcion va a tomar el
 * puntaje total y aplicar la tabla 85-100 / 70-84 / <70.
 */
function decisionSegunPolitica(score: number | null): {
  resultado: DecisionPolitica;
  explicacion: string;
} {
  if (score === null) {
    return {
      resultado: 'revision_manual',
      explicacion: 'No hay score externo disponible. La politica exige revision manual cuando no hay datos.',
    };
  }

  // Reglas duras primero
  if (score < 450) {
    return {
      resultado: 'rechazado',
      explicacion: 'Regla dura: score externo < 450 → rechazo automatico.',
    };
  }

  if (score < 599) {
    return {
      resultado: 'revision_manual',
      explicacion: 'Score externo entre 450-598 → solo revision manual (la politica no permite aprobar automaticamente con score en este rango).',
    };
  }

  // Para scores >= 599 la politica permite aprobacion automatica
  // condicional a que la SUMA de los 6 factores alcance 85 puntos.
  // Como solo tenemos score externo (max 50 pts), nunca podriamos
  // alcanzar 85 con un solo factor. Por eso la decision real depende
  // de los factores faltantes.
  return {
    resultado: 'revision_manual',
    explicacion:
      `Score externo en rango aprobatorio (${score}). Sin embargo, la politica exige sumar 85+ puntos entre los 6 factores ` +
      'para aprobacion automatica. Como solo tenemos el factor "Score externo" implementado (max 50 pts), ' +
      'la politica formal pediria revision manual hasta que se capturen los otros 5 factores.',
  };
}

// ============================================================
// Comparacion con la decision actual del sistema
// ============================================================

const LOGICA_SISTEMA_ACTUAL =
  'Modelo simplificado v0.1: score ≥ 600 → aprobado · 400-599 → condicionado · < 400 → rechazado · null → pendiente';

function compararDecisiones(
  politica: DecisionPolitica,
  sistema: ResultadoSistema,
): { coincide: boolean; observacion: string } {
  // Mapeo: politica.aprobado_automatico ≈ sistema.aprobado
  //        politica.revision_manual    ≈ sistema.condicionado
  //        politica.rechazado          ≈ sistema.rechazado
  const equivalente: Record<DecisionPolitica, ResultadoSistema> = {
    aprobado_automatico: 'aprobado',
    revision_manual: 'condicionado',
    rechazado: 'rechazado',
  };

  if (sistema === 'pendiente') {
    return {
      coincide: false,
      observacion: 'El estudio todavia no tiene un resultado registrado.',
    };
  }

  const esperado = equivalente[politica];
  if (esperado === sistema) {
    return {
      coincide: true,
      observacion: `La decision del sistema (${sistema}) coincide con la dictada por la politica (${politica}).`,
    };
  }

  return {
    coincide: false,
    observacion:
      `La decision del sistema (${sistema}) difiere de la politica (${politica}). ` +
      'Esto se debe al modelo simplificado actual (v0.1): se aprueban scores ≥ 600 con un solo factor, ' +
      'mientras la politica formal exige acumular 85 puntos entre los 6 factores. ' +
      'Cuando se implemente el modelo completo, este gap se cierra.',
  };
}

// ============================================================
// Listado de factores (lo que tenemos vs lo que falta)
// ============================================================

function listarFactores(score: number | null): FactorAuditado[] {
  const rangoScore = score !== null ? clasificarScore(score) : null;
  const puntosScore = rangoScore?.puntos ?? null;

  return [
    {
      id: 'score_externo',
      nombre: 'Score externo (TransUnion CreditVision)',
      maximo: 50,
      capturado: score !== null,
      puntos: puntosScore,
      detalle: rangoScore
        ? `Valor ${score} → rango "${rangoScore.etiqueta}" → ${puntosScore} pts (${rangoScore.observacion}).`
        : 'No hay score disponible.',
    },
    {
      id: 'endeudamiento',
      nombre: 'Capacidad de endeudamiento',
      maximo: 15,
      capturado: false,
      puntos: null,
      detalle:
        'Pendiente: requiere capturar ingresos mensuales + cuotas vigentes del solicitante. ' +
        'La politica define rangos ≤30%/31-50%/51-60% y rechazo automatico si > 60%.',
    },
    {
      id: 'experiencia_crediticia',
      nombre: 'Experiencia crediticia',
      maximo: 10,
      capturado: false,
      puntos: null,
      detalle:
        'Pendiente: requiere identificar si tiene credito en sector financiero (+6) o sector real (+4). ' +
        'Disponible en respuesta de TransUnion pero aun no se mapea.',
    },
    {
      id: 'comportamiento_reciente',
      nombre: 'Comportamiento reciente',
      maximo: 10,
      capturado: false,
      puntos: null,
      detalle:
        'Pendiente: requiere historial de moras 360 dias (+10 si sin moras, -15 si mora >30d en 12m, ' +
        'rechazo si mora vigente). Datos disponibles en TransUnion, pero no extraidos aun.',
    },
    {
      id: 'estabilidad_laboral',
      nombre: 'Estabilidad laboral',
      maximo: 10,
      capturado: false,
      puntos: null,
      detalle:
        'Pendiente: requiere capturar tipo de empleo (formal +10, independiente formal >1 año +6, ' +
        'informal +2). Hoy "ocupacion" se guarda como texto libre.',
    },
    {
      id: 'antiguedad_historial',
      nombre: 'Antiguedad del historial crediticio',
      maximo: 5,
      capturado: false,
      puntos: null,
      detalle:
        'Pendiente: requiere fecha del primer credito reportado. La politica asigna >5 años=5, ' +
        '2-5=3, <2=1, sin historial=0.',
    },
  ];
}

// ============================================================
// Service principal
// ============================================================

export async function getAuditoriaScore(expedienteId: string): Promise<AuditoriaScoreReporte> {
  // Verificar que el expediente existe (404 claro si no)
  const { data: expRow, error: expErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expErr || !expRow) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  // Traer el estudio mas reciente del titular (tipo='individual') con score.
  // Si no hay 'individual', caemos al ultimo de cualquier tipo — el reporte
  // lo aclara via metadata.
  const { data: estudiosRow, error: estErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, tipo, proveedor, estado, resultado, score, fecha_solicitud, fecha_completado, created_at')
    .eq('expediente_id', expedienteId)
    .neq('estado', 'cancelado')
    .order('created_at', { ascending: false });

  if (estErr) {
    logger.error({ expedienteId, error: estErr.message }, 'Auditoria: error consultando estudios');
    throw AppError.badRequest('Error al obtener estudios del expediente', 'ESTUDIOS_LIST_ERROR');
  }

  const estudios = (estudiosRow as Array<{
    id: string;
    tipo: string;
    proveedor: string;
    estado: string;
    resultado: string | null;
    score: number | null;
    fecha_solicitud: string | null;
    fecha_completado: string | null;
    created_at: string;
  }> | null) ?? [];

  if (estudios.length === 0) {
    throw AppError.notFound(
      'No hay estudios crediticios registrados para este expediente. Aun no se puede auditar.',
      'ESTUDIO_NOT_FOUND',
    );
  }

  // Preferir individual (titular); si no existe, tomar el mas reciente.
  const elegido = estudios.find((e) => e.tipo === 'individual') ?? estudios[0];

  const score = elegido.score;
  const rangoScore = score !== null ? clasificarScore(score) : null;

  const reglaDuraOk = score === null || score >= 450;
  const motivoReglaDura = !reglaDuraOk
    ? `Score externo (${score}) menor a 450 — la politica dicta rechazo automatico.`
    : null;

  const politica = decisionSegunPolitica(score);
  const resultadoSistema = (elegido.resultado as ResultadoSistema) ?? 'pendiente';
  const cumplimiento = compararDecisiones(politica.resultado, resultadoSistema);

  return {
    estudio: {
      id: elegido.id,
      score,
      resultado: resultadoSistema,
      fecha_solicitud: elegido.fecha_solicitud,
      fecha_completado: elegido.fecha_completado,
      proveedor: elegido.proveedor,
    },
    scoreExterno: {
      valor: score,
      rango: rangoScore,
      cumple_regla_dura: reglaDuraOk,
      motivo_regla_dura: motivoReglaDura,
    },
    decisionPolitica: politica,
    decisionSistema: {
      resultado: resultadoSistema,
      logica_aplicada: LOGICA_SISTEMA_ACTUAL,
    },
    cumplimiento,
    factores: listarFactores(score),
    modelo: {
      version: POLITICA_VERSION,
      referencia_politica: POLITICA_REF,
      nota:
        'Solo el factor "Score externo" esta implementado en el sistema. Los demas 5 factores ' +
        '(endeudamiento, experiencia, comportamiento, estabilidad, antiguedad) estan pendientes de ' +
        'captura. Cuando se implementen, esta auditoria reflejara la suma total de 100 puntos.',
    },
  };
}
