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
//   70 a 84 sin coarrendatario (o con < 80)     REVISION MANUAL
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

import type { SalidaSombra } from './motor';

export type ResultadoDecidido = 'aprobado' | 'condicionado' | 'rechazado';

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
  /** Coarrendatario evaluado, si lo hay. */
  coarrendatario?: { puntaje: number | null; reglaDura: boolean } | null;
  /** §14 / §16.5 / §8: motivos que impiden la aprobacion automatica. */
  motivosRevision: readonly string[];
}

export interface Decision {
  resultado: ResultadoDecidido;
  /** Para el gestor: la regla que decidio, con cifras. */
  motivo: string;
  /** Fila de la tabla de tarifas (Adenda §5). */
  via: 'automatica' | 'condicionada_coarrendatario' | 'revision_manual' | null;
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
  if (salida.revision_obligatoria) {
    return { resultado: 'condicionado', motivo: salida.revision_obligatoria, via: 'revision_manual' };
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
    return { resultado: 'aprobado', motivo: `Puntaje ${p} >= ${u.aprobacion}: aprobacion automatica`, via: 'automatica' };
  }

  // 7. Zona gris 70-84: el coarrendatario es la palanca (Adenda §3).
  const coa = e.coarrendatario ?? null;
  if (coa && !coa.reglaDura && coa.puntaje !== null && coa.puntaje >= u.coarrendatario) {
    return {
      resultado: 'aprobado',
      motivo: `Puntaje ${p} en zona gris con coarrendatario ${coa.puntaje} >= ${u.coarrendatario}: aprobacion automatica condicionada (Adenda §3)`,
      via: 'condicionada_coarrendatario',
    };
  }
  return {
    resultado: 'condicionado',
    motivo: coa
      ? `Puntaje ${p} en zona gris y coarrendatario ${coa.reglaDura ? 'con regla dura' : `${coa.puntaje ?? 's/p'} < ${u.coarrendatario}`}: revision manual`
      : `Puntaje ${p} en zona gris (${u.zonaGris}-${u.aprobacion - 1}) sin coarrendatario: revision manual, o coarrendatario >= ${u.coarrendatario}`,
    via: 'revision_manual',
  };
}
