import { purgeExpiredSessions } from '../../admin/sessions.js';
import { purgeIdempotencyKeys } from '../../lib/idempotency.js';
import { logger } from '../../lib/logger.js';

/** Daily housekeeping. Each step is independent; one failing doesn't block the rest. */
export async function maintenanceJob(): Promise<{ sessions: number; idempotencyKeys: number }> {
  let sessions = 0;
  let idempotencyKeys = 0;
  try {
    sessions = await purgeExpiredSessions();
  } catch (err) {
    logger.warn({ err }, 'maintenance: purgeExpiredSessions failed');
  }
  try {
    idempotencyKeys = await purgeIdempotencyKeys(7);
  } catch (err) {
    logger.warn({ err }, 'maintenance: purgeIdempotencyKeys failed');
  }
  logger.info({ sessions, idempotencyKeys }, 'maintenance complete');
  return { sessions, idempotencyKeys };
}
