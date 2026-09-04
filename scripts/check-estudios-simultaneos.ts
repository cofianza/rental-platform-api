/**
 * Check de los estudios simultaneos por inmueble (Flujo de Gerencia, modulo de
 * estudios, §4.2 — CAMBIO APROBADO).
 *
 * Existe porque este cambio MUEVE la unica proteccion contra el doble arriendo.
 * Antes vivia al principio del flujo ("el inmueble ya tiene un estudio en
 * proceso", RAISE en fn_crear_estudio) y era, ademas de restrictiva, falsa: el
 * camino real del piloto (habilitar estudio desde el expediente) nunca miraba
 * el inmueble, asi que los estudios paralelos ya ocurrian y el bloqueo solo
 * servia para sacar el 80% del inventario de la vitrina.
 *
 * Ahora la proteccion vive al FINAL: la propiedad se reserva cuando un
 * candidato aprobado avanza a la generacion del contrato. Un error aqui no se
 * nota en una pantalla — se nota en un juzgado:
 *
 *   - de menos: dos contratos activos sobre la misma propiedad. Cofianza es
 *     FIADOR de los dos.
 *   - de mas: se vuelve al bloqueo del primer estudio, que es exactamente lo
 *     que Gerencia mando quitar, y los candidatos se van a otra afianzadora.
 *
 * Las decisiones viven en funciones PURAS (estado del inmueble + titular ->
 * veredicto) para poder ejercitarlas aqui sin Supabase; las RPC de la migracion
 * 20260903000005 son la misma logica con un SELECT ... FOR UPDATE delante.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-estudios-simultaneos.ts
 */

import assert from 'node:assert';

// El guard importa @/lib/errors, que no toca el env, pero se rellenan los
// minimos igual que los demas checks por si la cadena de imports crece.
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
  ESTADOS_ESTUDIO_EN_CURSO,
  ESTADOS_ESTUDIO_FINALES,
  esEstudioEnCurso,
  contarEstudiosEnCurso,
  evaluarAdmisionDeEstudio,
  errorNoAdmision,
  mensajeNoAdmision,
  decidirReserva,
  errorReservaPerdida,
  esPublicableEnVitrina,
  puedePublicarseEnVitrina,
  INMUEBLE_RESERVADO_ERROR_CODE,
  INMUEBLE_YA_RESERVADO_ERROR_CODE,
} from '@/modules/estudios/estudios-simultaneos.guard';
import {
  mensajeInmuebleReservado,
  referenciaInmueble,
} from '@/modules/estudios/reserva-inmueble.notificaciones';
import { AppError } from '@/lib/errors';

const EXP_A = '11111111-1111-1111-1111-111111111111';
const EXP_B = '22222222-2222-2222-2222-222222222222';
const EXP_C = '33333333-3333-3333-3333-333333333333';

// ── 1. Un inmueble con N estudios en curso SIGUE admitiendo uno mas ────────
// El corazon del §4.2: "Una misma propiedad debe admitir varios estudios en
// curso de manera simultanea. La propiedad NO se bloquea porque exista un
// estudio en proceso."
//
// Se recorre hasta 25 porque el numero tiene que ser IRRELEVANTE: si alguien
// reintrodujera un tope ("maximo N candidatos") esto lo caza. La justificacion
// de negocio del documento es literal — una inmobiliaria muestra el inmueble a
// varios interesados a la vez y no sabe cual autorizara.
for (const n of [0, 1, 2, 3, 5, 10, 25]) {
  const v = evaluarAdmisionDeEstudio({
    estadoInmueble: 'disponible',
    reservadoPorExpedienteId: null,
    expedienteId: EXP_A,
    estudiosEnCurso: n,
  });
  assert.strictEqual(v.admite, true, `con ${n} estudios en curso el inmueble debe admitir uno mas`);
  assert.strictEqual(v.admite && v.estudiosEnCurso, n, 'el contador viaja intacto en el veredicto');
}
console.log('inmueble disponible con 0..25 estudios en curso -> admite siempre uno mas');

// El legado 'en_estudio' tambien admite. No se elimino del enum (romperia datos
// y codigo), pero dejo de escribirse: una fila historica NO puede seguir
// bloqueando, o los inmuebles atascados en produccion quedarian muertos.
const legado = evaluarAdmisionDeEstudio({
  estadoInmueble: 'en_estudio',
  reservadoPorExpedienteId: null,
  expedienteId: EXP_A,
  estudiosEnCurso: 3,
});
assert.strictEqual(legado.admite, true, "el legado 'en_estudio' ya no bloquea");
console.log("estado legado 'en_estudio' -> admite (ya no es bloqueante)");

// ── 2. Un inmueble RESERVADO no admite nuevos ─────────────────────────────
// "La propiedad se marca como reservada y deja de admitir nuevos estudios
//  unicamente cuando un estudio resulta APROBADO y avanza a la generacion del
//  contrato."
const reservado = evaluarAdmisionDeEstudio({
  estadoInmueble: 'ocupado',
  reservadoPorExpedienteId: EXP_A,
  expedienteId: EXP_B,
  estudiosEnCurso: 4,
});
console.log(
  'reservado por A, lo pide B ->',
  reservado.admite ? 'admite' : `NO admite (${reservado.motivo})`,
);
assert.strictEqual(reservado.admite, false, 'una propiedad reservada no admite candidatos nuevos');
assert.strictEqual(reservado.admite === false && reservado.motivo, 'reservado');
assert.strictEqual(
  reservado.admite === false && reservado.reservadoPorExpedienteId,
  EXP_A,
  'el veredicto dice QUIEN tiene la reserva — sin eso el gestor no puede rastrear el caso',
);

// Ni siquiera con CERO estudios en curso: lo que cierra la puerta es el
// compromiso con el contrato, no la competencia.
assert.strictEqual(
  evaluarAdmisionDeEstudio({
    estadoInmueble: 'ocupado',
    reservadoPorExpedienteId: EXP_A,
    expedienteId: EXP_B,
    estudiosEnCurso: 0,
  }).admite,
  false,
  'la reserva bloquea aunque no haya ningun estudio en curso',
);

// El PROPIO titular si puede seguir moviendo su caso (p. ej. el estudio del
// co-arrendatario del expediente ya aprobado). Sin esta rama, reservar
// congelaria al candidato que gano.
const titularSigue = evaluarAdmisionDeEstudio({
  estadoInmueble: 'ocupado',
  reservadoPorExpedienteId: EXP_A,
  expedienteId: EXP_A,
  estudiosEnCurso: 1,
});
assert.strictEqual(titularSigue.admite, true, 'el titular de la reserva no se bloquea a si mismo');
console.log('reservado por A, lo pide A -> admite (no se bloquea a si mismo)');

// 'ocupado' SIN titular = arrendado de verdad (contrato vigente, activacion
// manual, contrato en papel). Es el bloqueo que YA existia y que este cambio no
// toca: 'ocupado' sigue bloqueando igual que hoy.
const arrendado = evaluarAdmisionDeEstudio({
  estadoInmueble: 'ocupado',
  reservadoPorExpedienteId: null,
  expedienteId: EXP_B,
});
assert.strictEqual(arrendado.admite, false, "'ocupado' sigue bloqueando como siempre");
assert.strictEqual(arrendado.admite === false && arrendado.motivo, 'ocupado');

const inactivo = evaluarAdmisionDeEstudio({ estadoInmueble: 'inactivo', expedienteId: EXP_B });
assert.strictEqual(inactivo.admite, false, "'inactivo' (soft-delete) tampoco admite");
assert.strictEqual(inactivo.admite === false && inactivo.motivo, 'inactivo');
console.log("ocupado sin reserva -> NO admite | inactivo -> NO admite");

// El error es de DOMINIO y accionable. §13 prohibe la palabra "rechazado" y el
// tono de portazo en lo que ve el prospecto.
const errAdm = errorNoAdmision(reservado as Extract<typeof reservado, { admite: false }>);
assert.ok(errAdm instanceof AppError, 'debe ser AppError, no un Error pelado');
assert.strictEqual(errAdm.statusCode, 409);
assert.strictEqual(errAdm.errorCode, INMUEBLE_RESERVADO_ERROR_CODE);
assert.notStrictEqual(errAdm.errorCode, 'CONFLICT', 'codigo propio, no el generico');
// Y ya no puede ser el codigo viejo: la web dejo de manejarlo.
assert.notStrictEqual(errAdm.errorCode, 'INMUEBLE_EN_ESTUDIO');
assert.deepStrictEqual(errAdm.details, {
  motivo: 'reservado',
  reservado_por_expediente_id: EXP_A,
});
for (const motivo of ['reservado', 'ocupado', 'inactivo'] as const) {
  const m = mensajeNoAdmision(motivo);
  assert.ok(!/rechaz/i.test(m), `el §13 prohibe hablar de "rechazado" (${motivo})`);
  assert.ok(m.length > 40, `el mensaje de ${motivo} tiene que explicar y ofrecer salida`);
}
assert.ok(/otra propiedad/i.test(mensajeNoAdmision('reservado')), 'debe ofrecer la salida');
console.log('errorCode:', errAdm.errorCode, '| details:', JSON.stringify(errAdm.details));

// ── 3. Que cuenta como "estudio en curso" ─────────────────────────────────
// El numero del indicador. Si esta lista se desalinea, el gestor ve un
// contador que no corresponde con lo que puede hacer.
const EN_CURSO_ESPERADOS = [
  'solicitado',
  'pago_pendiente',
  'pagado',
  'autorizado',
  'formulario_enviado',
  'formulario_completado',
  'documentos_cargados',
  'en_proceso',
];
assert.deepStrictEqual(
  [...ESTADOS_ESTUDIO_EN_CURSO],
  EN_CURSO_ESPERADOS,
  'los 8 estados en curso del enum estado_estudio',
);
assert.deepStrictEqual(
  [...ESTADOS_ESTUDIO_FINALES],
  ['completado', 'fallido', 'cancelado'],
  'los 3 finales — misma lista que ESTADOS_ESTUDIO_FINALIZADOS de estudios.service',
);
// El enum de produccion tiene 11 valores; los 8 + 3 los cubren todos, sin
// solapamiento. Un valor nuevo en el enum NO cuenta hasta que alguien lo
// agregue a proposito.
assert.strictEqual(ESTADOS_ESTUDIO_EN_CURSO.length + ESTADOS_ESTUDIO_FINALES.length, 11);
for (const e of ESTADOS_ESTUDIO_FINALES) {
  assert.ok(!(ESTADOS_ESTUDIO_EN_CURSO as readonly string[]).includes(e), `${e} no puede estar en ambas`);
  assert.strictEqual(esEstudioEnCurso(e), false, `${e} NO esta en curso`);
}
for (const e of ESTADOS_ESTUDIO_EN_CURSO) {
  assert.strictEqual(esEstudioEnCurso(e), true, `${e} SI esta en curso`);
}

// 'fallido' cuenta como NO-en-curso aunque sea REINTENTABLE: un estudio caido
// por un timeout del buro no es un candidato compitiendo por la propiedad. Es
// el caso real de EXP-2026-0007 sobre el inmueble 2054.
assert.strictEqual(esEstudioEnCurso('fallido'), false, 'fallido no cuenta pese a ser reintentable');

// Basura y ausencias no revientan ni inflan el contador.
for (const basura of [null, undefined, '', '  ', 'no_existe', 'COMPLETADO']) {
  assert.strictEqual(esEstudioEnCurso(basura), false, `"${String(basura)}" no cuenta como en curso`);
}

const muestra = [
  { estado: 'solicitado' },
  { estado: 'en_proceso' },
  { estado: 'documentos_cargados' },
  { estado: 'completado' },
  { estado: 'fallido' },
  { estado: 'cancelado' },
  { estado: null },
  null,
  undefined,
];
assert.strictEqual(contarEstudiosEnCurso(muestra), 3, '3 en curso de 9 filas');
assert.strictEqual(contarEstudiosEnCurso([]), 0);
console.log(`estados en curso: ${ESTADOS_ESTUDIO_EN_CURSO.length} | finales: ${ESTADOS_ESTUDIO_FINALES.length} | contador de la muestra: ${contarEstudiosEnCurso(muestra)}`);

// ── 4. Dos aprobaciones concurrentes -> UNA sola reserva ──────────────────
// Se simula el CAS tal como lo hace fn_reservar_inmueble_para_contrato: la fila
// del inmueble es un objeto unico, cada transaccion la lee BAJO EL LOCK (o sea,
// en serie) y decide. La serializacion es lo que aporta el FOR UPDATE de la
// RPC; aqui se representa ejecutando las decisiones una tras otra sobre el
// mismo estado mutable, que es exactamente lo que ve Postgres.
interface FilaInmueble {
  estado: string;
  reservado_por_expediente_id: string | null;
  visible_vitrina: boolean;
}

/** La transaccion completa: leer bajo lock, decidir, escribir si gano. */
function transaccionReservar(fila: FilaInmueble, expedienteId: string) {
  const decision = decidirReserva({
    estadoInmueble: fila.estado,
    reservadoPorExpedienteId: fila.reservado_por_expediente_id,
    expedienteId,
  });
  if (decision.accion === 'reservar') {
    // Lo mismo que hace el UPDATE de la RPC: 'ocupado' + fuera de vitrina +
    // titular. La regla canonica de vitrina se aplica sola.
    fila.estado = 'ocupado';
    fila.visible_vitrina = false;
    fila.reservado_por_expediente_id = expedienteId;
  }
  return decision;
}

const fila: FilaInmueble = {
  estado: 'disponible',
  reservado_por_expediente_id: null,
  visible_vitrina: true,
};

const t1 = transaccionReservar(fila, EXP_A);
const t2 = transaccionReservar(fila, EXP_B); // se desbloquea tras el COMMIT de T1

console.log(`aprobaciones concurrentes: A -> ${t1.accion} | B -> ${t2.accion}`);
assert.strictEqual(t1.accion, 'reservar', 'la primera aprobacion reserva');
assert.strictEqual(t2.accion, 'conflicto', 'la segunda NO puede reservar tambien');
assert.strictEqual(t2.accion === 'conflicto' && t2.motivo, 'reservado');
assert.strictEqual(t2.accion === 'conflicto' && t2.titular, EXP_A, 'y sabe quien gano');
assert.strictEqual(fila.reservado_por_expediente_id, EXP_A, 'UNA sola reserva, la del ganador');
assert.strictEqual(fila.estado, 'ocupado');
assert.strictEqual(fila.visible_vitrina, false, 'la reserva saca la propiedad de la vitrina');

// El orden inverso da el mismo resultado con los papeles cambiados: no hay
// entrelazado que produzca dos reservas.
const fila2: FilaInmueble = {
  estado: 'disponible',
  reservado_por_expediente_id: null,
  visible_vitrina: true,
};
assert.strictEqual(transaccionReservar(fila2, EXP_B).accion, 'reservar');
assert.strictEqual(transaccionReservar(fila2, EXP_A).accion, 'conflicto');
assert.strictEqual(fila2.reservado_por_expediente_id, EXP_B);

// Un tercero que llega despues tambien pierde.
assert.strictEqual(transaccionReservar(fila, EXP_C).accion, 'conflicto');
assert.strictEqual(fila.reservado_por_expediente_id, EXP_A, 'el titular no cambia por reintentos ajenos');

// IDEMPOTENCIA: el propio titular reintentando (regenerar el contrato, doble
// click en "Generar contrato") no puede recibir un 409 contra si mismo.
const reintento = transaccionReservar(fila, EXP_A);
assert.strictEqual(reintento.accion, 'ya_reservado_por_este', 'reintentar es idempotente, no un conflicto');
assert.strictEqual(fila.reservado_por_expediente_id, EXP_A);
console.log('reintento del titular ->', reintento.accion);

// Un 'ocupado' heredado sin titular anotado (contrato en papel, activacion
// manual, filas anteriores a la migracion) tambien bloquea: el bloqueo viejo
// sigue en pie.
assert.strictEqual(
  decidirReserva({
    estadoInmueble: 'ocupado',
    reservadoPorExpedienteId: null,
    expedienteId: EXP_A,
  }).accion,
  'conflicto',
  'un ocupado heredado sin titular sigue bloqueando',
);
// Y el mismo caso detectado por contrato vigente ajeno, sin depender del estado.
assert.strictEqual(
  decidirReserva({
    estadoInmueble: 'disponible',
    reservadoPorExpedienteId: null,
    expedienteId: EXP_A,
    tieneContratoVigenteAjeno: true,
  }).accion,
  'conflicto',
  'un contrato vigente ajeno bloquea aunque el estado mienta',
);
assert.strictEqual(
  decidirReserva({ estadoInmueble: 'inactivo', expedienteId: EXP_A }).accion,
  'conflicto',
);
// El legado 'en_estudio' SI se puede reservar: es un 'disponible' mal etiquetado.
assert.strictEqual(
  decidirReserva({ estadoInmueble: 'en_estudio', expedienteId: EXP_A }).accion,
  'reservar',
);

const errRes = errorReservaPerdida(t2 as Extract<typeof t2, { accion: 'conflicto' }>);
assert.ok(errRes instanceof AppError);
assert.strictEqual(errRes.statusCode, 409, 'el perdedor recibe 409, no un 500 ni un exito silencioso');
assert.strictEqual(errRes.errorCode, INMUEBLE_YA_RESERVADO_ERROR_CODE);
assert.ok(/otro candidato/i.test(errRes.message), 'debe decir POR QUE se perdio');
assert.ok(/sigue vigente/i.test(errRes.message), 'y que el expediente NO es un callejon sin salida');
assert.ok(!/rechaz/i.test(errRes.message), 'sin la palabra prohibida por el §13');
console.log('perdedor del CAS ->', errRes.statusCode, errRes.errorCode);

// ── 5. La regla canonica de vitrina se PRESERVA ───────────────────────────
// publicado <=> visible_vitrina = true AND estado = 'disponible'.
// Es la regla de la auditoria previa "vitrina vs ocupado" y este cambio NO la
// toca: lo unico que cambia es cuantos inmuebles califican.

// (a) Un inmueble con estudios en curso SIGUE publicable — es el objetivo del
//     §4.2. Hoy en produccion 4 de 5 inmuebles estan fuera de la vitrina por el
//     bloqueo que este cambio elimina.
const conEstudios = { estado: 'disponible', visible_vitrina: true };
assert.strictEqual(
  esPublicableEnVitrina(conEstudios),
  true,
  'un inmueble con estudios en curso se queda disponible y sigue publicado',
);
assert.strictEqual(
  puedePublicarseEnVitrina('disponible'),
  true,
  'y su dueño puede publicarlo/pausarlo con normalidad (toggleVisibility)',
);
// El numero de estudios no entra en la regla de vitrina, ni por asomo.
for (const n of [0, 1, 7]) {
  assert.strictEqual(
    esPublicableEnVitrina({ estado: 'disponible', visible_vitrina: true }),
    true,
    `con ${n} estudios en curso la publicacion no cambia`,
  );
}

// (b) Un ocupado NO se publica — con flag encendido incluido. Es el bug Apt-001
//     de jul-2026 que la auditoria previa cerro, y sigue cerrado.
assert.strictEqual(
  esPublicableEnVitrina({ estado: 'ocupado', visible_vitrina: true }),
  false,
  'un ocupado con flag residual NO esta publicado',
);
assert.strictEqual(esPublicableEnVitrina({ estado: 'ocupado', visible_vitrina: false }), false);
assert.strictEqual(
  puedePublicarseEnVitrina('ocupado'),
  false,
  'y no se puede publicar a mano',
);

// (c) Un RESERVADO tampoco: la reserva usa 'ocupado' precisamente para salir de
//     la vitrina por la regla de siempre, sin logica nueva.
assert.strictEqual(
  esPublicableEnVitrina({ estado: fila.estado, visible_vitrina: fila.visible_vitrina }),
  false,
  'la propiedad reservada por el CAS quedo fuera de la vitrina',
);

// (d) El resto de la regla, sin cambios.
assert.strictEqual(esPublicableEnVitrina({ estado: 'disponible', visible_vitrina: false }), false, 'pausada');
assert.strictEqual(esPublicableEnVitrina({ estado: 'inactivo', visible_vitrina: true }), false, 'inactiva');
assert.strictEqual(esPublicableEnVitrina({ estado: 'disponible', visible_vitrina: null }), false);
assert.strictEqual(esPublicableEnVitrina({ estado: null, visible_vitrina: true }), false);
console.log('regla canonica de vitrina: preservada (disponible+flag publica; ocupado/reservado/inactivo no)');

// ── 6. El aviso a los demas candidatos ────────────────────────────────────
// §4.2: "los demas estudios en curso sobre esa propiedad se notifican al
// solicitante y quedan disponibles para reasignarse a otro inmueble". La
// REASIGNACION es el §4.3 y NO se implementa: el copy anuncia, no promete un
// boton que no existe.
assert.strictEqual(referenciaInmueble('Apt-013', 'Calle 1 #2-3'), 'Apt-013', 'manda el codigo');
assert.strictEqual(referenciaInmueble(null, 'Calle 1 #2-3'), 'Calle 1 #2-3', 'la direccion es el respaldo');
assert.strictEqual(referenciaInmueble('  ', null), 'que estabas evaluando', 'sin datos, algo legible');

const avisoMsg = mensajeInmuebleReservado('Apt-013');
console.log('aviso:', avisoMsg);
assert.ok(/Apt-013/.test(avisoMsg), 'debe nombrar el inmueble');
assert.ok(/sigue vigente/i.test(avisoMsg), 'el estudio NO se pierde — no es un callejon sin salida');
assert.ok(/otra propiedad/i.test(avisoMsg), 'debe decir cual es la salida');
assert.ok(/asesor/i.test(avisoMsg), 'la reasignacion la hace una persona: el §4.3 no esta implementado');
assert.ok(!/rechaz/i.test(avisoMsg), '§13: nada de "rechazado"');
assert.ok(!/cancelad/i.test(avisoMsg), 'el estudio NO se cancela — desde cancelado no hay vuelta atras');

// ── 7. Las decisiones son PURAS y deterministas ───────────────────────────
// Si tocaran la base, este check ni arrancaria (las credenciales de arriba son
// de mentira). Se deja explicito el determinismo.
assert.deepStrictEqual(
  decidirReserva({ estadoInmueble: 'disponible', reservadoPorExpedienteId: null, expedienteId: EXP_A }),
  decidirReserva({ estadoInmueble: 'disponible', reservadoPorExpedienteId: null, expedienteId: EXP_A }),
);
assert.deepStrictEqual(
  evaluarAdmisionDeEstudio({ estadoInmueble: 'ocupado', reservadoPorExpedienteId: EXP_A, expedienteId: EXP_B }),
  evaluarAdmisionDeEstudio({ estadoInmueble: 'ocupado', reservadoPorExpedienteId: EXP_A, expedienteId: EXP_B }),
);

console.log('\nOK — todas las aserciones pasaron');
