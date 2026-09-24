/**
 * Utilidad para combinar varios PDFs en uno solo. Usa pdf-lib (~150KB,
 * pure JS, sin dependencias nativas).
 *
 * Caso de uso principal: combinar el contrato original con los acuses
 * de firma electronica de cada solicitud firmada para producir el
 * "contrato firmado" descargable.
 */

import { Worker } from 'worker_threads';
import { PDFDocument } from 'pdf-lib';
import { logger } from '@/lib/logger';

/**
 * Concatena varios PDFs respetando el orden del array.
 * Cada buffer debe ser un PDF binario valido. Si alguno falla en parse,
 * se omite y se loggea warning — el resultado sigue siendo valido aunque
 * incompleto. Tambien acepta documentos ya cargados con pdf-lib, para no
 * volver a parsear lo que el caller ya leyo.
 *
 * `estricto` invierte eso y relanza: lo usa el sobre de firma de contratos V3,
 * donde perder en silencio el contrato de la inmobiliaria o el CRC seria grave.
 */
export async function mergePdfs(buffers: Array<Buffer | PDFDocument>, o?: { estricto?: boolean }): Promise<Buffer> {
  if (buffers.length === 0) {
    throw new Error('mergePdfs: no se recibieron buffers para concatenar');
  }
  const [unico] = buffers;
  if (buffers.length === 1 && Buffer.isBuffer(unico)) return unico;

  const merged = await PDFDocument.create();

  for (let i = 0; i < buffers.length; i++) {
    try {
      const b = buffers[i];
      const src = b instanceof PDFDocument ? b : await PDFDocument.load(b);
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
export type MotivoPdfInvalido = 'peso' | 'no_es_pdf' | 'protegido' | 'danado' | 'paginas' | 'formulario' | 'activo';

export class PdfInvalidoError extends Error {
  constructor(readonly motivo: MotivoPdfInvalido) {
    super(`PDF invalido: ${motivo}`);
  }
}

/**
 * Lo que corre aislado en un worker: cargar el PDF con pdf-lib puede inflar un
 * flujo comprimido hasta gigas ("bomba" de descompresion) y, en el hilo
 * principal, tumbaria la API entera. JS plano (sin TS ni alias): se evalua tal cual.
 * Acciones que ejecutan algo al abrir o al hacer clic: JavaScript, lanzar otro
 * programa, enviar o importar datos, abrir otro archivo. Los enlaces web (URI) pasan.
 */
const VALIDADOR = `
const { parentPort, workerData } = require('worker_threads');
const { PDFDocument, PDFDict, PDFArray, PDFName } = require(workerData.pdfLib);
const PELIGROSAS = new Set(['/JavaScript', '/Launch', '/SubmitForm', '/ImportData', '/GoToR', '/GoToE']);
function activo(doc) {
  const vistos = new Set();
  const pila = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) pila.push(obj);
  let presupuesto = 200000;
  while (pila.length && presupuesto-- > 0) {
    const o = pila.pop();
    if (!o || vistos.has(o)) continue;
    vistos.add(o);
    if (o instanceof PDFDict) {
      if (o.get(PDFName.of('JS'))) return true;
      const s = o.get(PDFName.of('S'));
      if (s && PELIGROSAS.has(String(s))) return true;
      for (const [, v] of o.entries()) pila.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) pila.push(o.get(i));
    }
  }
  return false;
}
(async () => {
  try {
    const doc = await PDFDocument.load(Buffer.from(workerData.buf));
    const paginas = doc.getPageCount();
    const campos = doc.getForm().getFields().length;
    const esActivo = activo(doc);
    const destino = await PDFDocument.create();
    await destino.copyPages(doc, doc.getPageIndices());
    parentPort.postMessage({ ok: true, paginas, campos, activo: esActivo });
  } catch (e) {
    parentPort.postMessage({ ok: false, mensaje: String((e && e.message) || e) });
  }
})();
`;

interface ResultadoValidador {
  ok: boolean;
  paginas?: number;
  campos?: number;
  activo?: boolean;
  mensaje?: string;
}

/**
 * Corre el validador en un worker y lo mata si tarda o si la memoria del proceso
 * crece de mas (resourceLimits no cuenta los ArrayBuffer que infla pdf-lib).
 */
function enWorker(buf: Buffer, o: { timeoutMs: number; maxMemoriaExtra: number }): Promise<ResultadoValidador> {
  return new Promise((resolve, reject) => {
    const w = new Worker(VALIDADOR, { eval: true, workerData: { buf, pdfLib: require.resolve('pdf-lib') } });
    const base = process.memoryUsage.rss();
    let terminado = false;
    const cerrar = () => {
      terminado = true;
      clearInterval(vigia);
      clearTimeout(reloj);
      void w.terminate();
    };
    const abortar = (motivo: string) => {
      if (terminado) return;
      cerrar();
      logger.warn({ motivo, bytes: buf.length }, 'validarPdfPropio: validacion abortada');
      reject(new PdfInvalidoError('danado'));
    };
    const vigia = setInterval(() => {
      if (process.memoryUsage.rss() - base > o.maxMemoriaExtra) abortar('memoria');
    }, 25);
    const reloj = setTimeout(() => abortar('tiempo'), o.timeoutMs);
    w.once('message', (m: ResultadoValidador) => {
      if (terminado) return;
      cerrar();
      resolve(m);
    });
    w.once('error', (e) => abortar(e instanceof Error ? e.message : String(e)));
  });
}

/**
 * Valida el PDF propio de la Ruta B ANTES de aceptarlo: tiene que poder unirse
 * al Anexo tal cual, sin tocarle una coma (V3 §4.4). Rechaza el protegido con
 * clave, el dañado, el que trae formulario (copyPages no copia el AcroForm y
 * aplanarlo seria modificarlo) y el que trae acciones que ejecutan algo. La
 * carga corre aislada (enWorker): un PDF bomba no tumba la API.
 */
export async function validarPdfPropio(
  buf: Buffer,
  limites: { maxBytes: number; maxPaginas: number; timeoutMs?: number; maxMemoriaExtra?: number },
): Promise<{ paginas: number; bytes: number }> {
  if (buf.length > limites.maxBytes) throw new PdfInvalidoError('peso');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfInvalidoError('no_es_pdf');
  const r = await enWorker(buf, {
    timeoutMs: limites.timeoutMs ?? 5000,
    maxMemoriaExtra: limites.maxMemoriaExtra ?? 300 * 1024 * 1024,
  });
  if (!r.ok) {
    // pdf-lib compila a ES5 y su EncryptedPDFError termina siendo un Error
    // pelado (el `Error.call(this)` del __extends devuelve otro objeto), asi
    // que se distingue por el mensaje.
    throw new PdfInvalidoError(/encrypted/i.test(r.mensaje ?? '') ? 'protegido' : 'danado');
  }
  const paginas = r.paginas ?? 0;
  if (paginas < 1 || paginas > limites.maxPaginas) throw new PdfInvalidoError('paginas');
  if ((r.campos ?? 0) > 0) throw new PdfInvalidoError('formulario');
  if (r.activo) throw new PdfInvalidoError('activo');
  return { paginas, bytes: buf.length };
}
