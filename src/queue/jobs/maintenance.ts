import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  adminAudit,
  auditLog,
  jobSteps,
  tenantConfig,
  tenantConfigHistory,
} from '../../db/schema.js';
import { loadConfig } from '../../config.js';
import { purgeExpiredSessions } from '../../admin/sessions.js';
import { purgeIdempotencyKeys } from '../../lib/idempotency.js';
import { seal } from '../../crypto/tokenVault.js';
import { accessCodeAad } from '../../tenancy/config.js';
import { logger } from '../../lib/logger.js';

const config = loadConfig();

export interface MaintenanceResult {
  sessions: number;
  idempotencyKeys: number;
  jobSteps: number;
  auditLog: number;
  adminAudit: number;
  tenantConfigHistory: number;
  accessCodesSealed: number;
}

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

async function step(name: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err, step: name }, 'maintenance step failed');
    return 0;
  }
}

/**
 * Daily housekeeping. Each step is independent; one failing doesn't block
 * the rest. Retention windows come from RETENTION_* env (see .env.example)
 * — this is the enforcement point for the data-retention policy.
 */
export async function maintenanceJob(): Promise<MaintenanceResult> {
  const result: MaintenanceResult = {
    sessions: await step('sessions', purgeExpiredSessions),
    idempotencyKeys: await step('idempotencyKeys', () => purgeIdempotencyKeys(7)),
    jobSteps: await step('jobSteps', async () => {
      const r = await db
        .delete(jobSteps)
        .where(lt(jobSteps.createdAt, cutoff(config.RETENTION_JOB_STEPS_DAYS)));
      return Number(r.count ?? 0);
    }),
    auditLog: await step('auditLog', async () => {
      const r = await db
        .delete(auditLog)
        .where(lt(auditLog.createdAt, cutoff(config.RETENTION_AUDIT_LOG_DAYS)));
      return Number(r.count ?? 0);
    }),
    adminAudit: await step('adminAudit', async () => {
      const r = await db
        .delete(adminAudit)
        .where(lt(adminAudit.createdAt, cutoff(config.RETENTION_ADMIN_AUDIT_DAYS)));
      return Number(r.count ?? 0);
    }),
    tenantConfigHistory: await step('tenantConfigHistory', async () => {
      const r = await db
        .delete(tenantConfigHistory)
        .where(lt(tenantConfigHistory.changedAt, cutoff(config.RETENTION_ADMIN_AUDIT_DAYS)));
      return Number(r.count ?? 0);
    }),
    // One-time data migration: move any legacy plaintext loyalty access code
    // into the vault and clear the plaintext column. Idempotent.
    accessCodesSealed: await step('accessCodesSealed', async () => {
      const rows = await db
        .select({ hubId: tenantConfig.hubId, accessCode: tenantConfig.accessCode })
        .from(tenantConfig)
        .where(and(isNotNull(tenantConfig.accessCode), isNull(tenantConfig.accessCodeCt)));
      let n = 0;
      for (const row of rows) {
        if (!row.accessCode) continue;
        const s = seal(row.accessCode, accessCodeAad(row.hubId));
        await db
          .update(tenantConfig)
          .set({ accessCodeCt: s.ct, accessCodeIv: s.iv, accessCodeTag: s.tag, accessCode: null })
          .where(eq(tenantConfig.hubId, row.hubId));
        n++;
      }
      return n;
    }),
  };
  logger.info(result, 'maintenance complete');
  return result;
}
