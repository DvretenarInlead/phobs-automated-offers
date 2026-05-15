import { db } from '../db/client.js';
import { adminAudit } from '../db/schema.js';
import { logger } from '../lib/logger.js';

export interface AdminAuditEntry {
  adminUserId: bigint;
  action: string;
  target?: string;
  ip?: string;
  before?: unknown;
  after?: unknown;
}

export async function writeAdminAudit(entry: AdminAuditEntry): Promise<void> {
  try {
    await db.insert(adminAudit).values({
      adminUserId: entry.adminUserId,
      action: entry.action,
      target: entry.target ?? null,
      ip: entry.ip ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  } catch (err) {
    logger.warn({ err, action: entry.action }, 'admin audit write failed');
  }
}
