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
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
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

    const startPdf = Date.now();
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
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
