// ============================================================
// Motor de scorecard V4.1 — ORQUESTADOR
// ------------------------------------------------------------
// evaluarSombra() = extraccion de features + scorecard + decision hipotetica.
//
// EL NOMBRE YA NO ES DEL TODO EXACTO (2026-09-03). El scorecard entero sigue
// en sombra —puntajes, umbrales 85/70, decision_sombra—, pero DOS de las
// reglas duras que salen en `reglas_duras` YA DECIDEN el resultado real:
// 'dti_mayor_65' (§4.2) y 'canon_ingreso_mayor_40' (§4.3), autorizadas por
// Gerencia. Quien las aplica es src/modules/estudios/reglas-duras.ts, que las
// filtra por lista blanca; esta funcion sigue sin aplicar nada por su cuenta.
// El nombre se conserva porque la version del modelo persistida lo lleva.
//
// INVARIANTE MAS IMPORTANTE DEL ARCHIVO: NUNCA LANZA. Con cualquier entrada —
// null, undefined, {}, un payload de otro buro, un string — devuelve una
// SalidaSombra valida. El motor corre despues de que el resultado real ya
// quedo registrado, asi que una excepcion aqui no puede llegar a tumbar nada;
// pero el contrato explicito ahorra tener que razonarlo en cada call site.
//
// `decision_sombra` NO se aplica: convive con `estudios.resultado` para poder
// cruzarlas, no para reemplazarla. Lo unico de esta salida que llega a la
// decision real es `reglas_duras`, y solo los dos codigos de la lista blanca
// de reglas-duras.ts.
// ============================================================

import {
  MAX_BRUTO_MODELO,
  PUNTOS_MAXIMOS,
  UMBRAL_APROBADO,
  UMBRAL_REVISION,
  decidirSombra,
  mesesEntre,
  porcentaje,
  porcentajeParaMostrar,
  puntajeV1ScoreExterno,
  puntajeV2Dti,
  puntajeV3CanonIngreso,
  puntajeV4SeguridadSocial,
  puntajeV5Experiencia,
  puntajeV6Comportamiento,
  puntajeV7EstabilidadLaboral,
  puntajeV8Antiguedad,
  puntajeV9ArrendamientoPrevio,
  totalizar,
} from './scorecard';
import type {
  CodigoReglaDura,
  CodigoVariable,
  DecisionSombra,
  PuntajeVariable,
  TotalesScorecard,
} from './scorecard';
import { extraerFeatures, featuresVacias } from './features';
import type { FeaturesBuro } from './features';

export * from './scorecard';
export * from './features';

/**
 * Version del modelo. Cubre scorecard + extractor: si cambia COMO se leen las
 * features, cambia la version aunque los pesos sigan iguales. Se persiste en
 * cada corrida y forma parte de la clave unica, asi que recalcular el
 * historico con otra version no pisa lo que dijo esta.
 *
 * '6var' = las 6 variables con fuente hoy (V1, V2, V3, V5, V6, V8).
 * Maximo 20 caracteres (VARCHAR de la tabla).
 */
export const MODELO_VERSION = 'v4.1-sombra-6var';

export interface EntradaSombra {
  /** 'datacredito' | 'transunion' | ... Decide el extractor. */
  proveedor?: string | null;
  /** `ProviderResult.datos_crudos` o `estudios.respuesta_proveedor`. */
  payload?: unknown;
  /** Canon mensual del inmueble en PESOS (inmuebles.valor_arriendo). */
  canon_mensual_cop?: number | null;
  /** `estudios.score` — respaldo de V1 cuando el payload no trae score
   *  (registro manual). Se etiqueta como modelo 'PERSISTIDO' porque su escala
   *  es desconocida y no debe compararse con la de un buro. */
  score_persistido?: number | null;
  /** ISO inyectada para que la evaluacion sea reproducible en los checks. */
  fecha_evaluacion?: string | null;
}

export interface ReglaDuraActivada {
  codigo: CodigoReglaDura;
  variable: CodigoVariable;
  detalle: string;
}

export interface SalidaSombra {
  modelo_version: string;
  /** Literal: este objeto no decide nada. */
  modo: 'sombra';
  fecha_evaluacion: string;
  proveedor: string;

  features: FeaturesBuro;
  puntajes: PuntajeVariable[];

  puntaje_bruto: number;
  puntaje_bruto_maximo_modelo: number;
  puntaje_bruto_alcanzable: number;
  puntaje_normalizado: number | null;
  puntaje_maximo_alcanzable: number | null;
  puntaje_topado: boolean;

  /** Ratios derivados, en % con un decimal. null cuando falta el ingreso. */
  dti_pct: number | null;
  canon_ingreso_pct: number | null;
  canon_evaluado_cop: number | null;
  antiguedad_historial_meses: number | null;

  umbral_aprobado: number;
  umbral_revision: number;
  decision_sombra: DecisionSombra;
  decision_motivo: string;
  motivo_no_calculable: string | null;

  reglas_duras: ReglaDuraActivada[];
  variables_no_calculables: CodigoVariable[];
  advertencias: string[];
}

const ETIQUETA_VARIABLE: Record<CodigoVariable, string> = {
  V1: 'score externo',
  V2: 'DTI',
  V3: 'canon / ingreso',
  V4: 'seguridad social',
  V5: 'experiencia crediticia',
  V6: 'comportamiento reciente',
  V7: 'estabilidad laboral',
  V8: 'antiguedad del historial',
  V9: 'arrendamiento previo',
};

function salidaDegradada(proveedor: string, fecha: string, motivo: string): SalidaSombra {
  return {
    modelo_version: MODELO_VERSION,
    modo: 'sombra',
    fecha_evaluacion: fecha,
    proveedor,
    features: featuresVacias(proveedor),
    puntajes: [],
    puntaje_bruto: 0,
    puntaje_bruto_maximo_modelo: MAX_BRUTO_MODELO,
    puntaje_bruto_alcanzable: 0,
    puntaje_normalizado: null,
    puntaje_maximo_alcanzable: null,
    puntaje_topado: true,
    dti_pct: null,
    canon_ingreso_pct: null,
    canon_evaluado_cop: null,
    antiguedad_historial_meses: null,
    umbral_aprobado: UMBRAL_APROBADO,
    umbral_revision: UMBRAL_REVISION,
    decision_sombra: 'no_calculable',
    decision_motivo: motivo,
    motivo_no_calculable: motivo,
    reglas_duras: [],
    variables_no_calculables: ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'],
    advertencias: [motivo],
  };
}

/** Numero positivo utilizable, o null. Filtra NaN, Infinity, negativos y los
 *  strings que llegan desde la BD (NUMERIC de PostgREST viaja como string). */
function montoPositivo(valor: unknown): number | null {
  const n = typeof valor === 'string' ? Number(valor) : valor;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Calcula el scorecard V4.1 en modo sombra. Nunca lanza.
 */
export function evaluarSombra(entrada?: EntradaSombra | null): SalidaSombra {
  const fecha = (() => {
    const f = entrada?.fecha_evaluacion;
    return typeof f === 'string' && f.trim() !== '' ? f : new Date().toISOString();
  })();
  const proveedor = String(entrada?.proveedor ?? '').trim().toLowerCase() || 'desconocido';

  try {
    const features = extraerFeatures(proveedor, entrada?.payload);
    const advertencias: string[] = [];

    // ── V1: respaldo con el score persistido ────────────────
    // Solo cuando el payload no trajo score. Se etiqueta aparte porque un
    // score capturado a mano no tiene la misma escala que uno del buro.
    if (features.score_externo === null) {
      const persistido = montoPositivo(entrada?.score_persistido);
      if (persistido !== null) {
        features.score_externo = persistido;
        features.score_modelo = 'PERSISTIDO';
        advertencias.push(
          'V1 se calculo con estudios.score (capturado fuera del buro): su escala no es comparable con la de DataCredito ni TransUnion.',
        );
      }
    }

    // ── Insumos derivados ───────────────────────────────────
    const canon = montoPositivo(entrada?.canon_mensual_cop);
    const ingreso = features.ingreso_mensual_inferido_cop;
    const dtiPct = porcentaje(features.cuota_mensual_vigente_cop, ingreso);
    const canonIngresoPct = porcentaje(canon, ingreso);

    // Ancla de la antiguedad: el corte de los datos del buro, NO hoy. En la
    // evidencia real hay ~3 meses de rezago entre consultDate y el ultimo mes
    // con comportamiento; anclar en hoy inflaria la antiguedad y metaria en la
    // ventana de 6 meses meses sin dato, leyendolos como limpios.
    const ancla = features.fecha_corte_datos ?? features.fecha_consulta ?? fecha.slice(0, 10);
    const antiguedadMeses = mesesEntre(features.fecha_primera_obligacion, ancla);

    // ── Puntajes ────────────────────────────────────────────
    const puntajes: PuntajeVariable[] = [
      { variable: 'V1', puntos_maximos: PUNTOS_MAXIMOS.V1, ...puntajeV1ScoreExterno(features.score_externo) },
      { variable: 'V2', puntos_maximos: PUNTOS_MAXIMOS.V2, ...puntajeV2Dti(dtiPct) },
      { variable: 'V3', puntos_maximos: PUNTOS_MAXIMOS.V3, ...puntajeV3CanonIngreso(canonIngresoPct) },
      { variable: 'V4', puntos_maximos: PUNTOS_MAXIMOS.V4, ...puntajeV4SeguridadSocial() },
      { variable: 'V5', puntos_maximos: PUNTOS_MAXIMOS.V5, ...puntajeV5Experiencia(features.sectores, features.sin_historial_crediticio) },
      { variable: 'V6', puntos_maximos: PUNTOS_MAXIMOS.V6, ...puntajeV6Comportamiento(features) },
      { variable: 'V7', puntos_maximos: PUNTOS_MAXIMOS.V7, ...puntajeV7EstabilidadLaboral() },
      { variable: 'V8', puntos_maximos: PUNTOS_MAXIMOS.V8, ...puntajeV8Antiguedad(antiguedadMeses) },
      { variable: 'V9', puntos_maximos: PUNTOS_MAXIMOS.V9, ...puntajeV9ArrendamientoPrevio() },
    ];

    const totales: TotalesScorecard = totalizar(puntajes);
    const decision = decidirSombra(totales, features.score_externo, UMBRAL_APROBADO, UMBRAL_REVISION);

    const reglasDuras: ReglaDuraActivada[] = puntajes
      .filter((p) => p.reglaDura !== null)
      .map((p) => ({
        codigo: p.reglaDura as CodigoReglaDura,
        variable: p.variable,
        detalle: `${ETIQUETA_VARIABLE[p.variable]}: ${p.banda ?? ''} (valor ${String(p.valor ?? 's/d')})`.trim(),
      }));

    // ── Advertencias: lo que hace interpretable el numero ────
    if (totales.puntaje_topado) {
      advertencias.push(
        `Puntaje topado: solo ${totales.puntaje_bruto_alcanzable} de ${MAX_BRUTO_MODELO} puntos brutos eran alcanzables en esta corrida (faltan ${totales.variables_no_calculables.join(', ')}). La banda solo se puede leer junto a puntaje_maximo_alcanzable.`,
      );
    }
    if (proveedor === 'datacredito') {
      advertencias.push(
        'V6: la banda de mora 1-30 dias no es observable en DataCredito — su bucket mas fino es 30-59 dias, asi que toda mora reportada cae ya en ">30 dias".',
      );
    }
    if (features.ausencias.ingreso_mensual_inferido_cop === 'no_soportado') {
      advertencias.push(
        'V2 y V3 no son calculables: este buro no entrega ingreso inferido. Quedan en null, NO en 0.',
      );
    }
    // Mora observada que el modelo no puede ubicar en la ventana de 12 o 6
    // meses: sin fecha por slot no se puede afirmar la ventana, asi que V6 no
    // penaliza -15 ni dispara la regla dura. Se advierte de forma explicita
    // para que nadie lea este perfil como limpio: NO tener la ventana no es lo
    // mismo que no tener mora.
    if (
      (features.meses_con_mora_24m ?? 0) > 0 &&
      features.ausencias.meses_con_mora_12m === 'no_parseable'
    ) {
      advertencias.push(
        `V6: se observaron ${features.meses_con_mora_24m} mes(es) con mora en la ventana de 24 meses, pero este buro no fecha cada periodo, asi que no se puede determinar si caen dentro de los 12 o 6 meses que exige la politica. NO se aplico la penalizacion de -15 ni la regla dura, y tampoco se otorgo el bono. Este perfil NO es limpio: requiere revision del reporte.`,
      );
    }
    if (features.ausencias.saldo_total_cop === 'unidad_sin_verificar') {
      advertencias.push(
        'Los montos del consolidado de este buro llegaron sin unidad verificada contra su manual, asi que no se escribieron en las columnas en pesos. Quedan en features_crudas para no mezclar escalas.',
      );
    }
    if (dtiPct !== null) {
      advertencias.push(
        'El DTI es el del buro (cuota reportada / ingreso inferido). La politica §4.2 pide sumar la cuota de la fianza, que no esta cotizada al momento del estudio.',
      );
    }
    if (canon === null) {
      advertencias.push('Sin canon del inmueble: V3 (canon / ingreso) queda no calculable.');
    }

    return {
      modelo_version: MODELO_VERSION,
      modo: 'sombra',
      fecha_evaluacion: fecha,
      proveedor,
      features,
      puntajes,
      puntaje_bruto: totales.puntaje_bruto,
      puntaje_bruto_maximo_modelo: MAX_BRUTO_MODELO,
      puntaje_bruto_alcanzable: totales.puntaje_bruto_alcanzable,
      puntaje_normalizado: totales.puntaje_normalizado,
      puntaje_maximo_alcanzable: totales.puntaje_maximo_alcanzable,
      puntaje_topado: totales.puntaje_topado,
      // Se publican redondeados a 2 decimales para casar con las columnas
      // generadas de la tabla; las bandas y reglas duras ya se evaluaron
      // arriba sobre el ratio exacto.
      dti_pct: porcentajeParaMostrar(dtiPct),
      canon_ingreso_pct: porcentajeParaMostrar(canonIngresoPct),
      canon_evaluado_cop: canon,
      antiguedad_historial_meses: antiguedadMeses !== null && antiguedadMeses >= 0 ? antiguedadMeses : null,
      umbral_aprobado: UMBRAL_APROBADO,
      umbral_revision: UMBRAL_REVISION,
      decision_sombra: decision.decision,
      decision_motivo: decision.motivo,
      motivo_no_calculable: decision.decision === 'no_calculable' ? decision.motivo : null,
      reglas_duras: reglasDuras,
      variables_no_calculables: totales.variables_no_calculables,
      advertencias,
    };
  } catch (err) {
    // Ultimo blindaje. Los extractores ya son a prueba de payloads raros, asi
    // que llegar aqui significa un bug del motor — se degrada en vez de
    // propagar, porque el estudio real ya esta registrado y no puede tocarse.
    return salidaDegradada(
      proveedor,
      fecha,
      `El motor sombra no pudo evaluar: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
