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
 */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
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
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), index: i },
        'mergePdfs: PDF #' + i + ' fallo al parsear, se omite',
      );
    }
  }

  const out = await merged.save();
  return Buffer.from(out);
}
