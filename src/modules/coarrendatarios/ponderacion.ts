// ============================================================
// Ponderacion titular x coarrendatario — que pasa con el expediente cuando
// termina el estudio del coarrendatario. Pura: la usan el service y
// scripts/check-ponderacion-coarrendatario.ts.
//
// Adenda 2 §2 y §5 (prevalece sobre la regla verbal de mayo "si uno aprueba,
// se van juntos"): un titular CONDICIONADO esta en revision manual y solo lo
// aprueba un analista de Cofianza. La unica aprobacion automatica es la de la
// Politica §5 / Adenda 1 §3 — titular 70-84 con coarrendatario >= 80, ambos
// por flujo automatico —, que exige los puntajes del motor
// (ponderarConScorecard, solo con MOTOR_DECIDE_ENABLED). Y el unico rechazo
// automatico por puntaje es el de la matriz QA V2, caso O: titular 70-84 con
// coarrendatario < 70 — salvo que el coarrendatario tenga score 450-599:
// entonces revision manual con la marca de conflicto (nota §5, como R2).
// ============================================================

import { CONFLICTO_REGLAS_COARRENDATARIO, CONFLICTO_REGLAS_R2, type UmbralesDecision } from '@/modules/estudios/decision';

export type Resultado = 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';

export type ResultadoPonderacion = 'aprobado' | 'rechazado' | 'revision_manual';

export interface VeredictoScorecard {
  resultado: 'aprobado' | 'rechazado' | 'sin_evaluar';
  /** R2 (matriz QA V2), o su espejo del coarrendatario: conflicto sin definir; la salida es la conservadora. */
  conflicto: string | null;
  puntajeTitular: number;
  puntajeCoa: number;
  /**
   * Adenda 2 §9.3: sin el motivo de identidad del titular esto se habria
   * aprobado solo. Sigue al analista, pero la tarifa es la de esta via.
   */
  viaSinIdentidad?: 'condicionada_coarrendatario';
}

/** Lo que se lee de estudios_scorecard_sombra (construirFilaSombra). */
export interface FilaScorecard {
  puntaje_normalizado: number | string | null;
  features_crudas?: { revision_obligatoria?: string | null; inconsistencia_score_buros?: boolean } | null;
}

const puntajeDe = (f?: FilaScorecard): number | null => {
  const n = f?.puntaje_normalizado == null ? null : Number(f.puntaje_normalizado);
  return n !== null && Number.isFinite(n) ? n : null;
};

/**
 * Adenda 1 §3 + matriz QA V2 (N, O, R2 y su espejo del coarrendatario) sobre las filas del motor de cada
 * estudio. Mismo criterio que decidirResultado (decision.ts, pasos 3 y 7) con
 * el coarrendatario en la mano. null si falta cualquiera de los dos puntajes
 * (y entonces manda la ponderacion por resultado del buro). Lo usa
 * ponderarConScorecard, que solo agrega la lectura.
 */
export function veredictoScorecard(e: {
  titular?: FilaScorecard;
  coa?: FilaScorecard;
  coaConReglaDura: boolean;
  u: Pick<UmbralesDecision, 'zonaGris' | 'aprobacion' | 'coarrendatario'>;
  /**
   * Politica §5, nota: la aprobacion automatica condicionada solo vale si
   * ambos se evaluaron integramente por flujo automatico y sin flags. Titular:
   * `sin_flags` de su estudios.cascada (en revision SOLO por la banda 70-84).
   * Coarrendatario: su estudio aprobado, o `sin_flags` en su traza. Sin el
   * dato (traza anterior, motor apagado) no se aprueba solo: revision manual.
   */
  titularSinFlags?: boolean;
  coaSinFlags?: boolean;
  /** `sin_flags_sin_identidad` de la traza del titular (Adenda 2 §9.3). */
  titularSinFlagsSinIdentidad?: boolean;
}): VeredictoScorecard | null {
  const pT = puntajeDe(e.titular);
  const pC = puntajeDe(e.coa);
  if (pT === null || pC === null) return null;
  const { u } = e;
  const v = (resultado: VeredictoScorecard['resultado'], conflicto: string | null = null): VeredictoScorecard => ({
    resultado,
    conflicto,
    puntajeTitular: pT,
    puntajeCoa: pC,
  });
  const coaAprueba = !e.coaConReglaDura && pC >= u.coarrendatario;
  // Politica §3.1: revision obligatoria del titular (score 450-599 o Caso G).
  // Ningun coarrendatario la levanta ni la vuelve rechazo.
  const fc = e.titular?.features_crudas;
  if (fc?.revision_obligatoria) {
    const r2 = !fc.inconsistencia_score_buros && pT < u.zonaGris && coaAprueba;
    return v('sin_evaluar', r2 ? CONFLICTO_REGLAS_R2 : null);
  }
  const enZonaGris = pT >= u.zonaGris && pT < u.aprobacion;
  if (enZonaGris && coaAprueba) {
    if (e.titularSinFlags && e.coaSinFlags) return v('aprobado');
    return e.titularSinFlagsSinIdentidad && e.coaSinFlags
      ? { ...v('sin_evaluar'), viaSinIdentidad: 'condicionada_coarrendatario' }
      : v('sin_evaluar');
  }
  // Caso O: < 70 no compensa. Entre 70 y el umbral sigue en revision manual.
  // Coarrendatario con score 450-599 (su revision obligatoria, sin Caso G):
  // conflicto sin definir -> revision manual marcada, como R2.
  if (enZonaGris && !e.coaConReglaDura && pC < u.zonaGris) {
    const fcCoa = e.coa?.features_crudas;
    return fcCoa?.revision_obligatoria && !fcCoa.inconsistencia_score_buros
      ? v('sin_evaluar', CONFLICTO_REGLAS_COARRENDATARIO)
      : v('rechazado');
  }
  return v('sin_evaluar');
}

export function ponderarConCoarrendatario(e: {
  titular: Resultado;
  /** Regla dura del coarrendatario: contamina el conjunto (Politica §5, ultima fila). */
  coaConReglaDura: boolean;
  /** Veredicto del scorecard (motor encendido); null si no aplica o no hay puntajes. */
  scorecard: VeredictoScorecard['resultado'] | null;
}): ResultadoPonderacion {
  if (e.coaConReglaDura) return 'rechazado';
  // El expediente no estaba en revision manual: el coarrendatario no lo cambia.
  if (e.titular === 'aprobado') return 'aprobado';
  // "< 70: ningun coarrendatario compensa" (Politica §5).
  if (e.titular === 'rechazado') return 'rechazado';
  if (e.titular === 'condicionado' && e.scorecard === 'aprobado') return 'aprobado';
  // Caso O: titular 70-84 + coarrendatario < 70, mismo rechazo que la regla dura.
  if (e.titular === 'condicionado' && e.scorecard === 'rechazado') return 'rechazado';
  return 'revision_manual';
}
