/**
 * Contratos V3 — documento: envuelve el HTML del motor en una página con el
 * formato del Word (Georgia → Gelasio, Carta, márgenes, cabecera y pie) y la
 * pasa a PDF con Chromium.
 *
 * Contrato de clases con motor.ts:
 *   - cada párrafo del Word es UN elemento `.k-<kind>` (p, sangria, sangria2,
 *     item, literal, vineta, titulo, nota, bloque, seccion, subtitulo,
 *     centrado, celda, recuadro, dato, firma); `.inicio` marca la primera
 *     línea de una cláusula;
 *   - contenedores: `table.cuadro` y `table.dinero` (celdas `.k-celda`, sea el
 *     `td` o un párrafo dentro), `.recuadro` (la caja de sus `.k-recuadro`,
 *     la primera es el título);
 *   - en línea: `.linea` (raya de firma), `.casilla` (con "X" si va marcada),
 *     `.pendiente` (modo revisión).
 * Las medidas salen del .docx (twips / 20 = pt); cada una trae su origen.
 */

import fs from 'fs';
import path from 'path';
import { renderHtmlToPdf } from '@/lib/pdfRenderer';

// Misma profundidad desde src/…/v3 (ts-node, vitest) y dist/…/v3 (build).
// Se lee al cargar el módulo: si falta un recurso, el require ya falla.
const RECURSOS = path.resolve(__dirname, '../../../../recursos/contratos');
const base64 = (f: string) => fs.readFileSync(path.join(RECURSOS, f)).toString('base64');

// Las cuatro caras de Gelasio (OFL, métricas de Georgia). Mismo data URI en
// el cuerpo y en cabecera/pie: Chromium incrusta una sola copia de cada cara.
const CARAS = (
  [
    [400, 'normal'],
    [700, 'normal'],
    [400, 'italic'],
    [700, 'italic'],
  ] as const
).map(([peso, estilo]) => ({
  css:
    `@font-face{font-family:Gelasio;font-weight:${peso};font-style:${estilo};` +
    `src:url(data:font/woff2;base64,${base64(`fuentes/gelasio-latin-${peso}-${estilo}.woff2`)}) format('woff2')}`,
  prueba: `${estilo} ${peso} 10pt Gelasio`,
}));

const LOGO_COFIANZA = `data:image/svg+xml;base64,${base64('cofianza-logo.svg')}`;

// sectPr del Word: top 1420, left/right 1360, bottom 1200 twips.
const MARGENES = { top: '0.986in', right: '0.944in', bottom: '0.833in', left: '0.944in' };
// Perillas: el Word pone la cabecera a 540 twips del borde y el pie a 520.
const CABECERA_DESDE_ARRIBA = '0.375in';
const PIE_HASTA_ABAJO = '0.361in';

// La marca va al centro del área de texto (8.5in − 2·0.944in, 11in − 0.986in − 0.833in)
// en pulgadas: un % se resolvería contra el viewport de Puppeteer (800×600), no la hoja.
// pre-wrap: el Word separa con espacios ("…     Municipio:", "SÍ ☐   NO ☐",
// "I.  PARTES"). Las firmas no se despegan del párrafo de cierre (break-before):
// no hay hoja de firmas sin texto del contrato.
const CSS = `${CARAS.map((c) => c.css).join('')}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#fff;color:#000;font-family:Gelasio;font-size:10pt;line-height:1.19;text-align:justify;hyphens:none;orphans:2;widows:2}
p{margin:0}
.k-p,.k-sangria,.k-sangria2{padding:4.5pt 0}
.k-sangria{padding-left:17pt}
.k-sangria2{padding-left:28pt}
.inicio{padding-top:10pt}
.k-item,.k-literal{padding:3pt 0 3pt 17pt}
.k-vineta{padding:2pt 0 2pt 15pt}
.k-dato{padding:2pt 0}
.k-dato,.k-celda,.k-bloque,.k-seccion{white-space:pre-wrap}
.k-titulo{font-size:13pt;text-align:center;padding:10pt 0 2pt}
.k-nota{font-size:9pt;font-style:italic;color:#595959;padding:10pt 0 4.5pt}
.k-titulo+.k-nota{text-align:center;padding:0 0 13pt}
.k-bloque,.k-seccion{text-align:left;line-height:1.14;border-bottom:.75pt solid #BFBFBF;break-after:avoid}
.k-bloque{font-size:11pt;padding-top:15pt;margin-bottom:7.5pt}
.k-seccion{font-size:10.5pt;padding-top:9.5pt;margin-bottom:4.5pt}
.k-subtitulo{padding:7.5pt 0 3pt;break-after:avoid}
.k-centrado{text-align:center;padding:15pt 0 5pt}
table{width:100%;border-collapse:collapse;table-layout:fixed}
tr{break-inside:avoid}
td{padding:0;vertical-align:top;border:.5pt solid #BFBFBF}
.k-celda{font-size:9.5pt;line-height:1.14;text-align:left}
.cuadro .k-celda{padding:3.5pt 5.5pt}
.cuadro td:first-child{width:33%;background:#F2F2F2}
.dinero .k-celda{padding:3.75pt 6pt}
.dinero td:first-child{width:63.6%}
.dinero td:last-child,.dinero td:last-child .k-celda{text-align:right}
.dinero tr:first-child td{background:#E6E6E6}
.dinero tr:last-child td{background:#F2F2F2}
.recuadro{background:#F2F2F2;border:.5pt solid #595959;padding:5.5pt 8.5pt;break-inside:avoid}
.k-recuadro{font-size:9.5pt;line-height:1.14;padding:1.75pt 0}
.k-recuadro:first-child{font-size:10pt;text-align:left;padding:0 0 4.5pt}
.k-firma{text-align:left;padding-top:19pt;break-inside:avoid;break-before:avoid}
.linea{display:block;width:3in;border-top:.75pt solid;margin:30pt 0 5pt}
.linea+br{display:none}
.casilla{display:inline-block;box-sizing:border-box;width:9pt;height:9pt;border:.75pt solid;font-size:7pt;line-height:7.5pt;text-align:center;vertical-align:-1pt}
.pendiente{background:#FFF3B0}
.marca{position:fixed;top:4.59in;left:3.306in;transform:translate(-50%,-50%) rotate(-50deg);white-space:nowrap;font-size:24pt;font-weight:700;color:rgba(192,0,0,.13)}`;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Una sola definición del pie para el PDF y para la prueba de fidelidad.
const lineaPie = (pie: string, numero: string, iniciales: string, pagina: string, total: string) =>
  `<span>${pie}  ·  N° ${numero}  ·  Iniciales: ${iniciales}</span><span>Página ${pagina} de ${total}</span>`;

/** El pie tal como lo lee la prueba de fidelidad: ▢ en número, iniciales y páginas. */
export function pieTexto(pie: string, _modo: 'fidelidad'): string {
  return lineaPie(pie, '▢', '▢', '▢', '▢')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface LogoPdf {
  mime: string;
  base64: string;
}

// Las plantillas de cabecera y pie viven aparte del documento: traen su propio
// @font-face y tamaño (Chromium no les hereda el CSS del cuerpo). Chromium les
// mete ~15pt de relleno propio arriba/abajo; se anula para que las perillas
// CABECERA_DESDE_ARRIBA / PIE_HASTA_ABAJO midan desde el borde del papel.
const RESET_PLANTILLA = 'html,body,#header,#footer{margin:0!important;padding:0!important}';

function cabecera(logo: LogoPdf | null): string {
  const inmobiliaria = logo
    ? `<img src="data:${logo.mime};base64,${logo.base64}" style="max-height:30pt;max-width:2.8in">`
    : '';
  return (
    `<style>${RESET_PLANTILLA}${CARAS[1].css}</style>` +
    `<div style="box-sizing:border-box;width:100%;padding:${CABECERA_DESDE_ARRIBA} ${MARGENES.right} 0 ${MARGENES.left};font-family:Gelasio;font-size:7.5pt">` +
    `<div style="display:flex;justify-content:space-between;align-items:center;height:30pt;padding:3pt 0 6pt;border-bottom:.75pt solid #BFBFBF">` +
    `<div>${inmobiliaria}</div>` +
    `<div style="display:flex;align-items:center;gap:4pt;font-weight:700;font-size:14pt;color:#111827">` +
    `<img src="${LOGO_COFIANZA}" style="height:17pt">cofianza</div>` +
    `</div></div>`
  );
}

function piePagina(pie: string, numero: string): string {
  return (
    `<style>${RESET_PLANTILLA}${CARAS[0].css}.ini{display:inline-block;width:22mm;border-bottom:.5pt solid #595959}</style>` +
    `<div style="box-sizing:border-box;width:100%;padding:0 ${MARGENES.right} ${PIE_HASTA_ABAJO} ${MARGENES.left};font-family:Gelasio;font-size:7.5pt;color:#595959">` +
    `<div style="display:flex;justify-content:space-between;padding-top:3pt;border-top:.75pt solid #BFBFBF;white-space:pre">` +
    lineaPie(
      esc(pie),
      esc(numero),
      '<span class="ini"></span>',
      '<span class="pageNumber"></span>',
      '<span class="totalPages"></span>',
    ) +
    `</div></div>`
  );
}

/**
 * PDF del contrato: `html` es la salida de `renderizar` (ya escapada).
 * `borrador` agrega la marca de agua diagonal en todas las páginas.
 * Lanza FUENTE_NO_CARGADA (500) si alguna cara de Gelasio no carga.
 */
export async function pdfContrato(
  html: string,
  o: { pie: string; numero: string; logo: LogoPdf | null; borrador: boolean },
): Promise<Buffer> {
  const marca = o.borrador ? '<div class="marca">BORRADOR — NO VÁLIDO PARA FIRMA</div>' : '';
  // Gelasio no trae ⟦ ⟧ (la marca ⟦PENDIENTE: x⟧ del modo revisión): Chromium
  // caería a una fuente del sistema, o a un cuadro vacío en el servidor. En el
  // PDF van como [ ]; el modo final nunca llega aquí con una marca.
  const cuerpo = html.replace(/⟦/g, '[').replace(/⟧/g, ']');
  return renderHtmlToPdf(
    `<!DOCTYPE html><html lang="es-CO"><head><meta charset="utf-8"><style>${CSS}</style></head>` +
      `<body>${marca}${cuerpo}</body></html>`,
    {
      margin: MARGENES,
      headerTemplate: cabecera(o.logo),
      footerTemplate: piePagina(o.pie, o.numero),
      fuentes: CARAS.map((c) => c.prueba),
    },
  );
}
