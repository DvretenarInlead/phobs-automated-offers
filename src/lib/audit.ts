import { db } from '../db/client.js';
import { auditLog, jobSteps } from '../db/schema.js';
import { logger } from './logger.js';

export interface AuditEntry {
  hubId: bigint;
  dealId?: bigint | null;
  requestId?: string;
  kind: string;
  status: 'ok' | 'error' | 'skipped';
  request?: unknown;
  response?: unknown;
  latencyMs?: number;
  error?: string;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      hubId: entry.hubId,
      dealId: entry.dealId ?? null,
      requestId: entry.requestId ?? null,
      kind: entry.kind,
      status: entry.status,
      request: entry.request ?? null,
      response: entry.response ?? null,
      latencyMs: entry.latencyMs ?? null,
      error: entry.error ?? null,
    });
  } catch (err) {
    logger.warn({ err, kind: entry.kind }, 'audit log write failed');
  }
}

export interface JobStepRow {
  jobId: string;
  hubId: bigint;
  dealId?: bigint | null;
  step: string;
  stepIndex: number;
  status: 'ok' | 'skipped' | 'error' | 'retrying';
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export async function writeJobStep(row: JobStepRow): Promise<void> {
  try {
    await db.insert(jobSteps).values({
      jobId: row.jobId,
      hubId: row.hubId,
      dealId: row.dealId ?? null,
      step: row.step,
      stepIndex: row.stepIndex,
      status: row.status,
      input: row.input ?? null,
      output: row.output ?? null,
      error: row.error ?? null,
      durationMs: row.durationMs ?? null,
    });
  } catch (err) {
    logger.warn({ err, step: row.step }, 'job step write failed');
  }
}
