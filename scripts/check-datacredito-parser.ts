/**
 * Check del parser de DataCredito con un payload sintetico.
 *
 * Existe porque el servicio de DataCredito SOLO acepta trafico desde las IPs
 * publicas declaradas a Experian: desde local responde 403 y no hay forma de
 * ejercitar el parser contra la API real. Este script cubre la logica que se
 * puede romper en silencio (eleccion del modelo DF, ingreso DW en miles,
 * normalizacion de -1, bandas de score).
 *
 * Correr:
 *   DOTENV_CONFIG_PATH=.env.local npx ts-node -r dotenv/config \
 *     -r tsconfig-paths/register scripts/check-datacredito-parser.ts
 */

import assert from 'node:assert';
process.env.DATACREDITO_CLIENT_ID = 'x';
process.env.DATACREDITO_CLIENT_SECRET = 'x';
process.env.DATACREDITO_OKTA_USERNAME = 'x';
process.env.DATACREDITO_OKTA_PASSWORD = 'x';
process.env.DATACREDITO_USER = 'x';
process.env.DATACREDITO_PASSWORD = 'x';

import { DatacreditoProvider } from '@/modules/estudios/providers/datacredito.provider';

const p = new DatacreditoProvider() as any;

// Payload sintetico con la forma documentada (manual + PATH.xlsx + anexo DW).
const report = {
  productResult: { securityCode: 'F127A9C', consultDate: '2026-08-17T10:00:00', responseCode: 13, responseDesc: 'La consulta fue efectiva' },
  models: [
    { modelCode: 47, scoreValue: 700 },
    { modelCode: 'DF', scoreValue: 655, modelDate: '2026-08-17', population: 0 },
  ],
  // arreglo ANIDADO, como documenta el anexo Advance Income
  productValueList: [[
    { productCode: 'DW', reason: '00', value: 6932, valueSMLV: 4.87 },
    { productCode: 'DW', value: 4852, valueSMLV: 3.409 },
    { productCode: 'DW', value: 9011, valueSMLV: 6.331 },
  ]],
  AgregatedInfo: { overview: {
    PrincipalsAgregatedInfo: { currentCredits: 5, currentNegativeCredits: 1, negativeHistoricalLast12Months: 2, currentDisputes: -1, valueMonthlyPayment: 850000 },
    BalancesAgregatedInfo: { totaldebtBalance: 12500000, debtBalanceD30: 300000, debtBalanceD60: -1, debtBalanceD90: -1 },
  } },
  alerts: [{ alertCode: 'A1', textAlert: 'Documento reportado como extraviado' }],
};

const r = p.parseResult(report, '13');
console.log('score:', r.score, '| resultado:', r.resultado);
console.log('observaciones:', r.observaciones);

assert.strictEqual(r.score, 655, 'debe tomar el scoreValue del modelCode DF, no el del 47');
assert.strictEqual(r.resultado, 'aprobado', '655 >= 600 => aprobado');
assert.ok(r.observaciones.includes('6.932.000'), 'ingreso DW en miles -> pesos');
assert.ok(!r.observaciones.includes('-1'), '-1 debe normalizarse a null y no imprimirse');
assert.ok(!/Reclamos vigentes/.test(r.observaciones), 'currentDisputes=-1 no debe reportarse');
assert.ok(r.observaciones.includes('en mora'), 'debe reportar la mora maxima');

// Sin score DF -> revision manual
const sinScore = p.parseResult({ ...report, models: [{ modelCode: 47, scoreValue: 700 }] }, '13');
assert.strictEqual(sinScore.score, null);
assert.strictEqual(sinScore.resultado, 'condicionado');

// Bandas
assert.strictEqual(p.parseResult({ ...report, models: [{ modelCode: 'DF', scoreValue: 450 }] }, '13').resultado, 'condicionado');
assert.strictEqual(p.parseResult({ ...report, models: [{ modelCode: 'DF', scoreValue: 300 }] }, '13').resultado, 'rechazado');

// ── Caso REAL observado en DEMO (cedula 1026130143 / VELEZ, 2026-08-17) ──
// responseCode 14: la persona existe pero no tiene informacion crediticia.
// scoreValue 0 y DW con reason de exclusion '0051' y value 0.
// Es el caso que hacia falta cubrir: sin este manejo, un no bancarizado
// caia en la banda <400 y salia 'rechazado'.
const noBancarizado = {
  productResult: { securityCode: 'Q3Ky914', responseCode: 14, responseDesc: 'La consulta fue efectiva, pero no hay informacion disponible' },
  models: [{ modelCode: 'DF', scoreValue: 0 }],
  productValueList: [
    { productCode: 'DW', productName: null, reason: '0051', value: 0, valueSMLV: 0 },
    { productCode: 'DW', productName: null, reason: '00000', value: 0, valueSMLV: 0 },
  ],
};
const rNB = p.parseResult(noBancarizado, '14');
console.log('\n[codigo 14] resultado:', rNB.resultado, '| score:', rNB.score);
console.log('[codigo 14] observaciones:', rNB.observaciones);
assert.strictEqual(rNB.resultado, 'condicionado', 'sin informacion NO es rechazo');
assert.strictEqual(rNB.score, null, 'scoreValue 0 = ausencia de score, no score cero');
assert.ok(!rNB.observaciones.includes('$ 0'), 'no debe reportar ingreso de $0 con codigo de exclusion');

// Ingreso con exclusion 51 no se usa aunque el codigo sea 13
const conExclusion = p.parseResult(
  { ...report, productValueList: [{ productCode: 'DW', reason: '0051', value: 0 }] },
  '13',
);
assert.ok(!/Ingreso estimado/.test(conExclusion.observaciones), 'reason 50-54 => ingreso no estimable');

console.log('\nOK — todas las aserciones pasaron');
