import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminUsers } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { AuthError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../admin/passwords.js';
import { findRecoveryMatch, verifyTotpOnce } from '../admin/totp.js';
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
  getLoginFailures,
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

    // CSRF check first (cookie may be absent first time; in that case the
    // client should hit /csrf before login). Requests that fail here never
    // touch the failure counters — they can't be used to lock an account.
    const csrfHeader = req.headers[csrfHeaderName];
    const csrfCookie = req.cookies?.[csrfCookieName];
    if (
      typeof csrfHeader !== 'string' ||
      typeof csrfCookie !== 'string' ||
      csrfHeader !== csrfCookie ||
      !verifyCsrfToken(csrfHeader)
    ) {
      throw new AuthError('bad_csrf', 403);
    }

    // Soft counter (per email) drives a progressive delay; the hard lock is
    // per email + IP so knowing an admin's email is not enough to lock them
    // out from their own network. See src/admin/rateLimit.ts.
    const fails = await getLoginFailures(body.email, req.ip);
    if (fails.hard >= LOGIN_HARD_LOCK) {
      logger.warn({ email: body.email, ip: req.ip, fails: fails.hard }, 'login hard-locked');
      throw new AuthError('locked');
    }
    await applyLoginBackoff(fails.soft);

    const fail = async (reason: string): Promise<never> => {
      const counts = await bumpLoginFailure(body.email, req.ip);
      logger.warn(
        { email: body.email, ip: req.ip, reason, fails: counts, latencyMs: Date.now() - start },
        'login failed',
      );
      throw new AuthError(reason);
    };

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
      return fail('bad_credentials');
    }

    // MFA enforcement
    if (user.totpEnabled) {
      if (body.recoveryCode) {
        const idx = findRecoveryMatch(user.recoveryHashes, body.recoveryCode);
        if (idx < 0) return fail('bad_mfa');
        // Consume the code atomically: remove it only if it is still present,
        // so two concurrent logins with the same code cannot both succeed.
        const consumedHash = user.recoveryHashes[idx]!;
        const consumed = await db.execute(sql`
          UPDATE ${adminUsers}
          SET recovery_hashes = array_remove(recovery_hashes, ${consumedHash})
          WHERE id = ${user.id} AND ${consumedHash} = ANY(recovery_hashes)
          RETURNING id
        `);
        if (consumed.length === 0) return fail('bad_mfa');
      } else if (body.totpCode) {
        if (!user.totpSecretCt || !user.totpSecretIv || !user.totpSecretTag) {
          throw new AuthError('totp_state_corrupt');
        }
        const secret = openUtf8(
          { ct: user.totpSecretCt, iv: user.totpSecretIv, tag: user.totpSecretTag },
          `admin_totp:${user.id}`,
        );
        const step = verifyTotpOnce(secret, body.totpCode, user.totpLastStep ?? null);
        if (step === null) return fail('bad_mfa');
        // Persist the accepted step atomically: the conditional UPDATE makes
        // two concurrent logins with the same code race for one row — the
        // loser sees no row and is rejected, so a code is never used twice.
        const claimed = await db
          .update(adminUsers)
          .set({ totpLastStep: step })
          .where(
            and(
              eq(adminUsers.id, user.id),
              or(isNull(adminUsers.totpLastStep), lt(adminUsers.totpLastStep, step)),
            ),
          )
          .returning({ id: adminUsers.id });
        if (claimed.length === 0) return fail('bad_mfa');
      } else {
        // Tell the client to ask for MFA
        return reply.code(202).send({ needsMfa: true });
      }
    }

    await resetLoginFailures(body.email, req.ip);
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

  app.get(`${prefix}/me`, async (req, reply) => {
    if (!req.adminUser) return reply.code(401).send({ error: 'unauthenticated' });
    const [row] = await db
      .select({ totpEnabled: adminUsers.totpEnabled })
      .from(adminUsers)
      .where(eq(adminUsers.id, req.adminUser.id))
      .limit(1);
    return reply.send({
      id: req.adminUser.id.toString(),
      email: req.adminUser.email,
      role: req.adminUser.role,
      scopedHubId: req.adminUser.scopedHubId?.toString() ?? null,
      totpEnabled: row?.totpEnabled ?? false,
    });
  });
}

/**
 * Used by the admin:create CLI. Not wired into an HTTP route.
 *
 * Refuses to run once any superadmin exists — bootstrap is a one-shot for
 * an empty install. Additional admins are invited from the UI (audited,
 * invite-token flow), never minted from a shell.
 */
export async function bootstrapSuperadmin(
  email: string,
  password: string,
): Promise<{ id: bigint; email: string }> {
  const [existing] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.role, 'superadmin'))
    .limit(1);
  if (existing) {
    throw new Error(
      'a superadmin already exists — invite further admins from the admin UI (Users page)',
    );
  }
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
