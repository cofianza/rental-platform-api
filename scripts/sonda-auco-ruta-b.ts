/**
 * Sonda de Auco para la Ruta B con firmas (Adenda 1 del módulo de contratos, respuesta 6).
 *
 * En la Ruta B cada firmante va con `label: true` (las anclas {{signature:N}} del
 * Anexo) Y `position` (sus rayas en el PDF de la inmobiliaria, que no se toca).
 * Contesta lo que la documentación de Auco no deja claro y la conversión
 * (v3/firma/reglas.ts, posicionAuco) da por bueno:
 *   1. si Auco acepta label y position a la vez, y varias posiciones por firmante;
 *   2. el origen de (x, y) —suponemos arriba a la izquierda— y que (x, y) es la
 *      esquina INFERIOR DERECHA del recuadro de 150×50 pt;
 *   3. si mide sobre la página como se ve: con /Rotate (pág. 3) y con CropBox (pág. 4);
 *   4. que `page` cuente desde 1 y que w/h sean puntos.
 *
 * Arma su propio PDF (no toca la base de datos): pág. 1 con dos rayas rotuladas;
 * pág. 2 con las anclas {{signature:0}} y {{signature:1}} como en el Anexo; pág. 3
 * girada 90° y pág. 4 con un CropBox grande y asimétrico, con dos rayas cada una. Las posiciones salen de
 * las MISMAS funciones del envío: congelarFirmas (geometría leída del PDF),
 * posicionesDeFirma (posicionAuco) y construirSignProfile.
 *
 * Sin --confirmar no llama a Auco: imprime lo que mandaría. Con --confirmar crea un
 * proceso real: consume un crédito y manda WhatsApp. Las llaves buenas están en Railway:
 *
 *   railway run npx ts-node -r tsconfig-paths/register scripts/sonda-auco-ruta-b.ts \
 *     "Ana Pérez|ana@correo.co|3001112233" "Beto Díaz|beto@correo.co|3004445566" [--confirmar]
 *
 * Para seguir el proceso y anularlo al terminar: src/scripts/sonda-auco-v3.ts con SONDA_ACCION=ver o
 * SONDA_ACCION=cancelar SONDA_CONFIRMAR=si (lo imprime esta sonda con el código).
 */

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { env } from '@/config';
import { uploadDocumentForSignature } from '@/lib/auco';
import type { MarcaFirma } from '@/modules/contratos/v3/asistente.types';
import {
  RECUADRO_FIRMA,
  congelarFirmas,
  construirSignProfile,
  posicionesDeFirma,
  type ParteFirmante,
  type PosicionAuco,
} from '@/modules/contratos/v3/firma/reglas';

/**
 * Una raya de firma: su punto medio relativo a la página como se ve (origen
 * arriba-izquierda) es exactamente la marca que haría la inmobiliaria en la web.
 */
export const RAYAS: MarcaFirma[] = [
  { parte: 'arrendatario', pagina: 1, x: 0.3, y: 0.55 },
  { parte: 'arrendador', pagina: 1, x: 0.7, y: 0.8 },
  { parte: 'arrendatario', pagina: 3, x: 0.3, y: 0.7 },
  { parte: 'arrendador', pagina: 3, x: 0.7, y: 0.7 },
  { parte: 'arrendatario', pagina: 4, x: 0.3, y: 0.6 },
  { parte: 'arrendador', pagina: 4, x: 0.7, y: 0.6 },
];
/** Largo de cada raya, relativo al ancho que se ve. */
export const LARGO = 0.3;
/** Pág. 4: CropBox grande y asimétrico (x, y, ancho, alto en pt) sobre un MediaBox de 612×792. */
export const RECORTE = [150, 200, 400, 500] as const;

/** Un punto de la página como se ve (relativo, origen arriba-izquierda) → coordenadas del PDF. Solo /Rotate 0 y 90 (los de la sonda). */
function aPdf(p: PDFPage, vx: number, vy: number): { x: number; y: number } {
  const c = p.getCropBox();
  return p.getRotation().angle === 90
    ? { x: c.x + vy * c.width, y: c.y + vx * c.height }
    : { x: c.x + vx * c.width, y: c.y + c.height - vy * c.height };
}

/** Texto que se lee derecho en la página como se ve, con la línea base desde (vx, vy). */
function escribir(p: PDFPage, font: PDFFont, vx: number, vy: number, s: string, size = 9, color = rgb(0, 0, 0)) {
  p.drawText(s, { ...aPdf(p, vx, vy), size, font, color, rotate: degrees(p.getRotation().angle) });
}

/** Una raya centrada en (x, y), con su rótulo debajo y, si va por position, la marca roja en el punto medio. */
function raya(p: PDFPage, font: PDFFont, x: number, y: number, rotulo: string, conMarca = true) {
  p.drawLine({ start: aPdf(p, x - LARGO / 2, y), end: aPdf(p, x + LARGO / 2, y), thickness: 1, color: rgb(0, 0, 0) });
  if (conMarca) p.drawLine({ start: aPdf(p, x, y - 0.008), end: aPdf(p, x, y + 0.008), thickness: 1, color: rgb(0.8, 0, 0) });
  escribir(p, font, x - LARGO / 2, y + 0.025, rotulo, 7);
}

/**
 * Pág. 4: si Auco midiera sobre el MediaBox y no sobre el CropBox, cuánto se correría la
 * firma (centro del borde inferior del recuadro) respecto de su marca, en pt: + = a la
 * derecha / hacia abajo, en la página como se ve.
 */
function corrimientoSiMediaBox(p: PDFPage, m: MarcaFirma, pos: PosicionAuco): { derecha: number; abajo: number } {
  const c = p.getCropBox();
  const mb = p.getMediaBox();
  const marcaX = c.x - mb.x + m.x * c.width; // desde el borde izquierdo del MediaBox
  const marcaY = mb.y + mb.height - (c.y + c.height) + m.y * c.height; // desde el borde superior del MediaBox
  return { derecha: Math.round(pos.x * mb.width - pos.w / 2 - marcaX), abajo: Math.round(pos.y * mb.height - marcaY) };
}

export async function pdfDePrueba(nombres: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [p1, p2, p3, p4] = [1, 2, 3, 4].map(() => doc.addPage([612, 792]));
  p3.setRotation(degrees(90));
  p4.setCropBox(...RECORTE);
  const titulos = [
    'Pág. 1: por position. Cada firma, sobre su raya y centrada en la marca roja.',
    'Pág. 2: por ancla (label), como en el Anexo. Cada firma, sobre su raya.',
    'Pág. 3: girada 90° (/Rotate). Cada firma, sobre su raya.',
    'Pág. 4: con CropBox (se ve solo una parte). Cada firma, sobre su raya.',
  ];
  [p1, p2, p3, p4].forEach((p, i) => {
    escribir(p, font, 0.08, 0.1, 'SONDA RUTA B · COFIANZA · prueba sin efectos jurídicos', 10);
    escribir(p, font, 0.08, 0.14, titulos[i], 8);
  });
  for (const r of RAYAS) {
    const n = r.parte === 'arrendatario' ? 0 : 1;
    raya([p1, p2, p3, p4][r.pagina - 1], font, r.x, r.y, `Firmante ${n + 1} (${nombres[n]})`);
  }
  // Pág. 2: el ancla va oculta (texto blanco y diminuto) al inicio de cada raya, como en el Anexo.
  for (const n of [0, 1]) {
    const y = 0.45 + n * 0.25;
    raya(p2, font, 0.5, y, `Firmante ${n + 1} (${nombres[n]}): ancla oculta al inicio de la raya`, false);
    escribir(p2, font, 0.5 - LARGO / 2, y - 0.004, `{{signature:${n}}}`, 2, rgb(1, 1, 1));
  }
  return Buffer.from(await doc.save());
}

/** "Nombre|correo|celular" → una parte como las de contrato_partes (arrendatario primero). */
function leerFirmante(x: string, i: number): ParteFirmante {
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
  };
}

const mask = (s: string) =>
  s.replace(/(\+?\d{2,3})\d{5,}(\d{2})/g, '$1…$2').replace(/([\w.+-]{2})[\w.+-]*(@[\w.-]+)/g, '$1…$2');

async function main() {
  const args = process.argv.slice(2);
  const confirmar = args.includes('--confirmar');
  const partes = args.filter((a) => !a.startsWith('--')).map(leerFirmante);
  if (partes.length !== 2) throw new Error('Pasa dos firmantes: "Nombre|correo|celular" "Nombre|correo|celular" [--confirmar]');

  const pdf = await pdfDePrueba(partes.map((p) => p.nombre));
  // Como el envío: la geometría se lee del PDF que se manda y se congela con las marcas.
  const doc = await PDFDocument.load(pdf);
  const firmasPropio = congelarFirmas(doc, RAYAS);
  const posiciones = posicionesDeFirma(partes, { ruta: 'B', firmasPropio })!;
  const signProfile = construirSignProfile(partes, posiciones);
  const siMediaBox = RAYAS.filter((r) => r.pagina === 4).map((r) => {
    const n = r.parte === 'arrendatario' ? 0 : 1;
    const { derecha, abajo } = corrimientoSiMediaBox(doc.getPage(3), r, posiciones[n].find((q) => q.page === 4)!);
    const horizontal = derecha ? `${Math.abs(derecha)} pt a la ${derecha > 0 ? 'derecha' : 'izquierda'}` : 'sin corrimiento horizontal';
    return `firmante ${n + 1}: ${horizontal} y ${Math.abs(abajo)} pt ${abajo > 0 ? 'más abajo' : 'más arriba'}`;
  });
  const cm = (pt: number) => (pt * 2.54 / 72).toFixed(1).replace('.', ',');
  console.log(`Auco: ${env.AUCO_API_URL}`);
  console.log(`\n== Geometría congelada\n${JSON.stringify(firmasPropio.paginas, null, 2)}`);
  console.log(`\n== signProfile\n${mask(JSON.stringify(signProfile, null, 2))}`);
  console.log(`\nPDF: ${(pdf.length / 1024).toFixed(1)} KB, 4 páginas.`);
  if (!confirmar) {
    console.log('\nSin --confirmar: no se llamó a Auco. Esto es lo que se enviaría.');
    return;
  }

  const code = await uploadDocumentForSignature(
    {
      email: env.AUCO_SENDER_EMAIL,
      name: 'SONDA · Ruta B: label + position (Cofianza)',
      subject: 'Prueba de firma — Cofianza',
      message: 'Documento de prueba. No tiene efectos jurídicos.',
      file: pdf.toString('base64'),
      signProfile,
      expiredDate: new Date(Date.now() + 4 * 86_400_000).toISOString(), // Auco exige más de 3 días
      custom: { cofianza_sonda: 'ruta-b' },
    },
    120_000,
  );
  const { w, h } = RECUADRO_FIRMA;
  console.log(`\nCREADO. SONDA_CODE=${code}`);
  console.log(`
Qué mirar al firmar (y en el PDF firmado que devuelve Auco). Todo se corrige en posicionAuco
(v3/firma/reglas.ts), con firmaX/firmaY = esquina superior izquierda del recuadro que queremos:
  Pág. 1: cada firma apoyada SOBRE su raya y centrada en la marca roja: el supuesto se cumple.
    Si Auco toma (x, y) como otra esquina del recuadro, la firma se corre a la DERECHA y/o hacia ABAJO:
    - ${w} pt (${cm(w)} cm) a la derecha y ${h} pt (${cm(h)} cm) hacia abajo: es la esquina superior izquierda
      → x = firmaX / ancho, y = firmaY / alto.
    - ${w} pt a la derecha, a la altura de la raya: es la esquina inferior izquierda → x = firmaX / ancho.
    - ${h} pt hacia abajo, centrada: es la esquina superior derecha → y = firmaY / alto.
    - ${w / 2} pt a la derecha y ${h / 2} pt hacia abajo: es el centro → x = (firmaX + w/2) / ancho, y = (firmaY + h/2) / alto.
    - Reflejada en vertical (la del firmante 2, con la raya al 80 % de la altura, cae cerca del 20 %):
      Auco mide y desde abajo → y = 1 − (firmaY + h) / alto.
    - Una página más adelante (las de la pág. 1 en la 2, las de la 3 en la 4; las de la 4, perdidas):
      Auco cuenta las páginas desde 0 → page = pagina − 1.
    - El recuadro no mide ~${cm(w)} × ${cm(h)} cm (${w} × ${h} pt): w/h no son puntos → ajustar RECUADRO_FIRMA.
  Pág. 2: cada firma sobre su ancla: label sigue funcionando junto con position.
  Pág. 3 (girada): igual que la 1. Si solo aquí falla, Auco no aplica /Rotate como un visor.
  Pág. 4 (recortada): igual que la 1. Si Auco midiera sobre el MediaBox, se correrían así:
    ${siMediaBox.join('; ')}.
  Si Auco rechazó el envío con un 400, lea el mensaje: puede que no acepte label y position juntos.

Para seguirlo y, al terminar (o si algo sale mal), anularlo:
  SONDA_ACCION=ver SONDA_CODE=${code} railway run npx ts-node -r tsconfig-paths/register src/scripts/sonda-auco-v3.ts
  SONDA_ACCION=cancelar SONDA_CODE=${code} SONDA_CONFIRMAR=si railway run npx ts-node -r tsconfig-paths/register src/scripts/sonda-auco-v3.ts
  (desde la Console de Railway: las mismas variables con node dist/scripts/sonda-auco-v3.js). Si nadie firma, vence solo en 4 días.`);
}

// Solo al correrla como script: importarla (para revisar el PDF) no llama a nada.
if (require.main === module)
  main().catch((e) => {
    console.error('ERROR:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
