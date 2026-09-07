/**
 * Check de la expiracion del estudio (Flujo §12 + §14).
 *
 * Existe porque expirar de mas y expirar de menos fallan de formas distintas y
 * las dos duelen: si un estudio expira antes de tiempo, el gestor cree que
 * perdio al candidato y vuelve a cobrar un estudio que ya estaba pagado; si no
 * expira nunca, el indicador del §4.2 sigue contando candidatos que llevan
 * meses sin responder y el gestor no sabe cuales estan vivos de verdad.
 *
 * Fija ademas de donde arranca el reloj —de cuando se le PIDIO la autorizacion
 * al prospecto, no de cuando se creo el estudio— que es la parte que se presta
 * a equivocarse.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-expiracion.ts
 */

import assert from 'node:assert';

import {
  evaluarExpiracion,
  cuentaComoEnCurso,
  PLAZO_EXPIRACION_DIAS,
  type ContextoExpiracion,
} from '@/modules/estudios/expiracion';

const DIA = 24 * 60 * 60 * 1000;
const AHORA = Date.parse('2026-09-07T12:00:00.000Z');

/** Un contexto por defecto: pedida hace `hace` dias, sin firmar, esperando. */
const ctx = (o: Partial<ContextoExpiracion> & { hace?: number }): ContextoExpiracion => {
  const { hace = 1, ...resto } = o;
  return {
    estado: 'solicitado',
    autorizacionSolicitadaEn: new Date(AHORA - hace * DIA).toISOString(),
    autorizacionFirmada: false,
    ahoraMs: AHORA,
    ...resto,
  };
};

let ok = 0;
function check(nombre: string, fn: () => void) {
  fn();
  ok++;
  console.log(`  ok  ${nombre}`);
}

console.log('\n§14 — el plazo son 15 dias');

check('el plazo definido por Gerencia es 15 dias', () => {
  assert.strictEqual(PLAZO_EXPIRACION_DIAS, 15);
});

check('a los 14 dias todavia no expira', () => {
  const v = evaluarExpiracion(ctx({ hace: 14 }));
  assert.strictEqual(v.expirado, false);
  assert.strictEqual(v.diasRestantes, 1);
});

check('a los 15 dias exactos YA expiro (el borde)', () => {
  const v = evaluarExpiracion(ctx({ hace: 15 }));
  assert.strictEqual(v.expirado, true, 'cumplido el plazo, se acabo');
  assert.strictEqual(v.diasRestantes, 0);
});

check('a los 30 dias expiro y los dias restantes son negativos', () => {
  const v = evaluarExpiracion(ctx({ hace: 30 }));
  assert.strictEqual(v.expirado, true);
  assert.ok((v.diasRestantes ?? 0) < 0);
});

check('el plazo se puede parametrizar sin tocar el modulo', () => {
  assert.strictEqual(evaluarExpiracion(ctx({ hace: 8, plazoDias: 7 })).expirado, true);
  assert.strictEqual(evaluarExpiracion(ctx({ hace: 8, plazoDias: 30 })).expirado, false);
});

console.log('\n§12 — de donde arranca el reloj');

check('si NUNCA se le pidio la autorizacion, el plazo no ha empezado', () => {
  const v = evaluarExpiracion(ctx({ hace: 999, autorizacionSolicitadaEn: null }));
  assert.strictEqual(v.expirado, false, 'no puede expirar algo que nunca se le pidio al prospecto');
  assert.strictEqual(v.diasRestantes, null);
});

check('un estudio viejo pero recien enviado al prospecto NO expira', () => {
  // El estudio pudo pasar meses en el panel esperando que el gestor eligiera
  // la forma de pago (§6). Ese tiempo no es del prospecto.
  const v = evaluarExpiracion(ctx({ hace: 0 }));
  assert.strictEqual(v.expirado, false);
  assert.strictEqual(v.diasRestantes, PLAZO_EXPIRACION_DIAS);
});

check('si el prospecto YA firmo, el reloj deja de correr', () => {
  const v = evaluarExpiracion(ctx({ hace: 100, autorizacionFirmada: true }));
  assert.strictEqual(v.expirado, false);
  assert.strictEqual(v.expiraEn, null);
});

console.log('\nEstados en los que el reloj NO corre');

for (const estado of ['en_proceso', 'completado', 'fallido', 'cancelado', 'autorizado', 'documentos_cargados', 'formulario_completado']) {
  check(`'${estado}' no expira: ya no espera al prospecto`, () => {
    assert.strictEqual(evaluarExpiracion(ctx({ hace: 400, estado })).expirado, false);
  });
}

for (const estado of ['solicitado', 'pago_pendiente', 'pagado', 'formulario_enviado']) {
  check(`'${estado}' SI expira: esta esperando al prospecto`, () => {
    assert.strictEqual(evaluarExpiracion(ctx({ hace: 400, estado })).expirado, true);
  });
}

console.log('\nDatos corruptos: no expirar por las dudas');

check('una fecha ilegible NO expira el estudio', () => {
  const v = evaluarExpiracion(ctx({ autorizacionSolicitadaEn: 'no-es-una-fecha' }));
  assert.strictEqual(v.expirado, false, 'expirar por un dato corrupto es peor que quedarse abierto');
});

check('estado nulo no revienta ni expira', () => {
  assert.strictEqual(evaluarExpiracion(ctx({ hace: 400, estado: null })).expirado, false);
});

console.log('\n§4.2 — un estudio expirado deja de contar como en curso');

check('en curso + no expirado = cuenta', () => {
  assert.strictEqual(cuentaComoEnCurso(ctx({ hace: 3 }), true), true);
});

check('en curso + expirado = NO cuenta', () => {
  assert.strictEqual(
    cuentaComoEnCurso(ctx({ hace: 40 }), true),
    false,
    'seguir contandolo infla el indicador de candidatos en paralelo',
  );
});

check('lo que no esta en curso nunca cuenta, expirado o no', () => {
  assert.strictEqual(cuentaComoEnCurso(ctx({ hace: 1 }), false), false);
  assert.strictEqual(cuentaComoEnCurso(ctx({ hace: 40 }), false), false);
});

console.log('\nEl mensaje al gestor');

check('al expirar se le dice que puede reenviar SIN COSTO (§12)', () => {
  const v = evaluarExpiracion(ctx({ hace: 20 }));
  assert.ok(v.motivo.toLowerCase().includes('sin costo'), v.motivo);
});

check('antes de expirar se le dice cuanto le queda', () => {
  const v = evaluarExpiracion(ctx({ hace: 10 }));
  assert.ok(v.motivo.includes('5'), v.motivo);
});

console.log(`\nTodos los casos pasan (${ok}): la expiracion del §12 cuenta desde que se le pidio al prospecto.\n`);
