import './lib/tracing.js';
import { makeWorker, scheduleDailyRollup } from './queue/index.js';
import { processDealJob } from './queue/jobs/processDeal.js';
import { rollupUsageJob } from './queue/jobs/rollupUsage.js';
import { logger } from './lib/logger.js';

const worker = makeWorker(async (job) => {
  logger.info(
    { jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 },
    'job received',
  );
  switch (job.name) {
    case 'processDeal':
      return processDealJob(job as Parameters<typeof processDealJob>[0]);
    case 'rollupUsage':
      return rollupUsageJob(job);
    default:
      throw new Error(`unknown job: ${job.name}`);
  }
});

// Worker-level errors (Redis stalls, connection resets, malformed job data)
// arrive asynchronously and would otherwise become unhandled rejections.
worker.on('error', (err) => {
  logger.error({ err }, 'BullMQ worker error');
});

// Ensure the daily rollup is scheduled. Safe to call repeatedly.
scheduleDailyRollup().catch((err: unknown) => {
  logger.warn({ err }, 'failed to schedule daily rollup');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  try {
    await worker.close();
  } catch (err) {
    logger.error({ err }, 'worker close failed');
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Never let an unhandled rejection quietly poison the process.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — exiting');
  // Uncaught exceptions leave the process in an unknown state; let the
  // orchestrator restart us cleanly.
  process.exit(1);
});

logger.info('worker started');
