/**
 * Check del motor de scorecard V4.1 en MODO SOMBRA.
 *
 * Existe por dos razones distintas:
 *
 *  1. El motor NO decide nada, asi que si se rompe NO se nota. Un estudio con
 *     el scorecard mal calculado sale exactamente igual que uno bien
 *     calculado: mismo `resultado`, mismo `score`, mismo correo. El unico
 *     sintoma seria que dentro de unos meses Gerencia moviera los umbrales
 *     apoyada en una medicion falsa. Este archivo es la unica alarma.
 *
 *  2. Las tablas de puntaje son tablas de negocio: cambiar un corte es una
 *     linea y no falla ruidosamente. Aqui se recorre cada frontera con el
 *     valor justo y el valor +/-1.
 *
 * Se corre contra los DOS payloads REALES que existen (no sinteticos):
 *   - DataCredito HDC Plus, codigo 13, 2026-08-21
 *   - TransUnion Combo 1901, UAT, 2026-07-17
 * y contra los valores verificados a mano en el analisis de brecha: ingreso
 * 2.387.000, cuota 460.000, DTI 19,3%, bruto 96, normalizado 80,7.
 *
 * El motor es puro: no toca Supabase ni env, asi que este check no necesita
 * credenciales de nada.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-scorecard.ts
 */

import assert from 'node:assert';
import fs from 'node:fs';
import {
  MAX_BRUTO_MODELO,
  MODELO_VERSION,
  PUNTOS_MAXIMOS,
  UMBRAL_APROBADO,
  UMBRAL_REVISION,
  decidirSombra,
  evaluarSombra,
  extraerFeaturesDataCredito,
  extraerFeaturesTransUnion,
  normalizar,
  puntajeV1ScoreExterno,
  puntajeV2Dti,
  puntajeV3CanonIngreso,
  puntajeV8Antiguedad,
} from '@/modules/estudios/motor';
import type { CodigoVariable, PuntajeVariable, SalidaSombra } from '@/modules/estudios/motor';
import { construirFilaSombra } from '@/modules/estudios/motor/fila';

const RUTA_DC = '/home/hector/Documentos/github/cofianza/datacredito/evidencia_response_20260821.json';
const RUTA_TU = '/home/hector/Documentos/cofianza-transunion/TransUnion_UAT_response_1026130143.json';

// Fecha inyectada: el motor no puede llamar a new Date() por su cuenta, y este
// check no puede depender del dia en que se corra.
const HOY = '2026-09-03T12:00:00.000Z';

function leerFixture(ruta: string): unknown {
  if (!fs.existsSync(ruta)) {
    console.error(`\nFALTA EL FIXTURE: ${ruta}`);
    console.error('Este check se corre contra las respuestas REALES de los buros, no contra sinteticos.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(ruta, 'utf8'));
}

const PAYLOAD_DC = leerFixture(RUTA_DC);
const PAYLOAD_TU = leerFixture(RUTA_TU);

function pts(salida: SalidaSombra, variable: CodigoVariable): PuntajeVariable {
  const p = salida.puntajes.find((x) => x.variable === variable);
  assert.ok(p, `no se encontro el puntaje de ${variable}`);
  return p;
}

let fallos = 0;
function fila(ok: boolean, etiqueta: string, detalle: string): void {
  if (!ok) fallos++;
  console.log(`${ok ? '✓' : '✗'} ${etiqueta.padEnd(46)} ${detalle}`);
}

// ============================================================
// 1. Payload REAL de DataCredito — los numeros verificados a mano
// ============================================================

console.log('\n── 1. DataCredito real (codigo 13, 2026-08-21) · canon 500.000 ──');

const dc = evaluarSombra({
  proveedor: 'datacredito',
  payload: PAYLOAD_DC,
  canon_mensual_cop: 500_000,
  fecha_evaluacion: HOY,
});

console.log(
  `  ingreso=${dc.features.ingreso_mensual_inferido_cop} cuota=${dc.features.cuota_mensual_vigente_cop} ` +
    `dti=${dc.dti_pct}% canon/ing=${dc.canon_ingreso_pct}%`,
);
console.log(`  ${dc.puntajes.map((p) => `${p.variable}=${p.puntos ?? '-'}`).join(' ')}`);
console.log(
  `  bruto=${dc.puntaje_bruto}/${dc.puntaje_bruto_alcanzable} normalizado=${dc.puntaje_normalizado} ` +
    `techo=${dc.puntaje_maximo_alcanzable} decision=${dc.decision_sombra}`,
);

// Features — los tres valores que se verificaron a mano sobre el payload.
assert.strictEqual(dc.features.ingreso_mensual_inferido_cop, 2_387_000, 'ingreso DW: 2387 MILES -> 2.387.000 pesos');
assert.strictEqual(dc.features.cuota_mensual_vigente_cop, 460_000, 'valueMonthlyPayment: 460 MILES -> 460.000 pesos');
// 2 decimales: los ratios se evaluan exactos y solo se redondean al publicar,
// para casar con las columnas NUMERIC(12,2) generadas en la tabla.
assert.strictEqual(dc.dti_pct, 19.27, 'DTI = 460.000 / 2.387.000');
assert.strictEqual(dc.features.score_externo, 972, 'score del modelCode DF');
assert.strictEqual(dc.features.score_modelo, 'DF');
assert.strictEqual(dc.features.saldo_total_cop, 1_545_000, 'totaldebtBalance 1545 MILES -> 1.545.000');
assert.strictEqual(dc.features.fecha_corte_datos, '2026-05-31', 'ancla = ultimo behaviourDate, NO consultDate');
assert.strictEqual(dc.features.fecha_consulta, '2026-08-21', 'consultDate va aparte: hay ~3 meses de rezago');
assert.strictEqual(dc.features.fecha_primera_obligacion, '2005-08-31', 'maturationSince');
assert.strictEqual(dc.antiguedad_historial_meses, 249, 'antiguedad anclada en el corte de datos, no en hoy');

// Sectores: hay que sumar liabilities Y creditCard. Solo liabilities daria
// financiero=3 en vez de 11 (las 8 tarjetas viven en creditCard).
assert.deepStrictEqual(
  dc.features.sectores,
  { financiero: 11, cooperativo: 1, real: 30, telco: 10, otros: 0 },
  'conteo de sectores confirmado a mano sobre las 52 cuentas',
);

// Comportamiento: 24 meses con marca, todos 'N'.
assert.strictEqual(dc.features.meses_observados, 24);
assert.strictEqual(dc.features.meses_con_mora_24m, 0);
assert.strictEqual(dc.features.mora_vigente, false);

// Puntajes.
const casosDC: Array<[CodigoVariable, number]> = [
  ['V1', 50], // score 972 -> banda >= 800
  ['V2', 15], // DTI 19.27% -> banda <= 25%
  ['V3', 10], // canon/ingreso 20.95% -> banda <= 25%
  ['V5', 6], //  sector financiero presente
  ['V6', 10], // 24 meses observados sin mora
  ['V8', 5], //  249 meses -> > 8 anios
];
for (const [variable, esperado] of casosDC) {
  const p = pts(dc, variable);
  fila(p.puntos === esperado && p.estado === 'calculada', `${variable} = ${esperado}`, `real=${p.puntos} (${p.banda})`);
}

assert.strictEqual(dc.puntaje_bruto, 96, 'bruto = 50+15+10+6+10+5');
assert.strictEqual(dc.puntaje_bruto_alcanzable, 96, 'las 6 variables con fuente son las que se pudieron calcular');
assert.strictEqual(dc.puntaje_normalizado, 80.7, '96/119 -> 80.7, el techo documentado de DataCredito');
assert.strictEqual(dc.puntaje_maximo_alcanzable, 80.7);
assert.strictEqual(dc.puntaje_topado, true, 'V4/V7/V9 no tienen fuente: siempre topado');
assert.deepStrictEqual(dc.variables_no_calculables, ['V4', 'V7', 'V9']);
assert.deepStrictEqual(dc.reglas_duras, []);

// El hallazgo que motiva toda la tarea: un estudio que HOY se aprueba (score
// 972 >= 600) caeria en revision manual con la politica V4.1, porque el techo
// alcanzable (80.7) esta por debajo del umbral de aprobacion (85).
assert.strictEqual(dc.decision_sombra, 'revision_manual');
assert.ok(dc.puntaje_maximo_alcanzable !== null && dc.puntaje_maximo_alcanzable < UMBRAL_APROBADO,
  'el techo con estas fuentes no alcanza el umbral de aprobacion — por eso el modo sombra');
console.log(`  → decision real hoy: aprobado · decision sombra: ${dc.decision_sombra} (techo ${dc.puntaje_maximo_alcanzable} < ${UMBRAL_APROBADO})`);

// ── canon 900.000: baja de banda pero no dispara regla dura ──
console.log('\n── 2. Mismo payload, canon 900.000 ──');
const dc900 = evaluarSombra({ proveedor: 'datacredito', payload: PAYLOAD_DC, canon_mensual_cop: 900_000, fecha_evaluacion: HOY });
// 900.000 / 2.387.000 = 37,7% (el brief lo cita redondeado a 38%: misma banda).
assert.strictEqual(dc900.canon_ingreso_pct, 37.7, 'canon/ingreso con canon 900.000');
assert.strictEqual(pts(dc900, 'V3').puntos, 2, 'banda 36-40% -> 2 puntos');
assert.strictEqual(dc900.puntaje_bruto, 88, 'bruto = 96 - 10 + 2');
assert.strictEqual(dc900.puntaje_normalizado, 73.9, '88/119 -> 73.9');
assert.deepStrictEqual(dc900.reglas_duras, [], 'el 37,7% no llega al 40% de la regla dura');
fila(true, 'canon 900.000', `canon/ing=${dc900.canon_ingreso_pct}% V3=2 bruto=88 norm=73.9`);

// ── canon 1.500.000: regla dura de V3 ──
console.log('\n── 3. Mismo payload, canon 1.500.000 (regla dura) ──');
const dc1500 = evaluarSombra({ proveedor: 'datacredito', payload: PAYLOAD_DC, canon_mensual_cop: 1_500_000, fecha_evaluacion: HOY });
// 1.500.000 / 2.387.000 = 62,8% (el brief lo cita redondeado a 63%).
assert.strictEqual(dc1500.canon_ingreso_pct, 62.84);
assert.strictEqual(pts(dc1500, 'V3').reglaDura, 'canon_ingreso_mayor_40');
assert.strictEqual(pts(dc1500, 'V3').puntos, 0, 'la regla dura puntua 0, NO deja la variable sin calcular');
assert.strictEqual(pts(dc1500, 'V3').estado, 'calculada', 'la variable se evaluo: no debe salir del denominador');
assert.deepStrictEqual(dc1500.reglas_duras.map((r) => r.codigo), ['canon_ingreso_mayor_40']);
assert.strictEqual(dc1500.decision_sombra, 'rechazado', 'una regla dura manda sobre el puntaje');
fila(true, 'canon 1.500.000 dispara regla dura', `canon/ing=${dc1500.canon_ingreso_pct}% decision=${dc1500.decision_sombra}`);

// ── sin canon: V3 no calculable, y BAJA el techo (no suma 0) ──
const dcSinCanon = evaluarSombra({ proveedor: 'datacredito', payload: PAYLOAD_DC, canon_mensual_cop: null, fecha_evaluacion: HOY });
assert.strictEqual(pts(dcSinCanon, 'V3').puntos, null, 'sin canon V3 es null, NUNCA 0');
assert.strictEqual(pts(dcSinCanon, 'V3').estado, 'no_calculable');
assert.strictEqual(dcSinCanon.puntaje_bruto_alcanzable, 86, 'el techo baja en los 10 puntos de V3');
assert.ok(dcSinCanon.variables_no_calculables.includes('V3'));
fila(true, 'sin canon: V3 null y techo 86/119', `norm=${dcSinCanon.puntaje_normalizado} techo=${dcSinCanon.puntaje_maximo_alcanzable}`);

// ============================================================
// 4. Payload REAL de TransUnion — V2 y V3 estructuralmente ausentes
// ============================================================

console.log('\n── 4. TransUnion real (Combo 1901 UAT, 2026-07-17) ──');

const tu = evaluarSombra({
  proveedor: 'transunion',
  payload: PAYLOAD_TU,
  canon_mensual_cop: 900_000,
  fecha_evaluacion: HOY,
});

console.log(`  ${tu.puntajes.map((p) => `${p.variable}=${p.puntos ?? '-'}`).join(' ')}`);
console.log(
  `  bruto=${tu.puntaje_bruto}/${tu.puntaje_bruto_alcanzable} normalizado=${tu.puntaje_normalizado} ` +
    `techo=${tu.puntaje_maximo_alcanzable} decision=${tu.decision_sombra}`,
);

assert.strictEqual(tu.features.score_externo, 632, 'CREDITVISION');
assert.strictEqual(tu.features.score_modelo, 'CREDITVISION');
assert.strictEqual(pts(tu, 'V1').puntos, 34, '632 -> banda 600-649');

// El punto central del caso TransUnion: sin ingreso inferido, V2 y V3 no son
// calculables. Si alguna vez salen 0 en vez de null, este check falla — y ese
// 0 estaria hundiendo el puntaje de todo el que se consulte por TransUnion.
assert.strictEqual(tu.features.ingreso_mensual_inferido_cop, null, 'TransUnion no entrega ingreso');
assert.strictEqual(tu.features.ausencias.ingreso_mensual_inferido_cop, 'no_soportado', 'no es "no reporto": es que el buro no lo vende');
assert.strictEqual(tu.dti_pct, null);
assert.strictEqual(tu.canon_ingreso_pct, null, 'aunque HAY canon: sin ingreso no hay ratio');
for (const v of ['V2', 'V3'] as CodigoVariable[]) {
  const p = pts(tu, v);
  fila(p.puntos === null && p.estado === 'no_calculable', `${v} no calculable (null, no 0)`, `puntos=${p.puntos} estado=${p.estado}`);
  assert.strictEqual(p.puntos, null, `${v} debe ser null`);
  assert.notStrictEqual(p.puntos, 0, `${v} NUNCA puede salir 0 por falta de fuente`);
}

assert.strictEqual(tu.puntaje_topado, true, 'el puntaje queda topado');
assert.ok(tu.variables_no_calculables.includes('V2') && tu.variables_no_calculables.includes('V3'));
assert.ok(
  tu.advertencias.some((a) => a.includes('no entrega ingreso inferido')),
  'la salida debe explicar POR QUE falta V2/V3',
);
// El techo de TransUnion baja respecto al de DataCredito: es la medida directa
// de la brecha de fuentes entre los dos buros.
assert.ok(
  tu.puntaje_maximo_alcanzable !== null && dc.puntaje_maximo_alcanzable !== null &&
    tu.puntaje_maximo_alcanzable < dc.puntaje_maximo_alcanzable,
  'TransUnion tiene menos fuentes: su techo debe ser menor que el de DataCredito',
);
console.log(`  → techo TransUnion ${tu.puntaje_maximo_alcanzable} vs DataCredito ${dc.puntaje_maximo_alcanzable}`);

// V6 en TransUnion: los slots de `Comportamientos` no traen fecha y cada
// obligacion tiene su propia FechaCorte, asi que las rejillas no estan
// alineadas. Con 7 meses observados el bono de 24 no se otorga.
assert.strictEqual(tu.features.meses_observados, 7, "7 slots 'N'; los 5 'R' no estan documentados y NO cuentan como limpios");
assert.strictEqual(pts(tu, 'V6').estado, 'no_calculable', 'sin 24 meses observados no hay bono');
assert.strictEqual(tu.features.meses_con_mora_12m, null, 'sin fecha por slot no hay ventana de 12 meses');
assert.strictEqual(tu.features.ausencias.meses_con_mora_12m, 'no_parseable');

assert.strictEqual(tu.features.fecha_primera_obligacion, '2011-07-29', 'FechaApertura viene DD/MM/YYYY');
assert.strictEqual(pts(tu, 'V8').puntos, 5);
assert.strictEqual(pts(tu, 'V5').puntos, 4, 'solo sector real -> 4 puntos');

// ============================================================
// 5. Fronteras de cada banda — el valor justo y el valor +/- 1
// ============================================================

console.log('\n── 5. Fronteras de las bandas ──');

// V1 — score externo (politica §3). Por debajo de 450 es regla dura.
const fronterasV1: Array<[number, number | null, string | null]> = [
  [801, 50, null],
  [800, 50, null],
  [799, 47, null],
  [750, 47, null],
  [749, 44, null],
  [700, 44, null],
  [699, 40, null],
  [650, 40, null],
  [649, 34, null],
  [600, 34, null],
  [599, 20, null],
  [550, 20, null],
  [549, 10, null],
  [450, 10, null],
  [449, 0, 'score_menor_450'],
  [0, 0, 'score_menor_450'],
];
for (const [score, esperado, regla] of fronterasV1) {
  const r = puntajeV1ScoreExterno(score);
  const ok = r.puntos === esperado && r.reglaDura === regla;
  fila(ok, `V1 score ${score}`, `puntos=${r.puntos} regla=${r.reglaDura ?? '-'} (esperado ${esperado}/${regla ?? '-'})`);
}
assert.strictEqual(puntajeV1ScoreExterno(null).estado, 'no_calculable', 'sin score V1 no es 0, es no calculable');

// V2 — DTI (politica §4.2). Por encima de 65% es regla dura.
// Los .1 cierran los huecos que deja una tabla escrita con enteros.
const fronterasV2: Array<[number, number | null, string | null]> = [
  [0, 15, null],
  [25, 15, null],
  [25.1, 12, null],
  [26, 12, null],
  [35, 12, null],
  [35.1, 8, null],
  [45, 8, null],
  [45.1, 4, null],
  [55, 4, null],
  [55.1, 2, null],
  [65, 2, null],
  [65.1, 0, 'dti_mayor_65'],
  [66, 0, 'dti_mayor_65'],
];
for (const [dti, esperado, regla] of fronterasV2) {
  const r = puntajeV2Dti(dti);
  const ok = r.puntos === esperado && r.reglaDura === regla;
  fila(ok, `V2 dti ${dti}%`, `puntos=${r.puntos} regla=${r.reglaDura ?? '-'} (esperado ${esperado}/${regla ?? '-'})`);
}
assert.strictEqual(puntajeV2Dti(null).puntos, null);

// V3 — canon / ingreso (politica §4.3). Por encima de 40% es regla dura.
const fronterasV3: Array<[number, number | null, string | null]> = [
  [0, 10, null],
  [25, 10, null],
  [25.1, 7, null],
  [26, 7, null],
  [30, 7, null],
  [30.1, 4, null],
  [35, 4, null],
  [35.1, 2, null],
  [40, 2, null],
  [40.1, 0, 'canon_ingreso_mayor_40'],
  [41, 0, 'canon_ingreso_mayor_40'],
];
for (const [pct, esperado, regla] of fronterasV3) {
  const r = puntajeV3CanonIngreso(pct);
  const ok = r.puntos === esperado && r.reglaDura === regla;
  fila(ok, `V3 canon/ing ${pct}%`, `puntos=${r.puntos} regla=${r.reglaDura ?? '-'} (esperado ${esperado}/${regla ?? '-'})`);
}
assert.strictEqual(puntajeV3CanonIngreso(null).puntos, null);

// V8 — antiguedad en MESES (la politica tabula en anios; se trabaja en meses
// para no perder 4,5 anios = 54 meses).
const fronterasV8: Array<[number, number | null]> = [
  [300, 5],
  [97, 5],
  [96, 4],
  [61, 4],
  [60, 4],
  [59, 3],
  [25, 3],
  [24, 3],
  [23, 1],
  [7, 1],
  [6, 1],
  [5, 0],
  [0, 0],
];
for (const [meses, esperado] of fronterasV8) {
  const r = puntajeV8Antiguedad(meses);
  fila(r.puntos === esperado, `V8 ${meses} meses`, `puntos=${r.puntos} (esperado ${esperado}) ${r.banda ?? ''}`);
}
assert.strictEqual(puntajeV8Antiguedad(null).estado, 'no_calculable');
assert.strictEqual(puntajeV8Antiguedad(-1).estado, 'no_calculable', 'primera obligacion posterior al corte: dato incoherente');

// Normalizacion — los dos techos documentados en el analisis de brecha.
assert.strictEqual(normalizar(96), 80.7, 'techo DataCredito');
assert.strictEqual(normalizar(71), 59.7, 'techo TransUnion (V1+V5+V6+V8)');
assert.strictEqual(normalizar(MAX_BRUTO_MODELO), 100);
assert.strictEqual(normalizar(0), 0);
fila(true, 'normalizacion 96->80.7 y 71->59.7', 'techos del analisis de brecha reproducidos');

// ============================================================
// 6. Centinelas y secciones ausentes — nada de esto es 0
// ============================================================

console.log('\n── 6. Centinelas (-1, guion, null, vacios) ──');

// -1 es el centinela de "no reportado" de DataCredito. Si se colara como
// numero, el saldo saldria en -1.000 pesos y el DTI seria negativo.
const centinelas = extraerFeaturesDataCredito({
  ReportHDCplus: {
    productResult: { consultDate: '2026-08-21T10:00:00', responseCode: 13 },
    models: [{ modelCode: 'DF', scoreValue: -1 }],
    productValueList: [[{ productCode: 'DW', reason: '00000', value: -1 }]],
    liabilities: [],
    creditCard: [],
    agregatedInfo: {
      overview: {
        principals: { currentCredits: -1, currentNegativeCredits: -1, maturationSince: '-' },
        balances: { valueMonthlyPayment: -1, totaldebtBalance: -1, totalValueBalanceOverdue: -1 },
        behavior: { month: [] },
      },
    },
  },
});
for (const [campo, valor] of [
  ['score_externo', centinelas.score_externo],
  ['ingreso', centinelas.ingreso_mensual_inferido_cop],
  ['cuota', centinelas.cuota_mensual_vigente_cop],
  ['saldo_total', centinelas.saldo_total_cop],
  ['obligaciones_vigentes', centinelas.obligaciones_vigentes],
  ['fecha_primera_obligacion', centinelas.fecha_primera_obligacion],
  ['mora_vigente', centinelas.mora_vigente],
  ['sectores', centinelas.sectores],
] as Array<[string, unknown]>) {
  fila(valor === null, `centinela -1/guion -> null: ${campo}`, `valor=${JSON.stringify(valor)}`);
  assert.strictEqual(valor, null, `${campo} debe ser null con centinela, no 0`);
}

// Payloads degenerados: ninguno puede lanzar y ninguno puede inventar valores.
const degenerados: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['objeto vacio', {}],
  ['envelope vacio', { ReportHDCplus: {} }],
  ['arreglos vacios', { ReportHDCplus: { models: [], liabilities: [], creditCard: [], productValueList: [] } }],
  ['secciones nulas', { ReportHDCplus: { models: null, agregatedInfo: null, liabilities: null } }],
  ['tipos equivocados', { ReportHDCplus: { models: 'no soy un arreglo', agregatedInfo: 42, liabilities: { a: 1 } } }],
  ['arreglo en la raiz', []],
  ['string', 'esto no es un reporte'],
  ['numero', 42],
];
for (const [nombre, payload] of degenerados) {
  let ok = true;
  let detalle = '';
  try {
    const f = extraerFeaturesDataCredito(payload);
    const g = extraerFeaturesTransUnion(payload);
    ok = f.score_externo === null && g.score_externo === null;
    detalle = `dc.score=${f.score_externo} tu.score=${g.score_externo}`;
  } catch (err) {
    ok = false;
    detalle = `LANZO: ${err instanceof Error ? err.message : String(err)}`;
  }
  fila(ok, `extractores toleran: ${nombre}`, detalle);
  assert.ok(ok, `los extractores no deben lanzar ni inventar con: ${nombre}`);
}

// ============================================================
// 7. Piso 0 — los penalizadores no producen puntajes negativos
// ============================================================

console.log('\n── 7. Piso 0 con penalizadores ──');

// Perfil construido para que V6 penalice mas de lo que suman los positivos:
// score 460 (10 pts), solo telcos (0 pts), historial de 1 mes (0 pts) y seis
// meses con mora >30d entre los meses 7 y 12 (-15). Bruto crudo = -5.
const mesesConMora = [
  { behaviourDate: '2026-06-30', behaviour: 'N' },
  { behaviourDate: '2026-05-31', behaviour: 'N' },
  { behaviourDate: '2026-04-30', behaviour: 'N' },
  { behaviourDate: '2026-03-31', behaviour: 'N' },
  { behaviourDate: '2026-02-28', behaviour: 'N' },
  { behaviourDate: '2026-01-31', behaviour: 'N' },
  { behaviourDate: '2025-12-31', behaviour: '1' },
  { behaviourDate: '2025-11-30', behaviour: '1' },
  { behaviourDate: '2025-10-31', behaviour: '1' },
  { behaviourDate: '2025-09-30', behaviour: '1' },
  { behaviourDate: '2025-08-31', behaviour: '1' },
  { behaviourDate: '2025-07-31', behaviour: '1' },
];
const payloadPiso = {
  ReportHDCplus: {
    productResult: { consultDate: '2026-07-15T10:00:00', responseCode: 13 },
    models: [{ modelCode: 'DF', scoreValue: 460 }],
    liabilities: [{ account: { economicSector: 4, economicSectorName: 'SECTOR TELCOS', accountOpeningDate: '2026-05-01' } }],
    agregatedInfo: {
      overview: {
        principals: { maturationSince: '2026-05-01', currentCredits: 1, currentNegativeCredits: 0, closedCredits: 0 },
        balances: { valueMonthlyPayment: -1, totaldebtBalance: -1, totalValueBalanceOverdue: 0 },
        behavior: { month: mesesConMora },
      },
    },
  },
};
const piso = evaluarSombra({ proveedor: 'datacredito', payload: payloadPiso, canon_mensual_cop: null, fecha_evaluacion: HOY });
console.log(`  ${piso.puntajes.map((p) => `${p.variable}=${p.puntos ?? '-'}`).join(' ')}`);
assert.strictEqual(pts(piso, 'V6').puntos, -15, 'mora >30d en 12 meses penaliza -15');
assert.strictEqual(pts(piso, 'V6').reglaDura, null, 'las moras estan fuera de la ventana de 6 meses: no hay regla dura');
assert.strictEqual(pts(piso, 'V1').puntos, 10);
assert.strictEqual(pts(piso, 'V5').puntos, 0, 'solo telcos no puntua (constante V5_TELCO_PUNTUA_COMO_REAL)');
assert.strictEqual(piso.puntaje_bruto, 0, 'la suma cruda es -5: el piso 0 la absorbe');
assert.strictEqual(piso.puntaje_normalizado, 0);
assert.ok(piso.puntaje_normalizado !== null && piso.puntaje_normalizado >= 0, 'jamas un normalizado negativo');
fila(true, 'piso 0 con bruto crudo -5', `bruto=${piso.puntaje_bruto} norm=${piso.puntaje_normalizado} decision=${piso.decision_sombra}`);

// Mora dentro de la ventana de 6 meses -> regla dura, no penalizacion.
const payloadMora6 = {
  ReportHDCplus: {
    ...payloadPiso.ReportHDCplus,
    agregatedInfo: {
      overview: {
        ...payloadPiso.ReportHDCplus.agregatedInfo.overview,
        behavior: { month: [{ behaviourDate: '2026-06-30', behaviour: '2' }, ...mesesConMora.slice(1)] },
      },
    },
  },
};
const mora6 = evaluarSombra({ proveedor: 'datacredito', payload: payloadMora6, fecha_evaluacion: HOY });
assert.strictEqual(pts(mora6, 'V6').reglaDura, 'mora_mayor_30d_6m');
assert.strictEqual(mora6.decision_sombra, 'rechazado');
fila(true, 'mora >30d en 6 meses -> regla dura', `decision=${mora6.decision_sombra}`);

// Mora vigente (saldo en mora en el consolidado) -> regla dura, aunque el
// vector de comportamiento venga limpio.
const moraVigente = evaluarSombra({
  proveedor: 'datacredito',
  fecha_evaluacion: HOY,
  payload: {
    ReportHDCplus: {
      models: [{ modelCode: 'DF', scoreValue: 900 }],
      agregatedInfo: {
        overview: {
          principals: { currentCredits: 3, currentNegativeCredits: 2, maturationSince: '2010-01-01' },
          balances: { totalValueBalanceOverdue: 1200 },
          behavior: { month: [{ behaviourDate: '2026-06-30', behaviour: 'N' }] },
        },
      },
    },
  },
});
assert.deepStrictEqual(moraVigente.reglas_duras.map((r) => r.codigo), ['mora_vigente']);
assert.strictEqual(moraVigente.decision_sombra, 'rechazado', 'mora vigente rechaza aunque el score sea 900');
fila(true, 'mora vigente -> regla dura con score 900', `decision=${moraVigente.decision_sombra}`);

// Sin historial crediticio: es un HECHO conocido, no un dato faltante.
const sinHistorial = evaluarSombra({
  proveedor: 'datacredito',
  fecha_evaluacion: HOY,
  payload: {
    ReportHDCplus: {
      models: [{ modelCode: 'DF', scoreValue: 700 }],
      liabilities: [],
      creditCard: [],
      agregatedInfo: {
        overview: {
          principals: { currentCredits: 0, closedCredits: 0, currentNegativeCredits: 0, maturationSince: '-' },
          balances: { totalValueBalanceOverdue: 0 },
        },
      },
    },
  },
});
assert.strictEqual(sinHistorial.features.sin_historial_crediticio, true);
assert.strictEqual(pts(sinHistorial, 'V5').puntos, 0, 'sin historial puntua 0 pero SI entra al denominador');
assert.strictEqual(pts(sinHistorial, 'V5').estado, 'calculada');
assert.strictEqual(pts(sinHistorial, 'V6').puntos, 5, 'bono documentado de sin historial');
fila(true, 'sin historial: V5=0 calculada, V6=+5', `bruto=${sinHistorial.puntaje_bruto}`);

// ============================================================
// 8. INVARIANTE CRITICA — evaluarSombra nunca lanza
// ============================================================

console.log('\n── 8. Invariante: evaluarSombra NUNCA lanza ──');

const circular: Record<string, unknown> = { ReportHDCplus: {} };
circular.self = circular;

const entradas: Array<[string, unknown]> = [
  ['sin argumento', undefined],
  ['null', null],
  ['objeto vacio', {}],
  ['proveedor null', { proveedor: null, payload: null }],
  ['proveedor desconocido', { proveedor: 'sifin', payload: PAYLOAD_DC }],
  ['proveedor vacio', { proveedor: '', payload: PAYLOAD_DC }],
  ['payload cruzado (TU leido como DC)', { proveedor: 'datacredito', payload: PAYLOAD_TU }],
  ['payload cruzado (DC leido como TU)', { proveedor: 'transunion', payload: PAYLOAD_DC }],
  ['payload string', { proveedor: 'datacredito', payload: 'x' }],
  ['payload arreglo', { proveedor: 'datacredito', payload: [1, 2, 3] }],
  ['payload circular', { proveedor: 'datacredito', payload: circular }],
  ['canon NaN', { proveedor: 'datacredito', payload: PAYLOAD_DC, canon_mensual_cop: NaN }],
  ['canon Infinity', { proveedor: 'datacredito', payload: PAYLOAD_DC, canon_mensual_cop: Infinity }],
  ['canon negativo', { proveedor: 'datacredito', payload: PAYLOAD_DC, canon_mensual_cop: -5 }],
  ['canon 0', { proveedor: 'datacredito', payload: PAYLOAD_DC, canon_mensual_cop: 0 }],
  ['score persistido sin payload', { proveedor: 'manual', payload: null, score_persistido: 720 }],
  ['fecha vacia', { proveedor: 'datacredito', payload: PAYLOAD_DC, fecha_evaluacion: '' }],
  ['fecha basura', { proveedor: 'datacredito', payload: PAYLOAD_DC, fecha_evaluacion: 'ayer' }],
];

// Ademas: quitar de a una las secciones del payload real de cada buro.
for (const clave of Object.keys(PAYLOAD_DC as Record<string, unknown>)) {
  const copia = { ...(PAYLOAD_DC as Record<string, unknown>) };
  delete copia[clave];
  entradas.push([`DC sin raiz.${clave}`, { proveedor: 'datacredito', payload: copia }]);
}
const dcReport = (PAYLOAD_DC as { ReportHDCplus: Record<string, unknown> }).ReportHDCplus;
for (const clave of Object.keys(dcReport)) {
  const copia = { ...dcReport };
  delete copia[clave];
  entradas.push([`DC sin ${clave}`, { proveedor: 'datacredito', payload: { ReportHDCplus: copia } }]);
}
for (const clave of Object.keys(PAYLOAD_TU as Record<string, unknown>)) {
  const copia = { ...(PAYLOAD_TU as Record<string, unknown>) };
  delete copia[clave];
  entradas.push([`TU sin ${clave}`, { proveedor: 'transunion', payload: copia }]);
}

let lanzaron = 0;
let incoherentes = 0;
for (const [nombre, entrada] of entradas) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = evaluarSombra(entrada as any);
    // Cada salida, por degradada que sea, debe respetar los CHECK de la tabla:
    // si no, la fila se rechaza y se pierde la corrida entera.
    const errores = validarContraSchema(s);
    if (errores.length > 0) {
      incoherentes++;
      console.log(`  ✗ ${nombre}: ${errores.join('; ')}`);
    }
  } catch (err) {
    lanzaron++;
    console.log(`  ✗ ${nombre} LANZO: ${err instanceof Error ? err.message : String(err)}`);
  }
}
fila(lanzaron === 0, `evaluarSombra no lanzo en ${entradas.length} entradas`, `${lanzaron} excepciones`);
fila(incoherentes === 0, 'toda salida respeta los CHECK de la tabla', `${incoherentes} incoherentes`);
assert.strictEqual(lanzaron, 0, 'evaluarSombra debe ser total: no puede lanzar con ninguna entrada');
assert.strictEqual(incoherentes, 0, 'una salida que viola un CHECK haria fallar el INSERT y perder la corrida');

/**
 * Replica los CHECK y los tipos de estudios_scorecard_sombra
 * (migracion 20260903000001). Si esto falla, el INSERT falla en produccion.
 */
function validarContraSchema(s: SalidaSombra): string[] {
  const e: string[] = [];
  const row = construirFilaSombra('00000000-0000-0000-0000-000000000000', s);

  const DECISIONES = ['aprobado', 'revision_manual', 'rechazado', 'no_calculable'];
  if (!DECISIONES.includes(String(row.decision_sombra))) e.push(`decision_sombra invalida: ${row.decision_sombra}`);

  // chk_scorecard_sombra_no_calculable
  const esNoCalculable = row.decision_sombra === 'no_calculable';
  if (esNoCalculable !== (row.puntaje_normalizado === null)) {
    e.push(`coherencia decision/puntaje rota: ${row.decision_sombra} con puntaje ${row.puntaje_normalizado}`);
  }

  if (String(row.modelo_version).length > 20) e.push('modelo_version excede VARCHAR(20)');
  if (row.score_externo_modelo !== null && String(row.score_externo_modelo).length > 40) {
    e.push('score_externo_modelo excede VARCHAR(40)');
  }

  const rangos: Array<[string, number | null, number, number]> = [
    ['puntaje_bruto', row.puntaje_bruto as number | null, 0, Number.MAX_SAFE_INTEGER],
    ['puntaje_normalizado', row.puntaje_normalizado as number | null, 0, 100],
    ['puntaje_maximo_alcanzable', row.puntaje_maximo_alcanzable as number | null, 0, 100],
    ['meses_con_mora_24m', row.meses_con_mora_24m as number | null, 0, 24],
    ['meses_con_mora_12m', row.meses_con_mora_12m as number | null, 0, 12],
    ['meses_con_mora_6m', row.meses_con_mora_6m as number | null, 0, 6],
    ['ventana_comportamiento_meses', row.ventana_comportamiento_meses as number | null, 0, 24],
    ['obligaciones_vigentes', row.obligaciones_vigentes as number | null, 0, 32_767],
    ['obligaciones_negativas', row.obligaciones_negativas as number | null, 0, 32_767],
    ['mora_maxima_dias', row.mora_maxima_dias as number | null, 0, 32_767],
    ['ingreso_inferido_cop', row.ingreso_inferido_cop as number | null, 0, Number.MAX_SAFE_INTEGER],
    ['cuota_mensual_cop', row.cuota_mensual_cop as number | null, 0, Number.MAX_SAFE_INTEGER],
    ['antiguedad_historial_meses', row.antiguedad_historial_meses as number | null, 0, Number.MAX_SAFE_INTEGER],
  ];
  for (const [campo, valor, min, max] of rangos) {
    if (valor === null) continue;
    if (!Number.isFinite(valor)) e.push(`${campo} no es finito: ${valor}`);
    else if (valor < min || valor > max) e.push(`${campo} fuera de [${min}, ${max}]: ${valor}`);
  }

  // canon_evaluado_cop tiene CHECK "> 0" (no ">= 0").
  const canon = row.canon_evaluado_cop as number | null;
  if (canon !== null && !(canon > 0)) e.push(`canon_evaluado_cop debe ser > 0 o NULL: ${canon}`);

  // Las columnas GENERATED no se pueden enviar en el INSERT.
  for (const generada of ['dti_pct', 'canon_ingreso_pct']) {
    if (generada in row) e.push(`la fila envia la columna GENERATED ${generada}`);
  }

  // Los NOT NULL con DEFAULT no pueden viajar como null.
  for (const noNulo of ['estudio_id', 'modelo_version', 'decision_sombra', 'sectores', 'reglas_duras_activadas', 'variables_no_calculables', 'puntaje_por_variable', 'features_crudas']) {
    if (row[noNulo] === null || row[noNulo] === undefined) e.push(`${noNulo} es NOT NULL y viaja vacio`);
  }

  // La fila tiene que sobrevivir a JSON.stringify: PostgREST la serializa.
  // Ojo: se serializa `row`, la fila construida — no `fila`, que es la funcion
  // de reporte. Serializar la funcion devolvia undefined y jamas lanzaba, asi
  // que esta guarda estaba muerta.
  try {
    JSON.stringify(row);
  } catch {
    e.push('la fila no es serializable a JSON');
  }
  return e;
}

// La fila de un caso real tambien tiene que pasar por el validador.
assert.deepStrictEqual(validarContraSchema(dc), [], 'la fila de DataCredito debe ser insertable');
assert.deepStrictEqual(validarContraSchema(tu), [], 'la fila de TransUnion debe ser insertable');

// ============================================================
// 9. Contrato de modo sombra
// ============================================================

console.log('\n── 9. Contrato de modo sombra ──');

assert.strictEqual(dc.modo, 'sombra', 'la salida se autodeclara sombra');
assert.strictEqual(dc.modelo_version, MODELO_VERSION);
assert.ok(MODELO_VERSION.length <= 20, 'modelo_version cabe en VARCHAR(20)');
// Los umbrales se anclan a los literales de la politica §3.1, no a si mismos:
// comparar dc.umbral_aprobado contra UMBRAL_APROBADO pasa verde aunque ambos
// esten equivocados.
assert.strictEqual(UMBRAL_APROBADO, 85, 'politica §3.1: aprobacion automatica desde 85');
assert.strictEqual(UMBRAL_REVISION, 70, 'politica §3.1: revision manual desde 70');
assert.strictEqual(dc.umbral_aprobado, UMBRAL_APROBADO);
assert.strictEqual(dc.umbral_revision, UMBRAL_REVISION);

// La tabla de maximos por variable se ata a la politica: §4.1 a §4.9. Su suma
// es el 119 del que depende toda la normalizacion.
assert.deepStrictEqual(
  PUNTOS_MAXIMOS,
  { V1: 50, V2: 15, V3: 10, V4: 8, V5: 6, V6: 10, V7: 10, V8: 5, V9: 5 },
  'PUNTOS_MAXIMOS debe seguir la politica §4.1-§4.9',
);
assert.strictEqual(
  Object.values(PUNTOS_MAXIMOS).reduce((a, b) => a + b, 0),
  MAX_BRUTO_MODELO,
  'los maximos por variable deben sumar el bruto del modelo',
);
assert.strictEqual(MAX_BRUTO_MODELO, 119, 'politica §3: 119 puntos brutos');

// ── Bandas de decision: se recorren con totales sinteticos, porque ningun
//    payload real llega hoy a 85 (el techo con las fuentes actuales es 80.7).
console.log('\n── 10. Bandas de decision y jerarquia del score externo ──');
function totalesSinteticos(normalizado: number) {
  return {
    puntaje_bruto: Math.round((normalizado / 100) * MAX_BRUTO_MODELO),
    puntaje_normalizado: normalizado,
    puntaje_bruto_alcanzable: MAX_BRUTO_MODELO,
    puntaje_maximo_alcanzable: 100,
    puntaje_topado: false,
    reglas_duras: [] as string[],
    variables_no_calculables: [] as string[],
  };
}
const bandas: Array<[number, string]> = [
  [100, 'aprobado'], [85.0, 'aprobado'], [84.9, 'revision_manual'],
  [70.0, 'revision_manual'], [69.9, 'rechazado'], [0, 'rechazado'],
];
for (const [n, esperado] of bandas) {
  const d = decidirSombra(totalesSinteticos(n) as never, 700);
  assert.strictEqual(d.decision, esperado, `normalizado ${n} deberia dar ${esperado}, dio ${d.decision}`);
  console.log(`\u2713 normalizado ${String(n).padEnd(5)} -> ${d.decision}`);
}

// Jerarquia §3.1: un score externo entre 450 y 599 fuerza revision manual
// AUNQUE el puntaje total este por debajo del umbral de rechazo.
const jerarquia: Array<[number, number, string]> = [
  [520, 40, 'revision_manual'],
  [450, 0, 'revision_manual'],
  [599, 10, 'revision_manual'],
  [600, 40, 'rechazado'],
  [449, 90, 'rechazado'],
];
for (const [score, norm, esperado] of jerarquia) {
  const totales = totalesSinteticos(norm) as never;
  const t = score < 450
    ? ({ ...totalesSinteticos(norm), reglas_duras: ['score_menor_450'] } as never)
    : totales;
  const d = decidirSombra(t, score);
  assert.strictEqual(
    d.decision, esperado,
    `score ${score} con puntaje ${norm} deberia dar ${esperado}, dio ${d.decision}`,
  );
  console.log(`\u2713 score ${String(score).padEnd(4)} puntaje ${String(norm).padEnd(4)} -> ${d.decision}`);
}
// La decision sombra NO puede confundirse con la real: no existe
// 'condicionado' ni 'pendiente' en su vocabulario.
for (const s of [dc, dc900, dc1500, tu, piso, mora6, moraVigente, sinHistorial]) {
  assert.ok(
    ['aprobado', 'revision_manual', 'rechazado', 'no_calculable'].includes(s.decision_sombra),
    `decision fuera del vocabulario sombra: ${s.decision_sombra}`,
  );
  assert.notStrictEqual(s.decision_sombra as string, 'condicionado', 'el vocabulario sombra NO comparte valores con resultado_estudio');
}
// La suma tiene que cuadrar con el detalle por variable en todos los casos.
for (const s of [dc, dc900, dc1500, tu, piso, sinHistorial]) {
  const suma = s.puntajes.reduce((acc, p) => acc + (p.estado === 'calculada' && p.puntos !== null ? p.puntos : 0), 0);
  assert.strictEqual(s.puntaje_bruto, Math.max(0, suma), 'puntaje_bruto debe ser la suma de las variables calculadas (con piso 0)');
  const techo = s.puntajes.reduce((acc, p) => acc + (p.estado === 'calculada' ? p.puntos_maximos : 0), 0);
  assert.strictEqual(s.puntaje_bruto_alcanzable, techo, 'el techo debe ser la suma de los maximos de las calculadas');
}
fila(true, 'vocabulario y aritmetica coherentes', `${MODELO_VERSION} · umbrales ${UMBRAL_APROBADO}/${UMBRAL_REVISION}`);

// ============================================================

if (fallos > 0) {
  console.error(`\n${fallos} verificacion(es) fallaron`);
  process.exit(1);
}
console.log('\nOK — el motor sombra reproduce los valores verificados a mano y no lanza con ningun input');
