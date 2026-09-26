// ============================================================
// Decision del estudio con el scorecard — Adenda 1 §2 (cascada) y §3 (bandas)
// ------------------------------------------------------------
// FUNCIONES PURAS. Reciben la salida del motor y los umbrales del panel;
// devuelven que hacer. No saben de Supabase, ni de proveedores, ni de fechas.
// Es lo que cubre scripts/check-decision-adenda.ts con la matriz de casos.
//
// Solo se aplican con MOTOR_DECIDE_ENABLED=true (estudios.service.ts). Con el
// flag apagado el buro sigue decidiendo y esto no se llama.
//
// ── Adenda §2.1, la cascada, literal ──────────────────────────
//   Paso 1. Consulta Datacredito.
//   Paso 2. Evalua reglas duras con la informacion de Datacredito. Si alguna
//           se activa, RECHAZADO y NO se consulta TransUnion.
//   Paso 3. Si no hay regla dura, calcula el puntaje normalizado.
//   Paso 4. < 40: RECHAZADO, no se consulta TransUnion.
//           >= 90: APROBADO, no se consulta TransUnion.
//           40 a 89: se consulta TransUnion, se promedian ambos scores y se
//           aplica la tabla de decision completa.
//   §2.3   Si Datacredito no responde, TransUnion pasa a ser la primaria con
//           los mismos umbrales. Si ninguna responde, Seccion 14 (revision).
//
// ── Adenda §3, las bandas, literal ────────────────────────────
//   85 a 100                                    APROBADO AUTOMATICO
//   70 a 84 con coarrendatario >= 80            APROBACION AUTOMATICA CONDICIONADA
//   70 a 84 sin coarrendatario (o con 70-79)    REVISION MANUAL
//   70 a 84 con coarrendatario < 70             RECHAZADO (matriz QA V2, caso O)
//     ...salvo coarrendatario con score 450-599 REVISION MANUAL + conflicto (nota §5)
//   < 70                                        RECHAZADO
//
// ── Politica §3.1, jerarquia ──────────────────────────────────
//   Score externo 450-599 -> REVISION MANUAL aunque el puntaje diga otra cosa.
//   Caso G (diferencia > 80 entre centrales) -> REVISION MANUAL.
//   §14: fuentes caidas / listas sin verificar / identidad sin validar ->
//   nunca aprobacion automatica (los motivos llegan ya calculados).
//
// "Revision manual" en este sistema es resultado 'condicionado' (ruta
// en_revision para el prospecto): el analista lo aprueba o lo rechaza.
// ============================================================

import { evaluarSombra, type SalidaSombra } from './motor';

export type ResultadoDecidido = 'aprobado' | 'condicionado' | 'rechazado';

/**
 * Matriz QA V2, caso R2 (sin definir): la Politica (tabla de reglas duras:
 * afianzado < 70 con coarrendatario alto = rechazo) y la Adenda 2 §2 (score
 * 450-599 = revision manual con prioridad sobre el < 70) chocan. Mientras la
 * Gerencia no defina, la salida es la conservadora —revision manual— y la
 * traza lo dice con este texto.
 */
const CONFLICTO_PENDIENTE = 'Conflicto de reglas pendiente de definición de la Gerencia';
export const CONFLICTO_REGLAS_R2 = `${CONFLICTO_PENDIENTE} (Política tabla reglas duras vs Adenda 2 punto 2).`;

/**
 * R2 del lado del coarrendatario: titular 70-84 con coarrendatario < 70 es el
 * caso O (rechazo), pero si el coarrendatario tiene score 450-599 la Adenda 2
 * §2 lo manda a revision manual con prioridad sobre el < 70. Sin definicion de
 * la Gerencia, misma salida conservadora que R2 (nota §5).
 */
export const CONFLICTO_REGLAS_COARRENDATARIO = `${CONFLICTO_PENDIENTE} (coarrendatario: matriz QA V2 caso O vs Adenda 2 punto 2).`;

export interface UmbralesDecision {
  cascadaRechazo: number;
  cascadaAprobacion: number;
  aprobacion: number;
  zonaGris: number;
  coarrendatario: number;
}

export interface DecisionCascada {
  /** true = hay que consultar la segunda central antes de decidir. */
  consultarSecundaria: boolean;
  /** Resultado que ya se puede afirmar SIN la segunda central (o null). */
  resultadoAnticipado: 'rechazado' | 'aprobado' | null;
  motivo: string;
}

/**
 * Adenda §2.1 sobre la corrida de la central PRIMARIA. Decide unicamente si
 * hace falta la segunda consulta; el resultado final lo da decidirResultado.
 *
 * `reglasDurasActivas` son las que YA decidieron (la lista blanca de
 * reglas-duras.ts), no todas las que el motor mide.
 */
export function decidirCascada(
  primaria: SalidaSombra,
  reglasDurasActivas: readonly string[],
  u: UmbralesDecision,
): DecisionCascada {
  if (reglasDurasActivas.length > 0) {
    return {
      consultarSecundaria: false,
      resultadoAnticipado: 'rechazado',
      motivo: `regla dura con la primaria (${reglasDurasActivas.join(', ')}): rechazado sin consultar la segunda central`,
    };
  }
  const p = primaria.puntaje_normalizado;
  if (p === null) {
    // Politica §4.1: la ausencia de score en una central no rechaza; se busca
    // en la otra ("si una sola central reporta score, se usa ese score").
    return { consultarSecundaria: true, resultadoAnticipado: null, motivo: 'la primaria no produjo puntaje: se consulta la segunda central' };
  }
  // Adenda 2 §2: score 450-599 = revision manual con prioridad sobre el
  // rechazo por puntaje. Ni el < 40 ni el >= 90 se anticipan: se consulta la
  // segunda y decidirResultado aplica la jerarquia sobre el score promedio.
  if (primaria.revision_obligatoria) {
    return {
      consultarSecundaria: true,
      resultadoAnticipado: null,
      motivo: `${primaria.revision_obligatoria}: prevalece sobre el puntaje ${p}; se consulta la segunda central`,
    };
  }
  if (p < u.cascadaRechazo) {
    return {
      consultarSecundaria: false,
      resultadoAnticipado: 'rechazado',
      motivo: `puntaje ${p} < ${u.cascadaRechazo} con la primaria: ni 100 en la segunda alcanzaria el umbral de revision`,
    };
  }
  if (p >= u.cascadaAprobacion) {
    return {
      consultarSecundaria: false,
      resultadoAnticipado: 'aprobado',
      motivo: `puntaje ${p} >= ${u.cascadaAprobacion} con la primaria: aprobado sin consultar la segunda central (asuncion de riesgo, Adenda §2.2)`,
    };
  }
  return {
    consultarSecundaria: true,
    resultadoAnticipado: null,
    motivo: `puntaje ${p} entre ${u.cascadaRechazo} y ${u.cascadaAprobacion - 1}: se consulta la segunda central y se promedian los scores`,
  };
}

export interface EntradaDecision {
  /** Corrida final: la combinada si se consulto la segunda central, si no la primaria. */
  salida: SalidaSombra;
  /** Reglas duras que YA decidieron (lista blanca). */
  reglasDurasActivas: readonly string[];
  u: UmbralesDecision;
  /**
   * Coarrendatario evaluado, si lo hay. `scoreEnBandaRevision`: su score cae
   * en la banda 450-599 (revision_obligatoria de su corrida, sin Caso G).
   */
  coarrendatario?: { puntaje: number | null; reglaDura: boolean; scoreEnBandaRevision?: boolean } | null;
  /** §14 / §16.5 / §8: motivos que impiden la aprobacion automatica. */
  motivosRevision: readonly string[];
}

export interface Decision {
  resultado: ResultadoDecidido;
  /** Para el gestor: la regla que decidio, con cifras. */
  motivo: string;
  /** Fila de la tabla de tarifas (Adenda §5). */
  via: 'automatica' | 'condicionada_coarrendatario' | 'revision_manual' | null;
  /**
   * Decidido solo por el puntaje (pasos 6-7): sin regla dura, sin revision
   * obligatoria (§3.1 / Caso G) ni motivos §14/§15/§8. Va a la traza
   * (`sin_flags`): la ponderacion con el coarrendatario lo exige para aprobar
   * sola (Politica §5, nota: "ambos evaluados por flujo automatico y sin flags").
   */
  sinFlags?: true;
}

/**
 * Adenda §3 + Politica §3.1/§14 sobre la corrida FINAL. Orden = jerarquia.
 */
export function decidirResultado(e: EntradaDecision): Decision {
  const { salida, u } = e;
  const p = salida.puntaje_normalizado;

  // 1. Reglas duras (§6): anulan todo, incluido el coarrendatario (§5).
  if (e.reglasDurasActivas.length > 0) {
    return { resultado: 'rechazado', motivo: `Regla dura: ${e.reglasDurasActivas.join(', ')}`, via: null };
  }

  // 2. Sin puntaje: ninguna central pudo evaluar. §14: revision manual, nunca rechazo.
  if (p === null || salida.decision_sombra === 'no_calculable') {
    return { resultado: 'condicionado', motivo: `Sin puntaje calculable (${salida.motivo_no_calculable ?? 'ninguna variable calculable'}): revision manual (Politica §14)`, via: 'revision_manual' };
  }

  // 3. Jerarquia §3.1 (score 450-599) y Caso G: revision obligatoria que
  //    ningun coarrendatario levanta. La revision "por banda" (70-84) NO es
  //    esta: esa se resuelve abajo, donde el coarrendatario si cuenta.
  //    Matriz QA V2, F1/F2: el motivo lleva tambien los demas motivos de
  //    revision (p. ej. ingreso no inferible), sin repetir el de la banda, que
  //    ya viene dentro de motivosRevision (resolverResultadoEstudio lo junta).
  if (salida.revision_obligatoria) {
    const ro = salida.revision_obligatoria;
    const otros = e.motivosRevision.map((m) => m.replace(ro, '').trim()).filter(Boolean);
    const coa = e.coarrendatario ?? null;
    // R2: banda de score (no Caso G) + puntaje < 70 + coarrendatario >= 80.
    const conflictoR2 =
      !salida.inconsistencia_score_buros &&
      p < u.zonaGris &&
      !!coa &&
      !coa.reglaDura &&
      coa.puntaje !== null &&
      coa.puntaje >= u.coarrendatario;
    return {
      resultado: 'condicionado',
      motivo: [ro, ...otros, conflictoR2 ? CONFLICTO_REGLAS_R2 : null].filter(Boolean).join(' '),
      via: 'revision_manual',
    };
  }

  // 4. < 70: rechazado. "Ningun coarrendatario compensa" (§5).
  if (p < u.zonaGris) {
    return { resultado: 'rechazado', motivo: `Puntaje ${p} < ${u.zonaGris}`, via: null };
  }

  // 5. Flags que impiden aprobar en automatico (§14 listas/identidad, §16.5, §8).
  if (e.motivosRevision.length > 0) {
    return { resultado: 'condicionado', motivo: e.motivosRevision.join(' '), via: 'revision_manual' };
  }

  // 6. >= 85: aprobado automatico.
  if (p >= u.aprobacion) {
    return { resultado: 'aprobado', motivo: `Puntaje ${p} >= ${u.aprobacion}: aprobacion automatica`, via: 'automatica', sinFlags: true };
  }

  // 7. Zona gris 70-84: el coarrendatario es la palanca (Adenda §3).
  const coa = e.coarrendatario ?? null;
  if (coa && !coa.reglaDura && coa.puntaje !== null && coa.puntaje >= u.coarrendatario) {
    return {
      resultado: 'aprobado',
      motivo: `Puntaje ${p} en zona gris con coarrendatario ${coa.puntaje} >= ${u.coarrendatario}: aprobacion automatica condicionada (Adenda §3)`,
      via: 'condicionada_coarrendatario',
      sinFlags: true,
    };
  }
  // Matriz QA V2, caso O: coarrendatario < 70 no compensa y el caso se rechaza.
  // Entre 70 y el umbral del coarrendatario sigue en revision manual (abajo).
  if (coa && !coa.reglaDura && coa.puntaje !== null && coa.puntaje < u.zonaGris) {
    if (coa.scoreEnBandaRevision) {
      return {
        resultado: 'condicionado',
        motivo: `Puntaje ${p} en zona gris y coarrendatario ${coa.puntaje} < ${u.zonaGris} con score en la banda de revision obligatoria: revision manual. ${CONFLICTO_REGLAS_COARRENDATARIO}`,
        via: 'revision_manual',
        sinFlags: true,
      };
    }
    return {
      resultado: 'rechazado',
      motivo: `Puntaje ${p} en zona gris y coarrendatario ${coa.puntaje} < ${u.zonaGris}: el coarrendatario no compensa (matriz QA V2, caso O)`,
      via: null,
      sinFlags: true,
    };
  }
  return {
    resultado: 'condicionado',
    motivo: coa
      ? `Puntaje ${p} en zona gris y coarrendatario ${coa.reglaDura ? 'con regla dura' : `${coa.puntaje ?? 's/p'} < ${u.coarrendatario}`}: revision manual`
      : `Puntaje ${p} en zona gris (${u.zonaGris}-${u.aprobacion - 1}) sin coarrendatario: revision manual, o coarrendatario >= ${u.coarrendatario}`,
    via: 'revision_manual',
    sinFlags: true,
  };
}

// ============================================================
// Traza de la cascada (estudios.cascada) — Adenda §2.4, Politica §9 y
// matriz QA V2 §2.5 ("en los casos de cascada debe verificarse cuantas
// centrales se consultaron").
// ============================================================

export interface EntradaTrazaCascada {
  /** Central que actuo como primaria en esta ejecucion. */
  primaria: string;
  /** Adenda §2.3: central que no respondio y le cedio la primaria. */
  centralCaida: string | null;
  salidaPrimaria: SalidaSombra;
  /** decidirCascada(...).motivo */
  decisionCascada: string;
  /** Segunda central que RESPONDIO, o null. */
  secundaria: string | null;
  scoreSecundaria: number | null;
  /** Centrales que no respondieron en esta ejecucion. */
  apisFallidas: readonly string[];
  /** Corrida final (la combinada si respondio la segunda). */
  salida: SalidaSombra;
  decision: Decision;
  u: UmbralesDecision;
  decididoEn: string;
}

/** Lo que se guarda en `estudios.cascada`. Pura. */
export function construirTrazaCascada(t: EntradaTrazaCascada) {
  return {
    modelo_version: t.salida.modelo_version,
    primaria: t.primaria,
    primaria_original: t.centralCaida ?? t.primaria,
    fallback_2_3: !!t.centralCaida,
    // Las que respondieron y entraron a la decision (0, 1 o 2).
    centrales_consultadas: [t.primaria, t.secundaria].filter((c): c is string => !!c && !t.apisFallidas.includes(c)),
    apis_fallidas: [...new Set(t.apisFallidas)],
    puntaje_primaria: t.salidaPrimaria.puntaje_normalizado,
    decision_cascada: t.decisionCascada,
    secundaria_consultada: t.secundaria !== null,
    secundaria: t.secundaria,
    score_secundaria: t.scoreSecundaria,
    puntaje_final: t.salida.puntaje_normalizado,
    // Adenda 2 §4.3: denominador aplicado y variables que participaron.
    denominador: t.salida.denominador_normalizacion,
    variables_participantes: t.salida.variables_participantes,
    fuente_score: t.salida.fuente_score_externo,
    scores_individuales: t.salida.scores_individuales,
    resultado: t.decision.resultado,
    via: t.decision.via,
    decision: t.decision.motivo,
    // Politica §5 nota: lo lee la ponderacion con el coarrendatario (ponderacion.ts).
    sin_flags: t.decision.sinFlags === true,
    umbrales: t.u,
    decidido_en: t.decididoEn,
  };
}

/**
 * Politica §14 / matriz QA V2, caso L: ni la primaria ni la central de
 * respaldo (Adenda §2.3) respondieron. Revision manual obligatoria, nunca
 * aprobacion automatica; fuente_score_externo = NO_DISPONIBLE.
 */
export function decidirSinCentrales(a: { primaria: string; centralCaida: string; u: UmbralesDecision; decididoEn: string }) {
  const salida = evaluarSombra({ proveedor: a.primaria, payload: null, fecha_evaluacion: a.decididoEn });
  const decision = decidirResultado({ salida, reglasDurasActivas: [], u: a.u, coarrendatario: null, motivosRevision: [] });
  const apisFallidas = [a.centralCaida, a.primaria];
  const traza = construirTrazaCascada({
    primaria: a.primaria,
    centralCaida: a.centralCaida,
    salidaPrimaria: salida,
    decisionCascada: 'ninguna central respondio: no hay cascada (Politica §14)',
    secundaria: null,
    scoreSecundaria: null,
    apisFallidas,
    salida,
    decision,
    u: a.u,
    decididoEn: a.decididoEn,
  });
  return { salida, decision, apisFallidas, traza };
}
