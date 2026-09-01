import { Queue, QueueEvents, Worker } from 'bullmq';
import type { JobsOptions, Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';

const config = loadConfig();

export const QUEUE_NAME = 'phobs-offers';

export interface RedisOpts {
  /**
   * Fail commands immediately while Redis is unreachable instead of queueing
   * them. Use for request-path clients (rate limiter, login counters, SSE
   * slots) so an outage turns into fast 5xx responses rather than hung
   * requests piling up. Queue/worker clients keep the default (queue + retry).
   */
  failFast?: boolean;
}

export function makeRedis(opts: RedisOpts = {}): Redis {
  const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: opts.failFast ? 1 : null,
    enableReadyCheck: true,
    lazyConnect: false,
    enableOfflineQueue: !opts.failFast,
    commandTimeout: opts.failFast ? 2_000 : undefined,
  });
  // Connection errors are events; without a listener ioredis logs them as
  // "Unhandled error event" on stderr. Route them through pino instead.
  client.on('error', (err: Error) => {
    logger.warn({ err: { name: err.name, message: err.message } }, 'redis connection error');
  });
  return client;
}

let queueInstance: Queue | null = null;
export function getQueue(): Queue {
  if (!queueInstance) {
    queueInstance = new Queue(QUEUE_NAME, { connection: makeRedis() });
  }
  return queueInstance;
}

export const defaultJobOpts: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86_400, count: 1000 },
  // Keep the dead-letter set inspectable from the admin UI, but not forever:
  // raw webhook payloads live in job data.
  removeOnFail: { age: 30 * 86_400, count: 5000 },
};

export interface ProcessDealPayload {
  hubId: string; // bigints serialised as strings in BullMQ
  source: 'webhook' | 'extension' | 'manual';
  requestId: string;
  rawPayload: unknown;
  /**
   * Set by the worker as it creates HubSpot objects, so a retry after a
   * mid-pipeline failure resumes instead of creating a second set of
   * products / line items.
   */
  progress?: {
    /** sku → HubSpot product id */
    products?: Record<string, string>;
    /** `${productId}:${unitId}:${rateId}` → HubSpot line item id */
    lineItems?: Record<string, string>;
    quote?: { id: string; link: string | null };
  };
}

export async function enqueueProcessDeal(
  payload: ProcessDealPayload,
  opts: JobsOptions = {},
): Promise<string> {
  const job = await getQueue().add('processDeal', payload, { ...defaultJobOpts, ...opts });
  if (!job.id) throw new Error('queue: enqueue returned no job id');
  return job.id;
}

/**
 * Schedule the daily usage rollup once per day at 03:10 UTC. Idempotent — calling
 * this multiple times replaces the schedule (BullMQ dedupes by jobId).
 */
export async function scheduleDailyRollup(): Promise<void> {
  await getQueue().add(
    'rollupUsage',
    {},
    {
      repeat: { pattern: '10 3 * * *', tz: 'UTC' },
      jobId: 'rollupUsage-daily',
      removeOnComplete: { age: 7 * 86_400, count: 30 },
      removeOnFail: 30,
    },
  );
}

/**
 * Daily housekeeping at 03:40 UTC: expired admin sessions, idempotency keys
 * older than the dedupe window. Idempotent like the rollup.
 */
export async function scheduleDailyMaintenance(): Promise<void> {
  await getQueue().add(
    'maintenance',
    {},
    {
      repeat: { pattern: '40 3 * * *', tz: 'UTC' },
      jobId: 'maintenance-daily',
      removeOnComplete: { age: 7 * 86_400, count: 30 },
      removeOnFail: 30,
    },
  );
}

export function makeWorker(processor: Processor): Worker {
  const worker = new Worker(QUEUE_NAME, processor, {
    connection: makeRedis(),
    concurrency: 4,
  });
  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err: { name: err.name, message: err.message } },
      'job failed',
    );
  });
  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'job completed');
  });
  return worker;
}

export function makeQueueEvents(): QueueEvents {
  return new QueueEvents(QUEUE_NAME, { connection: makeRedis() });
}
