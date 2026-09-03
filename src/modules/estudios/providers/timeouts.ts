// ============================================================
// Presupuesto de tiempo de las llamadas a los buros.
//
// Politica de Evaluacion y Score V4.1, seccion 14 (literal): "El tiempo de
// espera maximo por respuesta de cada API antes de considerar falla es de 8
// segundos. Si la API no responde en ese tiempo, el sistema debe ejecutar el
// protocolo de la tabla anterior sin esperar mas. El timeout debe configurarse
// en la capa de integracion, no en el motor de scoring."
//
// Vive aparte de los dos providers porque el timeout NO puede ser una sola
// variable global compartida: mitigar un proveedor lento con
// BURO_REQUEST_TIMEOUT_MS rompia el cumplimiento del otro y, de paso,
// desactivaba todos los reintentos (si un intento no cabe en el SLA, el guard
// de deadline lo suprime siempre).
// ============================================================

import { env } from '@/config/env';
import { logger } from '@/lib/logger';

/**
 * Timeout que se aplica mientras la URL configurada apunte al ambiente de
 * PRUEBAS (UAT) de un buro.
 *
 * Los 8 s de la politica describen un servicio productivo. El UAT de TransUnion
 * tarda 35-50 s bajo carga sin estar caido (medido), asi que aplicarle el corte
 * de la politica no mide "falla del buro": convierte el 100 % de los estudios
 * en 'fallido' — y ademas sin reintento, porque PROVIDER_TIMEOUT no es
 * reintentable (el abort es local: el buro pudo procesar y facturar).
 */
const TIMEOUT_AMBIENTE_PRUEBAS_MS = 45_000;

/** Las URLs de pruebas de ambos buros llevan 'uat' en el host. */
function esAmbienteDePruebas(url: string): boolean {
  return /uat/i.test(url);
}

function resolverTimeout(args: {
  proveedor: string;
  /** Valor explicito de env, si el operador lo fijo. Manda sobre todo lo demas. */
  explicito?: number;
  url: string;
  /** Llamadas HTTP que puede emitir UN intento (peor caso). */
  llamadasPorIntento: number;
  /** true = el default se relaja mientras la URL sea de UAT. */
  relajarEnPruebas: boolean;
}): number {
  const { proveedor, explicito, url, llamadasPorIntento, relajarEnPruebas } = args;
  const enPruebas = relajarEnPruebas && esAmbienteDePruebas(url);
  const timeout = explicito ?? (enPruebas ? TIMEOUT_AMBIENTE_PRUEBAS_MS : env.BURO_REQUEST_TIMEOUT_MS);

  if (timeout > env.BURO_REQUEST_TIMEOUT_MS) {
    logger.warn(
      { proveedor, timeout, politicaMs: env.BURO_REQUEST_TIMEOUT_MS, url, explicito: explicito !== undefined },
      'Timeout de buro POR ENCIMA del limite de la politica (seccion 14). Es lo correcto mientras la URL apunte al ambiente de pruebas; al pasar al endpoint productivo tiene que volver a los 8 s',
    );
  }

  // Un intento que no cabe en el SLA deja los reintentos apagados: el guard de
  // `deadlineMs` en withRetry nunca autorizara el segundo. No es un error (mas
  // vale fallar dentro del SLA que responder tarde), pero tiene que verse.
  const presupuestoIntento = timeout * llamadasPorIntento;
  if (presupuestoIntento > env.BURO_SLA_TOTAL_MS) {
    logger.warn(
      { proveedor, timeout, llamadasPorIntento, presupuestoIntento, slaMs: env.BURO_SLA_TOTAL_MS },
      'Un solo intento no cabe en el SLA de decision: los reintentos quedan desactivados para este proveedor',
    );
  }

  return timeout;
}

/**
 * TransUnion: UNA llamada HTTP por intento.
 *
 * `relajarEnPruebas` activo: produccion sigue apuntando al host UAT
 * (TRANSUNION_API_URL por defecto es tucoapplicationserviceuat...), y el corte
 * de 8 s ahi deja el modulo de estudios inoperante. En cuanto se configure el
 * endpoint productivo, el default vuelve solo a los 8 s de la politica.
 * TRANSUNION_REQUEST_TIMEOUT_MS fuerza cualquier valor.
 */
export const TRANSUNION_TIMEOUT_MS = resolverTimeout({
  proveedor: 'transunion',
  explicito: env.TRANSUNION_REQUEST_TIMEOUT_MS,
  url: env.TRANSUNION_API_URL,
  llamadasPorIntento: 1,
  relajarEnPruebas: true,
});

/**
 * DataCredito: hasta CUATRO llamadas HTTP por intento en el peor caso
 * (token -> consulta -> token forzado -> consulta, cuando el servicio rechaza
 * el token).
 *
 * Sin relajacion por ambiente: aqui SI se cumple la politica por defecto (8 s).
 * La primera consulta productiva real (2026-09-02) respondio dentro de ese
 * margen; si algun dia hiciera falta, DATACREDITO_REQUEST_TIMEOUT_MS lo sube
 * sin tocar a TransUnion.
 */
export const DATACREDITO_TIMEOUT_MS = resolverTimeout({
  proveedor: 'datacredito',
  explicito: env.DATACREDITO_REQUEST_TIMEOUT_MS,
  url: env.DATACREDITO_API_URL,
  llamadasPorIntento: 4,
  relajarEnPruebas: false,
});
