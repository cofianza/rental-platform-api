/**
 * Utilidad para combinar varios PDFs en uno solo. Usa pdf-lib (~150KB,
 * pure JS, sin dependencias nativas).
 *
 * Caso de uso principal: combinar el contrato original con los acuses
 * de firma electronica de cada solicitud firmada para producir el
 * "contrato firmado" descargable.
 */

import { PDFDocument } from 'pdf-lib';
import { logger } from '@/lib/logger';

/**
 * Concatena varios PDFs respetando el orden del array.
 * Cada buffer debe ser un PDF binario valido. Si alguno falla en parse,
 * se omite y se loggea warning — el resultado sigue siendo valido aunque
 * incompleto.
 *
 * `estricto` invierte eso y relanza: lo usa el sobre de firma de contratos V3,
 * donde perder en silencio el contrato de la inmobiliaria o el CRC seria grave.
 */
export async function mergePdfs(buffers: Buffer[], o?: { estricto?: boolean }): Promise<Buffer> {
  if (buffers.length === 0) {
    throw new Error('mergePdfs: no se recibieron buffers para concatenar');
  }
  if (buffers.length === 1) return buffers[0];

  const merged = await PDFDocument.create();

  for (let i = 0; i < buffers.length; i++) {
    try {
      const src = await PDFDocument.load(buffers[i]);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch (err) {
      if (o?.estricto) throw err;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), index: i },
        'mergePdfs: PDF #' + i + ' fallo al parsear, se omite',
      );
    }
  }

  const out = await merged.save();
  return Buffer.from(out);
}

/** Por que un PDF cargado por la inmobiliaria (Ruta B) no se puede usar. */
export type MotivoPdfInvalido = 'peso' | 'no_es_pdf' | 'protegido' | 'danado' | 'paginas' | 'formulario';

export class PdfInvalidoError extends Error {
  constructor(readonly motivo: MotivoPdfInvalido) {
    super(`PDF invalido: ${motivo}`);
  }
}

/**
 * Valida el PDF propio de la Ruta B ANTES de aceptarlo: tiene que poder unirse
 * al Anexo tal cual, sin tocarle una coma (V3 §4.4). Rechaza el protegido con
 * clave, el dañado y el que trae formulario (copyPages no copia el AcroForm y
 * aplanarlo seria modificarlo).
 */
export async function validarPdfPropio(
  buf: Buffer,
  limites: { maxBytes: number; maxPaginas: number },
): Promise<{ paginas: number; bytes: number }> {
  if (buf.length > limites.maxBytes) throw new PdfInvalidoError('peso');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfInvalidoError('no_es_pdf');
  try {
    const doc = await PDFDocument.load(buf);
    const paginas = doc.getPageCount();
    if (paginas < 1 || paginas > limites.maxPaginas) throw new PdfInvalidoError('paginas');
    if (doc.getForm().getFields().length > 0) throw new PdfInvalidoError('formulario');
    // Ultima prueba: que de verdad se pueda copiar. Un PDF roto puede cargar y
    // reventar aqui, que es justo donde reventaria al armar el sobre.
    const destino = await PDFDocument.create();
    await destino.copyPages(doc, doc.getPageIndices());
    return { paginas, bytes: buf.length };
  } catch (err) {
    if (err instanceof PdfInvalidoError) throw err;
    // pdf-lib compila a ES5 y su EncryptedPDFError termina siendo un Error
    // pelado (el `Error.call(this)` del __extends devuelve otro objeto), asi
    // que `instanceof` no sirve: se distingue por el mensaje.
    const protegido = err instanceof Error && /encrypted/i.test(err.message);
    throw new PdfInvalidoError(protegido ? 'protegido' : 'danado');
  }
}
