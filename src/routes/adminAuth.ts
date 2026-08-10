import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminUsers } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { AuthError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../admin/passwords.js';
import { findRecoveryMatch, verifyTotp } from '../admin/totp.js';
import { openUtf8, seal } from '../crypto/tokenVault.js';
import {
  SESSION_COOKIE_NAME,
  createSession,
  findSession,
  revokeSession,
} from '../admin/sessions.js';
import {
  csrfCookieName,
  csrfHeaderName,
  issueCsrfToken,
  verifyCsrfToken,
} from '../admin/csrf.js';
import {
  LOGIN_HARD_LOCK,
  applyLoginBackoff,
  bumpLoginFailure,
  resetLoginFailures,
} from '../admin/rateLimit.js';
import { writeAdminAudit } from '../admin/audit.js';

const COOKIE_BASE = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
};

// CSRF cookie must be readable by the SPA (it echoes the value in the header).
const COOKIE_CSRF = {
  path: '/',
  httpOnly: false,
  secure: true,
  sameSite: 'strict' as const,
};

const loginSchema = z.object({
  email: z.string().email().toLowerCase().max(256),
  password: z.string().min(1).max(256),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().min(8).max(64).optional(),
});

// Per-route HTTP rate limits — keyed by req.ip after trustProxy honours the
// exact hop count (see src/config.ts:TRUST_PROXY_HOPS). These are the
// per-IP flood ceiling. Per-account (email) throttling is separate and lives
// in bumpLoginFailure + progressiveDelayMs.
const LOGIN_RL = { max: 20, timeWindow: '1 minute' };
const CSRF_RL = { max: 60, timeWindow: '1 minute' };
const INVITE_ACCEPT_RL = { max: 10, timeWindow: '1 minute' };

export const rateLimits = { LOGIN_RL, CSRF_RL, INVITE_ACCEPT_RL };

export function registerAdminAuthRoutes(app: FastifyInstance, prefix = '/api/admin'): void {
  app.get(
    `${prefix}/csrf`,
    { config: { rateLimit: CSRF_RL } },
    (_req, reply) => {
      const token = issueCsrfToken();
      void reply
        .setCookie(csrfCookieName, token, { ...COOKIE_CSRF, maxAge: 60 * 60 * 24 })
        .send({ csrfToken: token, headerName: csrfHeaderName });
    },
  );

  app.post(
    `${prefix}/login`,
    { config: { rateLimit: LOGIN_RL } },
    async (req, reply) => {
    const start = Date.now();
    const body = loginSchema.parse(req.body);

    // Per-account (email) failure counter — independent of req.ip so a shared
    // corporate NAT can't self-lock. `applyLoginBackoff` inserts a growing
    // delay after each failure to slow bots down without hard-locking real
    // users. Hard lock only kicks in at LOGIN_HARD_LOCK failures/hour.
    const failsSoFar = await bumpLoginFailure(body.email);
    if (failsSoFar > LOGIN_HARD_LOCK) {
      logger.warn({ email: body.email, ip: req.ip, fails: failsSoFar }, 'login hard-locked');
      throw new AuthError('locked');
    }
    await applyLoginBackoff(failsSoFar - 1);

    // CSRF check on login too (cookie may be absent first time; in that case
    // the client should hit /csrf before login)
    const csrfHeader = req.headers[csrfHeaderName];
    const csrfCookie = req.cookies?.[csrfCookieName];
    if (
      typeof csrfHeader !== 'string' ||
      typeof csrfCookie !== 'string' ||
      csrfHeader !== csrfCookie ||
      !verifyCsrfToken(csrfHeader)
    ) {
      throw new AuthError('bad_csrf');
    }

    const [user] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.email, body.email))
      .limit(1);

    // Compute a verify-shaped delay even if user is missing to mask presence.
    const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$YWFhYWFhYWFhYWFhYWFhYQ$0000000000000000000000000000000000000000000';
    const passwordOk = user
      ? await verifyPassword(user.passwordHash, body.password)
      : (await verifyPassword(dummyHash, body.password), false);

    if (!user || !passwordOk || user.status !== 'active') {
      logger.warn({ email: body.email, ip: req.ip, latencyMs: Date.now() - start }, 'login failed');
      throw new AuthError('bad_credentials');
    }

    // MFA enforcement
    if (user.totpEnabled) {
      if (body.recoveryCode) {
        const idx = findRecoveryMatch(user.recoveryHashes, body.recoveryCode);
        if (idx < 0) throw new AuthError('bad_mfa');
        // Consume the recovery code
        const remaining = user.recoveryHashes.slice();
        remaining.splice(idx, 1);
        await db
          .update(adminUsers)
          .set({ recoveryHashes: remaining })
          .where(eq(adminUsers.id, user.id));
      } else if (body.totpCode) {
        if (!user.totpSecretCt || !user.totpSecretIv || !user.totpSecretTag) {
          throw new AuthError('totp_state_corrupt');
        }
        const secret = openUtf8(
          { ct: user.totpSecretCt, iv: user.totpSecretIv, tag: user.totpSecretTag },
          `admin_totp:${user.id}`,
        );
        if (!verifyTotp(secret, body.totpCode)) throw new AuthError('bad_mfa');
      } else {
        // Tell the client to ask for MFA
        return reply.code(202).send({ needsMfa: true });
      }
    }

    await resetLoginFailures(body.email);
    await db
      .update(adminUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminUsers.id, user.id));

    const session = await createSession(user.id, req.ip, req.headers['user-agent']);
    const csrf = issueCsrfToken();

    await writeAdminAudit({
      adminUserId: user.id,
      action: 'login.success',
      ip: req.ip,
    });

    return reply
      .setCookie(SESSION_COOKIE_NAME, session.sid, {
        ...COOKIE_BASE,
        maxAge: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
      })
      .setCookie(csrfCookieName, csrf, { ...COOKIE_CSRF, maxAge: 60 * 60 * 24 })
      .send({
        ok: true,
        user: {
          id: user.id.toString(),
          email: user.email,
          role: user.role,
          scopedHubId: user.scopedHubId?.toString() ?? null,
        },
        csrfToken: csrf,
      });
  },
  );

  app.post(`${prefix}/logout`, async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE_NAME];
    if (sid) {
      const found = await findSession(sid);
      await revokeSession(sid);
      if (found) {
        await writeAdminAudit({
          adminUserId: found.user.id,
          action: 'logout',
          ip: req.ip,
        });
      }
    }
    // __Host- prefix requires the full attribute set on deletion in some UAs.
    return reply
      .clearCookie(SESSION_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
      })
      .clearCookie(csrfCookieName, {
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'strict',
      })
      .send({ ok: true });
  });

  app.get(`${prefix}/me`, (req, reply) => {
    if (!req.adminUser) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.send({
      id: req.adminUser.id.toString(),
      email: req.adminUser.email,
      role: req.adminUser.role,
      scopedHubId: req.adminUser.scopedHubId?.toString() ?? null,
    });
  });
}

/** Used by the admin:create CLI. Not wired into an HTTP route. */
export async function bootstrapSuperadmin(
  email: string,
  password: string,
): Promise<{ id: bigint; email: string }> {
  const pwHash = await hashPassword(password);
  const [inserted] = await db
    .insert(adminUsers)
    .values({
      email: email.toLowerCase(),
      passwordHash: pwHash,
      role: 'superadmin',
      status: 'active',
    })
    .returning({ id: adminUsers.id, email: adminUsers.email });
  if (!inserted) throw new Error('insert returned no row');
  await writeAdminAudit({
    adminUserId: inserted.id,
    action: 'admin.bootstrap',
  });
  // Re-encrypt seal of a marker (not strictly necessary; just exercises vault)
  void seal('bootstrap', `admin_bootstrap:${inserted.id}`);
  return inserted;
}
