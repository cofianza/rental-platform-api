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
// (ponderarConScorecard, solo con MOTOR_DECIDE_ENABLED).
// ============================================================

export type Resultado = 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';

export type ResultadoPonderacion = 'aprobado' | 'rechazado' | 'revision_manual';

export function ponderarConCoarrendatario(e: {
  titular: Resultado;
  /** Regla dura del coarrendatario: contamina el conjunto (Politica §5, ultima fila). */
  coaConReglaDura: boolean;
  /** Veredicto del scorecard (motor encendido); null si no aplica o no hay puntajes. */
  scorecard: 'aprobado' | 'sin_evaluar' | null;
}): ResultadoPonderacion {
  if (e.coaConReglaDura) return 'rechazado';
  // El expediente no estaba en revision manual: el coarrendatario no lo cambia.
  if (e.titular === 'aprobado') return 'aprobado';
  // "< 70: ningun coarrendatario compensa" (Politica §5).
  if (e.titular === 'rechazado') return 'rechazado';
  if (e.titular === 'condicionado' && e.scorecard === 'aprobado') return 'aprobado';
  return 'revision_manual';
}
