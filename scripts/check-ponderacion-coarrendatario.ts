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

// ── Gate de re-consulta al otro buró (ejecutarEstudio) ──────────────────────
// Copia de la condición del service: solo un 'completado' + 'condicionado' +
// score null puede re-ejecutarse, y solo cambiando de proveedor. Si esto se
// relaja de más se podría re-ejecutar (y refacturar) un estudio ya aprobado.

const ESTADOS_PERMITIDOS_EJECUCION = ['formulario_completado', 'documentos_cargados', 'fallido'];

function puedeEjecutar(
  est: { estado: string; resultado: Resultado; score: number | null; proveedor: string },
  overrideProveedor?: string,
): boolean {
  const esCondicionadoSinInfo =
    est.estado === 'completado' && est.resultado === 'condicionado' && est.score === null;
  const reconsulta = esCondicionadoSinInfo && !!overrideProveedor && overrideProveedor !== est.proveedor;
  const permitidos = reconsulta ? [...ESTADOS_PERMITIDOS_EJECUCION, 'completado'] : ESTADOS_PERMITIDOS_EJECUCION;
  return permitidos.includes(est.estado);
}

const TU = 'transunion';
const DC = 'datacredito';

const gateCasos: Array<[string, Parameters<typeof puedeEjecutar>[0], string | undefined, boolean]> = [
  ['fallido, sin override', { estado: 'fallido', resultado: 'pendiente', score: null, proveedor: TU }, undefined, true],
  ['fallido, cambia buró', { estado: 'fallido', resultado: 'pendiente', score: null, proveedor: TU }, DC, true],
  ['condicionado sin info + otro buró', { estado: 'completado', resultado: 'condicionado', score: null, proveedor: DC }, TU, true],
  ['condicionado sin info + MISMO buró', { estado: 'completado', resultado: 'condicionado', score: null, proveedor: DC }, DC, false],
  ['condicionado sin info, sin override', { estado: 'completado', resultado: 'condicionado', score: null, proveedor: DC }, undefined, false],
  ['condicionado CON score + otro buró', { estado: 'completado', resultado: 'condicionado', score: 480, proveedor: TU }, DC, false],
  ['APROBADO + otro buró', { estado: 'completado', resultado: 'aprobado', score: 700, proveedor: TU }, DC, false],
  ['RECHAZADO + otro buró', { estado: 'completado', resultado: 'rechazado', score: 300, proveedor: TU }, DC, false],
  ['en_proceso', { estado: 'en_proceso', resultado: 'pendiente', score: null, proveedor: TU }, DC, false],
];

console.log('\n── Gate de re-consulta al otro buró ──');
let fallosGate = 0;
for (const [nombre, est, override, esperado] of gateCasos) {
  const real = puedeEjecutar(est, override);
  const ok = real === esperado;
  if (!ok) fallosGate++;
  console.log(`${ok ? '✓' : '✗'} ${nombre.padEnd(38)} → ${real ? 'permite' : 'bloquea'}${ok ? '' : '  ✗'}`);
}
assert.strictEqual(fallosGate, 0, `${fallosGate} caso(s) del gate fallaron`);

// Invariante: un estudio APROBADO nunca debe poder re-ejecutarse, con o sin
// cambio de buró — seria una consulta refacturada sobre un caso ya resuelto.
for (const p of [undefined, TU, DC]) {
  assert.ok(
    !puedeEjecutar({ estado: 'completado', resultado: 'aprobado', score: 700, proveedor: TU }, p),
    'un estudio aprobado no debe poder re-ejecutarse',
  );
}

console.log('\nOK — el gate de re-consulta solo abre el caso sin información');
