/**
 * Check del cotejo biometrico AucoFace (Politica V4.1 Anexo A, §14 y §7).
 *
 * Lo que se protege aqui es asimetrico y por eso el check existe:
 *
 *   - de MAS: la biometria no puede rechazar a nadie. Un `estado` mal leido
 *     convertiria "la camara del celular es mala" en un portazo, y la Politica
 *     no le da a esta fuente ningun rechazo (§2: "nunca rechaza por fallo
 *     tecnico"; el §7 rechaza por reporte de perdida en RNEC, que AucoFace no
 *     entrega).
 *   - de MENOS: un `verificada` de regalo desactiva justo el control que el
 *     Flujo §12 manda poner ("enlace reenviado a un tercero").
 *
 * Y una tercera, que no es del motor sino del consentimiento: el texto 2.0
 * dice "no se recolectan datos sensibles". Presentarlo mientras se pide una
 * selfie viciaria la autorizacion. Se verifica que el 2.0 siga byte a byte
 * como esta congelado en las filas historicas y que el 3.0 sea otro.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-biometria.ts
 */

import assert from 'node:assert';

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
  interpretarBiometria,
  requiereRevisionManualPorBiometria,
  leerResumenBiometria,
  mismoDocumento,
  biometriaDesactivada,
  biometriaOmitida,
} from '@/modules/autorizaciones/biometria';
import type { ResumenBiometria } from '@/modules/autorizaciones/biometria';
import {
  TEXTO_LEGAL,
  TEXTO_LEGAL_BIOMETRIA,
  TEXTO_LEGAL_COARRENDATARIO,
  VERSION_TERMINOS,
  VERSION_TERMINOS_BIOMETRIA,
  textoLegalSolicitante,
} from '@/modules/autorizaciones/autorizaciones.texto';

const HOY = '2026-09-07T12:00:00.000Z';
const UMBRAL = 70;
const DOC = '1001001010';

let pasos = 0;
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
  pasos++;
}

function veredicto(respuesta: unknown, documentoEsperado: string | null = DOC): ResumenBiometria {
  return interpretarBiometria({
    respuesta: respuesta as never,
    documentoEsperado,
    umbral: UMBRAL,
    verificadoEn: HOY,
  });
}

/** Respuesta exitosa de la documentacion de Auco, con la similitud parametrizada. */
function respuestaAuco(similarity: number, overrides: Record<string, unknown> = {}) {
  return {
    error: similarity < 60,
    similarity,
    code: 'JPJD42IDWP3Z6RXA',
    identificationCard: {
      error: false,
      isFront: true,
      data: { personalNumber: DOC, fullName: 'PEREZ PEREZ JUAN ALBERTO', name: 'JUAN ALBERTO PEREZ PEREZ' },
    },
    ...overrides,
  };
}

// ── 1. El caso feliz de la documentacion de Auco ────────────
const bueno = veredicto(respuestaAuco(89.46871185302734));
ok(bueno.estado === 'verificada', 'similitud 89.47 sobre umbral 70 -> verificada');
ok(bueno.similitud === 89.47, `similitud redondeada a 2 decimales (${bueno.similitud})`);
ok(bueno.code === 'JPJD42IDWP3Z6RXA', 'se guarda el code para reproducir la evidencia en Auco');
ok(bueno.documento_coincide === true, 'el OCR coincide con el documento a consultar');
ok(bueno.documento_ocr_masked === '*******010' && !bueno.documento_ocr_masked.includes(DOC), 'el documento OCR va ENMASCARADO');
ok(bueno.nombre_ocr === 'PEREZ PEREZ JUAN ALBERTO', 'el nombre del documento queda para el analista');
ok(bueno.motivo === null && requiereRevisionManualPorBiometria(bueno) === null, 'verificada + documento correcto -> aprobacion automatica posible');
ok(bueno.umbral === UMBRAL, 'el umbral aplicado queda registrado (auditable)');

// ── 2. Fronteras del umbral. Es el corte que decide, no adorno ──
ok(veredicto(respuestaAuco(70)).estado === 'verificada', 'exactamente 70 pasa (>= umbral)');
ok(veredicto(respuestaAuco(69.99)).estado === 'no_coincide', '69.99 no pasa');
ok(veredicto(respuestaAuco(0)).estado === 'no_coincide', '0 no pasa');
ok(veredicto(respuestaAuco(100)).estado === 'verificada', '100 pasa');

// El fallo de la documentacion de Auco.
const malo = veredicto({
  error: true,
  similarity: 49.4231344,
  code: 'JPJD42IDWP3Z6RXA',
  identificationCard: { error: true, message: 'DOCUMENT_FAKE', isFront: false, data: {} },
});
ok(malo.estado === 'no_coincide', 'el ejemplo de fallo de Auco -> no_coincide');
ok(malo.similitud === 49.42, 'se conserva el porcentaje del fallo, para el analista');
ok((malo.motivo ?? '').includes('DOCUMENT_FAKE'), 'el motivo del gestor arrastra la lectura del documento');

// Auco dice error:true aunque la similitud sea alta -> manda Auco.
ok(veredicto(respuestaAuco(95, { error: true })).estado === 'no_coincide', 'error:true de Auco tumba aunque la similitud sea alta');

// ── 3. NUNCA rechaza. Todo cae en revision manual (§14) ─────
for (const r of [malo, veredicto(respuestaAuco(20)), veredicto(null), veredicto('x')]) {
  ok(r.estado !== ('rechazado' as string), 'no existe un estado de rechazo en el vocabulario');
  const motivo = requiereRevisionManualPorBiometria(r);
  ok(!!motivo && /revision manual/i.test(motivo), 'todo fallo produce revision manual, no rechazo');
  ok(!/rechaz/i.test(motivo ?? ''), 'el motivo del gestor no habla de rechazo');
}

// ── 4. Ausencia de cotejo != cotejo fallido ─────────────────
for (const basura of [null, undefined, 'x', 42, [], {}]) {
  const r = veredicto(basura);
  ok(r.estado === 'no_verificada', `basura ${JSON.stringify(basura)} -> no_verificada, nunca verificada`);
  ok(r.similitud === null, 'sin cotejo no se inventa un porcentaje');
}
const sinPorcentaje = veredicto({ error: false, code: 'C', identificationCard: { error: true, message: 'BLURRY' } });
ok(sinPorcentaje.estado === 'no_verificada' && (sinPorcentaje.motivo ?? '').includes('BLURRY'), 'sin similarity -> no_verificada con el motivo de Auco');

// ── 5. §7: la cara coincide pero el documento es OTRO ───────
const otroDoc = veredicto(respuestaAuco(92, {
  identificationCard: { error: false, isFront: true, data: { personalNumber: '9998887776', fullName: 'OTRA PERSONA' } },
}));
ok(otroDoc.estado === 'verificada', 'el cotejo facial paso: el estado lo refleja con honestidad');
ok(otroDoc.documento_coincide === false, 'pero el documento fotografiado es otro');
const motivo7 = requiereRevisionManualPorBiometria(otroDoc);
ok(!!motivo7 && motivo7.includes('§7'), 'documento distinto -> revision manual por §7');
ok(!/rechaz/i.test(motivo7 ?? ''), '§7 aqui es REVISION, no rechazo: AucoFace no reporta perdida/suplantacion en RNEC');

const ocrIlegible = veredicto(respuestaAuco(92, {
  identificationCard: { error: true, message: 'OCR_FAILED', isFront: true, data: {} },
}));
ok(ocrIlegible.documento_coincide === null, 'sin numero leido no se puede afirmar ni negar la coincidencia');
ok(requiereRevisionManualPorBiometria(ocrIlegible) !== null, 'no poder comparar el documento tambien va a revision');

// Normalizacion del documento: puntos, espacios y ceros a la izquierda.
ok(mismoDocumento('1.001.001.010', '1001001010') === true, 'los puntos no cambian el documento');
ok(mismoDocumento('0001234', '1234') === true, 'los ceros a la izquierda tampoco');
ok(mismoDocumento('1234', '4321') === false, 'documentos distintos no coinciden');
ok(mismoDocumento('', '1234') === null && mismoDocumento(null, null) === null, 'sin dato no se afirma nada');

// ── 6. El prospecto se niega (Ley 1581 art. 6-a) ────────────
const omitida = biometriaOmitida(HOY, UMBRAL);
ok(omitida.estado === 'omitida', 'negarse es un estado de primera clase, no un error');
ok((omitida.motivo ?? '').includes('art. 6'), 'el motivo cita el derecho que se ejercio');
const motivoOmitida = requiereRevisionManualPorBiometria(omitida);
ok(!!motivoOmitida && motivoOmitida.includes('§14') && motivoOmitida.includes('derecho'), 'negarse manda a revision manual, no a rechazo, y se dice por que');

// ── 7. El interruptor apagado no cambia NADA ────────────────
const off = biometriaDesactivada(HOY, UMBRAL);
ok(off.estado === 'desactivada', 'apagado -> desactivada');
ok(requiereRevisionManualPorBiometria(off) === null, 'apagado NO manda a revision: no se pidio la foto');
ok(requiereRevisionManualPorBiometria(null) === null, 'sin veredicto (expedientes anteriores) tampoco cambia nada');
ok(requiereRevisionManualPorBiometria(undefined) === null, 'undefined tampoco');

// ── 8. Roundtrip por la columna JSONB ───────────────────────
const releido = leerResumenBiometria(JSON.parse(JSON.stringify(otroDoc)));
ok(releido?.estado === 'verificada' && releido.documento_coincide === false && releido.similitud === 92, 'leerResumenBiometria reconstruye el veredicto');
ok(requiereRevisionManualPorBiometria(releido)?.includes('§7') === true, 'y el veredicto releido decide igual que el original');
for (const basura of [null, undefined, 'x', 42, [], {}, { estado: 42 }]) {
  ok(leerResumenBiometria(basura) === null, `columna ${JSON.stringify(basura)} -> null`);
}
// El CHECK de la migracion exige similitud numerica en verificada/no_coincide.
for (const r of [bueno, malo]) {
  ok(typeof r.similitud === 'number', `${r.estado} siempre trae similitud (lo exige chk_perfil_prospecto_biometria)`);
}
for (const r of [off, omitida, veredicto(null)]) {
  ok(r.similitud === null, `${r.estado} nunca trae similitud`);
}

// ── 9. El texto legal ───────────────────────────────────────
ok(TEXTO_LEGAL.includes('No se recolectan datos sensibles'), 'el 2.0 sigue afirmando que no hay datos sensibles');
ok(!TEXTO_LEGAL.includes('biométric') && !TEXTO_LEGAL.includes('rostro'), 'y por tanto NO puede mencionar biometria');
ok(TEXTO_LEGAL_BIOMETRIA !== TEXTO_LEGAL, 'el texto con biometria es OTRO instrumento');
ok(!TEXTO_LEGAL_BIOMETRIA.includes('No se recolectan datos sensibles'), 'el 3.0 no puede seguir negando el dato sensible que pide');
ok(TEXTO_LEGAL_BIOMETRIA.includes('DATO SENSIBLE') && TEXTO_LEGAL_BIOMETRIA.includes('artículo 5'), 'el 3.0 declara el dato sensible y su articulo');
ok(TEXTO_LEGAL_BIOMETRIA.includes('NO ESTOY OBLIGADO'), 'y avisa que no esta obligado (art. 6-a)');
ok(TEXTO_LEGAL_BIOMETRIA.includes('sin perder el acceso al servicio'), 'y que negarse no le cuesta el servicio');
ok(TEXTO_LEGAL_BIOMETRIA.includes('NO se almacenan en las bases de datos de Cofianza'), 'y que las imagenes no se guardan (minimizacion)');
ok(VERSION_TERMINOS === '2.0' && VERSION_TERMINOS_BIOMETRIA === '3.0-biometria', 'versiones distintas para textos distintos (§8.4)');
// Los dos textos comparten encabezado y marco normativo: la unica diferencia
// es la clausula 4. Si divergiera algo mas, alguien reescribio de mas.
ok(TEXTO_LEGAL_BIOMETRIA.startsWith(TEXTO_LEGAL.slice(0, TEXTO_LEGAL.indexOf('4. Datos objeto'))), 'los dos textos son identicos hasta la clausula 4');
ok(TEXTO_LEGAL_BIOMETRIA.endsWith(TEXTO_LEGAL.slice(TEXTO_LEGAL.indexOf('5.1. Finalidades'))), 'e identicos desde la 5.1 hasta el final');
ok(TEXTO_LEGAL_COARRENDATARIO.includes('No se recolectan datos sensibles'), 'el texto del co-arrendatario no cambio (no se le pide biometria)');
ok(textoLegalSolicitante(false).version === VERSION_TERMINOS && textoLegalSolicitante(false).texto === TEXTO_LEGAL, 'interruptor OFF -> 2.0');
ok(textoLegalSolicitante(true).version === VERSION_TERMINOS_BIOMETRIA && textoLegalSolicitante(true).texto === TEXTO_LEGAL_BIOMETRIA, 'interruptor ON -> 3.0');

console.log(`\nOK — ${pasos} aserciones: la biometria valida identidad y NUNCA rechaza (Anexo A, §14, §7), y el texto legal declara el dato sensible.`);
