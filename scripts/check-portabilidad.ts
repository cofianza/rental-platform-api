/**
 * Check de la portabilidad del estudio (flujo del modulo de estudios, §4.3).
 *
 * Existe porque esta regla decide si Cofianza REGALA una evaluacion o si le
 * pide al prospecto que la pague otra vez. Un error en cualquiera de los dos
 * sentidos es plata o es un cliente perdido:
 *
 *   - de mas (portar cuando no se debe): se entrega gratis un estudio que
 *     habia que cobrar, y —peor— se puede colar por la puerta de atras un caso
 *     que la regla dura de canon/ingreso > 40% (ACTIVA en produccion,
 *     reglas-duras.ts) rechazaria de frente.
 *   - de menos (no portar cuando si se debe): se le cobra dos veces a alguien
 *     por buscar vivienda, que es exactamente lo que el §4.3 llama "beneficio
 *     comercial diferenciador".
 *
 * La decision vive en una funcion PURA (canon original + ingreso original +
 * canon destino -> veredicto) justamente para poder ejercitarla aqui sin
 * Supabase. `reasignarEstudio` solo resuelve los insumos, aplica esta funcion y
 * mueve `expedientes.inmueble_id`.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-portabilidad.ts
 */

import assert from 'node:assert';

// El modulo importa @/lib/errors y, por la cadena del guard del tope,
// @/config/env, que valida el env al cargar. Este check no toca la red ni la
// base: solo ejercita las funciones puras. Se rellenan los minimos que faltan,
// SIN pisar los reales si el .env.local ya esta cargado.
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

// El tope de 3.000.000 es parte de lo que se verifica aqui (la portabilidad lo
// reusa tal cual): se borra cualquier override del entorno para que el check
// mida la regla y no la configuracion de la maquina donde corre.
delete process.env.CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP;

import {
  evaluarPortabilidad,
  errorNoPortable,
  mensajeNoPortable,
  canonMaximoTolerado,
  relacionCanonIngresoPct,
  PORTABILIDAD_TOLERANCIA_PCT,
  ESTUDIO_NO_PORTABLE_ERROR_CODE,
  type VeredictoPortabilidad,
} from '@/modules/estudios/portabilidad';
import {
  V3_CANON_INGRESO_MAXIMO,
  porcentaje,
  puntajeV3CanonIngreso,
} from '@/modules/estudios/motor/scorecard';
import { getTopeCanon } from '@/modules/estudios/tope-canon.guard';
import { AppError } from '@/lib/errors';

const noPortable = (v: VeredictoPortabilidad) =>
  v as Extract<VeredictoPortabilidad, { portable: false }>;

// ── 0. Las constantes que manda el documento ───────────────────────────────
// Si alguien mueve el 15 o el 40, esto cae antes que un cliente lo descubra.
assert.strictEqual(PORTABILIDAD_TOLERANCIA_PCT, 15, 'la tolerancia del §4.3 es +15%');
assert.strictEqual(V3_CANON_INGRESO_MAXIMO, 40, 'el maximo canon/ingreso de la Politica V4.1 §4.3 es 40%');
assert.strictEqual(getTopeCanon(), 3_000_000, 'el tope del §4.4 sigue en 3.000.000');
console.log(
  `tolerancia: +${PORTABILIDAD_TOLERANCIA_PCT}% · canon/ingreso max: ${V3_CANON_INGRESO_MAXIMO}% · tope: ${getTopeCanon().toLocaleString('es-CO')}`,
);

// Sin ingreso en todos los casos donde no se este probando esa condicion: es el
// escenario REAL mas comun (TransUnion no entrega ingreso inferido y son 6 de
// los 8 estudios de produccion).
const SIN_INGRESO = null;

// ── 1. Frontera de la tolerancia: exactamente +15% PASA ────────────────────
// "hasta +15%" incluye el +15%, igual que "hasta 3.000.000" incluye los tres
// millones en el tope. Es la frontera donde un `>=` en vez de un `>` le cobra
// una evaluacion entera a alguien por un peso.
//
// Y es tambien la frontera donde el punto flotante muerde: 2.000.000 * 1.15 no
// es exactamente 2.300.000 en binario. Por eso el techo se calcula con
// `canon * 115 / 100` — si alguien lo "simplifica" a `* 1.15`, esta aserticion
// es la que lo atrapa.
const ORIGEN = 2_000_000;
const EXACTO_15 = 2_300_000; // ORIGEN * 1.15
assert.strictEqual(canonMaximoTolerado(ORIGEN, 15), EXACTO_15, 'el techo del +15% debe ser exacto');

const enLaTolerancia = evaluarPortabilidad({
  canonOriginal: ORIGEN,
  ingresoOriginal: SIN_INGRESO,
  canonDestino: EXACTO_15,
});
console.log(
  `2.000.000 -> 2.300.000 (exactamente +15%):`,
  enLaTolerancia.portable ? 'portable' : `no portable (${noPortable(enLaTolerancia).motivo})`,
);
assert.strictEqual(enLaTolerancia.portable, true, 'exactamente +15% debe pasar: la tolerancia es inclusiva');
assert.strictEqual(enLaTolerancia.portable && enLaTolerancia.canonMaximoToleradoCop, EXACTO_15);

// ── 2. +15.01% NO pasa ─────────────────────────────────────────────────────
const unPesoDeMas = evaluarPortabilidad({
  canonOriginal: ORIGEN,
  ingresoOriginal: SIN_INGRESO,
  canonDestino: EXACTO_15 + 1,
});
assert.strictEqual(unPesoDeMas.portable, false, 'un peso por encima del techo no pasa');
assert.strictEqual(noPortable(unPesoDeMas).motivo, 'excede_tolerancia');

const quinceComa01 = evaluarPortabilidad({
  canonOriginal: ORIGEN,
  ingresoOriginal: SIN_INGRESO,
  canonDestino: ORIGEN * 1.1501, // 2.300.200
});
console.log('+15.01% ->', quinceComa01.portable ? 'portable' : `no portable (${noPortable(quinceComa01).motivo})`);
assert.strictEqual(quinceComa01.portable, false, '+15.01% excede la tolerancia');
assert.strictEqual(noPortable(quinceComa01).motivo, 'excede_tolerancia');
// El mensaje tiene que decir los DOS numeros: sin ellos el gestor no puede
// explicarle al prospecto por que le toca pagar de nuevo.
const msgTolerancia = mensajeNoPortable(noPortable(quinceComa01));
console.log('mensaje:', msgTolerancia);
assert.ok(/2\.300\.000/.test(msgTolerancia), 'debe decir cual era el maximo tolerado');
assert.ok(/2\.000\.000/.test(msgTolerancia), 'debe decir con que canon se hizo el estudio');
assert.ok(/evaluacion nueva/i.test(msgTolerancia), 'debe decir cual es la salida (§4.3: "se requiere una nueva evaluacion")');
assert.ok(/no se genero ningun cobro/i.test(msgTolerancia), 'debe dejar claro que no se cobro nada');
assert.ok(!/rechaz/i.test(msgTolerancia), 'el flujo §13 prohibe hablar de "rechazado"');

// ── 3. Bajar de canon SIEMPRE puede ────────────────────────────────────────
// La tolerancia es un techo, no una banda: el §4.3 habla de "hasta +15%", no
// de "+/- 15%". Mudarse a algo mas barato no puede requerir pagar otra vez —
// ni el riesgo ni la relacion canon/ingreso empeoran.
for (const destino of [1_999_999, 1_500_000, 900_000, 1]) {
  const v = evaluarPortabilidad({
    canonOriginal: ORIGEN,
    ingresoOriginal: SIN_INGRESO,
    canonDestino: destino,
  });
  assert.strictEqual(v.portable, true, `bajar de ${ORIGEN} a ${destino} debe ser portable`);
}
console.log('canones por debajo del original -> portables');

// ── 4. Frontera de la regla dura: exactamente 40% PASA, 40.01% NO ──────────
// La Politica V4.1 §4.3 dice "> 40% -> RECHAZO AUTOMATICO": estrictamente
// mayor. El documento del flujo lo repite como "menor o igual al 40%". Se usa
// la MISMA constante que la regla dura que ya rechaza en produccion.
const INGRESO = 5_000_000;
const CANON_40 = 2_000_000; // 2.000.000 / 5.000.000 = 40.00%
assert.strictEqual(relacionCanonIngresoPct(CANON_40, INGRESO), 40);

const justo40 = evaluarPortabilidad({
  // Origen igual al destino: la tolerancia no interfiere, solo se mide el 40%.
  canonOriginal: CANON_40,
  ingresoOriginal: INGRESO,
  canonDestino: CANON_40,
});
console.log('canon/ingreso 40.00% ->', justo40.portable ? 'portable' : `no portable (${noPortable(justo40).motivo})`);
assert.strictEqual(justo40.portable, true, '40.00% exacto pasa: la regla dura es "> 40%"');
assert.strictEqual(justo40.portable && justo40.veredictoCanonIngreso, 'cumple');
assert.strictEqual(justo40.portable && justo40.canonIngresoDestinoPct, 40);

const cuarentaComa01 = evaluarPortabilidad({
  canonOriginal: CANON_40,
  ingresoOriginal: INGRESO,
  canonDestino: 2_000_500, // 40.01%
});
console.log(
  'canon/ingreso 40.01% ->',
  cuarentaComa01.portable ? 'portable' : `no portable (${noPortable(cuarentaComa01).motivo})`,
);
assert.strictEqual(cuarentaComa01.portable, false, '40.01% dispara la regla dura');
assert.strictEqual(noPortable(cuarentaComa01).motivo, 'canon_ingreso_excede');
assert.strictEqual(noPortable(cuarentaComa01).veredictoCanonIngreso, 'no_cumple');

// ── 4.b. EL BORDE QUE EL REDONDEO TAPABA: 40.004% ─────────────────────────
// Regresion de un defecto real. Mientras el veredicto se decidia sobre el
// porcentaje REDONDEADO a 2 decimales, todo el intervalo (40%, 40.005%) pasaba
// como 'cumple' —Math.round(40.004 * 100) / 100 = 40, y 40 > 40 es false—
// mientras `puntajeV3CanonIngreso`, la regla dura ACTIVA en produccion, que
// compara sobre el porcentaje exacto, lo marca 'canon_ingreso_mayor_40'. Es
// decir: la portabilidad aprobaba por la puerta de atras justo lo que el motor
// rechaza de frente, y la tolerancia no lo tapaba (el destino esta a +0.01%).
//
// Ahora decide el EXACTO y solo se redondea para mostrar y persistir.
const CANON_40_004 = 2_000_200; // 2.000.200 / 5.000.000 = 40.004%
assert.strictEqual(
  puntajeV3CanonIngreso(porcentaje(CANON_40_004, INGRESO)).reglaDura,
  'canon_ingreso_mayor_40',
  'la regla dura de produccion SI rechaza el 40.004% — la portabilidad no puede discrepar',
);
const cuarentaComa004 = evaluarPortabilidad({
  canonOriginal: CANON_40,
  ingresoOriginal: INGRESO,
  canonDestino: CANON_40_004,
});
console.log(
  'canon/ingreso 40.004% (dentro de la tolerancia) ->',
  cuarentaComa004.portable ? 'portable' : `no portable (${noPortable(cuarentaComa004).motivo})`,
);
assert.strictEqual(cuarentaComa004.portable, false, '40.004% NO puede pasar: decide el exacto, no el redondeado');
assert.strictEqual(noPortable(cuarentaComa004).motivo, 'canon_ingreso_excede');
assert.strictEqual(noPortable(cuarentaComa004).veredictoCanonIngreso, 'no_cumple');
// El numero que se muestra y se persiste SI va redondeado a 2 decimales, para
// casar con las columnas NUMERIC(_,2) de la traza.
assert.strictEqual(noPortable(cuarentaComa004).canonIngresoDestinoPct, 40);
// Y el redondeo no se comio la tolerancia: el destino esta a +0.01% del origen.
assert.strictEqual(
  evaluarPortabilidad({ canonOriginal: CANON_40, ingresoOriginal: null, canonDestino: CANON_40_004 }).portable,
  true,
  'sin ingreso ese mismo destino si es portable — lo que bloquea es la regla dura',
);

// ── 5. LA REGLA DURA MANDA SOBRE LA TOLERANCIA ─────────────────────────────
// El caso que motiva este check entero: un canon destino que SI cabe en el
// +15%, pero que con el ingreso de la corrida original empuja la relacion
// canon/ingreso por encima del 40%.
//
// Origen 2.000.000, ingreso 5.100.000 (39.2% -> el estudio paso). Destino
// 2.200.000 = +10%, dentro de la tolerancia. Pero 2.200.000 / 5.100.000 =
// 43.14% > 40. NO es portable: aprobar aqui seria colar por la puerta de atras
// exactamente el caso que la regla dura rechaza de frente.
const INGRESO_AJUSTADO = 5_100_000;
const dentroDe15PeroSobre40 = evaluarPortabilidad({
  canonOriginal: 2_000_000,
  ingresoOriginal: INGRESO_AJUSTADO,
  canonDestino: 2_200_000,
});
console.log(
  'destino +10% (dentro del 15%) pero canon/ingreso 43.14% ->',
  dentroDe15PeroSobre40.portable ? 'portable' : `no portable (${noPortable(dentroDe15PeroSobre40).motivo})`,
);
// La tolerancia, por si sola, lo habria dejado pasar:
assert.strictEqual(
  evaluarPortabilidad({ canonOriginal: 2_000_000, ingresoOriginal: null, canonDestino: 2_200_000 }).portable,
  true,
  'sin ingreso el mismo destino si es portable — lo que bloquea es la regla dura, no la tolerancia',
);
assert.strictEqual(dentroDe15PeroSobre40.portable, false, 'la regla dura manda sobre la tolerancia');
assert.strictEqual(noPortable(dentroDe15PeroSobre40).motivo, 'canon_ingreso_excede');
assert.strictEqual(noPortable(dentroDe15PeroSobre40).canonIngresoDestinoPct, 43.14);
const msgDura = mensajeNoPortable(noPortable(dentroDe15PeroSobre40));
console.log('mensaje:', msgDura);
assert.ok(/43\.14%/.test(msgDura), 'debe decir en cuanto quedaria la relacion');
assert.ok(/40%/.test(msgDura), 'debe decir cual es el maximo');
assert.ok(!/rechaz/i.test(msgDura), '§13: sin la palabra "rechazado"');

// ── 6. SIN CANON ORIGINAL: NO portable (los estudios historicos) ───────────
// `estudios.canon_evaluado` empezo a escribirse con este cambio. Los 8 estudios
// que ya existian en produccion no lo tienen, y NO se backfillea desde
// `inmuebles.valor_arriendo`: esa columna es editable y pudo cambiar desde
// entonces (2 de los 5 inmuebles estan hoy en 26.000.000, mas de 8x el tope),
// asi que adivinar produciria tolerancias fantasiosas. Se dice con claridad.
for (const canonOriginal of [null, undefined, 0, -1, '', '  ', 'no-es-un-numero', Number.NaN]) {
  const v = evaluarPortabilidad({
    canonOriginal: canonOriginal as number | string | null | undefined,
    ingresoOriginal: SIN_INGRESO,
    canonDestino: 1_500_000,
  });
  assert.strictEqual(v.portable, false, `sin canon original (${String(canonOriginal)}) no hay tolerancia que medir`);
  assert.strictEqual(noPortable(v).motivo, 'sin_canon_original');
  assert.strictEqual(noPortable(v).canonOriginalCop, null);
}
const historico = noPortable(
  evaluarPortabilidad({ canonOriginal: null, ingresoOriginal: null, canonDestino: 1_500_000 }),
);
const msgHistorico = mensajeNoPortable(historico);
console.log('\nestudio sin canon congelado:', msgHistorico);
// El mensaje NO puede afirmar la causa. Decia "este estudio se ejecuto antes de
// que el sistema registrara el canon evaluado", que es cierto para los
// historicos y FALSO para un estudio de hoy cuyo inmueble no tenia canon
// legible al completarse: al gestor se le nombraba una causa irreparable por
// definicion y se quedaba sin ninguna accion posible. Se dice lo unico que se
// sabe con certeza —que el dato no esta— sin insinuar que al prospecto le falte
// algo.
assert.ok(
  /no tiene registrado el canon con el que se evaluo/i.test(msgHistorico),
  'debe decir lo que se sabe (falta el dato), no una causa que no se puede conocer',
);
assert.ok(
  !/antes de que el sistema/i.test(msgHistorico),
  'no puede afirmar que el estudio es anterior al cambio: para un estudio de hoy seria falso',
);
assert.ok(/evaluacion nueva/i.test(msgHistorico), 'debe ofrecer la salida');
assert.ok(!/rechaz/i.test(msgHistorico), '§13: sin la palabra "rechazado"');
assert.ok(!/error|imposible/i.test(msgHistorico), 'sin tono dramatico');

// ── 7. SIN INGRESO ORIGINAL: la condicion queda 'no_evaluable' y NO bloquea ─
// COMPORTAMIENTO DECIDIDO Y DOCUMENTADO. Es la doctrina que este repo ya fijo
// en reglas-duras.ts ("NO CALCULABLE != INCUMPLIDA", Politica §2 "nunca rechaza
// por fallo tecnico" y §6 "ingreso no inferible" -> revision manual).
//
// El motivo concreto: TransUnion no entrega ingreso inferido, asi que ese
// estudio se DECIDIO en produccion sin que la regla del 40% fuera evaluable.
// Exigirla solo para portar seria un estandar mas duro que el de la evaluacion
// original, y empujaria al prospecto a pagar dos veces — justo lo que el §4.3
// evita. La exposicion queda acotada por la otra condicion: el destino no puede
// superar al origen en mas de 15%.
for (const ingreso of [null, undefined, 0, -1, '', 'no-es-un-numero', Number.NaN]) {
  const v = evaluarPortabilidad({
    canonOriginal: 2_000_000,
    ingresoOriginal: ingreso as number | string | null | undefined,
    canonDestino: 2_300_000,
  });
  assert.strictEqual(v.portable, true, `sin ingreso (${String(ingreso)}) la condicion no bloquea por si sola`);
  assert.strictEqual(v.portable && v.veredictoCanonIngreso, 'no_evaluable');
  assert.strictEqual(v.portable && v.canonIngresoDestinoPct, null);
  assert.strictEqual(v.portable && v.ingresoOriginalCop, null);
}
console.log('sin ingreso original -> portable, con veredicto canon/ingreso = no_evaluable');

// Y sigue bloqueando lo que le toca: sin ingreso, la tolerancia manda igual.
const sinIngresoPeroCaro = evaluarPortabilidad({
  canonOriginal: 2_000_000,
  ingresoOriginal: null,
  canonDestino: 2_400_000,
});
assert.strictEqual(sinIngresoPeroCaro.portable, false, 'sin ingreso, la tolerancia sigue aplicando');
assert.strictEqual(noPortable(sinIngresoPeroCaro).motivo, 'excede_tolerancia');
// El veredicto viaja tambien en las salidas negativas: sin eso, la traza de una
// reasignacion negada no diria si la segunda condicion se pudo mirar siquiera.
assert.strictEqual(noPortable(sinIngresoPeroCaro).veredictoCanonIngreso, 'no_evaluable');

// ── 8. TOPE DEL §4.4: el destino tambien esta sujeto a el ──────────────────
// El inmueble destino es una propiedad NUEVA que Cofianza tendria que
// afianzar: aqui no hay grandfathering que valga (el grandfathering del tope
// protege lo YA COBRADO sobre la propiedad que se estudio, no una propiedad
// distinta). Se reusa `evaluarTopeCanon`, no se reescribe el 3.000.000.
const sobreElTope = evaluarPortabilidad({
  // Origen alto a proposito para que la tolerancia NO sea lo que bloquea:
  // 3.100.000 esta a +3.3% de 3.000.000, comodamente dentro del 15%.
  canonOriginal: 3_000_000,
  ingresoOriginal: SIN_INGRESO,
  canonDestino: 3_100_000,
});
console.log(
  '\ndestino 3.100.000 (dentro del +15% pero sobre el tope) ->',
  sobreElTope.portable ? 'portable' : `no portable (${noPortable(sobreElTope).motivo})`,
);
assert.strictEqual(sobreElTope.portable, false, 'el destino supera el tope afianzable');
assert.strictEqual(noPortable(sobreElTope).motivo, 'excede_tope_canon');
const msgTope = mensajeNoPortable(noPortable(sobreElTope));
console.log('mensaje:', msgTope);
assert.ok(/coafianzamiento/i.test(msgTope), 'debe explicar POR QUE (falta el acuerdo de coafianzamiento)');
assert.ok(/3\.100\.000/.test(msgTope) && /3\.000\.000/.test(msgTope), 'debe decir el canon y el tope');
assert.ok(/no se genero ningun cobro/i.test(msgTope), 'debe dejar claro que no se cobro');

// Exactamente en el tope, en cambio, si pasa (el tope es inclusivo).
assert.strictEqual(
  evaluarPortabilidad({ canonOriginal: 3_000_000, ingresoOriginal: null, canonDestino: 3_000_000 }).portable,
  true,
  '3.000.000 exactos pasan: el tope es inclusivo',
);

// ── 9. El destino sin canon utilizable no se puede comparar ────────────────
// A diferencia del tope (donde un canon ausente NO bloquea, porque puede que
// todavia no haya inmueble), aqui el destino es un inmueble que el gestor
// acaba de elegir: sin canon, la comparacion es imposible.
const destinoSinCanon = evaluarPortabilidad({
  canonOriginal: 2_000_000,
  ingresoOriginal: null,
  canonDestino: null,
});
assert.strictEqual(destinoSinCanon.portable, false);
assert.strictEqual(noPortable(destinoSinCanon).motivo, 'sin_canon_destino');

// ── 9.b. relacionCanonIngresoPct devuelve el porcentaje EXACTO ────────────
// Lo que se redondea es lo que se muestra y se persiste, nunca lo que decide.
assert.strictEqual(relacionCanonIngresoPct(CANON_40_004, INGRESO), 40.004);
assert.strictEqual(relacionCanonIngresoPct(1_000_000, null), null, 'sin ingreso no hay relacion');

// ── 10. NUMERIC de PostgREST (string) decide igual ─────────────────────────
// Los tres insumos salen de columnas NUMERIC, que PostgREST devuelve como
// string. Si el modulo no los normalizara, la comparacion seria lexicografica
// y dejaria pasar cualquier cosa.
assert.deepStrictEqual(
  evaluarPortabilidad({ canonOriginal: '2000000.00', ingresoOriginal: '5100000.00', canonDestino: '2200000.00' }),
  evaluarPortabilidad({ canonOriginal: 2_000_000, ingresoOriginal: 5_100_000, canonDestino: 2_200_000 }),
  'un NUMERIC en texto decide exactamente igual',
);

// ── 11. El error es de DOMINIO y lleva los numeros de la decision ──────────
// Un "no" que le cuesta una evaluacion a alguien tiene que ser auditable: la
// web discrimina por el codigo, y los details son la explicacion.
assert.strictEqual(ESTUDIO_NO_PORTABLE_ERROR_CODE, 'ESTUDIO_NO_PORTABLE');
const err = errorNoPortable(noPortable(dentroDe15PeroSobre40));
assert.ok(err instanceof AppError, 'debe ser un AppError, no un Error pelado');
assert.strictEqual(err.statusCode, 400);
assert.strictEqual(err.errorCode, ESTUDIO_NO_PORTABLE_ERROR_CODE, 'codigo propio, no BAD_REQUEST generico');
assert.notStrictEqual(err.errorCode, 'BAD_REQUEST');
assert.deepStrictEqual(err.details, {
  motivo: 'canon_ingreso_excede',
  canon_original_cop: 2_000_000,
  canon_destino_cop: 2_200_000,
  canon_maximo_tolerado_cop: 2_300_000,
  tolerancia_pct: 15,
  canon_ingreso_destino_pct: 43.14,
  veredicto_canon_ingreso: 'no_cumple',
  canon_ingreso_maximo_pct: 40,
  tope_cop: 3_000_000,
});
console.log('\nerrorCode:', err.errorCode);
console.log('details:', JSON.stringify(err.details));

// ── 12. La regla es PURA: mismo insumo, mismo veredicto, sin Supabase ──────
// Si evaluarPortabilidad tocara la base, este check ni siquiera correria (las
// credenciales de arriba son de mentira). Que llegue hasta aca ya lo prueba; se
// deja explicito el determinismo.
assert.deepStrictEqual(
  evaluarPortabilidad({ canonOriginal: 2_000_000, ingresoOriginal: 5_100_000, canonDestino: 2_200_000 }),
  evaluarPortabilidad({ canonOriginal: 2_000_000, ingresoOriginal: 5_100_000, canonDestino: 2_200_000 }),
  'la funcion es pura y determinista',
);

console.log('\nOK — todas las aserciones pasaron');
