import { makeWorker } from './queue/index.js';
import { processDealJob } from './queue/jobs/processDeal.js';
import { logger } from './lib/logger.js';

const worker = makeWorker(async (job) => {
  logger.info(
    { jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 },
    'job received',
  );
  if (job.name === 'processDeal') {
    return processDealJob(job as Parameters<typeof processDealJob>[0]);
  }
  throw new Error(`unknown job: ${job.name}`);
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await worker.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info('worker started');
