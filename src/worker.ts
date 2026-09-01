import './lib/tracing.js';
import { UnrecoverableError } from 'bullmq';
import { makeWorker, scheduleDailyMaintenance, scheduleDailyRollup } from './queue/index.js';
import { processDealJob } from './queue/jobs/processDeal.js';
import { rollupUsageJob } from './queue/jobs/rollupUsage.js';
import { maintenanceJob } from './queue/jobs/maintenance.js';
import { isRetryable } from './lib/errors.js';
import { logger } from './lib/logger.js';

const worker = makeWorker(async (job) => {
  logger.info(
    { jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 },
    'job received',
  );
  try {
    switch (job.name) {
      case 'processDeal':
        return await processDealJob(job as Parameters<typeof processDealJob>[0]);
      case 'rollupUsage':
        return await rollupUsageJob(job);
      case 'maintenance':
        return await maintenanceJob();
      default:
        throw new UnrecoverableError(`unknown job: ${job.name}`);
    }
  } catch (err) {
    // Permanent failures (tenant missing/suspended, HubSpot 4xx, bad input)
    // go straight to the dead-letter set instead of burning 8 attempts and
    // re-running HubSpot writes each time.
    if (!isRetryable(err)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UnrecoverableError(message);
    }
    throw err;
  }
});

// Worker-level errors (Redis stalls, connection resets, malformed job data)
// arrive asynchronously and would otherwise become unhandled rejections.
worker.on('error', (err) => {
  logger.error({ err }, 'BullMQ worker error');
});

// Ensure the repeatable jobs are scheduled. Safe to call repeatedly.
scheduleDailyRollup().catch((err: unknown) => {
  logger.warn({ err }, 'failed to schedule daily rollup');
});
scheduleDailyMaintenance().catch((err: unknown) => {
  logger.warn({ err }, 'failed to schedule daily maintenance');
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
