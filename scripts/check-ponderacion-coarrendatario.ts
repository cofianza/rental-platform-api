/**
 * Check de la matriz de ponderación titular × co-arrendatario.
 *
 * Replica la decisión de onCoarrendatarioEstudioCompletado (paso 4) sobre una
 * tabla de casos. Existe porque esa función decide si un expediente se APRUEBA
 * o se RECHAZA solo, y un cambio ahí no falla ruidosamente: simplemente empieza
 * a cerrar expedientes que debían quedar en decisión humana.
 *
 * El caso que motivó el check: dos personas sin historial crediticio (código 14
 * de DataCrédito) se auto-rechazaban, cuando una sola queda 'condicionado' y la
 * decide un humano.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-ponderacion-coarrendatario.ts
 */

import assert from 'node:assert';

type Resultado = 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';
interface Estudio {
  resultado: Resultado;
  score: number | null;
}

// ── Copia fiel de la lógica del service (mantener en sync) ──────────────────

function fueEvaluadoPorElBuro(estudio: Estudio): boolean {
  if (estudio.resultado === 'aprobado' || estudio.resultado === 'rechazado') return true;
  if (estudio.resultado === 'condicionado') return estudio.score !== null;
  return false;
}

function ponderar(titular: Estudio, coa: Estudio): 'aprobado' | 'rechazado' | 'sin_evaluar' {
  const resultados = [titular.resultado, coa.resultado];
  if (resultados.includes('aprobado')) return 'aprobado';
  if (resultados.includes('rechazado')) return 'rechazado';
  if (!fueEvaluadoPorElBuro(titular) || !fueEvaluadoPorElBuro(coa)) return 'sin_evaluar';
  return 'rechazado';
}

// ── Casos ───────────────────────────────────────────────────────────────────

const APROBADO: Estudio = { resultado: 'aprobado', score: 720 };
const RECHAZADO: Estudio = { resultado: 'rechazado', score: 320 };
const MARGINAL: Estudio = { resultado: 'condicionado', score: 480 }; // evaluado
const SIN_INFO: Estudio = { resultado: 'condicionado', score: null }; // código 14 / exclusión
const PENDIENTE: Estudio = { resultado: 'pendiente', score: null };

const casos: Array<[string, Estudio, Estudio, 'aprobado' | 'rechazado' | 'sin_evaluar']> = [
  // Regla original: basta uno aprobado.
  ['aprobado + marginal', APROBADO, MARGINAL, 'aprobado'],
  ['marginal + aprobado', MARGINAL, APROBADO, 'aprobado'],
  ['aprobado + sin info', APROBADO, SIN_INFO, 'aprobado'],
  ['aprobado + rechazado', APROBADO, RECHAZADO, 'aprobado'],

  // Un rechazo es evidencia real de riesgo y manda sobre la falta de datos.
  ['rechazado + sin info', RECHAZADO, SIN_INFO, 'rechazado'],
  ['sin info + rechazado', SIN_INFO, RECHAZADO, 'rechazado'],
  ['marginal + rechazado', MARGINAL, RECHAZADO, 'rechazado'],

  // Ambos evaluados y ninguno aprobado → rechazo (comportamiento original).
  ['marginal + marginal', MARGINAL, MARGINAL, 'rechazado'],

  // EL FIX: sin información no es evidencia de riesgo → decisión humana.
  ['sin info + sin info', SIN_INFO, SIN_INFO, 'sin_evaluar'],
  ['sin info + marginal', SIN_INFO, MARGINAL, 'sin_evaluar'],
  ['marginal + sin info', MARGINAL, SIN_INFO, 'sin_evaluar'],

  // 'pendiente' nunca debe auto-rechazar.
  ['pendiente + marginal', PENDIENTE, MARGINAL, 'sin_evaluar'],
  ['marginal + pendiente', MARGINAL, PENDIENTE, 'sin_evaluar'],
];

let fallos = 0;
for (const [nombre, titular, coa, esperado] of casos) {
  const real = ponderar(titular, coa);
  const ok = real === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? '✓' : '✗'} ${nombre.padEnd(24)} → ${real}${ok ? '' : `  (esperado: ${esperado})`}`);
}

assert.strictEqual(fallos, 0, `${fallos} caso(s) de la matriz fallaron`);

// Un rechazo automático solo es legítimo con evidencia de ambos lados.
for (const [nombre, titular, coa] of casos) {
  if (ponderar(titular, coa) === 'rechazado') {
    const hayRechazoExplicito =
      titular.resultado === 'rechazado' || coa.resultado === 'rechazado';
    const ambosEvaluados = fueEvaluadoPorElBuro(titular) && fueEvaluadoPorElBuro(coa);
    assert.ok(
      hayRechazoExplicito || ambosEvaluados,
      `"${nombre}" auto-rechaza sin evidencia: nadie fue rechazado y alguno no pudo ser evaluado`,
    );
  }
}

console.log('\nOK — la matriz de ponderación se comporta como se espera');
