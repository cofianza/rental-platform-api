/**
 * Check del ORDEN del flujo §6.3 y del gate de pago del estudio.
 *
 * Existe porque este gate es lo unico que separa un click de una consulta
 * FACTURABLE e IRREVERSIBLE a una central de riesgo, y porque el orden que
 * protege es normativo, no estetico. Flujo de Gerencia, modulo de estudios,
 * §6.3 "Opcion C — Enlace de pago al prospecto":
 *
 *   "El pago se solicita DESPUES de que el prospecto otorgue la autorizacion y
 *    ANTES de que el motor ejecute la evaluacion. Si se cobra antes de
 *    autorizar, se cobra a personas que nunca autorizan; si se cobra despues
 *    del resultado, se ejecutan evaluaciones que nadie paga. Mientras el pago
 *    no se confirme, el estudio permanece en estado de espera y no consume
 *    consultas a centrales."
 *
 * Hasta 2026-09-04 el codigo hacia PAGO -> AUTORIZACION -> EJECUCION y NADIE
 * verificaba el pago antes del buro: la barrera la daba el orden. Al invertirlo,
 * la barrera pasa a ser el gate. Si alguien lo suaviza, este check se cae.
 *
 * Las dos decisiones viven en funciones PURAS (`siguientePasoEstudio` y
 * `assertPagoEstudio`) justamente para poder ejercitarlas aqui sin Supabase.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-orden-pago-estudio.ts
 */

import assert from 'node:assert';

// El guard importa @/lib/supabase, que valida el env al cargar. Este check no
// toca la red ni la base. Mismos minimos que check-autorizacion-previa.ts.
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

import {
  siguientePasoEstudio,
  assertPagoEstudio,
  senalIndicaPagado,
  PAGO_ESTUDIO_REQUERIDO_ERROR_CODE,
  PAGO_NO_VERIFICABLE_ERROR_CODE,
  ESTADO_ESPERANDO_PAGO,
  type SenalPagoEstudio,
  type PasoEstudio,
} from '@/modules/estudios/pago.guard';
import { AppError } from '@/lib/errors';

let fallos = 0;
function caso(nombre: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${nombre}`);
  } catch (e) {
    fallos++;
    console.error(`  FALLA  ${nombre}\n         ${e instanceof Error ? e.message : String(e)}`);
  }
}

function paso(over: {
  autorizado?: boolean;
  senalPago?: SenalPagoEstudio;
  pagoActivo?: boolean;
  pagoPor?: string | null;
} = {}): PasoEstudio {
  return siguientePasoEstudio({
    autorizado: over.autorizado ?? true,
    senalPago: over.senalPago ?? 'no_pagado',
    pagoActivo: over.pagoActivo ?? false,
    pagoPor: 'pagoPor' in over ? (over.pagoPor ?? null) : 'arrendatario',
  });
}

/** Ejecuta el gate y devuelve el AppError, o null si dejo pasar. */
function gate(senal: SenalPagoEstudio): AppError | null {
  try {
    assertPagoEstudio(senal, { origen: 'ejecutar', expedienteNumero: 'EXP-2026-0007' });
    return null;
  } catch (e) {
    assert.ok(e instanceof AppError, 'el gate debe lanzar AppError');
    return e as AppError;
  }
}

console.log('\n§6.3 — el ORDEN: nunca se cobra antes de autorizar');

caso('sin autorizacion NO se cobra: se pide el habeas data (opcion C)', () => {
  assert.strictEqual(paso({ autorizado: false, pagoPor: 'arrendatario' }), 'pedir_autorizacion');
});

caso('sin autorizacion NO se cobra aunque el gestor no haya decidido quien paga', () => {
  assert.strictEqual(paso({ autorizado: false, pagoPor: null }), 'pedir_autorizacion');
});

caso('sin autorizacion NUNCA se ejecuta, ni con el pago ya confirmado', () => {
  // A y B: el pago existe antes de la firma. Lo que corresponde ahi es pedir la
  // autorizacion, no ir al buro — el gate 8.4 lo rechazaria de todos modos.
  assert.strictEqual(paso({ autorizado: false, senalPago: 'pagado' }), 'pedir_autorizacion');
});

caso('ya autorizo y el pagador es el prospecto: RECIEN AHI se cobra (opcion C)', () => {
  assert.strictEqual(paso({ autorizado: true, pagoPor: 'arrendatario' }), 'cobrar');
});

caso('ya autorizo pero el gestor no decidio quien paga: espera, no se le cobra al prospecto', () => {
  assert.strictEqual(paso({ autorizado: true, pagoPor: null }), 'esperar_pago');
});

caso('ya autorizo y ya hay link vivo: no se emite un segundo cobro', () => {
  assert.strictEqual(paso({ autorizado: true, pagoActivo: true }), 'esperar_pago');
});

console.log('\n§6.3 — la EJECUCION solo con pago confirmado');

caso('autorizacion + pago confirmado = unico caso que va al buro', () => {
  assert.strictEqual(paso({ autorizado: true, senalPago: 'pagado' }), 'ejecutar');
});

caso('opciones A y B (pago ya completado antes de firmar) ejecutan igual que siempre', () => {
  // El pago de credito prepago y el "la inmobiliaria asume" nacen 'completado'.
  assert.strictEqual(paso({ autorizado: true, senalPago: 'pagado', pagoPor: 'inmobiliaria' }), 'ejecutar');
  assert.strictEqual(paso({ autorizado: true, senalPago: 'pagado', pagoPor: null }), 'ejecutar');
});

caso('expedientes historicos ya pagados NO se bloquean (grandfathering)', () => {
  // La señal es la fila en `pagos` que los 8 expedientes de produccion ya
  // tienen: sin migracion ni backfill, pasan.
  assert.strictEqual(gate('pagado'), null);
  assert.strictEqual(paso({ autorizado: true, senalPago: 'pagado' }), 'ejecutar');
});

caso('el pago "no verificable" NO ejecuta: fail-closed en la decision de orden', () => {
  assert.strictEqual(paso({ autorizado: true, senalPago: 'no_verificable', pagoActivo: true }), 'esperar_pago');
  assert.notStrictEqual(paso({ autorizado: true, senalPago: 'no_verificable' }), 'ejecutar');
});

console.log('\nGate de pago (ejecutarEstudio, paso 3.6)');

caso('sin pago: 409 PAGO_ESTUDIO_REQUERIDO, no una consulta al buro', () => {
  const err = gate('no_pagado');
  assert.ok(err, 'el gate tiene que bloquear cuando no hay pago');
  assert.strictEqual(err!.errorCode, PAGO_ESTUDIO_REQUERIDO_ERROR_CODE);
  assert.strictEqual(err!.statusCode, 409);
});

caso('lectura fallida: FAIL-CLOSED con 503 reintentable, nunca "seguro estaba pagado"', () => {
  const err = gate('no_verificable');
  assert.ok(err, 'un error de lectura no puede dejar pasar una consulta facturable');
  assert.strictEqual(err!.errorCode, PAGO_NO_VERIFICABLE_ERROR_CODE);
  assert.strictEqual(err!.statusCode, 503);
});

caso('el mensaje del gate es accionable y no acusa al prospecto', () => {
  const err = gate('no_pagado')!;
  assert.match(err.message, /no figura como pagado/i);
  assert.match(err.message, /se ejecuta solo apenas se confirme el pago/i);
});

caso('la reasignacion §4.3 conserva su codigo y su mensaje propios', () => {
  try {
    assertPagoEstudio('no_pagado', { origen: 'reasignacion', expedienteNumero: 'EXP-2026-0007' });
    assert.fail('deberia bloquear');
  } catch (e) {
    const err = e as AppError;
    assert.strictEqual(err.errorCode, 'ESTUDIO_NO_REASIGNABLE');
    assert.match(err.message, /EXP-2026-0007/);
  }
});

console.log('\nInterruptor bloquear/advertir del tope de canon (§4.4)');

caso('solo un pago confirmado activa el grandfathering del tope', () => {
  assert.strictEqual(senalIndicaPagado('pagado'), true);
  assert.strictEqual(senalIndicaPagado('no_pagado'), false);
  // fail-OPEN a la baja: "no pude verificar" se comporta como no pagado, o sea
  // el tope BLOQUEA. Es el lado seguro para el tope y para el dinero.
  assert.strictEqual(senalIndicaPagado('no_verificable'), false);
});

console.log('\nEstado de espera');

caso("el estudio espera en un valor que ya existe en el enum ('pago_pendiente')", () => {
  // Usar un valor nuevo obligaria a una migracion y a re-razonar
  // ESTADOS_ESTUDIO_FINALES, el guard del certificado y
  // fn_registrar_resultado_estudio (ver reasignacion.service.ts).
  assert.strictEqual(ESTADO_ESPERANDO_PAGO, 'pago_pendiente');
});

caso("'pago_pendiente' NO esta en los estados ejecutables", () => {
  // Defensa en profundidad: aunque el gate es el que manda, un estudio
  // aparcado tampoco pasa el guard de estado que existe desde siempre.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/modules/estudios/estudios.service.ts'),
    'utf8',
  ) as string;
  const linea = src.split('\n').find((l) => l.includes('const ESTADOS_PERMITIDOS_EJECUCION'));
  assert.ok(linea, 'no se encontro ESTADOS_PERMITIDOS_EJECUCION');
  assert.ok(!linea!.includes(ESTADO_ESPERANDO_PAGO), 'pago_pendiente no debe ser ejecutable por estado');
});

console.log('');
if (fallos > 0) {
  console.error(`${fallos} caso(s) fallaron — el orden del §6.3 esta roto.\n`);
  process.exit(1);
}
console.log('Todos los casos pasan: el orden del §6.3 y el gate de pago siguen en pie.\n');
