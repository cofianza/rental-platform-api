/**
 * Check de las CUATRO RUTAS del resultado (Flujo §10).
 *
 * Existe porque este modulo es lo que el prospecto LEE cuando sale su
 * resultado, y equivocarse aqui tiene dos costos distintos y ambos caros:
 * decirle "aprobado" a quien no lo esta compromete a Cofianza con un riesgo
 * que no acepto, y decirle "no" a quien si podia continuar con un
 * coarrendatario es un cliente perdido — justo lo que el §10 quiere evitar
 * ("nunca es un portazo").
 *
 * Ademas fija la jerarquia: regla dura > revision manual > buro > bandas. Si
 * alguien reordena esos casos, un caso con regla dura activada podria salir
 * como aprobado. Este check se cae si eso pasa.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-rutas-resultado.ts
 */

import assert from 'node:assert';

import {
  resolverRuta,
  CORTE_PERFIL_FUERTE,
  CORTE_PERFIL_MEDIO,
  CORTE_ZONA_GRIS,
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

console.log('\n§10 — las cuatro rutas por banda');

check('>= 85 es perfil fuerte y firma solo', () => {
  const r = resolverRuta(e({ puntaje: CORTE_PERFIL_FUERTE }));
  assert.strictEqual(r.ruta, 'perfil_fuerte');
  assert.strictEqual(r.puedeContinuarSolo, true);
  assert.strictEqual(r.coarrendatarioObligatorio, false);
});

check('80-84 es perfil medio: puede solo, y el acompanante le abarata la prima', () => {
  const r = resolverRuta(e({ puntaje: CORTE_PERFIL_MEDIO }));
  assert.strictEqual(r.ruta, 'perfil_medio');
  assert.strictEqual(r.puedeContinuarSolo, true);
  assert.strictEqual(r.coarrendatarioAbarataPrima, true, 'el 10 pide mostrar el incentivo de menor prima');
});

check('84 sigue siendo perfil medio; 85 ya es fuerte (el borde exacto)', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: 84 })).ruta, 'perfil_medio');
  assert.strictEqual(resolverRuta(e({ puntaje: 85 })).ruta, 'perfil_fuerte');
});

check('70-79 exige coarrendatario y BLOQUEA continuar solo', () => {
  const r = resolverRuta(e({ puntaje: CORTE_ZONA_GRIS }));
  assert.strictEqual(r.ruta, 'coarrendatario_requerido');
  assert.strictEqual(r.puedeContinuarSolo, false, '10: "la opcion de continuar solo se muestra bloqueada"');
  assert.strictEqual(r.coarrendatarioObligatorio, true);
});

check('79 exige acompanante; 80 ya no (el borde exacto)', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: 79 })).ruta, 'coarrendatario_requerido');
  assert.strictEqual(resolverRuta(e({ puntaje: 80 })).ruta, 'perfil_medio');
});

check('< 70 es no aprobable y NINGUN coarrendatario lo salva', () => {
  const r = resolverRuta(e({ puntaje: 69, coarrendatarioVinculado: true, puntajeCoarrendatario: 100 }));
  assert.strictEqual(r.ruta, 'no_aprobable');
  assert.strictEqual(
    r.coarrendatarioObligatorio,
    false,
    '5: "ningun coarrendatario compensa; el ocupante define el riesgo principal"',
  );
});

console.log('\n§10 — la zona gris con acompanante ya vinculado');

check('zona gris + coarrendatario >= 80 se comunica como aprobado con acompanante', () => {
  const r = resolverRuta(e({ puntaje: 75, coarrendatarioVinculado: true, puntajeCoarrendatario: 85 }));
  assert.strictEqual(r.ruta, 'coarrendatario_requerido');
  assert.ok(r.titulo.toLowerCase().includes('aprobada'), 'ya lo tiene: el titulo debe reflejarlo');
});

check('zona gris + coarrendatario debil NO se comunica como aprobado', () => {
  const r = resolverRuta(e({ puntaje: 75, coarrendatarioVinculado: true, puntajeCoarrendatario: 60 }));
  assert.ok(!r.titulo.toLowerCase().includes('aprobada'));
});

console.log('\nJerarquia — el orden de los casos NO se puede reordenar');

check('una regla dura anula el mejor puntaje posible', () => {
  const r = resolverRuta(e({ puntaje: 100, reglaDuraActivada: true }));
  assert.strictEqual(r.ruta, 'no_aprobable', '6: la regla dura anula el puntaje');
});

check('la regla dura gana incluso sobre un condicionado', () => {
  const r = resolverRuta(e({ puntaje: 100, reglaDuraActivada: true, resultadoVigente: 'condicionado' }));
  assert.strictEqual(r.ruta, 'no_aprobable');
});

check('condicionado = en revision, NO adelantamos veredicto', () => {
  const r = resolverRuta(e({ puntaje: 20, resultadoVigente: 'condicionado' }));
  assert.strictEqual(r.ruta, 'en_revision', 'mientras un humano decide no se le dice "no" al prospecto');
  assert.strictEqual(r.puedeContinuarSolo, false);
});

check('pendiente tampoco adelanta veredicto', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: 95, resultadoVigente: 'pendiente' })).ruta, 'en_revision');
});

check('el rechazo del buro manda aunque el puntaje sea alto', () => {
  const r = resolverRuta(e({ puntaje: 95, resultadoVigente: 'rechazado' }));
  assert.strictEqual(r.ruta, 'no_aprobable', 'hoy el buro es la autoridad; el scorecard va en sombra');
});

console.log('\nEl caso NORMAL de hoy: aprobado por el buro y sin puntaje');

check('sin puntaje del modelo se aprueba con la opcion abierta, no se inventa un perfil fuerte', () => {
  const r = resolverRuta(e({ puntaje: null, resultadoVigente: 'aprobado' }));
  assert.strictEqual(r.ruta, 'perfil_medio');
  assert.strictEqual(r.puedeContinuarSolo, true);
  assert.notStrictEqual(r.ruta, 'perfil_fuerte', 'no hay puntaje que justifique "firma solo, no necesitas nada mas"');
});

check('sin puntaje pero rechazado por el buro sigue siendo no aprobable', () => {
  assert.strictEqual(resolverRuta(e({ puntaje: null, resultadoVigente: 'rechazado' })).ruta, 'no_aprobable');
});

console.log('\n§13 — el lenguaje hacia el prospecto');

const TODAS: EntradaRuta[] = [
  e({ puntaje: 95 }),
  e({ puntaje: 82 }),
  e({ puntaje: 75 }),
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

console.log(`\nTodos los casos pasan (${ok}): las cuatro rutas del 10 respetan la jerarquia y el lenguaje.\n`);
