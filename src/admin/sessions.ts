import { randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminSessions, adminUsers } from '../db/schema.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h absolute
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15m idle

export const SESSION_COOKIE_NAME = '__Host-sid';

export interface AdminUser {
  id: bigint;
  email: string;
  role: 'superadmin' | 'tenant_admin';
  scopedHubId: bigint | null;
  status: string;
}

export interface SessionRow {
  sid: string;
  adminUserId: bigint;
  expiresAt: Date;
  lastSeenAt: Date;
}

export async function createSession(
  adminUserId: bigint,
  ip: string,
  userAgent: string | undefined,
): Promise<SessionRow> {
  const sid = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(adminSessions).values({
    sid,
    adminUserId,
    ip,
    userAgent: userAgent ?? null,
    expiresAt,
    createdAt: now,
    lastSeenAt: now,
  });
  return { sid, adminUserId, expiresAt, lastSeenAt: now };
}

export async function findSession(sid: string): Promise<{
  session: SessionRow;
  user: AdminUser;
} | null> {
  const [row] = await db
    .select({
      session: adminSessions,
      user: adminUsers,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminUserId))
    .where(and(eq(adminSessions.sid, sid), gt(adminSessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;
  if (row.user.status !== 'active') return null;
  if (Date.now() - row.session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) {
    await revokeSession(sid);
    return null;
  }
  if (row.user.role !== 'superadmin' && row.user.role !== 'tenant_admin') return null;

  return {
    session: {
      sid: row.session.sid,
      adminUserId: row.session.adminUserId,
      expiresAt: row.session.expiresAt,
      lastSeenAt: row.session.lastSeenAt,
    },
    user: {
      id: row.user.id,
      email: row.user.email,
      role: row.user.role,
      scopedHubId: row.user.scopedHubId,
      status: row.user.status,
    },
  };
}

export async function touchSession(sid: string): Promise<void> {
  await db.update(adminSessions).set({ lastSeenAt: new Date() }).where(eq(adminSessions.sid, sid));
}

export async function revokeSession(sid: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.sid, sid));
}

export async function purgeExpiredSessions(): Promise<number> {
  const res = await db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
  return Number(res.count ?? 0);
}
