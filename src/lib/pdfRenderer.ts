/**
 * Renderiza HTML a PDF usando Chromium headless.
 *
 * Usa el paquete `puppeteer` completo (no `puppeteer-core`): trae su
 * propio Chromium con todas las libs Linux necesarias, así funciona
 * en cualquier entorno (local Windows/macOS/Linux, Railway, Render).
 * Trade-off: ~170MB de binario en el bundle, pero es lo único que
 * funciona confiablemente — `@sparticuz/chromium` está optimizado solo
 * para AWS Lambda y rompe en imágenes Linux generales con exit 127.
 *
 * Una sola instancia de browser por proceso — se reutiliza entre
 * generaciones para evitar el costo de arranque (~1-2s en frío).
 */

import type { Browser } from 'puppeteer';
import puppeteer from 'puppeteer';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

/**
 * Opciones del PDF con cabecera/pie propios (contratos V3). Sin ellas el
 * render es el legacy: márgenes en cero y el HTML manda con su `@page`.
 * Márgenes en pulgadas ('0.986in'): Chromium rechaza 'pt' ("Failed to
 * parse parameter value"). `fuentes` son shorthands CSS ('bold 10pt Gelasio')
 * que deben cargar antes de imprimir; si una no carga el PDF saldría con la
 * fuente de respaldo del sistema, así que se aborta.
 */
export interface OpcionesPdf {
  margin: { top: string; right: string; bottom: string; left: string };
  headerTemplate: string;
  footerTemplate: string;
  fuentes: string[];
}

let cachedBrowser: Browser | null = null;
let inflightLaunch: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser?.connected) return cachedBrowser;
  if (inflightLaunch) return inflightLaunch;

  inflightLaunch = (async () => {
    const startLaunch = Date.now();
    logger.info('PDF renderer: lanzando Chromium');

    // Args necesarios en entornos containerizados (Railway, Docker, etc.)
    // donde no hay /dev/shm o tiene poca capacidad.
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ];

    const browser = await puppeteer.launch({
      headless: true,
      args,
      // executablePath omitido: puppeteer usa el Chromium que descargó
      // automáticamente en la instalación.
    });

    logger.info({ ms: Date.now() - startLaunch }, 'PDF renderer: Chromium lanzado');

    browser.on('disconnected', () => {
      logger.warn('PDF renderer: browser desconectado, se relanzará en la próxima request');
      cachedBrowser = null;
    });

    cachedBrowser = browser;
    return browser;
  })();

  try {
    return await inflightLaunch;
  } finally {
    inflightLaunch = null;
  }
}

/**
 * Renderiza el HTML a un PDF tamaño Letter (estándar para Colombia).
 * El HTML debe traer su propio `<style>` con `@page { size: Letter; ... }`
 * para controlar márgenes; el renderer respeta esos estilos.
 */
export async function renderHtmlToPdf(html: string, o?: OpcionesPdf): Promise<Buffer> {
  const startTotal = Date.now();
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
      'PDF renderer: fallo al lanzar browser',
    );
    throw err;
  }

  const page = await browser.newPage();
  try {
    const startContent = Date.now();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    logger.info({ ms: Date.now() - startContent }, 'PDF renderer: setContent listo');

    // Expresión en string (no función) porque el tsconfig no trae la lib DOM.
    // Un data URI corrupto rechaza la promesa; una familia sin @font-face da 0.
    for (const f of o?.fuentes ?? []) {
      const n = await page
        .evaluate(`document.fonts.load(${JSON.stringify(f)}).then(r => r.length)`)
        .catch(() => 0);
      if (!n) {
        throw new AppError(500, 'FUENTE_NO_CARGADA', `No cargó la fuente ${f}`, { fuente: f });
      }
    }

    const startPdf = Date.now();
    const pdf = await page.pdf(
      o
        ? {
            format: 'Letter',
            printBackground: true,
            preferCSSPageSize: false,
            displayHeaderFooter: true,
            headerTemplate: o.headerTemplate,
            footerTemplate: o.footerTemplate,
            margin: o.margin,
          }
        : {
            format: 'Letter',
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
          },
    );
    logger.info(
      { ms: Date.now() - startPdf, totalMs: Date.now() - startTotal, bytes: pdf.length },
      'PDF renderer: PDF generado',
    );
    return Buffer.from(pdf);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
        totalMs: Date.now() - startTotal,
      },
      'PDF renderer: fallo al generar PDF',
    );
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}
