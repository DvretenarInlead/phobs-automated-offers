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

// Ensure the daily rollup is scheduled. Safe to call repeatedly.
scheduleDailyRollup().catch((err: unknown) => {
  logger.warn({ err }, 'failed to schedule daily rollup');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await worker.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info('worker started');
