import { setTimeout as delay } from 'node:timers/promises';
import { ExternalServiceError } from './errors.js';
import { logger } from './logger.js';
import {
  externalApiCalls,
  externalApiDuration,
  externalApiRetries,
} from '../metrics/index.js';

export interface RetryOpts {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Caller-provided check whether a given error should be retried. */
  retryable?: (err: unknown) => boolean;
}

const defaultRetryable = (err: unknown): boolean => {
  if (err instanceof ExternalServiceError) {
    const s = err.upstreamStatus ?? 0;
    return s === 0 || s === 408 || s === 429 || s >= 500;
  }
  if (err instanceof Error) {
    // network-class errors
    const code = (err as NodeJS.ErrnoException).code ?? '';
    return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR/.test(code) ||
      /timeout|network|fetch failed/i.test(err.message);
  }
  return false;
};

export async function callWithRetry<T>(
  target: 'hubspot' | 'phobs',
  op: string,
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 8000;
  const retryable = opts.retryable ?? defaultRetryable;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const result = await fn();
      const latencyMs = Date.now() - start;
      externalApiDuration.labels(target, op).observe(latencyMs / 1000);
      externalApiCalls.labels(target, op, '2xx').inc();
      if (attempt > 1) {
        logger.info({ target, op, attempt, latencyMs }, 'retry succeeded');
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      externalApiDuration.labels(target, op).observe(latencyMs / 1000);
      const statusClass = classifyStatus(err);
      externalApiCalls.labels(target, op, statusClass).inc();
      lastErr = err;
      if (attempt === maxAttempts || !retryable(err)) {
        throw err;
      }
      externalApiRetries.labels(target, op, statusClass).inc();
      const jitter = Math.floor(Math.random() * baseDelay);
      const wait = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1)) + jitter;
      logger.warn(
        { target, op, attempt, waitMs: wait, err: { name: (err as Error).name, message: (err as Error).message } },
        'retrying after error',
      );
      await delay(wait);
    }
  }
  throw lastErr;
}

function classifyStatus(err: unknown): string {
  if (err instanceof ExternalServiceError && typeof err.upstreamStatus === 'number') {
    const s = err.upstreamStatus;
    if (s >= 500) return '5xx';
    if (s === 429) return '429';
    if (s >= 400) return '4xx';
  }
  return 'network';
}
