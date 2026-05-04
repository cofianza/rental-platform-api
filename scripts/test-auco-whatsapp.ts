/**
 * Diagnostic: enviar un PDF de prueba a Auco para que dispare el flow de
 * firma por WhatsApp al numero indicado en TEST_PHONE.
 *
 * Sin imports del proyecto (no path aliases) — solo dotenv, pdf-lib y fetch
 * nativo. Asi se puede correr aislado sin levantar el server.
 *
 * Uso:
 *   cd rental-platform-api
 *   npx ts-node scripts/test-auco-whatsapp.ts
 */

import 'dotenv/config';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ---- Inputs del test ----
const TEST_PHONE = '+524775813450';
const TEST_NAME = 'Diego Ramirez (Prueba Cofianza)';
const TEST_EMAIL = 'inxeniux@gmail.com';

async function buildTestPdf(): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Cofianza — Prueba de envio WhatsApp', {
    x: 50, y: 780, size: 18, font: bold, color: rgb(0.06, 0.46, 0.43),
  });
  page.drawText('Este documento se genera para verificar la integracion con', {
    x: 50, y: 740, size: 12, font,
  });
  page.drawText('Auco.ai en modo flow por WhatsApp.', {
    x: 50, y: 720, size: 12, font,
  });
  page.drawText(`Destinatario: ${TEST_NAME}`, {
    x: 50, y: 680, size: 12, font,
  });
  page.drawText(`WhatsApp: ${TEST_PHONE}`, {
    x: 50, y: 660, size: 12, font,
  });
  page.drawText(`Fecha: ${new Date().toISOString()}`, {
    x: 50, y: 640, size: 11, font,
  });
  const bytes = await pdf.save();
  return Buffer.from(bytes).toString('base64');
}

async function main() {
  const apiUrl = process.env.AUCO_API_URL;
  const privateKey = process.env.AUCO_PRIVATE_KEY;
  const senderEmail = process.env.AUCO_SENDER_EMAIL;

  if (!apiUrl || !privateKey || privateKey === 'prk_placeholder') {
    console.error('AUCO_API_URL o AUCO_PRIVATE_KEY no estan configurados (o son placeholder).');
    console.error('  AUCO_API_URL:', apiUrl);
    console.error('  AUCO_PRIVATE_KEY:', privateKey ? privateKey.slice(0, 8) + '...' : '(vacio)');
    process.exit(1);
  }
  if (!senderEmail) {
    console.error('AUCO_SENDER_EMAIL no esta configurado');
    process.exit(1);
  }

  console.log('---- Auco WhatsApp diagnostic ----');
  console.log('API URL:', apiUrl);
  console.log('Sender:', senderEmail);
  console.log('Phone:', TEST_PHONE);
  console.log('Generando PDF...');
  const fileBase64 = await buildTestPdf();
  console.log(`PDF generado: ${(fileBase64.length / 1024).toFixed(1)} KB base64`);

  const expiredDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Override del sender: el .env apunta a hola@knowmeapp.com (placeholder),
  // pero el Manager real de Stage para Cofianza es dramirez@inxeniux.com.
  const realSender = 'dramirez@inxeniux.com';
  console.log('Override sender:', realSender, '(en lugar de', senderEmail, ')');

  const payload = {
    email: realSender,
    name: 'Test WhatsApp Cofianza',
    subject: 'Prueba de envio WhatsApp — Cofianza',
    message: `Hola ${TEST_NAME}, este es un documento de prueba enviado por Cofianza para verificar la integracion de firma por WhatsApp con Auco.`,
    file: fileBase64,
    // Sin otpCode global; cada firmante define el suyo via signProfile.
    signProfile: [
      {
        name: TEST_NAME,
        email: TEST_EMAIL,
        phone: TEST_PHONE,
        // Tipo de firma — Auco exige al menos uno de type/label/position.
        // 'signature' = firma libre que el firmante coloca donde Auco le indique.
        type: 'signature',
        // Activan el flow del firmante por WhatsApp con OTP por phone.
        otpCode: true,
        options: { whatsapp: true, otpCode: 'phone' },
      },
    ],
    expiredDate,
  };

  console.log('Payload signProfile:', JSON.stringify(payload.signProfile, null, 2));
  console.log('Llamando POST', `${apiUrl}/document/upload`, '...');

  const res = await fetch(`${apiUrl}/document/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: privateKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch {}

  console.log('Status:', res.status, res.statusText);
  console.log('Body:', parsed ?? text);

  if (!res.ok) {
    console.error('Auco rechazo el documento. Revisa el body de arriba.');
    process.exit(2);
  }

  console.log('OK. Auco creo el documento. Si todo esta configurado bien,');
  console.log(`deberias recibir un WhatsApp en ${TEST_PHONE} en los proximos minutos.`);
  console.log('Document code:', (parsed as { document?: string })?.document);
}

main().catch((err) => {
  console.error('Error inesperado:', err);
  process.exit(3);
});
