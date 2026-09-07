/**
 * Check de las CUATRO RUTAS del resultado (Flujo §10) con las bandas de la
 * Adenda 1 §3.
 *
 * Existe porque este modulo es lo que el prospecto LEE cuando sale su
 * resultado, y equivocarse aqui tiene dos costos distintos y ambos caros:
 * decirle "aprobado" a quien no lo esta compromete a Cofianza con un riesgo
 * que no acepto, y decirle "no" a quien si podia continuar con un
 * coarrendatario es un cliente perdido — justo lo que el §10 quiere evitar.
 *
 * Y fija la CORRECCION de Gerencia (Adenda §3): la zona gris es 70-84
 * COMPLETA y el 80 es el umbral del COARRENDATARIO, no del solicitante. La
 * lectura anterior ("80-84 perfil medio") le quitaba la palanca del
 * coarrendatario al segmento 70-79, "precisamente el segmento al que apunta
 * la propuesta comercial de Cofianza". Si alguien la reintroduce, este check
 * se cae.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-rutas-resultado.ts
 */

import assert from 'node:assert';

import {
  resolverRuta,
  CORTE_PERFIL_FUERTE,
  CORTE_ZONA_GRIS,
  UMBRAL_COARRENDATARIO,
  type EntradaRuta,
} from '@/modules/estudios/rutas-resultado';

const BASE: EntradaRuta = {
  puntaje: 90,
  resultadoVigente: 'aprobado',
  reglaDuraActivada: false,
  coarrendatarioVinculado: false,
  puntajeCoarrendatario: null,
};

const e = (o: Partial<EntradaRuta>): EntradaRuta => ({ ...BASE, ...o });

let ok = 0;
function check(nombre: string, fn: () => void) {
  fn();
  ok++;
  console.log(`  ok  ${nombre}`);
}

console.log('\nAdenda §3 — las bandas correctas');

assert.strictEqual(CORTE_PERFIL_FUERTE, 85);
assert.strictEqual(CORTE_ZONA_GRIS, 70);
assert.strictEqual(UMBRAL_COARRENDATARIO, 80);

check('>= 85 es aprobado automatico: firma solo, y el acompanante le abarata la prima (Adenda §5.2)', () => {
  const r = resolverRuta(e({ puntaje: CORTE_PERFIL_FUERTE }));
  assert.strictEqual(r.ruta, 'perfil_fuerte');
  assert.strictEqual(r.puedeContinuarSolo, true);
  assert.strictEqual(r.coarrendatarioObligatorio, false);
  assert.strictEqual(r.coarrendatarioAbarataPrima, true, 'la prima de vinculacion baja del 20% al 10% con coarrendatario');
});

check('84 es zona gris; 85 ya es aprobado automatico (el borde exacto)', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: 84 })).ruta, 'coarrendatario_requerido');
  assert.strictEqual(resolverRuta(e({ puntaje: 85 })).ruta, 'perfil_fuerte');
});

check('70-84 COMPLETA exige coarrendatario y BLOQUEA continuar solo — NO existe "perfil medio" por puntaje', () => {
  for (const p of [70, 75, 79, 80, 82, 84]) {
    const r = resolverRuta(e({ puntaje: p }));
    assert.strictEqual(r.ruta, 'coarrendatario_requerido', `puntaje ${p}`);
    assert.strictEqual(r.puedeContinuarSolo, false, `§10: "la opcion de continuar solo se muestra bloqueada" (${p})`);
    assert.strictEqual(r.coarrendatarioObligatorio, true);
    assert.notStrictEqual(r.ruta, 'perfil_medio', `Adenda §3: 80-84 NO es perfil medio (${p})`);
  }
});

check('69 no es aprobable; 70 ya entra a la zona gris (el borde exacto)', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: 69 })).ruta, 'no_aprobable');
  assert.strictEqual(resolverRuta(e({ puntaje: 70 })).ruta, 'coarrendatario_requerido');
});

check('< 70 es no aprobable y NINGUN coarrendatario lo salva', () => {
  const r = resolverRuta(e({ puntaje: 69, coarrendatarioVinculado: true, puntajeCoarrendatario: 100 }));
  assert.strictEqual(r.ruta, 'no_aprobable');
  assert.strictEqual(r.coarrendatarioObligatorio, false, '§5: "ningun coarrendatario compensa"');
});

console.log('\nAdenda §3 — el 80 es del COARRENDATARIO');

check('zona gris + coarrendatario >= 80 se comunica como aprobado con acompanante', () => {
  for (const p of [70, 79, 84]) {
    const r = resolverRuta(e({ puntaje: p, coarrendatarioVinculado: true, puntajeCoarrendatario: UMBRAL_COARRENDATARIO }));
    assert.strictEqual(r.ruta, 'coarrendatario_requerido');
    assert.ok(r.titulo.toLowerCase().includes('aprobada'), `titular ${p} + coarrendatario 80: aprobacion automatica condicionada`);
  }
});

check('zona gris + coarrendatario 79 NO se comunica como aprobado (revision manual)', () => {
  const r = resolverRuta(e({ puntaje: 75, coarrendatarioVinculado: true, puntajeCoarrendatario: 79 }));
  assert.ok(!r.titulo.toLowerCase().includes('aprobada'));
  assert.ok(r.etiquetaGestor.includes('revision manual'));
});

check('los umbrales del panel de calibracion mandan sobre los defaults', () => {
  const u = { aprobacion: 90, zonaGris: 60, coarrendatario: 85 };
  assert.strictEqual(resolverRuta(e({ puntaje: 88, umbrales: u })).ruta, 'coarrendatario_requerido', '88 < 90 ya no es fuerte');
  assert.strictEqual(resolverRuta(e({ puntaje: 62, umbrales: u })).ruta, 'coarrendatario_requerido', '62 >= 60 entra a la zona gris');
  const conCoa = resolverRuta(e({ puntaje: 75, umbrales: u, coarrendatarioVinculado: true, puntajeCoarrendatario: 84 }));
  assert.ok(!conCoa.titulo.toLowerCase().includes('aprobada'), 'coarrendatario 84 < 85 no aprueba');
});

console.log('\nJerarquia — el orden de los casos NO se puede reordenar');

check('una regla dura anula el mejor puntaje posible', () => {
  const r = resolverRuta(e({ puntaje: 100, reglaDuraActivada: true }));
  assert.strictEqual(r.ruta, 'no_aprobable', '§6: la regla dura anula el puntaje');
});

check('la regla dura gana incluso sobre un condicionado', () => {
  const r = resolverRuta(e({ puntaje: 100, reglaDuraActivada: true, resultadoVigente: 'condicionado' }));
  assert.strictEqual(r.ruta, 'no_aprobable');
});

check('condicionado = en revision, NO adelantamos veredicto', () => {
  const r = resolverRuta(e({ puntaje: 20, resultadoVigente: 'condicionado' }));
  assert.strictEqual(r.ruta, 'en_revision');
  assert.strictEqual(r.puedeContinuarSolo, false);
});

check('pendiente tampoco adelanta veredicto', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: 95, resultadoVigente: 'pendiente' })).ruta, 'en_revision');
});

check('el rechazo registrado manda aunque el puntaje sea alto', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: 95, resultadoVigente: 'rechazado' })).ruta, 'no_aprobable');
});

console.log('\nAprobado sin puntaje del modelo (el buro aprobo y el motor no pudo calcular)');

check('sin puntaje se aprueba con la opcion abierta, no se inventa un perfil fuerte', () => {
  const r = resolverRuta(e({ puntaje: null, resultadoVigente: 'aprobado' }));
  assert.strictEqual(r.ruta, 'perfil_medio');
  assert.strictEqual(r.puedeContinuarSolo, true);
});

check('sin puntaje pero rechazado sigue siendo no aprobable', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: null, resultadoVigente: 'rechazado' })).ruta, 'no_aprobable');
});

console.log('\n§13 — el lenguaje hacia el prospecto');

const TODAS: EntradaRuta[] = [
  e({ puntaje: 95 }),
  e({ puntaje: 82 }),
  e({ puntaje: 75 }),
  e({ puntaje: 75, coarrendatarioVinculado: true, puntajeCoarrendatario: 85 }),
  e({ puntaje: 50 }),
  e({ reglaDuraActivada: true }),
  e({ resultadoVigente: 'condicionado' }),
  e({ puntaje: null }),
];

check('ninguna ruta usa la palabra "rechazado" con el prospecto', () => {
  for (const entrada of TODAS) {
    const r = resolverRuta(entrada);
    const texto = `${r.titulo} ${r.mensaje}`.toLowerCase();
    assert.ok(!texto.includes('rechaz'), `"${r.ruta}" dice rechazado: ${texto}`);
  }
});

check('ninguna ruta dice "seguro" ni "aseguradora" (Cofianza es afianzadora)', () => {
  for (const entrada of TODAS) {
    const r = resolverRuta(entrada);
    const texto = `${r.titulo} ${r.mensaje}`.toLowerCase();
    assert.ok(!texto.includes('seguro'), `"${r.ruta}" dice seguro`);
    assert.ok(!texto.includes('aseguradora'), `"${r.ruta}" dice aseguradora`);
  }
});

check('ninguna ruta le filtra al prospecto el puntaje ni los umbrales', () => {
  for (const entrada of TODAS) {
    const r = resolverRuta(entrada);
    const texto = `${r.titulo} ${r.mensaje}`;
    assert.ok(!/\d{2,}\s*(pts|puntos)/i.test(texto), `"${r.ruta}" filtra puntaje: ${texto}`);
  }
});

check('la etiqueta del gestor SI puede ser tecnica (es interna)', () => {
  const r = resolverRuta(e({ puntaje: 75 }));
  assert.ok(r.etiquetaGestor.includes('75'), 'el gestor necesita el dato crudo');
});

check('toda ruta trae titulo y mensaje no vacios', () => {
  for (const entrada of TODAS) {
    const r = resolverRuta(entrada);
    assert.ok(r.titulo.trim().length > 0 && r.mensaje.trim().length > 0);
  }
});

console.log(`\nTodos los casos pasan (${ok}): las cuatro rutas del §10 con las bandas de la Adenda §3.\n`);
