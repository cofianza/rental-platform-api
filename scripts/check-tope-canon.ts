/**
 * Check del tope de canon (flujo del modulo de estudios, seccion 4.4).
 *
 * Existe porque esta regla decide, ANTES de cualquier cobro, si un estudio
 * puede nacer: "Si el canon supera el maximo permitido sin acuerdo de
 * coafianzamiento, el flujo se detiene con un mensaje claro y no se cobra el
 * estudio. Hasta 3.000.000" (Gerencia, Direccion de Riesgo, 2026-09-03 —
 * resolviendo la contradiccion con la Politica V4.1 §6, que decia 2.000.000).
 * Un error de un peso en cualquiera de los dos sentidos es plata: o se cobra un
 * estudio que Cofianza no puede afianzar, o se bloquea uno que si.
 *
 * La decision vive en una funcion PURA (canon + tope -> veredicto) justamente
 * para poder ejercitarla aqui sin Supabase. `assertCanonDentroDelTope` solo lee
 * el canon del inmueble y traduce el veredicto a un AppError.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-tope-canon.ts
 */

import assert from 'node:assert';

// El guard importa @/lib/supabase y @/config/env, que validan el env al cargar.
// Este check no toca la red ni la base: solo ejercita las funciones puras. Se
// rellenan los minimos que faltan, SIN pisar los reales si el .env.local ya
// esta cargado.
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

// El default del env es parte de lo que se verifica (3.000.000): se borra
// cualquier override del entorno para que el check mida la regla y no la
// configuracion de la maquina donde corre.
delete process.env.CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP;

import {
  evaluarTopeCanon,
  errorTopeExcedido,
  getTopeCanon,
  mensajeTopeExcedido,
  CANON_EXCEDE_TOPE_ERROR_CODE,
} from '@/modules/estudios/tope-canon.guard';
import { AppError } from '@/lib/errors';

const TOPE = 3_000_000;

// ── 0. El default vigente ──────────────────────────────────────────────────
// Gerencia dijo 3.000.000. Si alguien cambia el default en env.ts, esto cae.
assert.strictEqual(getTopeCanon(), TOPE, 'el tope por defecto debe ser 3.000.000 COP');
console.log('tope vigente:', getTopeCanon().toLocaleString('es-CO'));

// ── 1. Justo en el tope: PERMITE ───────────────────────────────────────────
// El documento dice "Hasta 3.000.000" y bloquea solo lo que lo "supera": el
// tope es INCLUSIVO. Es la frontera donde un `>=` en vez de un `>` costaria un
// negocio real por cada canon redondo de tres millones.
const enElTope = evaluarTopeCanon({ canonCop: TOPE });
console.log('3.000.000 ->', enElTope.ok ? 'permite' : `bloquea (${enElTope.motivo})`);
assert.strictEqual(enElTope.ok, true, '3.000.000 exactos deben pasar: "hasta 3.000.000"');
assert.strictEqual(enElTope.ok && enElTope.canonConocido, true);

// ── 2. Un peso por encima: BLOQUEA ─────────────────────────────────────────
const unPesoMas = evaluarTopeCanon({ canonCop: 3_000_001 });
console.log('3.000.001 ->', unPesoMas.ok ? 'permite' : `bloquea (${unPesoMas.motivo})`);
assert.strictEqual(unPesoMas.ok, false, '3.000.001 supera el tope');
assert.strictEqual(unPesoMas.ok === false && unPesoMas.motivo, 'excede_tope');

// ── 3. Caso REAL: el estudio productivo del 2026-09-02 ─────────────────────
// Se ejecuto con canon 3.800.000. Con esta regla no se habria podido crear: es
// exactamente el caso que Gerencia quiso cortar antes del cobro.
const productivo0902 = evaluarTopeCanon({ canonCop: 3_800_000 });
console.log('3.800.000 (estudio real 2026-09-02) ->', productivo0902.ok ? 'permite' : 'bloquea');
assert.strictEqual(productivo0902.ok, false, 'el estudio del 2026-09-02 (3.800.000) debe bloquearse');
assert.strictEqual(productivo0902.ok === false && productivo0902.canonCop, 3_800_000);
assert.strictEqual(productivo0902.ok === false && productivo0902.topeCop, TOPE);

// PostgREST devuelve NUMERIC como string: el mismo canon en texto tiene que
// decidir igual, o el guard dejaria pasar todo al leerlo de la base.
const comoString = evaluarTopeCanon({ canonCop: '3800000' });
assert.strictEqual(comoString.ok, false, 'un canon en string (NUMERIC de PostgREST) decide igual');
const conDecimales = evaluarTopeCanon({ canonCop: '3800000.00' });
assert.strictEqual(conDecimales.ok, false, 'NUMERIC con decimales tambien');

// ── 4. Por debajo del tope: PERMITE ────────────────────────────────────────
for (const canon of [1, 850_000, 2_000_000, 2_999_999]) {
  const v = evaluarTopeCanon({ canonCop: canon });
  assert.strictEqual(v.ok, true, `${canon} esta por debajo del tope y debe pasar`);
  assert.strictEqual(v.ok && v.canonConocido, true);
}
console.log('canones por debajo del tope -> permiten');

// ── 5. Canon ausente o absurdo: PERMITE, marcado como desconocido ──────────
// COMPORTAMIENTO DECIDIDO Y DOCUMENTADO: un canon nulo, cero, negativo o no
// numerico NO bloquea. Un canon ausente no "supera" nada — es un vacio de
// datos, no un inmueble caro, y bloquear por un vacio seria una restriccion
// que Gerencia no pidio. Se deja pasar y se registra un warning en el log.
//
// OJO con el alcance: el esquema NO permite un inmueble sin canon
// (inmuebles.valor_arriendo es numeric NOT NULL con CHECK > 0, y
// expedientes.inmueble_id es NOT NULL — verificado contra la base productiva
// el 2026-09-03), asi que con datos legitimos esta rama solo se alcanza en el
// caso estructural: que todavia no haya inmueble que resolver. Por eso el
// guard NO usa esta rama cuando la consulta a Supabase falla: ahi lanza
// (CANON_NO_VERIFICABLE, 503), porque tragarse un timeout convertiria una
// caida de la base en permiso para cobrar. Esta funcion pura sigue tolerando
// basura porque lo que NO puede pasar es reventar: por eso se ejercita.
const sinCanon: Array<number | string | null | undefined> = [
  null,
  undefined,
  0,
  -1,
  -3_800_000,
  '',
  '  ',
  'no-es-un-numero',
  Number.NaN,
  Number.POSITIVE_INFINITY,
];
for (const canon of sinCanon) {
  const v = evaluarTopeCanon({ canonCop: canon });
  assert.strictEqual(v.ok, true, `canon ${String(canon)} no debe bloquear (vacio de datos, no exceso)`);
  assert.strictEqual(v.ok && v.canonConocido, false, `canon ${String(canon)} debe marcarse como desconocido`);
  assert.strictEqual(v.ok && v.canonCop, null, `canon ${String(canon)} se normaliza a null`);
}
console.log(`${sinCanon.length} canones no utilizables -> permiten, marcados canonConocido=false`);

// ── 6. Tope configurable (regla TRANSITORIA) ───────────────────────────────
// El tope sube cuando exista el acuerdo de coafianzamiento, sin desplegar. Con
// un tope de 5.000.000 el mismo canon de 3.800.000 tiene que pasar.
const conTopeMayor = evaluarTopeCanon({ canonCop: 3_800_000, topeCop: 5_000_000 });
assert.strictEqual(conTopeMayor.ok, true, 'con el tope subido, 3.800.000 pasa');
const conTopeMenor = evaluarTopeCanon({ canonCop: 2_500_000, topeCop: 2_000_000 });
assert.strictEqual(conTopeMenor.ok, false, 'con el tope de la Politica V4.1 (2.000.000), 2.500.000 se bloquea');
console.log('tope configurable -> respeta el valor inyectado');

// ── 7. El error es de DOMINIO, no una excepcion generica ───────────────────
assert.strictEqual(CANON_EXCEDE_TOPE_ERROR_CODE, 'CANON_EXCEDE_TOPE');

const err = errorTopeExcedido(productivo0902 as Extract<typeof productivo0902, { ok: false }>);
assert.ok(err instanceof AppError, 'debe ser un AppError, no un Error pelado');
assert.strictEqual(err.statusCode, 400);
assert.strictEqual(err.errorCode, CANON_EXCEDE_TOPE_ERROR_CODE, 'codigo propio, no BAD_REQUEST generico');
assert.notStrictEqual(err.errorCode, 'BAD_REQUEST');
assert.deepStrictEqual(err.details, {
  motivo: 'excede_tope',
  canon_cop: 3_800_000,
  tope_cop: TOPE,
});
console.log('\nerrorCode:', err.errorCode);
console.log('details:', JSON.stringify(err.details));

// ── 8. El mensaje es accionable y no dramatico ─────────────────────────────
const mensaje = mensajeTopeExcedido(3_800_000, TOPE);
console.log('mensaje:', mensaje);
assert.strictEqual(err.message, mensaje, 'el AppError lleva el mensaje accionable');
assert.ok(/3\.800\.000/.test(mensaje), 'debe decir cual es el canon');
assert.ok(/3\.000\.000/.test(mensaje), 'debe decir cual es el tope');
assert.ok(/coafianzamiento/i.test(mensaje), 'debe explicar POR QUE (falta el acuerdo de coafianzamiento)');
assert.ok(/no se genero ningun cobro/i.test(mensaje), 'debe dejar claro que no se cobro — es la promesa del §4.4');
// El flujo §13 prohibe la palabra "rechazado" en pantallas del prospecto y pide
// que ninguna ruta sea un portazo.
assert.ok(!/rechaz/i.test(mensaje), 'el flujo §13 prohibe hablar de "rechazado"');
assert.ok(!/error|imposible|no puede/i.test(mensaje), 'sin tono dramatico');

// ── 9. La regla es PURA: mismo insumo, mismo veredicto, sin Supabase ───────
// Si evaluarTopeCanon tocara la base, este check ni siquiera correria (las
// credenciales de arriba son de mentira). Que llegue hasta aca ya lo prueba;
// se deja explicito el determinismo.
assert.deepStrictEqual(
  evaluarTopeCanon({ canonCop: 3_800_000 }),
  evaluarTopeCanon({ canonCop: '3800000' }),
  'la funcion es pura y determinista',
);

console.log('\nOK — todas las aserciones pasaron');
