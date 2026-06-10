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

      logger.warn(
        { context, attempt, maxAttempts: opts.maxAttempts, delay, error: lastError.message },
        'Provider operation failed, retrying',
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
