/**
 * Check del §15 de la Politica: ningun perfil extranjero se aprueba solo.
 *
 * Es una regla que hoy el buro tapa (un CE con buen score sale 'aprobado' y
 * el gestor no ve nada raro) y que se vuelve visible el dia que el motor
 * decida. Se verifica la funcion pura y que el motivo no rechace.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-perfil-extranjero.ts
 */

import assert from 'node:assert';
import { esPerfilExtranjero, motivoRevisionPerfilExtranjero } from '@/modules/estudios/perfil-extranjero';

let pasos = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); pasos++; };

ok(esPerfilExtranjero('cc') === false && esPerfilExtranjero('CC') === false && esPerfilExtranjero(' cc ') === false, 'cedula de ciudadania NO es extranjero');
for (const t of ['ce', 'CE', 'pasaporte', 'ppt', 'pep', 'nit', 'ti']) {
  ok(esPerfilExtranjero(t) === true, `${t} va a revision manual (§15)`);
}
ok(esPerfilExtranjero(null) === false && esPerfilExtranjero(undefined) === false && esPerfilExtranjero('') === false, 'sin documento no se afirma nada (el gate 8.4 ya lo exige)');

ok(motivoRevisionPerfilExtranjero('cc') === null, 'CC no genera motivo');
const m = motivoRevisionPerfilExtranjero('ce') ?? '';
ok(m.includes('§15') && m.includes('cedula de extranjeria'), 'el motivo cita el §15 y el tipo de documento');
ok(/revision manual/i.test(m) && !/rechaz/i.test(m), 'es REVISION, nunca rechazo');
ok((motivoRevisionPerfilExtranjero('ppt') ?? '').includes('PPT'), 'PPT se nombra como tal');
ok((motivoRevisionPerfilExtranjero('xyz') ?? '').includes("documento 'xyz'"), 'un tipo desconocido tambien va a revision, con su codigo');

console.log(`\nOK — ${pasos} aserciones: el §15 manda a revision a todo lo que no sea cedula colombiana, sin rechazar.`);
