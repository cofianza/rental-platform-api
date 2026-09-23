import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { mergePdfs, validarPdfPropio, PdfInvalidoError } from '../pdfMerger';

// ============================================================
// Unión estricta y validación del PDF que carga la inmobiliaria (Ruta B, E5):
// lo que aquí se cuele va al sobre de firma sin que nadie lo revise.
// ============================================================

const LIMITES = { maxBytes: 6 * 1024 * 1024, maxPaginas: 60 };

async function pdf(paginas: number, texto = 'x'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) doc.addPage([200, 200]).drawText(`${texto}${i}`, { x: 10, y: 100, size: 12 });
  return Buffer.from(await doc.save());
}

async function conFormulario(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  doc.getForm().createTextField('nombre').addToPage(page, { x: 10, y: 100, width: 100, height: 20 });
  return Buffer.from(await doc.save());
}

/** PDF real con clave (generado con ghostscript): el caso "subelo sin contrasena". */
const CIFRADO = fs.readFileSync(path.join(__dirname, 'fixtures/cifrado.pdf'));

describe('mergePdfs', () => {
  it('concatena en orden y suma las páginas', async () => {
    const out = await mergePdfs([await pdf(2), await pdf(3)]);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(5);
  });

  it('sin `estricto` sigue omitiendo el PDF ilegible (flujo anterior)', async () => {
    const out = await mergePdfs([await pdf(2), Buffer.from('no soy un pdf'), await pdf(1)]);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(3);
  });

  it('con `estricto` relanza: el sobre de firma nunca sale incompleto en silencio', async () => {
    await expect(mergePdfs([await pdf(1), Buffer.from('no soy un pdf')], { estricto: true })).rejects.toThrow();
  });

  it('las páginas de la inmobiliaria pasan intactas: mismo contenido y tamaño, sin nada estampado ni repaginado (Adenda 1, respuesta 6)', async () => {
    /** Los flujos de contenido de una página, tal como están en el archivo. */
    const contenido = (d: PDFDocument, i: number) => {
      const c = d.getPage(i).node.Contents();
      const flujos = c instanceof PDFArray ? c.asArray().map((r) => d.context.lookup(r)) : [c];
      return flujos.map((f) => Buffer.from((f as PDFRawStream).getContents()).toString('latin1'));
    };
    const propio = await PDFDocument.load(await pdf(2, 'inmobiliaria'));
    const unido = await PDFDocument.load(await mergePdfs([Buffer.from(await propio.save()), await pdf(1, 'anexo')], { estricto: true }));
    for (const i of [0, 1]) {
      expect(contenido(unido, i)).toEqual(contenido(propio, i));
      expect(unido.getPage(i).getSize()).toEqual(propio.getPage(i).getSize());
    }
  });

  it('un solo buffer se devuelve tal cual', async () => {
    const uno = await pdf(1);
    expect(await mergePdfs([uno], { estricto: true })).toBe(uno);
    await expect(mergePdfs([])).rejects.toThrow(/no se recibieron/);
  });
});

describe('validarPdfPropio', () => {
  it('acepta un PDF normal y devuelve páginas y peso', async () => {
    const buf = await pdf(3);
    expect(await validarPdfPropio(buf, LIMITES)).toEqual({ paginas: 3, bytes: buf.length });
  });

  it.each([
    ['no_es_pdf', async () => Buffer.from('%PNG\r\n cualquier cosa')],
    ['danado', async () => Buffer.from('%PDF-1.4 y nada mas')],
    ['protegido', async () => CIFRADO],
    ['formulario', conFormulario],
  ] as const)('rechaza con motivo «%s»', async (motivo, hacer) => {
    await expect(validarPdfPropio(await hacer(), LIMITES)).rejects.toMatchObject({ motivo });
  });

  it('rechaza por peso y por número de páginas', async () => {
    const buf = await pdf(2);
    await expect(validarPdfPropio(buf, { ...LIMITES, maxBytes: 10 })).rejects.toMatchObject({ motivo: 'peso' });
    await expect(validarPdfPropio(buf, { ...LIMITES, maxPaginas: 1 })).rejects.toMatchObject({ motivo: 'paginas' });
  });

  it('rechaza acciones que ejecutan algo (JavaScript al abrir); un enlace web pasa', async () => {
    const conJs = await PDFDocument.create();
    conJs.addPage([200, 200]);
    conJs.catalog.set(PDFName.of('OpenAction'), conJs.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
    await expect(validarPdfPropio(Buffer.from(await conJs.save()), LIMITES)).rejects.toMatchObject({ motivo: 'activo' });

    const conEnlace = await PDFDocument.create();
    conEnlace.addPage([200, 200]);
    conEnlace.catalog.set(PDFName.of('OpenAction'), conEnlace.context.obj({ S: 'URI', URI: PDFString.of('https://cofianza.co') }));
    await expect(validarPdfPropio(Buffer.from(await conEnlace.save()), LIMITES)).resolves.toMatchObject({ paginas: 1 });
  });

  it('la carga corre vigilada: si tarda o la memoria crece de más, se corta como dañado (PDF bomba)', async () => {
    const buf = await pdf(3);
    await expect(validarPdfPropio(buf, { ...LIMITES, timeoutMs: 1 })).rejects.toMatchObject({ motivo: 'danado' });
    await expect(validarPdfPropio(buf, { ...LIMITES, maxMemoriaExtra: 1 })).rejects.toMatchObject({ motivo: 'danado' });
    // y con los límites normales el mismo PDF pasa
    await expect(validarPdfPropio(buf, LIMITES)).resolves.toMatchObject({ paginas: 3 });
  });

  it('el error es PdfInvalidoError, para que la ruta lo traduzca a 422', async () => {
    await expect(validarPdfPropio(Buffer.from('x'), LIMITES)).rejects.toBeInstanceOf(PdfInvalidoError);
  });
});
