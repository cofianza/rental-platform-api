/**
 * Check del aviso de estudio vigente (§5.2) y de su ventana de vigencia.
 *
 * Flujo de Gerencia, modulo de estudios, §5.2 "PASO 2 — SOLICITANTE":
 *
 *   "Si ya existe un estudio vigente para ese mismo numero de documento, el
 *    sistema lo informa y ofrece consultarlo o reutilizarlo, en lugar de crear
 *    uno nuevo y cobrarlo."
 *
 * Existe porque este aviso es lo que evita COBRARLE DOS VECES a la misma
 * persona, y porque el match por documento es facil de romper: si se compara
 * solo el numero, una CC y una CE con la misma cifra —dos personas distintas—
 * se confunden, y le mostrariamos a un gestor el estudio de un tercero.
 *
 * La seleccion vive en una funcion PURA (filas + documento + ventana ->
 * resultado) para poder ejercitarla aqui sin Supabase.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-estudio-vigente.ts
 */

import assert from 'node:assert';

// El service importa @/lib/supabase, que valida el env al cargar. Este check
// no toca la red ni la base. Mismos minimos que check-autorizacion-previa.ts.
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

import { seleccionarEstudioVigente, type FilaEstudioVigente } from '@/modules/estudios/estudios.service';

const DIA = 24 * 60 * 60 * 1000;
const VALIDEZ = 60 * DIA; // configuracion_sistema.certificateValidityDays
const AHORA = Date.parse('2026-09-04T12:00:00.000Z');

function fila(over: Partial<FilaEstudioVigente> & { tipo?: string; numero?: string; dias?: number }): FilaEstudioVigente {
  const { tipo = 'cc', numero = '1128441234', dias = 10, ...rest } = over;
  return {
    id: 'est-1',
    expediente_id: 'exp-1',
    resultado: 'aprobado',
    fecha_completado: new Date(AHORA - dias * DIA).toISOString(),
    datos_formulario: { tipo_documento: tipo, numero_documento: numero },
    ...rest,
  };
}

let ok = 0;
function check(nombre: string, fn: () => void) {
  fn();
  ok++;
  console.log(`  ok  ${nombre}`);
}

console.log('\n§5.2 — a quien corresponde el estudio');

check('mismo tipo y mismo numero: lo encuentra', () => {
  const r = seleccionarEstudioVigente([fila({})], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.ok(r, 'deberia encontrarlo');
  assert.strictEqual(r.id, 'est-1');
});

check('mismo numero pero OTRO tipo de documento: NO es la misma persona', () => {
  const r = seleccionarEstudioVigente([fila({ tipo: 'cc' })], 'ce', '1128441234', VALIDEZ, AHORA);
  assert.strictEqual(r, null, 'una CC y una CE con la misma cifra son personas distintas');
});

check('otro numero con el mismo tipo: no lo confunde', () => {
  const r = seleccionarEstudioVigente([fila({ numero: '1128441234' })], 'cc', '9999999999', VALIDEZ, AHORA);
  assert.strictEqual(r, null);
});

check('el tipo se compara sin distinguir mayusculas', () => {
  const r = seleccionarEstudioVigente([fila({ tipo: 'CC' })], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.ok(r, 'datos_formulario es JSON de varios origenes: puede venir en mayusculas');
});

check('el numero se compara recortado (espacios de un copy/paste)', () => {
  const r = seleccionarEstudioVigente([fila({ numero: ' 1128441234 ' })], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.ok(r);
});

check('sin datos_formulario no revienta: simplemente no hay match', () => {
  const r = seleccionarEstudioVigente([fila({ datos_formulario: null })], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.strictEqual(r, null);
});

console.log('\n§5.2 — la ventana de vigencia');

check('dentro de los 60 dias: vigente', () => {
  const r = seleccionarEstudioVigente([fila({ dias: 59 })], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.ok(r);
  assert.strictEqual(r.dias_restantes, 1);
});

check('justo en el borde de los 60 dias: YA NO es vigente', () => {
  const r = seleccionarEstudioVigente([fila({ dias: 60 })], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.strictEqual(r, null, 'a los 60 dias exactos ya vencio: no se puede ofrecer reutilizarlo');
});

check('vencido hace rato: null, no un numero negativo', () => {
  const r = seleccionarEstudioVigente([fila({ dias: 200 })], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.strictEqual(r, null);
});

check('recien completado: le quedan los 60 dias completos', () => {
  const r = seleccionarEstudioVigente([fila({ dias: 0 })], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.ok(r);
  assert.strictEqual(r.dias_restantes, 60);
  assert.strictEqual(r.vigente_hasta, new Date(AHORA + VALIDEZ).toISOString());
});

check('sin fecha_completado no se puede fechar la vigencia: null', () => {
  const r = seleccionarEstudioVigente([fila({ fecha_completado: null })], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.strictEqual(r, null, 'sin ancla no hay vigencia que ofrecer');
});

console.log('\n§5.2 — cual de varios');

check('con varios candidatos toma el primero (la query los trae mas reciente primero)', () => {
  const reciente = fila({ dias: 5 });
  const viejo = { ...fila({ dias: 50 }), id: 'est-viejo' };
  const r = seleccionarEstudioVigente([reciente, viejo], 'cc', '1128441234', VALIDEZ, AHORA);
  assert.ok(r);
  assert.strictEqual(r.id, 'est-1', 'debe respetar el orden que le da la query');
});

check('lista vacia: null', () => {
  assert.strictEqual(seleccionarEstudioVigente([], 'cc', '1128441234', VALIDEZ, AHORA), null);
});

console.log(`\nTodos los casos pasan (${ok}): el aviso del §5.2 no confunde personas ni ofrece estudios vencidos.\n`);
