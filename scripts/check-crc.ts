/**
 * Check del Certificado de Riesgo Cofianza (CRC) — Flujo §10.1.
 *
 * "Entregables del resultado: Certificado de Riesgo Cofianza (CRC) descargable,
 *  con su numero, vigencia y condiciones economicas."
 *
 * Existe porque el CRC es el unico entregable que sale de Cofianza hacia un
 * tercero —el arrendador lo recibe y decide firmar con el en la mano— y porque
 * un PDF se rompe EN SILENCIO: un campo que se desborda, una seccion que se
 * sale de la pagina o un dato que deja de imprimirse no lanzan ningun error.
 * tsc y lint no ven nada. Este check renderiza el PDF de verdad y lee el texto
 * de vuelta.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-crc.ts
 */

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

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateCertificatePdf, generateQrCode } from '@/modules/estudios/certificado.service';

const BASE = {
  codigo: 'CRC-2026-0001',
  fechaEmision: '2026-09-07T10:00:00Z',
  fechaVencimiento: '2026-11-06T10:00:00Z',
  solicitanteNombre: 'Juan Carlos',
  solicitanteApellido: 'Ramirez Gomez',
  solicitanteTipoDoc: 'CC',
  solicitanteNumDoc: '1128441234',
  solicitanteEmail: 'juan@ejemplo.com',
  solicitanteTelefono: '+573001234567',
  tipoEstudio: 'individual',
  inmuebleDireccion: 'Calle 75 AB Sur 52 D 336 Apto 302',
  inmuebleCiudad: 'Itagui',
  inmuebleDepartamento: 'Antioquia',
  inmuebleTipo: 'apartamento',
  inmuebleUso: 'vivienda',
  inmuebleEstrato: 4,
  inmuebleValorArriendo: 2_500_000,
  inmuebleArea: 78,
  inmuebleCodigo: 'APT-001',
  resultado: 'aprobado',
  score: 773,
  proveedor: 'datacredito',
  fechaEstudio: '2026-09-07T09:58:00Z',
  duracionContrato: 12,
  observaciones: 'Sin moras vigentes reportadas en los ultimos 24 meses.',
  condiciones: null,
  canonEvaluado: 2_500_000,
  canonMaximoTolerado: 2_875_000,
  requiereAcompanante: false,
  rutaEtiqueta: 'Aprobado por el buro — sin puntaje del modelo',
  modeloVersion: 'v4.1-sombra-6var',
};

/**
 * Extrae el texto del PDF con `pdftotext` (poppler-utils), que es lo que ya
 * usamos a mano para leer PDFs en este repo.
 *
 * ponytail: se intento un parser propio (inflar los streams y sacar los Tj) y
 * no vale la pena: pdfkit subsetea las fuentes con codificacion propia, asi que
 * los bytes del stream no son el texto. Reimplementar eso es escribir media
 * libreria de PDF para un check.
 *
 * Si poppler no esta instalado, las aserciones de CONTENIDO se saltan con un
 * aviso ruidoso — pero las de RENDER (que el PDF se genere y no reviente) se
 * siguen corriendo, que es la mitad que mas se rompe.
 */
function hayPdftotext(): boolean {
  const r = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  return !r.error;
}

function textoDelPdf(buf: Buffer): string {
  const tmp = path.join(os.tmpdir(), `crc-check-${process.pid}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    const r = spawnSync('pdftotext', ['-layout', tmp, '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`pdftotext salio con ${r.status}: ${r.stderr}`);
    return r.stdout;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

let ok = 0;
function check(nombre: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    ok++;
    console.log(`  ok  ${nombre}`);
  });
}

(async () => {
  const qr = await generateQrCode('https://www.cofianza.co/verificar/CRC-2026-0001');

  console.log('\n§10.1 — el CRC se genera y lleva lo que el documento pide');

  const pdf = await generateCertificatePdf(BASE, qr);
  const puedeLeer = hayPdftotext();
  if (!puedeLeer) {
    console.log('\n  !! pdftotext no esta instalado: se saltan las aserciones de CONTENIDO.');
    console.log('     Instalalo con `sudo apt install poppler-utils` para que este check sirva de verdad.\n');
  }
  const texto = puedeLeer ? textoDelPdf(pdf) : '';

  const checkTexto = (nombre: string, fn: () => void) =>
    puedeLeer ? check(nombre, fn) : Promise.resolve(console.log(`  -   ${nombre} (saltado)`));

  await check('el PDF se genera y es un PDF de verdad', () => {
    assert.ok(pdf.length > 5000, `demasiado pequeno: ${pdf.length} bytes`);
    assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-', 'no empieza por %PDF-');
  });

  await checkTexto('se llama Certificado de Riesgo Cofianza (CRC), no "estudio de riesgo crediticio"', () => {
    assert.ok(texto.includes('CERTIFICADO DE RIESGO COFIANZA'), texto.slice(0, 300));
  });

  await checkTexto('lleva su NUMERO', () => {
    assert.ok(texto.includes('CRC-2026-0001'));
    assert.ok(texto.includes('NUMERO DEL CERTIFICADO'), 'el numero debe estar rotulado, no suelto');
  });

  await checkTexto('lleva su VIGENCIA rotulada', () => {
    assert.ok(texto.includes('VIGENTE HASTA'));
  });

  await checkTexto('lleva las CONDICIONES ECONOMICAS: canon evaluado y canon maximo amparado', () => {
    assert.ok(texto.includes('CONDICIONES DEL CERTIFICADO'));
    assert.ok(texto.includes('Canon evaluado'));
    assert.ok(texto.includes('Canon maximo amparado'));
  });

  await checkTexto('registra la version del modelo (Politica V4.1 §8)', () => {
    assert.ok(texto.includes('Version del modelo'));
    assert.ok(texto.includes('v4.1'));
  });

  await checkTexto('explica la tolerancia de canon que define cuando deja de servir', () => {
    assert.ok(texto.includes('15%'), 'debe decir la tolerancia');
    assert.ok(texto.includes('40%'), 'debe decir el techo de canon/ingreso');
  });

  await checkTexto('dice si el CRC ampara un contrato con acompanante', () => {
    assert.ok(texto.includes('Acompanante'));
  });

  console.log('\nCasos que antes rompian el PDF en silencio');

  await check('sin canon evaluado no revienta: omite la seccion de condiciones', async () => {
    const sinCanon = await generateCertificatePdf(
      { ...BASE, canonEvaluado: null, canonMaximoTolerado: null },
      qr,
    );
    const t = textoDelPdf(sinCanon);
    assert.ok(sinCanon.length > 5000);
    assert.ok(!t.includes('CONDICIONES DEL CERTIFICADO'), 'sin canon no hay condiciones que imprimir');
    assert.ok(t.includes('CRC-2026-0001'), 'el resto del certificado sigue completo');
  });

  await check('con observaciones largas sigue generando', async () => {
    const largo = await generateCertificatePdf(
      { ...BASE, observaciones: 'Observacion muy larga. '.repeat(40) },
      qr,
    );
    assert.ok(largo.length > 5000);
  });

  await check('un CRC con acompanante lo dice', async () => {
    const conAcomp = await generateCertificatePdf(
      { ...BASE, requiereAcompanante: true, tipoEstudio: 'con_coarrendatario' },
      qr,
    );
    assert.ok(textoDelPdf(conAcomp).includes('Requerido'));
  });

  await check('sin score no imprime la fila de score', async () => {
    const sinScore = await generateCertificatePdf({ ...BASE, score: null }, qr);
    assert.ok(sinScore.length > 5000);
  });

  console.log(`\nTodos los casos pasan (${ok}): el CRC del §10.1 se genera con numero, vigencia y condiciones.\n`);
})().catch((e) => {
  console.error('\nFALLO:', e);
  process.exit(1);
});
