/**
 * Check de las DOS reglas duras que YA DECIDEN (Politica de Evaluacion V4.1).
 *
 * Existe porque este es el unico punto del sistema donde el motor de scorecard
 * deja de medir y empieza a rechazar gente. Un error aqui no se nota: el
 * estudio sale con un `resultado` perfectamente valido: solo que el equivocado.
 * Hay dos formas de equivocarse y las dos cuestan:
 *
 *   - de menos: vuelve a aprobar el caso fca479e0 (score 773, DTI 80%,
 *     canon/ingreso 75%), que es exactamente el riesgo que Gerencia mando
 *     cortar;
 *   - de mas: rechaza a alguien por un dato que el buro no mando. Como
 *     TransUnion NO entrega ingreso inferido, un bug en la rama "no
 *     calculable" rechazaria de golpe a TODOS los estudios de TransUnion.
 *     Politica §2: "nunca rechaza por fallo tecnico".
 *
 * Se recorre cada frontera con el valor justo y con +0.01, porque las dos
 * tablas dicen "> 65%" y "> 40%" — estrictamente mayor — y un `>=` en vez de
 * un `>` no falla ruidosamente, solo rechaza al que estaba justo en el limite.
 *
 * La decision vive en una funcion PURA (salida del motor -> veredicto) para
 * poder ejercitarla aqui sin Supabase; resolverResultadoEstudio solo resuelve
 * los insumos (proveedor, payload, canon) y aplica esta misma funcion.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-reglas-duras.ts
 */

import assert from 'node:assert';

// reglas-duras.ts importa @/lib/supabase y @/config/env, que validan el env al
// cargar. Este check no toca la red ni la base: solo ejercita el motor (puro) y
// la funcion de decision (pura). Se rellenan los minimos que faltan, SIN pisar
// los reales si el .env.local ya esta cargado.
for (const [k, v] of Object.entries({
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'x',
  SUPABASE_SERVICE_ROLE_KEY: 'x',
  SUPABASE_JWT_SECRET: 'x',
  RESEND_API_KEY: 'x',
  AUCO_SENDER_EMAIL: 'qa@cofianza.co',
})) {
  if (!process.env[k]) process.env[k] = v;
}

import { evaluarSombra } from '@/modules/estudios/motor';
import type { SalidaSombra } from '@/modules/estudios/motor';
import { V2_DTI_MAXIMO, V3_CANON_INGRESO_MAXIMO } from '@/modules/estudios/motor/scorecard';
import {
  REGLAS_DURAS_ACTIVAS,
  PREFIJO_MOTIVO_REGLA_DURA,
  aplicarReglasDuras,
  inferirReglasDurasDesdeMotivo,
  motivoGestorReglasDuras,
  motivoParaProspectoDesdeMotivoGestor,
  motivoProspectoReglasDuras,
  notaObservacionesReglasDuras,
} from '@/modules/estudios/reglas-duras';
import type { VeredictoReglasDuras } from '@/modules/estudios/reglas-duras';

// Fecha inyectada: el motor no puede llamar a new Date() por su cuenta y este
// check no puede depender del dia en que se corra.
const HOY = '2026-09-03T12:00:00.000Z';

/**
 * Payload sintetico de DataCredito con las tres cifras que mueven las reglas.
 * Sintetico y no fixture real a proposito: aqui lo que se prueba son las
 * FRONTERAS (65.00 vs 65.01), que ningun reporte real trae. La lectura del
 * payload real la cubre scripts/check-scorecard.ts contra la evidencia del
 * 2026-08-21.
 *
 * Unidades: DataCredito manda el ingreso (DW) y la cuota (valueMonthlyPayment)
 * en MILES de pesos. El extractor multiplica por 1000.
 */
function payloadDataCredito(opts: {
  ingresoCop?: number | null;
  cuotaCop?: number | null;
  score?: number | null;
}): Record<string, unknown> {
  const report: Record<string, unknown> = {
    productResult: { consultDate: '2026-09-02' },
  };
  if (opts.score !== null && opts.score !== undefined) {
    report.models = [{ modelCode: 'DF', scoreValue: opts.score }];
  }
  if (opts.ingresoCop !== null && opts.ingresoCop !== undefined) {
    report.productValueList = [[{ productCode: 'DW', reason: '00000', value: opts.ingresoCop / 1000 }]];
  }
  if (opts.cuotaCop !== null && opts.cuotaCop !== undefined) {
    report.agregatedInfo = { overview: { balances: { valueMonthlyPayment: opts.cuotaCop / 1000 } } };
  }
  return { ReportHDCplus: report };
}

/** Corre el motor y aplica la decision, como lo hace resolverResultadoEstudio. */
function decidir(opts: {
  ingresoCop?: number | null;
  cuotaCop?: number | null;
  canonCop?: number | null;
  score?: number | null;
  resultadoPropuesto?: string;
}): { salida: SalidaSombra; veredicto: VeredictoReglasDuras } {
  const salida = evaluarSombra({
    proveedor: 'datacredito',
    payload: payloadDataCredito(opts),
    canon_mensual_cop: opts.canonCop ?? null,
    fecha_evaluacion: HOY,
  });
  const veredicto = aplicarReglasDuras({
    resultadoPropuesto: opts.resultadoPropuesto ?? 'aprobado',
    salida,
  });
  return { salida, veredicto };
}

let fallos = 0;
function fila(ok: boolean, etiqueta: string, detalle: string): void {
  if (!ok) fallos++;
  console.log(`${ok ? '✓' : '✗'} ${etiqueta.padEnd(48)} ${detalle}`);
}

// ============================================================
// 0. Solo DOS reglas estan activas
// ============================================================
//
// Es la asercion mas importante del archivo: Gerencia autorizo estas dos y
// NADA mas. Si alguien agrega 'score_menor_450' a la lista, el corte externo
// se mueve de 400 a 450 en produccion sin que nadie lo pida — y este check cae.

console.log('\n── 0. Alcance autorizado ──');
assert.deepStrictEqual(
  [...REGLAS_DURAS_ACTIVAS],
  ['dti_mayor_65', 'canon_ingreso_mayor_40'],
  'Gerencia autorizo SOLO la de DTI (§4.2) y la de canon/ingreso (§4.3)',
);
assert.strictEqual(V2_DTI_MAXIMO, 65, 'la tabla §4.2 dice "> 65%"');
assert.strictEqual(V3_CANON_INGRESO_MAXIMO, 40, 'la tabla §4.3 dice "> 40%"');
fila(true, 'reglas activas', REGLAS_DURAS_ACTIVAS.join(', '));
fila(true, 'umbrales', `DTI ${V2_DTI_MAXIMO}% · canon/ingreso ${V3_CANON_INGRESO_MAXIMO}%`);

// ============================================================
// 1. El caso REAL: estudio fca479e0 (produccion, 2026-09-02)
// ============================================================
//
// score 773 -> el sistema lo aprobo automaticamente.
// ingreso inferido 5.094.000 · cuotas vigentes 4.081.000 -> DTI 80,11%
// canon 3.800.000 -> canon/ingreso 74,60%
// Con las reglas activas sale RECHAZADO, y por LAS DOS.

console.log('\n── 1. Caso real fca479e0 (score 773, DTI 80%, canon/ingreso 75%) ──');

const real = decidir({
  ingresoCop: 5_094_000,
  cuotaCop: 4_081_000,
  canonCop: 3_800_000,
  score: 773,
  resultadoPropuesto: 'aprobado', // lo que dijo scoreToResultado (773 >= 600)
});

console.log(
  `  ingreso=${real.salida.features.ingreso_mensual_inferido_cop} ` +
    `cuota=${real.salida.features.cuota_mensual_vigente_cop} ` +
    `dti=${real.salida.dti_pct}% canon/ing=${real.salida.canon_ingreso_pct}% score=${real.salida.features.score_externo}`,
);

// Las cifras del caso, tal como el motor las lee del payload.
assert.strictEqual(real.salida.features.ingreso_mensual_inferido_cop, 5_094_000);
assert.strictEqual(real.salida.features.cuota_mensual_vigente_cop, 4_081_000);
assert.strictEqual(real.salida.dti_pct, 80.11, 'DTI = 4.081.000 / 5.094.000');
assert.strictEqual(real.salida.canon_ingreso_pct, 74.6, 'canon/ingreso = 3.800.000 / 5.094.000');
assert.strictEqual(real.salida.features.score_externo, 773);

// La decision.
assert.strictEqual(real.veredicto.rechaza, true, 'el caso real debe rechazarse');
assert.strictEqual(real.veredicto.resultadoFinal, 'rechazado');
assert.strictEqual(real.veredicto.cambiaResultado, true, 'hoy sale aprobado: la regla CAMBIA el resultado');
assert.deepStrictEqual(
  [...real.veredicto.reglas],
  ['dti_mayor_65', 'canon_ingreso_mayor_40'],
  'las DOS reglas aplican a este caso, no una',
);
fila(true, 'fca479e0 hoy aprobado -> rechazado', `por ${real.veredicto.reglas.join(' + ')}`);

// El motivo del gestor lleva las cifras REALES y los umbrales aplicados
// (Politica §2, trazabilidad).
assert.ok(real.veredicto.rechaza);
const motivoGestor = real.veredicto.motivoGestor;
console.log(`\n  motivo (gestor): ${motivoGestor}\n`);
for (const [etiqueta, patron] of [
  ['DTI real', /80\.11%/],
  ['umbral DTI', /maximo de 65%/],
  ['canon/ingreso real', /74\.6%/],
  ['umbral canon/ingreso', /maximo de 40%/],
  ['cuota en pesos', /\$4\.081\.000/],
  ['ingreso en pesos', /\$5\.094\.000/],
  ['canon en pesos', /\$3\.800\.000/],
  ['el score no salva', /score del buro \(773\)/],
  ['version del modelo', /v4\.1-sombra-6var/],
] as const) {
  assert.ok(patron.test(motivoGestor), `el motivo del gestor debe decir ${etiqueta}`);
}

// El motivo del prospecto NO revela los parametros internos del modelo
// (Politica §2) y usa el lenguaje del Flujo §10.
const motivoProspecto = real.veredicto.motivoProspecto;
console.log(`  motivo (prospecto): ${motivoProspecto}\n`);
assert.ok(/^No aprobable por ahora\./.test(motivoProspecto), 'Flujo §10: "No aprobable por ahora"');
assert.ok(!/rechaz/i.test(motivoProspecto), 'Flujo §13: nunca la palabra "rechazado" al prospecto');
assert.ok(!/%/.test(motivoProspecto), '§2: sin porcentajes — son parametros internos del modelo');
assert.ok(!/\b65\b|\b40\b|DTI/i.test(motivoProspecto), '§2: sin umbrales ni nombres de variables');
assert.ok(!/\$/.test(motivoProspecto), 'sin cifras del buro');
assert.ok(/no es una decision definitiva/i.test(motivoProspecto), '§10: "Nunca es un portazo"');
assert.ok(/co-arrendatario/i.test(motivoProspecto), '§10: se indica que puede mejorar');
assert.notStrictEqual(motivoProspecto, motivoGestor, 'gestor y prospecto NO leen lo mismo');

// ============================================================
// 2. Frontera del DTI: "> 65%" es estrictamente mayor
// ============================================================
//
// Con ingreso 10.000.000 los porcentajes salen redondos y la frontera es
// exacta, sin ruido de coma flotante.

console.log('── 2. Frontera DTI (§4.2) ──');

const dtiExacto = decidir({ ingresoCop: 10_000_000, cuotaCop: 6_500_000, score: 773 });
assert.strictEqual(dtiExacto.salida.dti_pct, 65, 'la corrida debe dar 65.00% exacto');
assert.strictEqual(dtiExacto.veredicto.rechaza, false, 'DTI 65.00% NO rechaza: la tabla dice "> 65%"');
fila(true, 'DTI 65.00%', 'permite (frontera inclusiva por abajo)');

const dtiUnCentesimo = decidir({ ingresoCop: 10_000_000, cuotaCop: 6_501_000, score: 773 });
assert.strictEqual(dtiUnCentesimo.salida.dti_pct, 65.01);
assert.strictEqual(dtiUnCentesimo.veredicto.rechaza, true, 'DTI 65.01% rechaza');
assert.deepStrictEqual([...dtiUnCentesimo.veredicto.reglas], ['dti_mayor_65']);
fila(true, 'DTI 65.01%', 'rechaza');

// ============================================================
// 3. Frontera de canon / ingreso: "> 40%"
// ============================================================

console.log('\n── 3. Frontera canon / ingreso (§4.3) ──');

// Cuota baja a proposito para aislar la regla de canon: si el DTI tambien
// disparara, la prueba no distinguiria cual de las dos rechazo.
const canonExacto = decidir({ ingresoCop: 10_000_000, cuotaCop: 500_000, canonCop: 4_000_000, score: 773 });
assert.strictEqual(canonExacto.salida.canon_ingreso_pct, 40, 'la corrida debe dar 40.00% exacto');
assert.strictEqual(canonExacto.veredicto.rechaza, false, 'canon/ingreso 40.00% NO rechaza: "> 40%"');
fila(true, 'canon/ingreso 40.00%', 'permite (frontera inclusiva por abajo)');

const canonUnCentesimo = decidir({ ingresoCop: 10_000_000, cuotaCop: 500_000, canonCop: 4_001_000, score: 773 });
assert.strictEqual(canonUnCentesimo.salida.canon_ingreso_pct, 40.01);
assert.strictEqual(canonUnCentesimo.veredicto.rechaza, true, 'canon/ingreso 40.01% rechaza');
assert.deepStrictEqual([...canonUnCentesimo.veredicto.reglas], ['canon_ingreso_mayor_40']);
fila(true, 'canon/ingreso 40.01%', 'rechaza');

// ============================================================
// 4. Sin ingreso -> NINGUNA regla se evalua (todo TransUnion)
// ============================================================
//
// La rama que hay que no romper nunca. TransUnion no entrega ingreso inferido
// por ningun nodo del combo 1901, asi que ni el DTI ni la relacion canon /
// ingreso son calculables y TODOS sus estudios deben comportarse EXACTAMENTE
// como hoy. Politica §2: "ante indisponibilidad de fuentes de datos, el
// sistema escala a revision manual — nunca rechaza por fallo tecnico". Y §6
// pone "ingreso no inferible" en la fila de REVISION MANUAL, no en las de
// rechazo.

console.log('\n── 4. Sin ingreso inferido (TransUnion) ──');

// Payload de TransUnion COMPLETO: score alto, consolidado con obligaciones y
// cuota. Aun asi el ingreso no existe y las dos reglas quedan mudas.
const payloadTU = {
  Tercero: { Fecha: '2026-09-02' },
  CreditVision_5694: {
    fechaCorte: [{ valor: '2026-08-31', variables: [{ nombre: 'CREDITVISION', valor: 773 }] }],
  },
  Informacion_Comercial_154: {
    Consolidado: {
      Registro: [
        {
          PaqueteInformacion: 'TOTAL',
          NumeroObligaciones: 12,
          CantidadObligacionesMora: 0,
          TotalSaldo: 4081,
          CuotaObligacionesDia: 4081,
        },
      ],
    },
  },
};

for (const [etiqueta, resultadoPropuesto] of [
  ['aprobado', 'aprobado'],
  ['condicionado', 'condicionado'],
  ['rechazado', 'rechazado'],
] as const) {
  const salidaTU = evaluarSombra({
    proveedor: 'transunion',
    payload: payloadTU,
    // Canon muy por encima del 40% de cualquier ingreso plausible: si la regla
    // se pudiera evaluar, este canon la dispararia. No se puede.
    canon_mensual_cop: 3_800_000,
    fecha_evaluacion: HOY,
  });
  assert.strictEqual(
    salidaTU.features.ingreso_mensual_inferido_cop,
    null,
    'TransUnion no entrega ingreso inferido',
  );
  assert.strictEqual(salidaTU.features.ausencias.ingreso_mensual_inferido_cop, 'no_soportado');
  assert.strictEqual(salidaTU.dti_pct, null, 'sin ingreso el DTI no es calculable');
  assert.strictEqual(salidaTU.canon_ingreso_pct, null, 'sin ingreso la relacion no es calculable');
  assert.deepStrictEqual(salidaTU.reglas_duras, [], 'ninguna regla dura se activa sin ingreso');

  const v = aplicarReglasDuras({ resultadoPropuesto, salida: salidaTU });
  assert.strictEqual(v.rechaza, false, `TransUnion/${etiqueta}: no se puede rechazar por regla dura`);
  assert.strictEqual(v.resultadoFinal, resultadoPropuesto, 'el resultado pasa intacto');
  assert.strictEqual(v.cambiaResultado, false);
  assert.deepStrictEqual([...v.reglas], []);
}
fila(true, 'TransUnion (sin ingreso)', 'los 3 resultados pasan intactos');

// Mismo criterio para DataCredito cuando el buro EXCLUYE el ingreso (codigos de
// exclusion del producto DW) o simplemente no manda la seccion.
for (const [etiqueta, payload] of [
  ['sin seccion DW', payloadDataCredito({ cuotaCop: 4_081_000, score: 773 })],
  ['DW excluido por el buro', { ReportHDCplus: {
    models: [{ modelCode: 'DF', scoreValue: 773 }],
    productValueList: [[{ productCode: 'DW', reason: '00014', value: 0 }]],
    agregatedInfo: { overview: { balances: { valueMonthlyPayment: 4081 } } },
  } }],
] as const) {
  const s = evaluarSombra({
    proveedor: 'datacredito',
    payload,
    canon_mensual_cop: 3_800_000,
    fecha_evaluacion: HOY,
  });
  assert.strictEqual(s.features.ingreso_mensual_inferido_cop, null, `${etiqueta}: sin ingreso`);
  const v = aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: s });
  assert.strictEqual(v.rechaza, false, `${etiqueta}: dato ausente NO es dato incumplido`);
}
fila(true, 'DataCredito sin ingreso inferido', 'no rechaza (dato ausente != incumplido)');

// Y el caso degenerado: sin salida del motor no hay nada que decidir.
const sinSalida = aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: null });
assert.strictEqual(sinSalida.rechaza, false, 'sin corrida del motor no se rechaza');
assert.strictEqual(sinSalida.resultadoFinal, 'aprobado');
fila(true, 'sin corrida del motor', 'pasa intacto (falla controlada §2)');

// ============================================================
// 5. Sin canon -> solo la regla de canon/ingreso queda muda
// ============================================================
//
// El DTI no depende del canon: es la relacion entre lo que la persona YA debe
// y su ingreso. Que no haya inmueble resuelto no puede apagar esa regla.

console.log('\n── 5. Sin canon del inmueble ──');

const sinCanon = decidir({ ingresoCop: 5_094_000, cuotaCop: 4_081_000, canonCop: null, score: 773 });
assert.strictEqual(sinCanon.salida.canon_ingreso_pct, null, 'sin canon la relacion no es calculable');
assert.strictEqual(sinCanon.salida.dti_pct, 80.11, 'el DTI si se calcula sin canon');
assert.strictEqual(sinCanon.veredicto.rechaza, true);
assert.deepStrictEqual(
  [...sinCanon.veredicto.reglas],
  ['dti_mayor_65'],
  'sin canon rechaza el DTI solo, no la relacion canon/ingreso',
);
fila(true, 'sin canon', 'DTI si decide, canon/ingreso no');

// Y al reves: con canon pero sin cuota reportada, solo decide canon/ingreso.
const sinCuota = decidir({ ingresoCop: 5_094_000, cuotaCop: null, canonCop: 3_800_000, score: 773 });
assert.strictEqual(sinCuota.salida.dti_pct, null, 'sin cuota reportada el DTI no es calculable');
assert.strictEqual(sinCuota.veredicto.rechaza, true);
assert.deepStrictEqual([...sinCuota.veredicto.reglas], ['canon_ingreso_mayor_40']);
fila(true, 'sin cuota reportada', 'canon/ingreso si decide, DTI no');

// ============================================================
// 6. La regla dura ANULA el puntaje (Politica §3)
// ============================================================
//
// "Las reglas duras anulan el puntaje total y generan rechazo automatico sin
// importar cuantos puntos tenga el solicitante en las demas variables".

console.log('\n── 6. La regla dura anula el puntaje (§3) ──');

const scoreAltisimo = decidir({
  ingresoCop: 5_000_000,
  cuotaCop: 4_000_000, // DTI 80%
  canonCop: 1_000_000, // canon/ingreso 20% — esta regla NO aplica
  score: 900,
  resultadoPropuesto: 'aprobado',
});
assert.strictEqual(scoreAltisimo.salida.dti_pct, 80);
assert.strictEqual(scoreAltisimo.salida.canon_ingreso_pct, 20);
assert.strictEqual(scoreAltisimo.veredicto.rechaza, true, 'score 900 con DTI 80% se rechaza igual');
assert.deepStrictEqual([...scoreAltisimo.veredicto.reglas], ['dti_mayor_65']);
assert.ok(scoreAltisimo.veredicto.rechaza && /score del buro \(900\)/.test(scoreAltisimo.veredicto.motivoGestor));
fila(true, 'score 900 + DTI 80%', 'rechaza: el puntaje no salva');

// ============================================================
// 7. Score bajo: decide el camino de SIEMPRE, no este
// ============================================================
//
// La regla dura de score < 450 (§4.1) NO esta autorizada: activarla moveria el
// corte 400 -> 450 de los providers. El motor la calcula —aparece en
// salida.reglas_duras— y la lista blanca la descarta. Si alguien la activara
// sin querer, estas aserciones caen.

console.log('\n── 7. Score bajo sigue por el camino de siempre ──');

const scoreBajo = decidir({
  ingresoCop: 10_000_000,
  cuotaCop: 1_000_000, // DTI 10% — ninguna regla activa aplica
  canonCop: 1_000_000, // canon/ingreso 10%
  score: 300,
  resultadoPropuesto: 'rechazado', // scoreToResultado: 300 < 400
});
assert.ok(
  scoreBajo.salida.reglas_duras.some((r) => r.codigo === 'score_menor_450'),
  'el motor SI calcula score_menor_450 (sigue midiendose en sombra)',
);
assert.strictEqual(scoreBajo.veredicto.rechaza, false, 'pero NO decide: no esta en la lista blanca');
assert.strictEqual(scoreBajo.veredicto.resultadoFinal, 'rechazado', 'el resultado del provider pasa intacto');
assert.strictEqual(scoreBajo.veredicto.motivoGestor, null, 'sin motivo de regla dura: no la hubo');
fila(true, 'score 300', 'rechazado por el provider, no por regla dura');

// El caso que lo prueba de verdad: score 420 esta por debajo de 450 (regla
// dura de la politica) pero por encima de 400 (corte del provider). Si la
// regla estuviera activa, este estudio pasaria de 'condicionado' a
// 'rechazado' — que es justo el cambio que Gerencia NO autorizo.
const scoreZonaGris = decidir({
  ingresoCop: 10_000_000,
  cuotaCop: 1_000_000,
  canonCop: 1_000_000,
  score: 420,
  resultadoPropuesto: 'condicionado', // scoreToResultado: 400 <= 420 < 600
});
assert.ok(scoreZonaGris.salida.reglas_duras.some((r) => r.codigo === 'score_menor_450'));
assert.strictEqual(scoreZonaGris.veredicto.rechaza, false, 'el corte 400 -> 450 NO se movio');
assert.strictEqual(scoreZonaGris.veredicto.resultadoFinal, 'condicionado');
fila(true, 'score 420 (400 <= s < 450)', 'sigue condicionado, no rechazado');

// Las reglas de mora tampoco deciden todavia.
const conMora = evaluarSombra({
  proveedor: 'datacredito',
  payload: {
    ReportHDCplus: {
      models: [{ modelCode: 'DF', scoreValue: 700 }],
      productValueList: [[{ productCode: 'DW', reason: '00000', value: 10_000 }]],
      agregatedInfo: {
        overview: {
          balances: { valueMonthlyPayment: 1_000, totalValueBalanceOverdue: 500 },
          principals: { currentCredits: 5, currentNegativeCredits: 3 },
        },
      },
    },
  },
  canon_mensual_cop: 1_000_000,
  fecha_evaluacion: HOY,
});
const veredictoMora = aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: conMora });
assert.strictEqual(veredictoMora.rechaza, false, 'las reglas de mora (V6) no estan autorizadas');
fila(true, 'mora observada', 'no decide (V6 sigue en sombra)');

// ============================================================
// 8. Confirmar vs cambiar: un rechazo que ya lo era
// ============================================================
//
// Si el provider YA dijo 'rechazado' y ademas aplica una regla dura, el
// resultado no cambia pero la causa si: se registra la regla y el motivo con
// cifras. `cambiaResultado` distingue los dos casos para que la medicion de
// impacto no cuente como "nuevos rechazos" los que ya existian.

console.log('\n── 8. Confirmar vs cambiar ──');

const yaRechazado = decidir({
  ingresoCop: 5_094_000,
  cuotaCop: 4_081_000,
  canonCop: 3_800_000,
  score: 350,
  resultadoPropuesto: 'rechazado',
});
assert.strictEqual(yaRechazado.veredicto.rechaza, true);
assert.strictEqual(yaRechazado.veredicto.cambiaResultado, false, 'ya estaba rechazado: la regla confirma');
assert.strictEqual(yaRechazado.veredicto.resultadoFinal, 'rechazado');
assert.ok(yaRechazado.veredicto.rechaza && yaRechazado.veredicto.motivoGestor.length > 0, 'igual queda el motivo');
fila(true, 'ya rechazado + regla dura', 'confirma (cambiaResultado=false)');

const condicionado = decidir({
  ingresoCop: 5_094_000,
  cuotaCop: 4_081_000,
  canonCop: 3_800_000,
  score: 500,
  resultadoPropuesto: 'condicionado',
});
assert.strictEqual(condicionado.veredicto.rechaza, true);
assert.strictEqual(condicionado.veredicto.cambiaResultado, true);
assert.strictEqual(condicionado.veredicto.resultadoFinal, 'rechazado', 'condicionado tambien cae');
fila(true, 'condicionado + regla dura', 'pasa a rechazado');

// ============================================================
// 9. Los mensajes por regla: cada uno dice lo suyo
// ============================================================

console.log('\n── 9. Mensajes por combinacion de reglas ──');

const soloDti = motivoProspectoReglasDuras(['dti_mayor_65']);
const soloCanon = motivoProspectoReglasDuras(['canon_ingreso_mayor_40']);
const ambas = motivoProspectoReglasDuras(['dti_mayor_65', 'canon_ingreso_mayor_40']);
assert.notStrictEqual(soloDti, soloCanon, 'el motivo distingue que regla cayo');
assert.notStrictEqual(soloDti, ambas);
for (const m of [soloDti, soloCanon, ambas]) {
  assert.ok(/^No aprobable por ahora\./.test(m), 'Flujo §10 en las tres variantes');
  assert.ok(!/rechaz/i.test(m), 'Flujo §13 en las tres variantes');
  assert.ok(!/%/.test(m) && !/DTI/i.test(m), '§2 en las tres variantes');
}
assert.ok(/canon de este inmueble/.test(soloCanon) && !/compromisos financieros/.test(soloCanon));
assert.ok(/compromisos financieros/.test(soloDti) && !/canon de este inmueble/.test(soloDti));
fila(true, 'motivo prospecto', '3 variantes, todas §10 + §13 + §2');

// La nota que se anexa a `observaciones` es corta y trae las dos cifras.
assert.ok(real.veredicto.rechaza);
const nota = notaObservacionesReglasDuras(real.veredicto.reglas, real.veredicto.detalle);
console.log(`  nota (observaciones): ${nota}`);
assert.ok(/80\.11%/.test(nota) && /max 65%/.test(nota));
assert.ok(/74\.6%/.test(nota) && /max 40%/.test(nota));
assert.ok(nota.length < 200, 'la nota se anexa a observaciones: tiene que ser corta');

// motivoGestorReglasDuras es pura: mismo detalle, mismo texto.
assert.strictEqual(
  motivoGestorReglasDuras(real.veredicto.reglas, real.veredicto.detalle),
  real.veredicto.motivoGestor,
  'el motivo del veredicto es exactamente el de la funcion pura',
);

// ============================================================
// 10. La decision es PURA y no toca Supabase
// ============================================================
//
// Si aplicarReglasDuras hablara con la base, este check ni arrancaria: las
// credenciales de arriba son de mentira. Que llegue hasta aca ya lo prueba; se
// deja explicito el determinismo, que es lo que permite re-decidir un caso
// historico y obtener el mismo veredicto.

console.log('\n── 10. Pureza y determinismo ──');

assert.deepStrictEqual(
  aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: real.salida }),
  aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: real.salida }),
  'mismo insumo, mismo veredicto',
);

// Entradas basura: la funcion decide, no revienta. Un throw aqui abortaria el
// registro del resultado de un estudio que ya se cobro.
for (const salidaRara of [
  null,
  { ...real.salida, reglas_duras: [] },
  { ...real.salida, reglas_duras: [{ codigo: 'inventada', variable: 'V2', detalle: '' }] },
] as unknown as (SalidaSombra | null)[]) {
  const v = aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: salidaRara });
  assert.strictEqual(v.rechaza, false, 'una regla desconocida no rechaza');
}
fila(true, 'pureza', 'sin Supabase, determinista, tolerante a basura');

// ============================================================
// 11. Respaldo por texto y separacion de audiencias
// ============================================================
//
// El veredicto viaja en memoria por el hook post-resultado, pero hay dos
// lectores que solo tienen la fila delante: el orquestador cuando lo invoca
// otro camino, y el redactado de la respuesta que lee el prospecto. Los dos se
// apoyan en el MARCADOR con que arranca el motivo del gestor, y no en la
// columna `regla_dura_activada` — que solo existe si corrio la migracion, y
// mientras no corra un SELECT que la nombre falla entero.
//
// Si alguien reescribe el texto del gestor sin tocar los marcadores, esta
// seccion se cae aqui y no en produccion, donde la consecuencia seria mandarle
// al prospecto "no cumpliste los requisitos" junto a su score de 773.

console.log('\n── 11. Respaldo por texto y separacion de audiencias ──');

assert.ok(real.veredicto.rechaza);
const motivoGestorReal = real.veredicto.motivoGestor;

assert.ok(
  motivoGestorReal.startsWith(PREFIJO_MOTIVO_REGLA_DURA),
  'el motivo del gestor arranca con el marcador de regla dura',
);
assert.deepStrictEqual(
  inferirReglasDurasDesdeMotivo(motivoGestorReal),
  ['dti_mayor_65', 'canon_ingreso_mayor_40'],
  'las dos reglas se reconstruyen del texto, en el orden de la politica',
);

// Una sola regla se reconstruye sola, sin arrastrar la otra.
for (const codigo of REGLAS_DURAS_ACTIVAS) {
  const soloUna = motivoGestorReglasDuras([codigo], real.veredicto.detalle);
  assert.deepStrictEqual(inferirReglasDurasDesdeMotivo(soloUna), [codigo], `inferencia de ${codigo}`);
}

// Lo que NO es una regla dura no puede pasar por una: el generico del score
// bajo, un motivo escrito a mano por un gestor, o la ausencia de motivo.
for (const ajeno of [
  null,
  undefined,
  '',
  'El estudio crediticio del titular fue rechazado. La solicitud no procede.',
  'Rechazado por documentacion incompleta (revisado por Ana, 2026-09-02).',
  // El marcador tiene que estar al INICIO: un motivo del gestor que lo cite
  // de pasada no convierte el caso en regla dura.
  `Nota: no aplica. ${PREFIJO_MOTIVO_REGLA_DURA}`,
]) {
  assert.deepStrictEqual(inferirReglasDurasDesdeMotivo(ajeno), [], `no es regla dura: ${ajeno}`);
  assert.strictEqual(
    motivoParaProspectoDesdeMotivoGestor(ajeno),
    null,
    'sin regla dura no se le afirma ninguna causa al prospecto',
  );
}
fila(true, 'inferencia por marcador', 'reconstruye las 2 reglas y no produce falsos positivos');

// Lo que el prospecto recibe en lugar del motivo del gestor: el §10, y NADA
// del modelo. Esta es la asercion que cubre la fuga por JSON.
const motivoProspectoRedactado = motivoParaProspectoDesdeMotivoGestor(motivoGestorReal);
console.log(`  gestor    : ${motivoGestorReal.slice(0, 90)}...`);
console.log(`  prospecto : ${motivoProspectoRedactado}`);
assert.strictEqual(
  motivoProspectoRedactado,
  motivoProspectoReglasDuras(['dti_mayor_65', 'canon_ingreso_mayor_40']),
  'al prospecto le llega exactamente el texto §10',
);
assert.ok(motivoProspectoRedactado !== null);
for (const filtrado of ['80.11', '74.6', '65%', '40%', 'DTI', 'v4.1', 'datacredito', '773']) {
  assert.ok(
    !motivoProspectoRedactado.toLowerCase().includes(filtrado.toLowerCase()),
    `el texto del prospecto no revela "${filtrado}" (Politica §2 y §11)`,
  );
}
fila(true, 'separacion de audiencias', 'el §10 no lleva cifras, umbrales, buro ni version del modelo');

// ============================================================

console.log(
  fallos === 0
    ? '\nOK — todas las aserciones pasaron'
    : `\n${fallos} FALLO(S)`,
);
process.exit(fallos === 0 ? 0 : 1);
