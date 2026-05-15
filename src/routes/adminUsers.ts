import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminUsers, tenants as tenantsTable } from '../db/schema.js';
import { requireRole } from '../admin/auth.js';
import { writeAdminAudit } from '../admin/audit.js';
import { hashPassword, passwordSchema, verifyPassword } from '../admin/passwords.js';
import { signInvite, verifyInvite } from '../admin/inviteTokens.js';
import { loadConfig } from '../config.js';
import {
  findRecoveryMatch,
  generateRecoveryCodes,
  generateTotp,
  verifyTotp,
} from '../admin/totp.js';
import { openUtf8, seal } from '../crypto/tokenVault.js';
import { AuthError, AppError } from '../lib/errors.js';

const config = loadConfig();
const PENDING_PASSWORD = '!pending!'; // hashed, never matches; sentinel only

const inviteSchema = z.object({
  email: z.string().email().toLowerCase().max(256),
  hubId: z.string().regex(/^\d+$/),
});

const acceptSchema = z.object({
  token: z.string().min(10).max(4096),
  password: passwordSchema,
});

const totpConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

const totpDisableSchema = z.object({
  password: z.string().min(1).max(256),
  code: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().min(8).max(64).optional(),
});

const changePasswordSchema = z.object({
  current: z.string().min(1).max(256),
  next: passwordSchema,
});

export function registerAdminUserRoutes(app: FastifyInstance, prefix = '/api/admin'): void {
  // --- Superadmin: invite a tenant_admin ----------------------------------
  app.post(
    `${prefix}/users/invite`,
    { preHandler: requireRole('superadmin', { allowSuperadmin: false }) },
    async (req, reply) => {
      const body = inviteSchema.parse(req.body);
      const hubId = BigInt(body.hubId);

      const [tenant] = await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.hubId, hubId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });

      // Insert pending user (status='pending'); the sentinel hash will never
      // verify until they accept the invite and set a real password.
      const pendingHash = await hashPassword(PENDING_PASSWORD);
      const [inserted] = await db
        .insert(adminUsers)
        .values({
          email: body.email,
          passwordHash: pendingHash,
          role: 'tenant_admin',
          scopedHubId: hubId,
          status: 'pending',
        })
        .returning({ id: adminUsers.id, email: adminUsers.email });
      if (!inserted) return reply.code(500).send({ error: 'insert_failed' });

      const token = signInvite({
        userId: inserted.id.toString(),
        email: inserted.email,
        iat: Date.now(),
      });
      const acceptUrl = `${config.PUBLIC_BASE_URL}/admin/accept-invite?token=${encodeURIComponent(
        token,
      )}`;

      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'user.invite',
        target: `admin_user_id=${inserted.id.toString()} hub_id=${body.hubId}`,
        ip: req.ip,
        after: { email: inserted.email, hubId: body.hubId },
      });

      // Email delivery is out of scope for v1 — we return the link so the
      // superadmin can send it via whatever channel they prefer.
      return reply.send({
        ok: true,
        userId: inserted.id.toString(),
        email: inserted.email,
        acceptUrl,
        expiresInDays: 7,
      });
    },
  );

  // --- Public: GET invite metadata (used by /admin/accept-invite UI) ------
  app.get(`${prefix}/users/invite/preview`, async (req, reply) => {
    const q = z.object({ token: z.string().min(1).max(4096) }).parse(req.query);
    const payload = verifyInvite(q.token);
    if (!payload) return reply.code(400).send({ error: 'invalid_or_expired' });
    return reply.send({ email: payload.email });
  });

  // --- Public: accept invite, set password --------------------------------
  app.post(`${prefix}/users/invite/accept`, async (req, reply) => {
    const body = acceptSchema.parse(req.body);
    const payload = verifyInvite(body.token);
    if (!payload) throw new AuthError('invalid_or_expired_invite');

    const userId = BigInt(payload.userId);
    const [user] = await db.select().from(adminUsers).where(eq(adminUsers.id, userId)).limit(1);
    if (!user) throw new AuthError('user_gone');
    if (user.status !== 'pending') throw new AuthError('invite_already_used');
    if (user.email !== payload.email) throw new AuthError('email_mismatch');

    const hash = await hashPassword(body.password);
    await db
      .update(adminUsers)
      .set({ passwordHash: hash, status: 'active' })
      .where(eq(adminUsers.id, userId));

    await writeAdminAudit({
      adminUserId: user.id,
      action: 'user.invite_accepted',
      ip: req.ip,
    });

    return reply.send({ ok: true, email: user.email });
  });

  // --- Self: start TOTP enrollment -----------------------------------------
  app.post(`${prefix}/totp/setup`, async (req, reply) => {
    const user = req.adminUser;
    if (!user) throw new AuthError('unauthenticated');
    const t = generateTotp(user.email);
    const sealed = seal(t.base32Secret, `admin_totp:${user.id}`);
    // Stage the secret on the row but do NOT flip totpEnabled until confirm.
    await db
      .update(adminUsers)
      .set({
        totpSecretCt: sealed.ct,
        totpSecretIv: sealed.iv,
        totpSecretTag: sealed.tag,
        totpEnabled: false,
      })
      .where(eq(adminUsers.id, user.id));

    await writeAdminAudit({
      adminUserId: user.id,
      action: 'totp.setup_started',
      ip: req.ip,
    });
    return reply.send({ otpauthUri: t.uri, base32Secret: t.base32Secret });
  });

  // --- Self: confirm TOTP code; receive recovery codes ---------------------
  app.post(`${prefix}/totp/confirm`, async (req, reply) => {
    const user = req.adminUser;
    if (!user) throw new AuthError('unauthenticated');
    const { code } = totpConfirmSchema.parse(req.body);
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, user.id)).limit(1);
    if (!row?.totpSecretCt || !row.totpSecretIv || !row.totpSecretTag) {
      throw new AppError('no_pending_totp', 400, 'no_pending_totp');
    }
    const secret = openUtf8(
      { ct: row.totpSecretCt, iv: row.totpSecretIv, tag: row.totpSecretTag },
      `admin_totp:${user.id}`,
    );
    if (!verifyTotp(secret, code)) throw new AuthError('bad_totp');

    const { plain, hashes } = generateRecoveryCodes();
    await db
      .update(adminUsers)
      .set({ totpEnabled: true, recoveryHashes: hashes })
      .where(eq(adminUsers.id, user.id));

    await writeAdminAudit({
      adminUserId: user.id,
      action: 'totp.enabled',
      ip: req.ip,
    });
    return reply.send({ ok: true, recoveryCodes: plain });
  });

  // --- Self: disable TOTP (requires password + a valid code) ---------------
  app.post(`${prefix}/totp/disable`, async (req, reply) => {
    const user = req.adminUser;
    if (!user) throw new AuthError('unauthenticated');
    const body = totpDisableSchema.parse(req.body);
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, user.id)).limit(1);
    if (!row) throw new AuthError('user_gone');

    const pwOk = await verifyPassword(row.passwordHash, body.password);
    if (!pwOk) throw new AuthError('bad_password');

    if (row.totpEnabled) {
      if (body.code) {
        if (!row.totpSecretCt || !row.totpSecretIv || !row.totpSecretTag)
          throw new AppError('totp_state_corrupt', 500, 'totp_state_corrupt');
        const secret = openUtf8(
          { ct: row.totpSecretCt, iv: row.totpSecretIv, tag: row.totpSecretTag },
          `admin_totp:${user.id}`,
        );
        if (!verifyTotp(secret, body.code)) throw new AuthError('bad_totp');
      } else if (body.recoveryCode) {
        if (findRecoveryMatch(row.recoveryHashes, body.recoveryCode) < 0) {
          throw new AuthError('bad_recovery_code');
        }
      } else {
        throw new AuthError('mfa_required');
      }
    }

    await db
      .update(adminUsers)
      .set({
        totpEnabled: false,
        totpSecretCt: null,
        totpSecretIv: null,
        totpSecretTag: null,
        recoveryHashes: [],
      })
      .where(eq(adminUsers.id, user.id));

    await writeAdminAudit({
      adminUserId: user.id,
      action: 'totp.disabled',
      ip: req.ip,
    });
    return reply.send({ ok: true });
  });

  // --- Self: change password ----------------------------------------------
  app.post(`${prefix}/password`, async (req, reply) => {
    const user = req.adminUser;
    if (!user) throw new AuthError('unauthenticated');
    const body = changePasswordSchema.parse(req.body);
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, user.id)).limit(1);
    if (!row) throw new AuthError('user_gone');
    if (!(await verifyPassword(row.passwordHash, body.current))) {
      throw new AuthError('bad_password');
    }
    const hash = await hashPassword(body.next);
    await db.update(adminUsers).set({ passwordHash: hash }).where(eq(adminUsers.id, user.id));
    await writeAdminAudit({
      adminUserId: user.id,
      action: 'password.changed',
      ip: req.ip,
    });
    return reply.send({ ok: true });
  });

  // --- Superadmin: list admin users ---------------------------------------
  app.get(
    `${prefix}/users`,
    { preHandler: requireRole('superadmin', { allowSuperadmin: false }) },
    async (_req, reply) => {
      const rows = await db.select().from(adminUsers);
      return reply.send({
        users: rows.map((u) => ({
          id: u.id.toString(),
          email: u.email,
          role: u.role,
          scopedHubId: u.scopedHubId?.toString() ?? null,
          status: u.status,
          totpEnabled: u.totpEnabled,
          lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
          createdAt: u.createdAt.toISOString(),
        })),
      });
    },
  );

  // --- Superadmin: deactivate a user --------------------------------------
  app.post(
    `${prefix}/users/:id/deactivate`,
    { preHandler: requireRole('superadmin', { allowSuperadmin: false }) },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
      const userId = BigInt(id);
      if (userId === req.adminUser!.id) {
        return reply.code(400).send({ error: 'cannot_deactivate_self' });
      }
      await db
        .update(adminUsers)
        .set({ status: 'disabled' })
        .where(eq(adminUsers.id, userId));
      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'user.deactivate',
        target: `admin_user_id=${id}`,
        ip: req.ip,
      });
      return reply.send({ ok: true });
    },
  );
}
