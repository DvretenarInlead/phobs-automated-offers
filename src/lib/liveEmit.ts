import { makeRedis } from '../queue/index.js';
import type { Redis } from 'ioredis';
import { logger } from './logger.js';

export type LiveChannel = 'webhooks' | 'jobs' | 'ext' | 'filter';

export interface LiveEvent {
  ts: number;
  type: string;
  hubId?: string;
  dealId?: string;
  jobId?: string;
  data?: Record<string, unknown>;
}

let publisher: Redis | null = null;
function pub(): Redis {
  if (!publisher) publisher = makeRedis();
  return publisher;
}

/**
 * Publishes a live event to Redis. Best-effort — failures never break the
 * caller. The canonical record always lives in DB (audit_log, job_steps).
 */
export function liveEmit(channel: LiveChannel, hubId: bigint | string, event: LiveEvent): void {
  const key = `live:${channel}:${typeof hubId === 'bigint' ? hubId.toString() : hubId}`;
  pub()
    .publish(key, JSON.stringify(event))
    .catch((err: unknown) => {
      logger.warn({ err, key }, 'liveEmit publish failed');
    });
}

/** Channel name builder used by SSE subscribers. */
export function liveChannelKey(channel: LiveChannel, hubId: bigint | string): string {
  return `live:${channel}:${typeof hubId === 'bigint' ? hubId.toString() : hubId}`;
}
