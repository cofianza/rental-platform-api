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
import { ponderarConCoarrendatario } from '@/modules/coarrendatarios/ponderacion';

type Resultado = 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';
interface Estudio {
  resultado: Resultado;
  score: number | null;
}

// ── La regla REAL (ponderacion.ts), no una copia ─────────────────────────────
// Adenda 2 §2 y §5: un titular condicionado lo decide un analista de Cofianza.
// La regla verbal de mayo ("si uno aprueba, se van juntos") dejo de aplicar.

const ponderar = (titular: Estudio, _coa: Estudio, opts: { reglaDuraCoa?: boolean; scorecard?: 'aprobado' | 'sin_evaluar' | null } = {}) =>
  ponderarConCoarrendatario({ titular: titular.resultado, coaConReglaDura: !!opts.reglaDuraCoa, scorecard: opts.scorecard ?? null });

// ── Casos ───────────────────────────────────────────────────────────────────

const APROBADO: Estudio = { resultado: 'aprobado', score: 720 };
const RECHAZADO: Estudio = { resultado: 'rechazado', score: 320 };
const MARGINAL: Estudio = { resultado: 'condicionado', score: 480 }; // evaluado
const SIN_INFO: Estudio = { resultado: 'condicionado', score: null }; // código 14 / exclusión
const PENDIENTE: Estudio = { resultado: 'pendiente', score: null };

const casos: Array<[string, Estudio, Estudio, 'aprobado' | 'rechazado' | 'revision_manual']> = [
  // El titular NO estaba en revision manual: el coarrendatario no lo cambia.
  ['aprobado + marginal', APROBADO, MARGINAL, 'aprobado'],
  ['aprobado + rechazado', APROBADO, RECHAZADO, 'aprobado'],
  ['rechazado + aprobado', RECHAZADO, APROBADO, 'rechazado'], // "< 70: ningun coarrendatario compensa"

  // Titular condicionado = revision manual: decide un analista (Adenda 2 §5),
  // aunque el coarrendatario salga aprobado (antes se aprobaba solo).
  ['marginal + aprobado', MARGINAL, APROBADO, 'revision_manual'],
  ['sin info + aprobado', SIN_INFO, APROBADO, 'revision_manual'],
  ['marginal + rechazado', MARGINAL, RECHAZADO, 'revision_manual'],
  ['marginal + marginal', MARGINAL, MARGINAL, 'revision_manual'],
  ['sin info + sin info', SIN_INFO, SIN_INFO, 'revision_manual'],
  ['marginal + pendiente', MARGINAL, PENDIENTE, 'revision_manual'],
];

let fallos = 0;
for (const [nombre, titular, coa, esperado] of casos) {
  const real = ponderar(titular, coa);
  const ok = real === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? '✓' : '✗'} ${nombre.padEnd(24)} → ${real}${ok ? '' : `  (esperado: ${esperado})`}`);
}
assert.strictEqual(fallos, 0, `${fallos} caso(s) de la matriz fallaron`);

// Politica §5, ultima fila: la regla dura del coarrendatario contamina el conjunto.
for (const titular of [APROBADO, MARGINAL, SIN_INFO]) {
  assert.strictEqual(ponderar(titular, APROBADO, { reglaDuraCoa: true }), 'rechazado', 'regla dura del coarrendatario -> rechazo automatico');
}
// Con el motor: la aprobacion automatica condicionada (70-84 + coa >= 80) sigue.
assert.strictEqual(ponderar(MARGINAL, APROBADO, { scorecard: 'aprobado' }), 'aprobado', 'scorecard aprueba -> aprobado sin analista');
assert.strictEqual(ponderar(MARGINAL, APROBADO, { scorecard: 'sin_evaluar' }), 'revision_manual');
assert.strictEqual(ponderar(APROBADO, APROBADO, { reglaDuraCoa: true, scorecard: 'aprobado' }), 'rechazado', 'la regla dura manda sobre el scorecard');

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
