import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

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

  it('el error es PdfInvalidoError, para que la ruta lo traduzca a 422', async () => {
    await expect(validarPdfPropio(Buffer.from('x'), LIMITES)).rejects.toBeInstanceOf(PdfInvalidoError);
  });
});
