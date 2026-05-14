import { Queue, QueueEvents, Worker } from 'bullmq';
import type { JobsOptions, Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';

const config = loadConfig();

export const QUEUE_NAME = 'phobs-offers';

export function makeRedis(): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
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
  removeOnFail: false,
};

export interface ProcessDealPayload {
  hubId: string; // bigints serialised as strings in BullMQ
  source: 'webhook' | 'extension' | 'manual';
  requestId: string;
  rawPayload: unknown;
}

export async function enqueueProcessDeal(
  payload: ProcessDealPayload,
  opts: JobsOptions = {},
): Promise<string> {
  const job = await getQueue().add('processDeal', payload, { ...defaultJobOpts, ...opts });
  if (!job.id) throw new Error('queue: enqueue returned no job id');
  return job.id;
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

