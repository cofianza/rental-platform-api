// ============================================================
// Retry with exponential backoff
// ============================================================

import { logger } from '@/lib/logger';

interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  /**
   * Si devuelve false para un error, NO se reintenta (se propaga de una).
   * Útil cuando el reintento puede duplicar efectos facturables: un timeout
   * local no implica que el proveedor no haya procesado (y cobrado) la consulta.
   */
  shouldRetry?: (error: unknown) => boolean;
  /**
   * Presupuesto TOTAL de la operacion, en ms, contado desde la primera
   * llamada. Politica de Evaluacion y Score V4.1 seccion 14: la decision
   * automatica tiene un SLA de 40 s. Antes de dormir para reintentar se
   * comprueba si el siguiente intento cabe dentro del presupuesto; si no
   * cabe, se corta y se propaga el ultimo error. Sin esto, tres intentos con
   * backoff pueden dejar al solicitante esperando minutos.
   */
  deadlineMs?: number;
  /**
   * Coste estimado de UN intento (ms). Se suma al delay para decidir si el
   * reintento cabe en `deadlineMs`. Para DataCredito son DOS llamadas HTTP
   * por intento (token + consulta), asi que vale el doble que para TransUnion.
   */
  attemptBudgetMs?: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  backoffFactor: 2,
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  context: string,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const startedAt = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === opts.maxAttempts) break;
      if (opts.shouldRetry && !opts.shouldRetry(error)) {
        logger.warn({ context, error: lastError.message }, 'Provider operation failed — retry suppressed by shouldRetry');
        break;
      }

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(opts.backoffFactor, attempt - 1),
        opts.maxDelayMs,
      );

      if (opts.deadlineMs !== undefined) {
        const elapsed = Date.now() - startedAt;
        const costeSiguiente = delay + (opts.attemptBudgetMs ?? 0);
        if (elapsed + costeSiguiente > opts.deadlineMs) {
          logger.warn(
            { context, attempt, elapsed, delay, deadlineMs: opts.deadlineMs, error: lastError.message },
            'Provider operation failed — retry suppressed by deadline (SLA)',
          );
          break;
        }
      }

      logger.warn(
        { context, attempt, maxAttempts: opts.maxAttempts, delay, error: lastError.message },
        'Provider operation failed, retrying',
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
