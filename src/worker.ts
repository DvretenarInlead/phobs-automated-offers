import { makeWorker } from './queue/index.js';
import { logger } from './lib/logger.js';

const worker = makeWorker((job) => {
  logger.info({ jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 }, 'job received');
  // Pipeline implementation lands in src/queue/jobs/processDeal.ts next.
  // For now we acknowledge so the queue plumbing can be exercised end-to-end.
  return Promise.resolve({ acknowledged: true });
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await worker.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info('worker started');
