/**
 * Sonda de Auco para la firma de contratos V3 (Entrega 5).
 *
 * Contesta lo que la documentación no contesta y que el diseño de E5 da por
 * bueno: si `order` de verdad firma en cadena (en stage no llegaba el WhatsApp),
 * si el ancla `{{signature:N}}` deja cada firma en su raya, cuánto pesa el PDF
 * que Auco acepta en base64, qué devuelve `cancel` y qué ids trae el roadmap.
 *
 * NO toca la base de datos: arma su propio PDF y su propio proceso en Auco.
 * Sin SONDA_CONFIRMAR=si no llama a Auco: solo imprime lo que haría.
 * Crear un proceso consume un crédito y manda WhatsApp real.
 *
 * Se corre desde la Console de Railway (ahí viven las llaves buenas):
 *
 *   SONDA_ACCION=crear SONDA_CONFIRMAR=si \
 *   SONDA_FIRMANTES="Ana|ana@x.co|3001112233;Beto|beto@x.co|3004445566" \
 *     node dist/scripts/sonda-auco-v3.js
 *   SONDA_ACCION=ver SONDA_CODE=XXXXXXXX node dist/scripts/sonda-auco-v3.js
 *   SONDA_ACCION=cancelar SONDA_CODE=XXXXXXXX SONDA_CONFIRMAR=si node dist/scripts/sonda-auco-v3.js
 *
 * Perillas: SONDA_CANAL=email (plan B1), SONDA_SILENCIAR=1 (plan B2: sin order
 * y con los firmantes 2..n en notification:false), SONDA_RELLENO_MB=6 (mide el
 * tope del base64), SONDA_FIRMANTE=<id> (para `recordar`, plan B2).
 */

import { PDFDocument } from 'pdf-lib';
import { env } from '@/config';
import {
  cancelDocument,
  getDocumentRoadmap,
  getDocumentStatus,
  sendReminder,
  uploadDocumentForSignature,
  type AucoSignProfile,
} from '@/lib/auco';
import { anclarFirmas, pdfContrato } from '@/modules/contratos/v3/documento';
import { construirSignProfile, type ParteFirmante } from '@/modules/contratos/v3/firma/reglas';

const mask = (s: string) =>
  s
    .replace(/(\+?\d{2,3})\d{5,}(\d{2})/g, '$1…$2')
    .replace(/([\w.+-]{2})[\w.+-]*(@[\w.-]+)/g, '$1…$2');
const imprimir = (titulo: string, x: unknown) => console.log(`\n== ${titulo}\n${mask(JSON.stringify(x, null, 2))}`);

/** "Ana|ana@x.co|3001112233;Beto|…" → partes con el mismo formato que contrato_partes. */
function leerFirmantes(): ParteFirmante[] {
  const crudo = process.env.SONDA_FIRMANTES ?? '';
  const partes = crudo
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x, i): ParteFirmante => {
      const [nombre, email, telefono] = x.split('|').map((y) => y?.trim());
      if (!nombre || !email || !telefono) throw new Error(`Firmante ${i + 1} mal escrito: «${x}» (Nombre|correo|celular)`);
      return {
        id: `sonda-${i + 1}`,
        rol: i === 0 ? 'arrendatario' : 'arrendador',
        orden: i + 1,
        nombre,
        tipo_documento: null, // sin documento: Auco no lo exige con WhatsApp + OTP
        numero_documento: null,
        email,
        telefono,
        representante_legal_nombre: nombre,
        representante_legal_tipo_documento: null,
        representante_legal_documento: null,
      };
    });
  if (partes.length < 2) throw new Error('Se necesitan al menos 2 firmantes en SONDA_FIRMANTES');
  return partes;
}

/** Un PDF mínimo con el mismo bloque de firmas que el contrato, con sus anclas. */
async function pdfDePrueba(nombres: string[]): Promise<Buffer> {
  const bloques = nombres
    .map(
      (n, i) =>
        `<p class="k-firma" data-o="sonda"><span class="linea"></span><br><b>FIRMANTE ${i + 1}</b><br>${n}</p>`,
    )
    .join('\n');
  const html = anclarFirmas(
    `<p class="k-titulo">SONDA DE FIRMA — COFIANZA</p>` +
      `<p class="k-p">Documento de prueba del proceso de firma electrónica. No tiene efectos jurídicos.</p>` +
      bloques,
    nombres.length,
  );
  const pdf = await pdfContrato(html, { pie: 'Sonda de firma', numero: 'SONDA', logo: null, borrador: false });
  const rellenoMb = Number(process.env.SONDA_RELLENO_MB ?? 0);
  if (!rellenoMb) return pdf;
  // Adjunto de relleno: sube el peso sin tocar las páginas, para ver dónde corta Auco.
  const doc = await PDFDocument.load(pdf);
  const relleno = Buffer.alloc(Math.round(rellenoMb * 1024 * 1024), 7);
  doc.attach(relleno, 'relleno.bin', { mimeType: 'application/octet-stream' });
  return Buffer.from(await doc.save());
}

function conPerillas(perfiles: AucoSignProfile[]): AucoSignProfile[] {
  const canalEmail = process.env.SONDA_CANAL === 'email';
  const silenciar = process.env.SONDA_SILENCIAR === '1';
  return perfiles.map((p, i) => ({
    ...p,
    ...(canalEmail ? { options: { otpCode: 'email' as const } } : {}),
    ...(silenciar ? { order: undefined, notification: i === 0 } : {}),
  }));
}

async function crear() {
  const partes = leerFirmantes();
  const perfiles = conPerillas(construirSignProfile(partes));
  const dias = Number(process.env.SONDA_DIAS ?? 4); // Auco exige > 3 días
  const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
  const pdf = await pdfDePrueba(partes.map((p) => p.nombre));
  const file = pdf.toString('base64');
  imprimir('signProfile', perfiles);
  console.log(`\nPDF: ${(pdf.length / 1024).toFixed(1)} KB · base64: ${(file.length / 1024).toFixed(1)} KB · expira ${expira}`);
  if (process.env.SONDA_CONFIRMAR !== 'si') {
    console.log('\nSONDA_CONFIRMAR≠si: no se llamó a Auco. Esto es lo que se enviaría.');
    return;
  }
  const code = await uploadDocumentForSignature(
    {
      email: env.AUCO_SENDER_EMAIL,
      name: 'SONDA · firma en orden (Cofianza V3)',
      subject: 'Prueba de firma — Cofianza',
      message: 'Documento de prueba. No tiene efectos jurídicos.',
      file,
      signProfile: perfiles,
      expiredDate: expira,
      custom: { cofianza_sonda: 'e5' },
    },
    120_000,
  );
  console.log(`\nCREADO. SONDA_CODE=${code}`);
  await ver(code);
}

async function ver(codeArg?: string) {
  const code = codeArg ?? process.env.SONDA_CODE;
  if (!code) throw new Error('Falta SONDA_CODE');
  const info = (await getDocumentStatus(code)) as unknown as Record<string, unknown>;
  imprimir('GET /document', { status: info.status, signProfile: info.signProfile, url: info.url ? '(hay url)' : null });
  const roadmap = await getDocumentRoadmap(code).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  imprimir('GET /document/roadmap', roadmap);

  // Diagnóstico de `order`: con firma en cadena, solo el primero queda notificado.
  const perfiles = (info.signProfile as { status?: string }[] | undefined) ?? [];
  const estados = perfiles.map((p) => p.status);
  const notificados = estados.filter((s) => s === 'NOTIFICATION' || s === 'FINISH').length;
  const pendientes = estados.filter((s) => s === 'PENDING').length;
  const firmados = estados.filter((s) => s === 'FINISH').length;
  const diag =
    info.status === 'FINISH'
      ? 'ORDER_OK (todos firmaron; revisa en el PDF que cada firma esté sobre su raya)'
      : notificados === firmados + 1 && pendientes === estados.length - notificados
        ? 'ORDER_OK (va por turnos: solo el siguiente está notificado)'
        : pendientes === 0 && firmados < estados.length
          ? 'ORDER_FALLA (Auco notificó a todos a la vez: es firma en paralelo)'
          : 'ESPERANDO (aún no hay suficiente información; vuelve a correr `ver` tras la próxima firma)';
  console.log(`\n== Diagnóstico\nestados: ${estados.join(', ')}\n${diag}`);
  console.log('Si nadie recibió el WhatsApp, busca NOTIFICATION_FAILED_SIGN en el roadmap.');
}

async function cancelar() {
  const code = process.env.SONDA_CODE;
  if (!code) throw new Error('Falta SONDA_CODE');
  if (process.env.SONDA_CONFIRMAR !== 'si') return console.log('SONDA_CONFIRMAR≠si: no se canceló nada.');
  await cancelDocument(code, { message: 'Prueba de cancelación (sonda Cofianza)', email: env.AUCO_SENDER_EMAIL });
  console.log('CANCELADO. Corre `ver` y anota en qué estado queda (esperado: REJECTED).');
}

async function recordar() {
  const code = process.env.SONDA_CODE;
  const firmante = process.env.SONDA_FIRMANTE;
  if (!code || !firmante) throw new Error('Faltan SONDA_CODE y SONDA_FIRMANTE (el id que imprime `ver`)');
  if (process.env.SONDA_CONFIRMAR !== 'si') return console.log('SONDA_CONFIRMAR≠si: no se mandó el recordatorio.');
  // La doc pide código del documento + id del firmante concatenados.
  await sendReminder(`${code}${firmante}`);
  console.log('Recordatorio enviado. ¿Le llegó al firmante silenciado? (plan B2)');
}

async function main() {
  const accion = process.env.SONDA_ACCION ?? 'crear';
  console.log(`Auco: ${env.AUCO_API_URL} · acción: ${accion}`);
  if (accion === 'crear') return crear();
  if (accion === 'ver') return ver();
  if (accion === 'cancelar') return cancelar();
  if (accion === 'recordar') return recordar();
  throw new Error(`SONDA_ACCION desconocida: ${accion} (crear | ver | cancelar | recordar)`);
}

main().catch((e) => {
  console.error('ERROR:', e instanceof Error ? e.message : e);
  process.exit(1);
});
