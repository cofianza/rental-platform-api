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
// sombra, no solo una promesa del try/catch.
//
// TRES REGLAS DE ESTE ARCHIVO
//   1. NUNCA lanza. Devuelve void y traga todo con logger.warn. El call site
//      no tiene que defenderse.
//   2. Escritura idempotente: upsert por (estudio_id, modelo_version). Un
//      estudio puede pasar por el RPC mas de una vez — reintento tras
//      'fallido' y re-consulta al otro buro son caminos reales — y la segunda
//      corrida debe SOBRESCRIBIR a la primera, no acumularse: si el buro
//      cambio de TransUnion a DataCredito, el scorecard viejo esta obsoleto.
//   3. No persiste corridas vacias. Si ninguna variable resulto calculable no
//      hay nada que medir y la fila solo ensuciaria el cruce agregado.
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
import { construirFilaSombra } from './fila';

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

    // 3. Evaluar. evaluarSombra nunca lanza.
    const salida = evaluarSombra({
      proveedor,
      payload,
      canon_mensual_cop: canon,
      score_persistido: scorePersistido,
    });

    // 4. Una corrida sin ninguna variable calculable no mide nada: se registra
    //    en el log y no se escribe fila.
    if (salida.puntaje_normalizado === null) {
      logger.debug(
        { estudioId, proveedor, motivo: salida.motivo_no_calculable },
        'scorecard sombra: sin variables calculables, no se persiste',
      );
      return;
    }

    // 5. Upsert idempotente por (estudio_id, modelo_version).
    const { error } = await (supabase
      .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
      .upsert(construirFilaSombra(estudioId, salida) as never, {
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
      },
      'scorecard sombra calculado (no afecta la decision del estudio)',
    );
  } catch (err) {
    logger.warn(
      { estudioId, expedienteId, err: err instanceof Error ? err.message : String(err) },
      'scorecard sombra fallo — el estudio se completo igual',
    );
  }
}
