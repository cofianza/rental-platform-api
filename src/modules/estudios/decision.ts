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
//     ...salvo coarrendatario con score 450-599 REVISION MANUAL (Adenda de precios §8.4)
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
import type { ReglaDuraActiva } from './reglas-duras';

/** Nombre legible de cada regla dura (notas, motivos y textos visibles). */
export const ETIQUETA_REGLA: Record<ReglaDuraActiva, string> = {
  score_menor_450: 'puntaje de las centrales de riesgo por debajo del mínimo',
  mora_vigente: 'mora vigente',
  mora_mayor_30d_6m: 'mora de más de 30 días en los últimos 6 meses',
  dti_mayor_65: 'capacidad de endeudamiento insuficiente',
  canon_ingreso_mayor_40: 'canon demasiado alto frente al ingreso',
  listas_restrictivas: 'reporte en listas restrictivas',
};
const etiquetas = (codigos: readonly string[]) =>
  codigos.map((c) => ETIQUETA_REGLA[c as ReglaDuraActiva] ?? c).join(', ');

const NOMBRE_CENTRAL: Record<string, string> = { DATACREDITO: 'DataCrédito', TRANSUNION: 'TransUnion' };

/** Motivo visible cuando el modelo (no una regla dura) no alcanza para aprobar. */
export const MOTIVO_VISIBLE_NO_ALCANZA = 'El resultado de la evaluación no alcanza el mínimo para aprobar.';

/** Puntaje con coma decimal (es-CO) para las notas internas del analista. */
const pts = (p: number | null | undefined) =>
  p === null || p === undefined ? 'sin dato' : new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(p);

export type ResultadoDecidido = 'aprobado' | 'condicionado' | 'rechazado';

/**
 * Matriz QA V2, caso R2 (definido por la Adenda de precios §8): score externo
 * 450-599 con puntaje < 70 y coarrendatario alto. La banda prevalece sobre el
 * rechazo por < 70 (Adenda 2 §2): revision manual, y la traza cita la regla.
 */
export const REGLA_R2 =
  'El puntaje de las centrales en el rango de revisión obligatoria prevalece sobre el resultado menor a 70 del modelo: revisión manual con prioridad baja.';

/**
 * Misma regla del lado del coarrendatario (Adenda de precios §8.4, aplicable a
 * cualquier caso): titular 70-84 con coarrendatario < 70 es el caso O (rechazo),
 * pero si el coarrendatario tiene score 450-599 la banda prevalece: revision manual.
 */
export const REGLA_BANDA_COARRENDATARIO =
  'El puntaje de las centrales del co-arrendatario en el rango de revisión obligatoria prevalece sobre su resultado menor a 70: revisión manual.';

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
      motivo: `Con la central primaria no se cumple una condición obligatoria (${etiquetas(reglasDurasActivas)}): se rechaza sin consultar la segunda central.`,
    };
  }
  const p = primaria.puntaje_normalizado;
  if (p === null) {
    // Politica §4.1: la ausencia de score en una central no rechaza; se busca
    // en la otra ("si una sola central reporta score, se usa ese score").
    return { consultarSecundaria: true, resultadoAnticipado: null, motivo: 'La central primaria no produjo puntaje: se consulta la segunda central.' };
  }
  // Adenda 2 §2: score 450-599 = revision manual con prioridad sobre el
  // rechazo por puntaje. Ni el < 40 ni el >= 90 se anticipan: se consulta la
  // segunda y decidirResultado aplica la jerarquia sobre el score promedio.
  if (primaria.revision_obligatoria) {
    return {
      consultarSecundaria: true,
      resultadoAnticipado: null,
      motivo: `${primaria.revision_obligatoria} Esto prevalece sobre el puntaje ${pts(p)} de la central primaria: se consulta la segunda central.`,
    };
  }
  if (p < u.cascadaRechazo) {
    return {
      consultarSecundaria: false,
      resultadoAnticipado: 'rechazado',
      motivo: `Puntaje ${pts(p)} con la central primaria, menor que ${u.cascadaRechazo}: ni el máximo en la segunda alcanzaría el umbral de revisión; se rechaza.`,
    };
  }
  if (p >= u.cascadaAprobacion) {
    return {
      consultarSecundaria: false,
      resultadoAnticipado: 'aprobado',
      motivo: `Puntaje ${pts(p)} con la central primaria, igual o mayor que ${u.cascadaAprobacion}: se aprueba sin consultar la segunda central.`,
    };
  }
  return {
    consultarSecundaria: true,
    resultadoAnticipado: null,
    motivo: `Puntaje ${pts(p)} con la central primaria, entre ${u.cascadaRechazo} y ${u.cascadaAprobacion - 1}: se consulta la segunda central y se promedian los puntajes.`,
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
  /**
   * Adenda 2 §9.3: el motivo de identidad (ResolucionEstudio.revisionIdentidad),
   * que ya viene DENTRO de motivosRevision. Manda a revision igual; solo sirve
   * para calcular `viaSinIdentidad`.
   */
  motivoIdentidad?: string | null;
}

/** Franja 70-84 (Adenda §3), en palabras para la inmobiliaria. */
export const MOTIVO_VISIBLE_FRANJA_INTERMEDIA =
  'El perfil queda en un rango intermedio: puede fortalecerse con un co-arrendatario o lo decide un analista de Cofianza.';

type Via = 'automatica' | 'condicionada_coarrendatario' | 'revision_manual';

export interface Decision {
  resultado: ResultadoDecidido;
  /** Para el gestor: la regla que decidio, con cifras (nota interna). */
  motivo: string;
  /**
   * Para las observaciones VISIBLES, sin cifras ni umbrales, cuando el motivo
   * no sale ya de los motivos de revision ni de una regla dura. Ver
   * observacionesVisibles (reglas-duras.ts).
   */
  visible?: string | null;
  /** Fila de la tabla de tarifas (Adenda §5). */
  via: Via | null;
  /**
   * Adenda 2 §9.3 ("sin penalizacion alguna"): la via que habria tenido sin el
   * motivo de identidad. Solo cuando la identidad fue motivo de revision. Es
   * la que lee la tarifa (viaPorRutaDeAprobacion) si el analista aprueba.
   */
  viaSinIdentidad?: Via;
  /** Sin el motivo de identidad habria sido `sinFlags` (lo lee la ponderacion). */
  sinFlagsSinIdentidad?: true;
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
 *
 * Adenda 2 §9.3 y Decreto 1377/2013 art. 6: la identidad (biometria omitida,
 * bajo el umbral o sin verificar) manda al analista —nunca aprueba sola—, pero
 * no cambia la ruta de tarifa: se decide otra vez sin ese motivo y la via que
 * sale queda en `viaSinIdentidad` (si esa decision es un rechazo, lo que
 * apruebe el analista es revision manual de verdad).
 */
export function decidirResultado(e: EntradaDecision): Decision {
  const d = decidirPorJerarquia(e);
  const id = e.motivoIdentidad;
  if (!id || d.via !== 'revision_manual') return d;
  const sin = decidirPorJerarquia({
    ...e,
    motivosRevision: e.motivosRevision.map((m) => m.replace(id, '').replace(/\s{2,}/g, ' ').trim()).filter(Boolean),
  });
  return { ...d, viaSinIdentidad: sin.via ?? 'revision_manual', ...(sin.sinFlags ? { sinFlagsSinIdentidad: true as const } : {}) };
}

function decidirPorJerarquia(e: EntradaDecision): Decision {
  const { salida, u } = e;
  const p = salida.puntaje_normalizado;

  // 1. Reglas duras (§6): anulan todo, incluido el coarrendatario (§5).
  if (e.reglasDurasActivas.length > 0) {
    return { resultado: 'rechazado', motivo: `No se cumple una condición obligatoria: ${etiquetas(e.reglasDurasActivas)}.`, via: null };
  }

  // 2. Sin puntaje: ninguna central pudo evaluar. §14: revision manual, nunca rechazo.
  if (p === null || salida.decision_sombra === 'no_calculable') {
    return {
      resultado: 'condicionado',
      motivo: `Sin puntaje calculable (${salida.motivo_no_calculable ?? 'ninguna variable calculable'}): revisión manual.`,
      visible: 'No fue posible calcular el resultado con la información disponible.',
      via: 'revision_manual',
    };
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
    const casoR2 =
      !salida.inconsistencia_score_buros &&
      p < u.zonaGris &&
      !!coa &&
      !coa.reglaDura &&
      coa.puntaje !== null &&
      coa.puntaje >= u.coarrendatario;
    // La nota interna lleva los puntajes; el texto visible (ro) no.
    const detalle = salida.inconsistencia_score_buros
      ? `Puntajes por central: ${Object.entries(salida.scores_individuales ?? {}).map(([k, v]) => `${NOMBRE_CENTRAL[k] ?? k} ${v}`).join(', ')}.`
      : `Puntaje de las centrales: ${salida.features?.score_externo ?? 'sin dato'}.`;
    return {
      resultado: 'condicionado',
      motivo: [detalle, ro, ...otros, casoR2 ? REGLA_R2 : null].filter(Boolean).join(' '),
      visible: ro,
      via: 'revision_manual',
    };
  }

  // 4. < 70: rechazado. "Ningun coarrendatario compensa" (§5).
  if (p < u.zonaGris) {
    return { resultado: 'rechazado', motivo: `Puntaje ${pts(p)}, menor que ${u.zonaGris}: no alcanza para aprobar.`, visible: MOTIVO_VISIBLE_NO_ALCANZA, via: null };
  }

  // 5. Flags que impiden aprobar en automatico (§14 listas/identidad, §16.5, §8).
  if (e.motivosRevision.length > 0) {
    return { resultado: 'condicionado', motivo: e.motivosRevision.join(' '), via: 'revision_manual' };
  }

  // 6. >= 85: aprobado automatico.
  if (p >= u.aprobacion) {
    return { resultado: 'aprobado', motivo: `Puntaje ${pts(p)}, igual o mayor que ${u.aprobacion}: aprobación automática.`, via: 'automatica', sinFlags: true };
  }

  // 7. Zona gris 70-84: el coarrendatario es la palanca (Adenda §3).
  const coa = e.coarrendatario ?? null;
  if (coa && !coa.reglaDura && coa.puntaje !== null && coa.puntaje >= u.coarrendatario) {
    return {
      resultado: 'aprobado',
      motivo: `Puntaje ${pts(p)} en la franja intermedia con co-arrendatario ${pts(coa.puntaje)} (mínimo ${u.coarrendatario}): aprobación automática condicionada.`,
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
        motivo: `Puntaje ${pts(p)} en la franja intermedia y co-arrendatario ${pts(coa.puntaje)}, menor que ${u.zonaGris}. ${REGLA_BANDA_COARRENDATARIO}`,
        visible: MOTIVO_VISIBLE_FRANJA_INTERMEDIA,
        via: 'revision_manual',
        sinFlags: true,
      };
    }
    return {
      resultado: 'rechazado',
      motivo: `Puntaje ${pts(p)} en la franja intermedia y co-arrendatario ${pts(coa.puntaje)}, menor que ${u.zonaGris}: el co-arrendatario no compensa.`,
      visible: MOTIVO_VISIBLE_NO_ALCANZA,
      via: null,
      sinFlags: true,
    };
  }
  return {
    resultado: 'condicionado',
    motivo: coa
      ? `Puntaje ${pts(p)} en la franja intermedia y co-arrendatario ${coa.reglaDura ? 'que no cumple una condición obligatoria' : `${pts(coa.puntaje)}, menor que ${u.coarrendatario}`}: revisión manual.`
      : `Puntaje ${pts(p)} en la franja intermedia (${u.zonaGris} a ${u.aprobacion - 1}) sin co-arrendatario: revisión manual, o co-arrendatario con ${u.coarrendatario} o más.`,
    visible: MOTIVO_VISIBLE_FRANJA_INTERMEDIA,
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
    // Adenda 2 §9.3: null = la identidad no fue motivo de revision. Lo lee la
    // tarifa (viaDelEstudio); la ponderacion puede subirlo a la condicionada.
    via_sin_identidad: t.decision.viaSinIdentidad ?? null,
    sin_flags_sin_identidad: t.decision.sinFlagsSinIdentidad === true,
    umbrales: t.u,
    decidido_en: t.decididoEn,
  };
}

/** Traza de `estudios.cascada` del caso L: no respondio ninguna central (lo lee quien escribe los avisos). */
export function esSinCentrales(cascada: unknown): boolean {
  const c = cascada as { centrales_consultadas?: unknown; apis_fallidas?: unknown } | null;
  return (
    Array.isArray(c?.centrales_consultadas) && c.centrales_consultadas.length === 0 &&
    Array.isArray(c?.apis_fallidas) && c.apis_fallidas.length > 0
  );
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
    decisionCascada: 'Ninguna central de riesgo respondió.',
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
