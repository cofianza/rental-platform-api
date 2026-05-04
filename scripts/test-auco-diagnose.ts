/**
 * Diagnostico mas profundo: probar variantes para acotar el USER_NOTFOUND.
 *
 * 1) Verifica si el private key responde en Stage vs Prod.
 * 2) Lista cuentas/managers asociados al key (si hay endpoint).
 * 3) Reintenta upload con el sender exacto del .env.
 */

import 'dotenv/config';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

async function tinyPdf(): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Cofianza — Test', { x: 50, y: 780, size: 18, font, color: rgb(0, 0, 0) });
  return Buffer.from(await pdf.save()).toString('base64');
}

async function probeUploadAt(apiUrl: string, label: string, payload: object, privateKey: string) {
  console.log(`\n→ ${label}: ${apiUrl}/document/upload`);
  const res = await fetch(`${apiUrl}/document/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: privateKey },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch {}
  console.log(`   Status: ${res.status}`);
  console.log(`   Body:`, parsed ?? text);
  return { status: res.status, body: parsed };
}

async function main() {
  const senderEmail = process.env.AUCO_SENDER_EMAIL!;
  const privateKey = process.env.AUCO_PRIVATE_KEY!;
  const stageUrl = 'https://dev.auco.ai/v1.5/ext';
  const prodUrl = 'https://api.auco.ai/v1.5/ext';

  console.log('Sender:', senderEmail);
  console.log('Private key prefix:', privateKey.slice(0, 12) + '...');

  const file = await tinyPdf();
  const expiredDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  const buildPayload = (creator: string) => ({
    email: creator,
    name: 'Cofianza WhatsApp Diagnostic',
    subject: 'Test',
    message: 'Test',
    file,
    signProfile: [
      {
        name: 'Diego Test',
        email: 'inxeniux@gmail.com',
        phone: '+524775813450',
        type: 'signature',
        otpCode: true,
        options: { whatsapp: true, otpCode: 'phone' },
      },
    ],
    expiredDate,
  });

  // Test 1: Stage con email del .env
  await probeUploadAt(stageUrl, 'Stage + sender del .env', buildPayload(senderEmail), privateKey);

  // Test 2: Prod con la misma key
  await probeUploadAt(prodUrl, 'Prod + sender del .env', buildPayload(senderEmail), privateKey);

  // Test 3: Stage con sender en mayusculas (paranoia)
  await probeUploadAt(stageUrl, 'Stage + sender UPPERCASE', buildPayload(senderEmail.toUpperCase()), privateKey);

  // Test 4: Stage con email del firmante como creator (paranoia: tal vez Auco lo trate distinto)
  await probeUploadAt(stageUrl, 'Stage + creator = inxeniux@gmail.com', buildPayload('inxeniux@gmail.com'), privateKey);

  console.log('\n---- Listo. Comparar status entre tests para acotar el problema ----');
}

main().catch((e) => { console.error(e); process.exit(1); });
