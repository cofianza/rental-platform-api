// ============================================================
// Motor de scorecard V4.1 — PERSISTENCIA (modo sombra)
// ------------------------------------------------------------
// Unico punto del motor que habla con Supabase. Corre SIEMPRE despues de que
// fn_registrar_resultado_estudio ya commiteo el resultado real, y solo hace
// dos cosas: leer (estudio + canon) y hacer UN upsert en
// estudios_scorecard_sombra.
//
// Es fisicamente incapaz de tocar `estudios.resultado` / `estudios.score`: no
// escribe en la tabla `estudios`. Esa es la garantia estructural del modo
// sombra, no solo una promesa del try/catch — y SIGUE VIGENTE aunque desde el
// 2026-09-03 dos reglas duras decidan: quien las aplica es
// src/modules/estudios/reglas-duras.ts, que corre ANTES del RPC y no depende
// de que este upsert funcione. Si esta escritura falla, el rechazo por regla
// dura ya quedo registrado igual.
//
// TRES REGLAS DE ESTE ARCHIVO
//   1. NUNCA lanza. Devuelve void y traga todo con logger.warn. El call site
//      no tiene que defenderse.
//   2. Escritura idempotente: upsert por (estudio_id, modelo_version). Un
//      estudio puede pasar por el RPC mas de una vez — reintento tras
//      'fallido' y re-consulta al otro buro son caminos reales — y la segunda
//      corrida debe SOBRESCRIBIR a la primera, no acumularse: si el buro
//      cambio de TransUnion a DataCredito, el scorecard viejo esta obsoleto.
//   3. Persiste TODAS las corridas, tambien las vacias. Hasta el 2026-09-08 una
//      corrida sin puntaje (no-hit, thin file, buro degradado) no dejaba fila,
//      y con ella se perdia justo la traza que pide la Politica §9
//      (apis_fallidas, session_id, tiempo_procesamiento_ms, factor...). La fila
//      va con decision_sombra = 'no_calculable' y el motivo, que es lo que el
//      CHECK de la tabla admite sin puntaje; el cruce agregado la filtra por
//      esa columna.
//
// NOTA sobre estudios.canon_evaluado: la migracion agrega esa columna como el
// hogar definitivo del canon congelado, pero el motor sombra NO la escribe. El
// congelamiento pertenece a la ruta REAL de ejecucion del estudio (antes de
// llamar al buro) y meterlo aqui obligaria a este modulo a escribir en
// `estudios`, que es justo lo que la regla de aislamiento prohibe. El canon
// que uso esta corrida queda en estudios_scorecard_sombra.canon_evaluado_cop.
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { MODELO_VERSION, evaluarSombra } from './index';
import type { SalidaSombra } from './index';
import { construirFilaSombra, puntajesDesdeFila, type ContextoEjecucion } from './fila';
import { OPCIONES_V7, OPCIONES_V9, recalcularConRevisionManual, type OpcionV7, type OpcionV9 } from './scorecard';
import { getCalibracion } from '@/lib/calibracion';

export interface ArgsScorecardSombra {
  estudioId: string;
  expedienteId: string;
  /** Si no viene, se lee de la fila del estudio. */
  proveedor?: string | null;
  /** `ProviderResult.datos_crudos` en memoria. Si no viene, se lee
   *  `estudios.respuesta_proveedor`. */
  datosCrudos?: Record<string, unknown> | null;
  /** `estudios.score` — respaldo de V1 en el registro manual. */
  scorePersistido?: number | null;
  /**
   * Corrida del motor YA evaluada por el punto de decision de reglas duras
   * (reglas-duras.ts), que corre antes del RPC. Cuando viene, esta funcion no
   * vuelve a leer ni a evaluar: solo persiste.
   *
   * No invierte la dependencia — la decision NO espera nada de aqui. Es al
   * reves: se pasa para que la fila sombra cuente exactamente la misma corrida
   * que decidio, en vez de una segunda evaluacion con otra fecha y, si el
   * gestor movio el canon del inmueble en el intervalo, otros ratios.
   */
  salidaPrecalculada?: SalidaSombra | null;
  /** Politica §9: apis_fallidas, tiempo, session_id, analista. */
  contexto?: ContextoEjecucion;
}

/**
 * Canon mensual del inmueble asociado al expediente, en PESOS.
 *
 * `inmuebles.valor_arriendo` es el canon: NO existe ninguna columna llamada
 * "canon". Se usa el del inmueble y no `contratos.valor_arriendo` porque en el
 * momento del estudio todavia no hay contrato.
 *
 * Dos queries encadenadas en vez de un embed de PostgREST: el embed es mas
 * corto pero sensible a la ambiguedad de FKs, y este camino no puede fallar
 * por sintaxis de relacion.
 */
async function obtenerCanon(expedienteId: string): Promise<number | null> {
  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('inmueble_id')
    .eq('id', expedienteId)
    .maybeSingle();

  const inmuebleId = (exp as { inmueble_id?: string | null } | null)?.inmueble_id;
  if (!inmuebleId) return null;

  const { data: inm } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('valor_arriendo')
    .eq('id', inmuebleId)
    .maybeSingle();

  const valor = (inm as { valor_arriendo?: number | string | null } | null)?.valor_arriendo;
  const n = typeof valor === 'string' ? Number(valor) : valor;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Calcula el scorecard V4.1 en sombra y lo persiste. Best-effort total: no
 * lanza, no bloquea, no toca el resultado del estudio.
 */
export async function registrarScorecardSombra(args: ArgsScorecardSombra): Promise<void> {
  const { estudioId, expedienteId } = args;
  try {
    // 0. Corrida ya evaluada por el punto de decision: no se repite nada.
    if (args.salidaPrecalculada) {
      await persistirFila(estudioId, args.salidaPrecalculada, args.contexto);
      return;
    }

    // 1. Completar lo que no vino del call site. El registro manual no tiene
    //    ni proveedor ni payload en scope, asi que se leen de la fila.
    let proveedor = args.proveedor ?? null;
    let payload: unknown = args.datosCrudos ?? null;
    let scorePersistido = args.scorePersistido ?? null;

    if (!proveedor || !payload) {
      const { data: row } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('proveedor, respuesta_proveedor, score')
        .eq('id', estudioId)
        .maybeSingle();
      const est = row as {
        proveedor?: string | null;
        respuesta_proveedor?: Record<string, unknown> | null;
        score?: number | null;
      } | null;
      proveedor = proveedor ?? est?.proveedor ?? null;
      payload = payload ?? est?.respuesta_proveedor ?? null;
      scorePersistido = scorePersistido ?? est?.score ?? null;
    }

    // 2. Canon congelado para esta corrida.
    const canon = await obtenerCanon(expedienteId);

    // 3. Evaluar. evaluarSombra nunca lanza. Mismos parametros del panel que
    //    usa el punto de decision, para que sombra y decision cuenten lo mismo.
    const cal = await getCalibracion();
    const salida = evaluarSombra({
      proveedor,
      payload,
      canon_mensual_cop: canon,
      score_persistido: scorePersistido,
      factor_ajuste_ingreso: cal.FACTOR_AJUSTE_INGRESO,
      umbral_aprobado: cal.UMBRAL_APROBACION_AUTOMATICA,
      umbral_revision: cal.UMBRAL_ZONA_GRIS,
      umbral_score_rechazo: cal.UMBRAL_SCORE_RECHAZO,
      umbral_score_revision: cal.UMBRAL_SCORE_REVISION,
    });

    // 4-5. Upsert idempotente (tambien de la corrida vacia: regla 3).
    await persistirFila(estudioId, salida, args.contexto);
  } catch (err) {
    logger.warn(
      { estudioId, expedienteId, err: err instanceof Error ? err.message : String(err) },
      'scorecard sombra fallo — el estudio se completo igual',
    );
  }
}

export interface EvaluacionRevisionManual {
  estabilidad_laboral: OpcionV7;
  arrendamiento_previo: OpcionV9;
}

export interface RecalculoRevisionManual {
  puntaje_normalizado: number | null;
  denominador: number;
  variables_participantes: string[];
  estabilidad_laboral: { opcion: OpcionV7; puntos: number };
  arrendamiento_previo: { opcion: OpcionV9; puntos: number };
  puntaje_automatico: number | null;
  denominador_automatico: number | null;
}

/**
 * Adenda 2 §4.3: recalcula la ultima corrida del estudio con V7 y V9 puntuados
 * por el analista y la guarda en features_crudas.revision_manual, que es lo que
 * leen el CRC y el log. NO toca puntaje_normalizado ni decision_sombra: esos
 * son la corrida AUTOMATICA, la que Gerencia cruza para calibrar.
 *
 * Sin corrida, o sin puntaje automatico (nada calculable), no hay nada que
 * recalcular: devuelve null. Nunca lanza, como el resto de este archivo.
 */
export async function recalcularEnRevisionManual(
  estudioId: string,
  analistaId: string,
  evaluacion: EvaluacionRevisionManual,
): Promise<RecalculoRevisionManual | null> {
  try {
    const { data, error } = await (supabase
      .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
      .select('id, puntaje_normalizado, puntaje_por_variable, features_crudas')
      .eq('estudio_id', estudioId)
      .order('fecha_calculo', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const fila = data as {
      id: string;
      puntaje_normalizado: number | string | null;
      puntaje_por_variable: unknown;
      features_crudas: Record<string, unknown> | null;
    } | null;
    const num = (v: unknown) => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    };
    if (!fila || num(fila.puntaje_normalizado) === null) return null;

    const { estabilidad_laboral: v7, arrendamiento_previo: v9 } = evaluacion;
    const totales = recalcularConRevisionManual(puntajesDesdeFila(fila.puntaje_por_variable), v7, v9);
    const crudas = fila.features_crudas ?? {};
    const recalculo: RecalculoRevisionManual = {
      puntaje_normalizado: totales.puntaje_normalizado,
      denominador: totales.denominador,
      variables_participantes: totales.variables_participantes,
      estabilidad_laboral: { opcion: v7, puntos: OPCIONES_V7[v7].puntos },
      arrendamiento_previo: { opcion: v9, puntos: OPCIONES_V9[v9].puntos },
      puntaje_automatico: num(fila.puntaje_normalizado),
      denominador_automatico: num(crudas.denominador_normalizacion),
    };

    const { error: updErr } = await (supabase
      .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
      .update({
        features_crudas: { ...crudas, revision_manual: { ...recalculo, analista_id: analistaId, fecha: new Date().toISOString() } },
      } as never)
      .eq('id', fila.id);
    if (updErr) throw new Error(updErr.message);

    logger.info({ estudioId, ...recalculo }, 'scorecard: puntaje recalculado en revision manual (Adenda 2 §4.3)');
    return recalculo;
  } catch (err) {
    logger.warn(
      { estudioId, err: err instanceof Error ? err.message : String(err) },
      'scorecard: no se pudo recalcular en revision manual — la decision del analista queda igual',
    );
    return null;
  }
}

/**
 * Upsert idempotente por (estudio_id, modelo_version). Extraido para que el
 * camino con salida precalculada y el que evalua aqui escriban por el mismo
 * sitio.
 *
 * Una corrida sin ninguna variable calculable tambien se escribe (regla 3 del
 * encabezado): no mide el scorecard, pero SI deja la traza de ejecucion del
 * §9. construirFilaSombra la encuadra como 'no_calculable' con su motivo.
 */
async function persistirFila(estudioId: string, salida: SalidaSombra, contexto: ContextoEjecucion = {}): Promise<void> {
  if (salida.puntaje_normalizado === null) {
    logger.debug(
      { estudioId, proveedor: salida.proveedor, motivo: salida.motivo_no_calculable ?? salida.decision_motivo },
      'scorecard sombra: sin variables calculables — se persiste solo la traza (§9)',
    );
  }

  const { error } = await (supabase
    .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
    .upsert(construirFilaSombra(estudioId, salida, contexto) as never, {
      onConflict: 'estudio_id,modelo_version',
    });

  if (error) {
    logger.warn(
      { estudioId, error: error.message, modeloVersion: MODELO_VERSION },
      'scorecard sombra: no se pudo persistir — el estudio no se ve afectado',
    );
    return;
  }

  logger.info(
    {
      estudioId,
      proveedor: salida.proveedor,
      decisionSombra: salida.decision_sombra,
      puntaje: salida.puntaje_normalizado,
      techo: salida.puntaje_maximo_alcanzable,
      modeloVersion: salida.modelo_version,
      reglasDuras: salida.reglas_duras.map((r) => r.codigo),
    },
    'scorecard sombra calculado',
  );
}
