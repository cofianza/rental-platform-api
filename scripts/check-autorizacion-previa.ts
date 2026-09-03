/**
 * Check del gate de autorizacion previa (habeas data).
 *
 * Existe porque este gate es la unica barrera entre un click y una consulta
 * FACTURABLE e IRREVERSIBLE a una central de riesgo, y su regla es normativa,
 * no estetica: el flujo del modulo de estudios, seccion 8.4, exige que la
 * autorizacion sea "previa, expresa e informada" y "demostrable si alguna vez
 * es cuestionada". En produccion se midio que 4 de 7 estudios completados
 * consultaron el buro ANTES de que la persona autorizara (hasta 13,9 min
 * antes), porque ejecutarEstudio nunca leia autorizaciones_habeas_data.
 *
 * La decision vive en una funcion PURA (fila + fecha -> veredicto) justamente
 * para poder ejercitarla aqui sin Supabase. `assertAutorizacionVigente` solo
 * resuelve el sujeto y traduce el veredicto a un AppError.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-autorizacion-previa.ts
 */

import assert from 'node:assert';

// El guard importa @/lib/supabase, que valida el env al cargar. Este check no
// toca la red ni la base: solo ejercita la funcion pura. Se rellenan los
// minimos que faltan para que el modulo cargue, SIN pisar los reales si el
// .env.local ya esta cargado.
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
  evaluarAutorizacionPrevia,
  AUTORIZACION_PREVIA_ERROR_CODE,
  type AutorizacionEvidencia,
  type ContextoAutorizacion,
} from '@/modules/estudios/autorizacion.guard';
import { AppError } from '@/lib/errors';

// ── Fixtures ────────────────────────────────────────────────

const SOLICITANTE = '11111111-1111-4111-8111-111111111111';
const OTRO_SOLICITANTE = '22222222-2222-4222-8222-222222222222';
const COARRENDATARIO = '33333333-3333-4333-8333-333333333333';
const OTRO_COARRENDATARIO = '44444444-4444-4444-8444-444444444444';

/** Momento en que se consultaria el buro en todos los casos de abajo. */
const MOMENTO_CONSULTA = new Date('2026-09-03T15:00:00.000Z');

const ANTES = '2026-09-03T14:45:00.000Z'; // 15 min antes de la consulta
const DESPUES = '2026-09-03T15:13:54.000Z'; // 13,9 min DESPUES — el caso real medido

function autorizacion(over: Partial<AutorizacionEvidencia> = {}): AutorizacionEvidencia {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    estado: 'autorizado',
    autorizado_en: ANTES,
    fecha_revocacion: null,
    vigente_hasta: '2027-09-03T14:45:00.000Z',
    numero_documento_aceptante: '1026130143',
    tipo_documento_aceptante: 'cc',
    solicitante_id: SOLICITANTE,
    coarrendatario_id: null,
    ...over,
  };
}

function contexto(over: Partial<ContextoAutorizacion> = {}): ContextoAutorizacion {
  return {
    momentoConsulta: MOMENTO_CONSULTA,
    sujeto: { solicitanteId: SOLICITANTE },
    numeroDocumentoConsultado: '1026130143',
    tipoDocumentoConsultado: 'cc',
    ...over,
  };
}

function rechaza(
  etiqueta: string,
  fila: AutorizacionEvidencia | null,
  ctx: ContextoAutorizacion,
  motivoEsperado: string,
) {
  const v = evaluarAutorizacionPrevia(fila, ctx);
  assert.strictEqual(v.ok, false, `${etiqueta}: el gate deberia RECHAZAR y acepto`);
  assert.strictEqual(
    v.ok === false ? v.motivo : null,
    motivoEsperado,
    `${etiqueta}: motivo esperado ${motivoEsperado}, recibido ${v.ok === false ? v.motivo : 'ok'}`,
  );
  console.log(`  rechaza ${etiqueta.padEnd(34)} -> ${motivoEsperado}`);
}

// ── 1. El gate RECHAZA ──────────────────────────────────────

console.log('\n[1] Casos que el gate debe rechazar');

// Sin autorizacion: el camino que produjo el hallazgo. Un estudio con
// estudio_habilitado=true y cero filas en autorizaciones_habeas_data.
rechaza('sin autorizacion', null, contexto(), 'sin_autorizacion');

// Enlace enviado pero no firmado.
rechaza(
  'autorizacion pendiente',
  autorizacion({ estado: 'pendiente', autorizado_en: null, vigente_hasta: null }),
  contexto(),
  'no_firmada',
);

// Enlace caducado sin firmar.
rechaza(
  'enlace expirado sin firmar',
  autorizacion({ estado: 'expirado', autorizado_en: null, vigente_hasta: null }),
  contexto(),
  'no_firmada',
);

// Revocada: derecho del titular (Ley 1581). Se prueban las dos formas, porque
// una fila con fecha_revocacion y estado 'autorizado' seria un dato roto que
// tambien tiene que bloquear.
rechaza(
  'revocada (estado)',
  autorizacion({ estado: 'revocado', fecha_revocacion: '2026-09-03T14:50:00.000Z' }),
  contexto(),
  'revocada',
);
rechaza(
  'revocada (solo fecha)',
  autorizacion({ fecha_revocacion: '2026-09-03T14:50:00.000Z' }),
  contexto(),
  'revocada',
);

// Caducada: vigente_hasta ya paso.
rechaza(
  'caducada',
  autorizacion({ vigente_hasta: '2026-09-01T00:00:00.000Z' }),
  contexto(),
  'caducada',
);

// De otro solicitante.
rechaza(
  'de otro solicitante',
  autorizacion({ solicitante_id: OTRO_SOLICITANTE }),
  contexto(),
  'otro_titular',
);

// EL caso del hallazgo: la firma es POSTERIOR a la consulta. La consulta no
// estaba autorizada en el instante en que ocurrio.
rechaza(
  'firmada DESPUES de la consulta',
  autorizacion({ autorizado_en: DESPUES }),
  contexto(),
  'posterior_a_la_consulta',
);

// Documento distinto al congelado en la evidencia: el enlace pudo reenviarse a
// un tercero (caso borde del 12 del flujo).
rechaza(
  'documento distinto al firmado',
  autorizacion({ numero_documento_aceptante: '1026130143' }),
  contexto({ numeroDocumentoConsultado: '80123456' }),
  'documento_distinto',
);

// TIPO distinto con el MISMO numero. Es el par (tipo, numero) lo que identifica
// a una persona en el buro: con CC 79876543 autorizada, consultar CE 79876543 es
// consultar a OTRO titular de datos. Ambos campos llegan desde el body de
// /estudios/:id/ejecutar, asi que comparar solo el numero dejaba esa puerta
// abierta con una autorizacion legitima.
rechaza(
  'mismo numero, tipo distinto',
  autorizacion({ numero_documento_aceptante: '79876543', tipo_documento_aceptante: 'cc' }),
  contexto({ numeroDocumentoConsultado: '79876543', tipoDocumentoConsultado: 'ce' }),
  'documento_distinto',
);

// Fila historica (sin documento congelado) + documento del body distinto al del
// sujeto: antes se aceptaba con solo un warning, asi que sobre cualquiera de los
// 8 expedientes anteriores al 2026-09-03 se podia consultar y facturar el buro
// de un tercero. El respaldo es el snapshot vivo del sujeto, leido antes de que
// sincronizarDocumentoSolicitante lo pise.
rechaza(
  'historica: documento del body != sujeto',
  autorizacion({ numero_documento_aceptante: null, tipo_documento_aceptante: null, vigente_hasta: null }),
  contexto({
    numeroDocumentoConsultado: '80123456',
    tipoDocumentoConsultado: 'cc',
    documentoSujetoActual: { tipo: 'cc', numero: '1026130143' },
  }),
  'documento_distinto',
);

// ── 2. Co-arrendatario: autorizacion PROPIA, no la del titular ──

console.log('\n[2] Co-arrendatario');

// La autorizacion del titular NO cubre al co-arrendatario: es otro titular de
// datos y su consulta al buro es una consulta distinta.
rechaza(
  'titular no cubre al co-arrendatario',
  autorizacion(),
  contexto({ sujeto: { coarrendatarioId: COARRENDATARIO }, numeroDocumentoConsultado: '1026130143' }),
  'otro_titular',
);

rechaza(
  'autorizacion de otro co-arrendatario',
  autorizacion({ solicitante_id: null, coarrendatario_id: OTRO_COARRENDATARIO }),
  contexto({ sujeto: { coarrendatarioId: COARRENDATARIO } }),
  'otro_titular',
);

const vCoa = evaluarAutorizacionPrevia(
  autorizacion({ solicitante_id: null, coarrendatario_id: COARRENDATARIO }),
  contexto({ sujeto: { coarrendatarioId: COARRENDATARIO } }),
);
assert.strictEqual(vCoa.ok, true, 'la autorizacion propia del co-arrendatario debe aceptarse');
console.log('  acepta  autorizacion propia del co-arrendatario');

// ── 3. El gate ACEPTA ───────────────────────────────────────

console.log('\n[3] Casos que el gate debe aceptar');

const vOk = evaluarAutorizacionPrevia(autorizacion(), contexto());
assert.strictEqual(vOk.ok, true, 'una autorizacion valida y previa debe aceptarse');
assert.strictEqual(
  vOk.ok === true ? vOk.autorizacionId : null,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'debe devolver el id de la autorizacion que habilita la consulta',
);
assert.strictEqual(
  vOk.ok === true ? vOk.documentoVerificado : null,
  true,
  'con numero_documento_aceptante presente el documento queda verificado',
);
console.log('  acepta  autorizacion valida y previa');

// Documento con puntos y guiones: la comparacion normaliza.
const vFormato = evaluarAutorizacionPrevia(
  autorizacion({ numero_documento_aceptante: '1.026.130-143' }),
  contexto({ numeroDocumentoConsultado: '1026130143' }),
);
assert.strictEqual(vFormato.ok, true, 'el documento se compara sin puntos ni guiones');
console.log('  acepta  mismo documento con otra grafia');

// Las 8 autorizaciones firmadas antes del 2026-09-03 no tienen el documento
// congelado (evidencia parcial). Se aceptan — no se puede invalidar
// retroactivamente evidencia historica — pero marcadas como no verificadas.
const vHistorica = evaluarAutorizacionPrevia(
  autorizacion({ numero_documento_aceptante: null, tipo_documento_aceptante: null, vigente_hasta: null }),
  contexto({
    numeroDocumentoConsultado: '1026130143',
    documentoSujetoActual: { tipo: 'cc', numero: '1026130143' },
  }),
);
assert.strictEqual(vHistorica.ok, true, 'una autorizacion historica sin documento no debe bloquear');
assert.strictEqual(
  vHistorica.ok === true ? vHistorica.documentoVerificado : null,
  false,
  'debe marcarse como documento NO verificado para que el caller lo deje en el log',
);
console.log('  acepta  historica sin documento, coincide con el sujeto (no verificada)');

// Sin documento congelado Y sin snapshot vivo no hay nada contra que contrastar:
// se acepta (no se puede invalidar evidencia historica) pero marcada.
const vSinReferencia = evaluarAutorizacionPrevia(
  autorizacion({ numero_documento_aceptante: null, tipo_documento_aceptante: null, vigente_hasta: null }),
  contexto({ numeroDocumentoConsultado: '80123456', documentoSujetoActual: null }),
);
assert.strictEqual(vSinReferencia.ok, true, 'sin referencia alguna no se puede bloquear');
console.log('  acepta  historica sin documento ni snapshot (no verificada)');

// vigente_hasta NULL = sin vigencia declarada = vigente. Es lo que mantiene
// validas las 8 filas historicas sin tocarlas.
const vSinVigencia = evaluarAutorizacionPrevia(autorizacion({ vigente_hasta: null }), contexto());
assert.strictEqual(vSinVigencia.ok, true, 'vigente_hasta NULL debe interpretarse como vigente');
console.log('  acepta  sin vigencia declarada (vigente_hasta NULL)');

// Firmada en el mismo instante de la consulta: previa o simultanea, no posterior.
const vBorde = evaluarAutorizacionPrevia(
  autorizacion({ autorizado_en: MOMENTO_CONSULTA.toISOString() }),
  contexto(),
);
assert.strictEqual(vBorde.ok, true, 'autorizado_en == momentoConsulta no es posterior');
console.log('  acepta  firmada en el mismo instante (borde)');

// ── 4. El error es de dominio, no una excepcion generica ────

console.log('\n[4] Contrato del error');

assert.strictEqual(
  AUTORIZACION_PREVIA_ERROR_CODE,
  'AUTORIZACION_PREVIA_REQUERIDA',
  'el codigo de dominio no debe cambiar sin actualizar la web',
);

// Se construye el mismo AppError que lanza assertAutorizacionVigente, para
// fijar el contrato que ve el gestor: 400 (accionable), codigo propio y un
// mensaje que dice QUE hacer, no solo que fallo.
const errorDelGate = AppError.badRequest(
  'El solicitante aun no ha autorizado la consulta en centrales de riesgo. Envie la solicitud de autorizacion antes de ejecutar el estudio.',
  AUTORIZACION_PREVIA_ERROR_CODE,
  { motivo: 'sin_autorizacion', sujeto: 'solicitante' },
);

assert.ok(errorDelGate instanceof AppError, 'debe ser un AppError, no un Error generico');
assert.strictEqual(errorDelGate.errorCode, 'AUTORIZACION_PREVIA_REQUERIDA');
assert.strictEqual(errorDelGate.statusCode, 400, 'es un error accionable del gestor, no un 500');
assert.notStrictEqual(errorDelGate.errorCode, 'INTERNAL_ERROR');
assert.notStrictEqual(errorDelGate.errorCode, 'BAD_REQUEST', 'no debe caer en el codigo generico');
assert.ok(
  /autoriza/i.test(errorDelGate.message) && /antes de ejecutar/i.test(errorDelGate.message),
  `el mensaje debe decir que hacer: ${errorDelGate.message}`,
);
console.log(`  ${errorDelGate.statusCode} ${errorDelGate.errorCode} — mensaje accionable`);

// ── 5. Ningun motivo se queda sin cubrir ────────────────────

console.log('\n[5] Cobertura de motivos');

const MOTIVOS_ESPERADOS = [
  'sin_autorizacion',
  'no_firmada',
  'revocada',
  'caducada',
  'posterior_a_la_consulta',
  'otro_titular',
  'documento_distinto',
].sort();

const motivosEjercitados = [
  evaluarAutorizacionPrevia(null, contexto()),
  evaluarAutorizacionPrevia(autorizacion({ estado: 'pendiente', autorizado_en: null }), contexto()),
  evaluarAutorizacionPrevia(autorizacion({ fecha_revocacion: ANTES }), contexto()),
  evaluarAutorizacionPrevia(autorizacion({ vigente_hasta: '2026-01-01T00:00:00.000Z' }), contexto()),
  evaluarAutorizacionPrevia(autorizacion({ autorizado_en: DESPUES }), contexto()),
  evaluarAutorizacionPrevia(autorizacion({ solicitante_id: OTRO_SOLICITANTE }), contexto()),
  evaluarAutorizacionPrevia(autorizacion(), contexto({ numeroDocumentoConsultado: '999' })),
]
  .map((v) => (v.ok === false ? v.motivo : 'ok'))
  .sort();

assert.deepStrictEqual(
  motivosEjercitados,
  MOTIVOS_ESPERADOS,
  'todos los motivos de rechazo deben estar ejercitados',
);
console.log(`  ${MOTIVOS_ESPERADOS.length} motivos ejercitados: ${MOTIVOS_ESPERADOS.join(', ')}`);

console.log('\nOK — todas las aserciones pasaron');
