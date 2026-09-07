/**
 * Check de la tabla de tarifas y primas — Adenda 1 §5.
 *
 * Son cifras que van al CRC, un documento que el cliente puede oponer. Un
 * porcentaje mal tecleado aqui es un precio mal cobrado en cada contrato.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-tarifas.ts
 */

import assert from 'node:assert';
import {
  calcularTarifas,
  leerTarifaOverride,
  viaDeAprobacion,
  TARIFA_MENSUAL_PCT,
  PRIMA_VINCULACION_PCT,
  CASHBACK_PCT,
  IVA_PCT,
} from '@/modules/estudios/tarifas';

let pasos = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); pasos++; };

// ── 5.1 Tarifa mensual, literal ─────────────────────────────
ok(TARIFA_MENSUAL_PCT.automatica === 2.0, 'aprobado automatico: 2,0%');
ok(TARIFA_MENSUAL_PCT.condicionada_coarrendatario === 2.5, 'condicionada con coarrendatario: 2,5%');
ok(TARIFA_MENSUAL_PCT.revision_manual === 2.7, 'tras revision manual: 2,7%');
ok(IVA_PCT === 19, 'IVA general Colombia 19%');

// ── 5.2 Prima de vinculacion ────────────────────────────────
ok(PRIMA_VINCULACION_PCT.solo === 20 && PRIMA_VINCULACION_PCT.con_coarrendatario === 10, 'prima 20% solo / 10% con coarrendatario');

// ── 5.3 Cashback ────────────────────────────────────────────
ok(CASHBACK_PCT === 30, 'cashback 30% de las tarifas pagadas');

// ── Cifras sobre un canon de 2.500.000 ──────────────────────
const t = calcularTarifas({ via: 'automatica', conCoarrendatario: false, canonCop: 2_500_000 });
ok(t.tarifa_mensual_cop === 50_000, '2% de 2.500.000 = 50.000');
ok(t.tarifa_mensual_con_iva_cop === 59_500, '50.000 + 19% IVA = 59.500');
ok(t.prima_vinculacion_cop === 500_000, '20% de 2.500.000 = 500.000');
ok(t.negociada === false && t.override === null, 'sin override no es negociada');

const c = calcularTarifas({ via: 'condicionada_coarrendatario', conCoarrendatario: true, canonCop: 2_500_000 });
ok(c.tarifa_mensual_cop === 62_500 && c.prima_vinculacion_cop === 250_000, 'con coarrendatario: 2,5% = 62.500 y prima 10% = 250.000');

const m = calcularTarifas({ via: 'revision_manual', conCoarrendatario: false, canonCop: 1_000_000 });
ok(m.tarifa_mensual_cop === 27_000, '2,7% de 1.000.000 = 27.000');

const sinCanon = calcularTarifas({ via: 'automatica', conCoarrendatario: false, canonCop: null });
ok(sinCanon.tarifa_mensual_cop === null && sinCanon.prima_vinculacion_cop === null && sinCanon.tarifa_mensual_pct === 2, 'sin canon: porcentajes si, pesos no');

// ── Override autorizado (nota de la Adenda §5) ──────────────
const o = calcularTarifas({
  via: 'automatica',
  conCoarrendatario: false,
  canonCop: 2_500_000,
  override: { tarifa_mensual_pct: 1.5, autorizado_por: 'gerencia-uuid', autorizado_en: '2026-09-07T00:00:00Z', motivo: 'convenio' },
});
ok(o.tarifa_mensual_pct === 1.5 && o.tarifa_mensual_cop === 37_500, 'el override manda sobre la tabla');
ok(o.prima_vinculacion_pct === 20 && o.cashback_pct === 30, 'lo que el override no toca sigue de la tabla');
ok(o.negociada === true && o.override?.autorizado_por === 'gerencia-uuid', 'queda marcado como negociado y con quien autorizo');

ok(leerTarifaOverride(null) === null && leerTarifaOverride({}) === null && leerTarifaOverride('x') === null, 'override vacio o basura -> null');
ok(leerTarifaOverride({ tarifa_mensual_pct: 1.5 }) === null, 'sin autorizado_por/en no es un override valido');
ok(leerTarifaOverride({ tarifa_mensual_pct: -1, autorizado_por: 'a', autorizado_en: 'b' })?.tarifa_mensual_pct === undefined, 'un porcentaje negativo se descarta');

// ── Via de aprobacion (Adenda §3 -> fila de la tabla) ───────
const u = { umbralAprobacion: 85, umbralZonaGris: 70, umbralCoarrendatario: 80 };
ok(viaDeAprobacion({ puntaje: 85, coarrendatarioVinculado: false, puntajeCoarrendatario: null, ...u }) === 'automatica', '85 -> automatica');
ok(viaDeAprobacion({ puntaje: 84, coarrendatarioVinculado: true, puntajeCoarrendatario: 80, ...u }) === 'condicionada_coarrendatario', '84 + coa 80 -> condicionada');
ok(viaDeAprobacion({ puntaje: 84, coarrendatarioVinculado: true, puntajeCoarrendatario: 79, ...u }) === 'revision_manual', '84 + coa 79 -> revision manual');
ok(viaDeAprobacion({ puntaje: 70, coarrendatarioVinculado: false, puntajeCoarrendatario: null, ...u }) === 'revision_manual', '70 solo -> revision manual');
ok(viaDeAprobacion({ puntaje: null, coarrendatarioVinculado: false, puntajeCoarrendatario: null, ...u }) === 'revision_manual', 'sin puntaje -> tarifa de revision manual (la mas conservadora)');

console.log(`\nOK — ${pasos} aserciones: la tabla de tarifas de la Adenda §5 esta tal cual.`);
