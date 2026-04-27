/**
 * Renderiza HTML a PDF usando Chromium headless.
 *
 * En desarrollo (Windows/macOS) usa el Chrome del sistema vía
 * `executablePath` que detecta puppeteer-core. En producción (Railway,
 * Linux) usa @sparticuz/chromium — un binario empaquetado pensado para
 * entornos serverless/contenedores con tamaño optimizado.
 *
 * Una sola instancia de browser por proceso — se reutiliza entre
 * generaciones para evitar el costo de arranque (~1-2s en frío).
 */

import type { Browser } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';
import { logger } from '@/lib/logger';

let cachedBrowser: Browser | null = null;
let inflightLaunch: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser?.connected) return cachedBrowser;
  if (inflightLaunch) return inflightLaunch;

  inflightLaunch = (async () => {
    const isProduction = process.env.NODE_ENV === 'production';

    let executablePath: string;
    let args: string[];

    if (isProduction) {
      // En Railway/Linux: usar @sparticuz/chromium (Chromium empaquetado).
      // Import dinámico para que el require no se evalúe en dev.
      const { default: chromium } = await import('@sparticuz/chromium');
      executablePath = await chromium.executablePath();
      args = chromium.args;
    } else {
      // Dev: detectar Chrome local. Si no está, fallar con mensaje claro.
      const localPath = await detectLocalChrome();
      if (!localPath) {
        throw new Error(
          'Chrome no encontrado en el sistema. Instala Google Chrome o define PUPPETEER_EXECUTABLE_PATH.',
        );
      }
      executablePath = localPath;
      args = ['--no-sandbox', '--disable-setuid-sandbox'];
    }

    logger.info({ executablePath, isProduction }, 'PDF renderer: lanzando Chromium');
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args,
    });

    // Cuando el browser muere (p.ej. OOM), invalidamos el cache.
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

async function detectLocalChrome(): Promise<string | null> {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env) return env;
  // Paths típicos por OS — best-effort. Si nada existe, devolvemos null.
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  const fs = await import('node:fs/promises');
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Renderiza el HTML a un PDF tamaño Letter (estándar para Colombia).
 * El HTML debe traer su propio `<style>` con `@page { size: Letter; ... }`
 * para controlar márgenes; el renderer respeta esos estilos.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true, // respeta @page del CSS si está definido
      margin: { top: '0', right: '0', bottom: '0', left: '0' }, // dejamos al CSS
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
