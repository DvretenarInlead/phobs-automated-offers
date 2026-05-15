import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => 'bytea',
  toDriver: (v) => v,
  fromDriver: (v) => v as Buffer,
});

const citext = customType<{ data: string; default: false }>({
  dataType: () => 'citext',
});

export const tenants = pgTable('tenants', {
  hubId: bigint('hub_id', { mode: 'bigint' }).primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthTokens = pgTable('oauth_tokens', {
  hubId: bigint('hub_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => tenants.hubId, { onDelete: 'cascade' }),
  accessTokenCt: bytea('access_token_ct').notNull(),
  accessTokenIv: bytea('access_token_iv').notNull(),
  accessTokenTag: bytea('access_token_tag').notNull(),
  accessTokenExpires: timestamp('access_token_expires', { withTimezone: true }).notNull(),
  refreshTokenCt: bytea('refresh_token_ct').notNull(),
  refreshTokenIv: bytea('refresh_token_iv').notNull(),
  refreshTokenTag: bytea('refresh_token_tag').notNull(),
  scopes: text('scopes').array().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantConfig = pgTable('tenant_config', {
  hubId: bigint('hub_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => tenants.hubId, { onDelete: 'cascade' }),
  phobsEndpoint: text('phobs_endpoint').notNull(),
  phobsSiteId: text('phobs_site_id').notNull(),
  phobsAuthUserCt: bytea('phobs_auth_user_ct').notNull(),
  phobsAuthUserIv: bytea('phobs_auth_user_iv').notNull(),
  phobsAuthUserTag: bytea('phobs_auth_user_tag').notNull(),
  phobsAuthPassCt: bytea('phobs_auth_pass_ct').notNull(),
  phobsAuthPassIv: bytea('phobs_auth_pass_iv').notNull(),
  phobsAuthPassTag: bytea('phobs_auth_pass_tag').notNull(),
  hubdbTableId: text('hubdb_table_id').notNull(),
  hubdbColumnMap: jsonb('hubdb_column_map').notNull().default(sql`'{}'::jsonb`),
  quoteTemplateId: text('quote_template_id').notNull(),
  ownerId: bigint('owner_id', { mode: 'bigint' }).notNull(),
  accessCode: text('access_code'),
  propertyRules: jsonb('property_rules').notNull().default(sql`'{}'::jsonb`),
  rateFilters: jsonb('rate_filters').notNull().default(sql`'{}'::jsonb`),
  triggerMode: text('trigger_mode').notNull().default('webhook'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    jobId: text('job_id').notNull(),
    hubId: bigint('hub_id', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idempotency_keys_created_at_idx').on(t.createdAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    hubId: bigint('hub_id', { mode: 'bigint' }).notNull(),
    dealId: bigint('deal_id', { mode: 'bigint' }),
    requestId: text('request_id'),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    request: jsonb('request'),
    response: jsonb('response'),
    latencyMs: integer('latency_ms'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_hub_created_idx').on(t.hubId, t.createdAt),
    index('audit_log_deal_idx').on(t.dealId),
  ],
);

export const jobSteps = pgTable(
  'job_steps',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    jobId: text('job_id').notNull(),
    hubId: bigint('hub_id', { mode: 'bigint' }).notNull(),
    dealId: bigint('deal_id', { mode: 'bigint' }),
    step: text('step').notNull(),
    stepIndex: smallint('step_index').notNull(),
    status: text('status').notNull(),
    input: jsonb('input'),
    output: jsonb('output'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_steps_job_idx').on(t.jobId),
    index('job_steps_hub_created_idx').on(t.hubId, t.createdAt),
  ],
);

export const tenantConfigHistory = pgTable('tenant_config_history', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  hubId: bigint('hub_id', { mode: 'bigint' }).notNull(),
  adminUserId: bigint('admin_user_id', { mode: 'bigint' }).notNull(),
  before: jsonb('before').notNull(),
  after: jsonb('after').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usageDaily = pgTable(
  'usage_daily',
  {
    hubId: bigint('hub_id', { mode: 'bigint' }).notNull(),
    day: date('day').notNull(),
    webhooks: integer('webhooks').notNull().default(0),
    phobsCalls: integer('phobs_calls').notNull().default(0),
    hubspotCalls: integer('hubspot_calls').notNull().default(0),
    quotesCreated: integer('quotes_created').notNull().default(0),
    emailsSent: integer('emails_sent').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.hubId, t.day] })],
);

export const adminUsers = pgTable(
  'admin_users',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    email: citext('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    totpSecretCt: bytea('totp_secret_ct'),
    totpSecretIv: bytea('totp_secret_iv'),
    totpSecretTag: bytea('totp_secret_tag'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    recoveryHashes: text('recovery_hashes').array().notNull().default(sql`'{}'::text[]`),
    role: text('role').notNull(),
    scopedHubId: bigint('scoped_hub_id', { mode: 'bigint' }),
    status: text('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_users_email_uq').on(t.email)],
);

export const adminSessions = pgTable('admin_sessions', {
  sid: text('sid').primaryKey(),
  adminUserId: bigint('admin_user_id', { mode: 'bigint' })
    .notNull()
    .references(() => adminUsers.id, { onDelete: 'cascade' }),
  ip: inet('ip').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const adminAudit = pgTable(
  'admin_audit',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    adminUserId: bigint('admin_user_id', { mode: 'bigint' }).notNull(),
    action: text('action').notNull(),
    target: text('target'),
    ip: inet('ip'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('admin_audit_user_idx').on(t.adminUserId, t.createdAt)],
);
