# Phobs Automated Offers — Architecture

A multi-tenant service that receives HubSpot deal webhooks, queries the Phobs
availability API, and writes back products, line items, quotes, and triggers
transactional emails. Deployed on DigitalOcean App Platform, integrated with
HubSpot as a Public App via OAuth.

---

## 1. High-level flow

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                  HubSpot (per tenant)                    │
                 │  Workflow → Webhook action → POST /webhooks/hubspot      │
                 └──────────────────────────────────────────────────────────┘
                                            │  signed (HMAC v3)
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DO App Platform — Web service                         │
│  Fastify                                                                    │
│   ├─ POST /webhooks/hubspot/:portalId   verify sig → enqueue → 200 ack      │
│   ├─ GET  /oauth/install                start HubSpot OAuth                 │
│   ├─ GET  /oauth/callback               exchange code, store tokens         │
│   ├─ /admin/*                           admin UI (auth-gated, see §13)      │
│   ├─ /api/admin/*                       JSON API the UI calls               │
│   ├─ GET  /metrics                      Prometheus scrape (auth-gated)      │
│   └─ GET  /healthz, /readyz                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                            │ enqueue job
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  DO Managed Redis — BullMQ queue                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                            │ pull
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     DO App Platform — Worker service                        │
│  BullMQ worker                                                              │
│   1. Load tenant config + decrypt HubSpot access token                      │
│   2. Normalize child ages (donja/gornja) → update deal                      │
│   3. Query HubDB units table                                                │
│   4. Build PCPropertyAvailabilityRQ XML → POST to Phobs                     │
│   5. Parse PCPropertyAvailabilityRS → for each unit/rate:                   │
│        a. find-or-create HubSpot Product                                    │
│        b. create Line Item, associate to Deal                               │
│   6. Create Quote with associations (template, deal, line items)            │
│   7. Patch Quote → status APPROVED                                          │
│   8. Fetch hs_quote_link                                                    │
│   9. Send HubSpot transactional email (Single-Send API)                     │
│  10. Update deal with quote link + status                                   │
│  11. Persist audit_log row                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 DO Managed Postgres — system of record                      │
│  tenants, oauth_tokens, tenant_config, jobs, audit_log, idempotency_keys    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Stack

| Layer            | Choice                          | Why                                  |
| ---------------- | ------------------------------- | ------------------------------------ |
| Runtime          | Node.js 22 LTS                  | Matches existing HubSpot SDK code    |
| HTTP framework   | Fastify                         | Fast, raw-body support for HMAC      |
| Queue            | BullMQ + ioredis                | Retries, backoff, concurrency        |
| DB               | Postgres 16 (DO Managed)        | Tenants, tokens, audit, idempotency  |
| Cache / queue    | Redis 7 (DO Managed)            | BullMQ + short-lived access tokens   |
| ORM / SQL        | Drizzle ORM                     | Type-safe, no codegen, lightweight   |
| HubSpot SDK      | `@hubspot/api-client`           | Already proven in your code          |
| XML              | `fast-xml-parser` + builder     | Phobs request/response               |
| HTTP client      | `undici`                        | Built-in to Node, fast               |
| Validation       | `zod`                           | Webhook payload + admin inputs       |
| Logging          | `pino` (JSON) + pino-pretty dev | Structured, App Platform friendly    |
| Secrets at rest  | AES-256-GCM (Node `crypto`)     | Wraps refresh_token in DB            |
| Tests            | `vitest` + `supertest`          | Fast, ESM-native                     |
| Container        | Multi-stage Dockerfile          | App Platform Docker deploy           |

---

## 3. Project layout

```
phobs-automated-offers/
├── src/
│   ├── server.ts                  # Fastify entry (web)
│   ├── worker.ts                  # BullMQ worker entry
│   ├── config.ts                  # env parsing (zod)
│   ├── db/
│   │   ├── client.ts              # drizzle + pg pool
│   │   ├── schema.ts              # tables
│   │   └── migrations/
│   ├── queue/
│   │   ├── index.ts               # bullmq queue factory
│   │   └── jobs/
│   │       └── processDeal.ts     # full pipeline
│   ├── hubspot/
│   │   ├── client.ts              # per-tenant client factory (token refresh)
│   │   ├── oauth.ts               # install + callback
│   │   ├── signature.ts           # X-HubSpot-Signature-v3 verify
│   │   ├── deals.ts               # update deal helpers
│   │   ├── hubdb.ts               # HubDB row queries
│   │   ├── products.ts            # find-or-create product
│   │   ├── lineItems.ts           # create + associate
│   │   ├── quotes.ts              # create + approve + fetch link
│   │   └── email.ts               # transactional Single-Send
│   ├── phobs/
│   │   ├── client.ts              # POST XML
│   │   ├── buildRequest.ts        # PCPropertyAvailabilityRQ
│   │   └── parseResponse.ts       # PCPropertyAvailabilityRS → typed
│   ├── tenancy/
│   │   ├── config.ts              # tenant_config CRUD
│   │   └── childAgeRules.ts       # donja/gornja normalizer
│   ├── crypto/
│   │   └── tokenVault.ts          # AES-256-GCM wrap/unwrap
│   ├── routes/
│   │   ├── webhook.ts
│   │   ├── oauth.ts
│   │   ├── admin.ts               # stub for now
│   │   └── health.ts
│   ├── lib/
│   │   ├── logger.ts
│   │   ├── idempotency.ts
│   │   └── errors.ts
│   └── types/
├── test/
├── .do/app.yaml                   # App Platform spec
├── Dockerfile
├── docker-compose.yml             # local dev (pg + redis)
├── drizzle.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

Two App Platform components share the same image and entrypoints:

- `web`: `node dist/server.js`
- `worker`: `node dist/worker.js`

---

## 4. Data model (Postgres)

```sql
-- One row per HubSpot portal that installs the app
tenants(
  hub_id            bigint primary key,        -- HubSpot portalId
  name              text not null,
  status            text not null default 'active',  -- active | suspended
  created_at        timestamptz not null default now()
)

-- OAuth credentials, encrypted
oauth_tokens(
  hub_id                bigint primary key references tenants(hub_id) on delete cascade,
  access_token_ct       bytea not null,         -- AES-256-GCM ciphertext
  access_token_iv       bytea not null,
  access_token_tag      bytea not null,
  access_token_expires  timestamptz not null,
  refresh_token_ct      bytea not null,
  refresh_token_iv      bytea not null,
  refresh_token_tag     bytea not null,
  scopes                text[] not null,
  updated_at            timestamptz not null default now()
)

-- Per-tenant operational config (editable via admin UI later)
tenant_config(
  hub_id              bigint primary key references tenants(hub_id) on delete cascade,
  phobs_auth_user_ct  bytea, phobs_auth_user_iv bytea, phobs_auth_user_tag bytea,
  phobs_auth_pass_ct  bytea, phobs_auth_pass_iv bytea, phobs_auth_pass_tag bytea,
  phobs_endpoint      text not null,
  hubdb_table_id      text not null,           -- "which ID will I want to modify in the UI"
  quote_template_id   text not null,
  owner_id            bigint not null,
  access_code         text,                    -- loyalty access code, optional
  email_template_id   text not null,           -- transactional email
  property_rules      jsonb not null default '{}'::jsonb,
                       -- { "<propertyId>": {name, donja, gornja} }
  updated_at          timestamptz not null default now()
)

-- Idempotency: dedupe HubSpot retries
idempotency_keys(
  key             text primary key,            -- sha256(hub_id|hs_object_id|eventId)
  job_id          text not null,
  created_at      timestamptz not null default now()
)
-- Auto-purge rows older than 7d via a scheduled job.

-- Append-only audit log of every external interaction
audit_log(
  id              bigserial primary key,
  hub_id          bigint not null,
  deal_id         bigint,
  kind            text not null,               -- 'hubspot.deal.update' | 'phobs.availability' | ...
  status          text not null,               -- 'ok' | 'error'
  request         jsonb,
  response        jsonb,
  latency_ms      integer,
  error           text,
  created_at      timestamptz not null default now()
)
create index on audit_log(hub_id, created_at desc);
create index on audit_log(deal_id);
```

---

## 5. Webhook contract

HubSpot Workflow → "Send a webhook" action sends the array payload you showed.
We accept it at:

```
POST /webhooks/hubspot/:portalId
Content-Type: application/json
X-HubSpot-Signature-v3: ...
X-HubSpot-Request-Timestamp: ...
```

Handler:

1. Read **raw body** (Fastify `addContentTypeParser` capturing buffer).
2. Reject if timestamp older than 5 minutes.
3. Compute `HMAC-SHA256(client_secret, timestamp + method + url + rawBody)` (HubSpot v3 spec) and `timingSafeEqual` against header. **Reject 401 on mismatch.**
4. `zod`-parse the body. Reject 400 on invalid shape (don't 500 — HubSpot would retry).
5. Compute idempotency key = `sha256(portalId|hs_object_id|hash(rawBody))`.
6. `INSERT ... ON CONFLICT DO NOTHING` into `idempotency_keys`. If conflict → return 200 with `duplicate: true`.
7. Enqueue BullMQ job `processDeal` with `{ portalId, payload }`.
8. Return `200 { accepted: true, jobId }` within ~50 ms. **Do not block on Phobs or HubSpot writes.**

---

## 6. Worker job pipeline

`processDeal` (idempotent, retry-safe, BullMQ `attempts: 5, backoff: exponential 10s`):

| Step | Action                                                          | Failure mode                              |
| ---- | --------------------------------------------------------------- | ----------------------------------------- |
| 1    | Load `tenant_config`, decrypt secrets                           | Skip + alert if tenant missing            |
| 2    | Get fresh HubSpot access token (refresh if <2 min to expiry)    | Retry; mark tenant suspended after N      |
| 3    | Apply `childAgeRules` (your donja/gornja logic) → patch deal    | Retry on 5xx, fail on 4xx                 |
| 4    | Query HubDB table for unit IDs for this property                | Retry on 5xx                              |
| 5    | Build Phobs XML request (incl. AccessCode if loyaltyid present) | —                                         |
| 6    | POST to Phobs, parse RS                                         | Retry on network/5xx, fail on parse error |
| 7    | For each `Unit` × `RatePlan`: find-or-create Product            | Use `sku = <portalId>:<unitId>:<rateId>`  |
| 8    | Create Line Items, associate to deal (HUBSPOT_DEFINED type 20)  | Idempotent via deal-line-item dedupe      |
| 9    | Create Quote with associations (286 template, 64 deal, 67 LIs)  | Existing logic                            |
| 10   | Update Quote → `hs_status=APPROVED`                             | Existing logic                            |
| 11   | Poll `hs_quote_link` (up to 10s, 1s interval — not setTimeout)  | Replace your 6s setTimeout                |
| 12   | Send transactional email (Single-Send API, per-tenant template) | Retry on 5xx                              |
| 13   | Update deal: `quote_link_custom`, status, `number_of_childrens` | —                                         |
| 14   | Write `audit_log` rows for each external call                   | Best-effort                               |

---

## 7. Multi-tenancy

- **One** HubSpot Public App. Client ID/secret in env vars.
- Install URL: `https://app.example.com/oauth/install` → redirects to HubSpot consent.
- Callback `/oauth/callback?code=...&hub_id=...` → token exchange → upsert `tenants` + encrypted `oauth_tokens`.
- Required scopes (initial guess — confirm against your existing workflow actions):
  - `crm.objects.deals.read`, `crm.objects.deals.write`
  - `crm.objects.line_items.read`, `crm.objects.line_items.write`
  - `crm.objects.quotes.read`, `crm.objects.quotes.write`
  - `crm.objects.products.read`, `crm.objects.products.write`
  - `crm.schemas.deals.read`
  - `hubdb`
  - `transactional-email`
- On every job, refresh access token if needed using stored `refresh_token`. Cache the live access token in Redis with TTL = `expires_in - 120s`.
- **Tenant config (HubDB ID, quote template ID, owner ID, Phobs creds, email template ID, property rules JSON)** is stored in `tenant_config`. Initially seeded by a CLI script; an admin UI is added later. The HubDB table ID is editable from the UI as you asked.

---

## 8. Security

### 8.1 Threat model (what we're defending against)

| Threat                                      | Control                                                       |
| ------------------------------------------- | ------------------------------------------------------------- |
| Forged webhook from random internet caller  | HMAC v3 signature verification, mandatory                     |
| Replay of valid webhook                     | 5-min timestamp window + idempotency keys                     |
| HubSpot client_secret leak                  | Stored only in encrypted env; rotated via HubSpot dev portal  |
| DB dump → tokens stolen                     | AES-256-GCM app-level encryption on top of DO encryption-at-rest |
| Compromised admin laptop                    | Short session TTL + TOTP MFA + IP allowlist on admin routes   |
| Compromised tenant portal (mass webhook)    | Per-tenant rate limit + circuit breaker → tenant auto-suspend |
| XML External Entity (XXE) on Phobs response | Parser configured with `processEntities:false`, no DTD load   |
| SSRF via tenant-configured Phobs endpoint   | URL allow-list + DNS pinning to public IPs only               |
| SQL injection                               | Drizzle parameterised queries only; no raw string SQL         |
| XSS in admin UI                             | React auto-escape + strict CSP + sanitise tenant strings      |
| CSRF on admin mutations                     | SameSite=strict session cookie + CSRF token on state-changing requests |
| Privilege escalation between tenants        | All queries scoped by `hub_id`; row-level checks in every API |
| Supply-chain attack via npm dep             | Lockfile, Dependabot, `npm audit --audit-level=high` in CI    |
| Container escape                            | Non-root user, read-only FS, no `--privileged`                |
| Logs leak PII/tokens                        | Pino redaction allow-list, log retention 30d, no body logging |
| Insider abuse                               | Append-only `audit_log` with admin user, IP, before/after diff |
| Denial of service                           | Global rate limit + per-IP Fastify limit + queue length cap   |

### 8.2 Webhook ingestion

- **HMAC v3** verification on every request, before any parsing logic.
- Raw body captured via Fastify content-type parser; HMAC computed over raw bytes, never the re-serialised JSON.
- Header `X-HubSpot-Request-Timestamp` checked against `Date.now()` — reject if >5 min skew.
- `crypto.timingSafeEqual` for signature comparison.
- Per-tenant sliding-window rate limit in Redis (e.g. 100 req/min, configurable).
- Idempotency keys: `sha256(portalId|hs_object_id|sha256(rawBody))`, 7-day TTL, `INSERT … ON CONFLICT DO NOTHING`.
- 400 on schema mismatch, 401 on signature mismatch, 200 on duplicate, 200 on accepted — never 5xx for invalid input (avoids HubSpot retries on permanent failures).

### 8.3 Secrets at rest

- **Token vault**: AES-256-GCM. 32-byte master key in env `TOKEN_VAULT_KEY` (DO encrypted env). Each ciphertext stores its own 12-byte IV and 16-byte tag in separate columns. AAD = `"oauth_token:" + hub_id` to bind ciphertext to its tenant.
- **Key rotation**: dual-key support. `TOKEN_VAULT_KEY` (write) + `TOKEN_VAULT_KEY_PREV` (read fallback). Background job re-encrypts rows with the new key, then `_PREV` is removed.
- **Phobs credentials** wrapped the same way in `tenant_config`.
- **DB**: DO Managed Postgres has encryption-at-rest + TLS-in-transit by default. App-level encryption layers on top so a leaked dump still doesn't expose tokens.

### 8.4 Transport

- HTTPS everywhere. HSTS `max-age=63072000; includeSubDomains; preload`.
- DO App Platform terminates TLS; internal port HTTP only (private network).
- Outbound HTTPS to HubSpot and Phobs with certificate validation. No `rejectUnauthorized:false` anywhere.
- Fastify behind App Platform's proxy: `trustProxy: true` only with the App Platform CIDR.

### 8.5 Application code hardening

- All route inputs through `zod` schemas (webhook body, admin API bodies, query params, route params).
- XML built with `fast-xml-parser` builder (no string interpolation). XML responses parsed with `processEntities: false`, `allowBooleanAttributes: false`, no DOCTYPE handling → **no XXE surface**.
- `@fastify/helmet` for security headers: CSP (admin UI only allows self + a strict nonce), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimum, `X-Frame-Options: DENY`.
- CORS: disabled on `/webhooks/*` and `/oauth/*`; admin UI is same-origin (no CORS needed) and uses session cookies, not bearer tokens.
- Pino redaction: `req.headers.authorization`, `req.headers.cookie`, `*.access_token`, `*.refresh_token`, `*.client_secret`, `*.password`, `*.bluesunrewards___loyaltyid`. Webhook **body** never logged in full — only a hash + size.
- Static analysis: ESLint with `eslint-plugin-security`, `eslint-plugin-no-unsanitized`. TypeScript strict.
- Supply chain: `package-lock.json` committed, `npm ci --ignore-scripts` in build, Dependabot weekly, `npm audit --audit-level=high` gating CI.
- Container: `node:22-alpine`, non-root user UID 10001, read-only root FS, no shell in final layer if practical.

### 8.6 OAuth

- HubSpot install URL builds a `state` = signed `{ nonce, returnTo, ts }` (JWT, 10-min TTL). Verified on callback; nonce single-use via Redis.
- Redirect URI strictly allow-listed against `HUBSPOT_REDIRECT_URI` env.
- Refresh tokens encrypted in DB; access tokens cached in Redis with TTL `expires_in - 120s`, **never written to disk**.
- Token refresh uses HubSpot SDK; on revoked/invalid grant → mark tenant `status='suspended'`, alert, halt jobs for that tenant.

### 8.7 Multi-tenant isolation

- Every DB query scoped by `hub_id`. A `tenantContext(req)` middleware sets `req.hubId` and a `withTenant(hubId, fn)` helper passes it to data accessors; lint rule forbids raw `db.select(...)` outside that helper.
- BullMQ jobs carry `hubId` in payload; worker re-validates the tenant exists and is active before touching anything.
- Cross-tenant access in admin API requires `superadmin` role and is logged twice (audit + alert).

### 8.8 Operations

- **No prod secrets in repo.** Only `.env.example`.
- DO App Platform env vars marked "Encrypted". Rotation procedure in `RUNBOOK.md`.
- Production DB access restricted: psql via DO VPC, never from a laptop direct. Read-only role for ad-hoc.
- Quarterly key rotation drill (token vault, HubSpot client secret, session signing).
- Disaster recovery: managed Postgres PITR retention 7 days; weekly logical dumps to encrypted DO Spaces (separate region).
- Vulnerability disclosure email + SECURITY.md.

---

## 8b. Admin UI

### Stack
- **Frontend**: React + Vite + TypeScript, served from the same Fastify origin under `/admin`. Tailwind for styling. TanStack Query for data fetching against `/api/admin/*`. No SPA-on-a-CDN — keeping it same-origin removes a class of CSRF/CORS issues.
- **State of truth**: `/api/admin/*` JSON endpoints backed by the same Drizzle layer.

### Pages
1. **Sign-in** — email + password + TOTP, magic-link fallback.
2. **Dashboard** — per-tenant counters (last 24h: webhooks received, jobs ok/failed, quotes created, p95 Phobs latency, p95 HubSpot latency). Links into each.
3. **Tenants** — list of installed portals, status (active/suspended), last activity. Click → tenant detail.
4. **Tenant detail / config** — editable form for: `hubdb_table_id`, `quote_template_id`, `owner_id`, `email_template_id`, `phobs_endpoint`, `phobs_auth_user`/`phobs_auth_pass` (write-only inputs, masked), `access_code`, and the `property_rules` JSON table (one row per propertyId: name, donja, gornja). Save runs through `/api/admin/tenants/:hubId/config` with audit.
5. **Activity / logs** — paginated `audit_log` viewer filtered by tenant, deal, kind, status, date range. Each row expandable to show request/response (with secrets redacted).
6. **Jobs** — BullMQ admin (queued / active / completed / failed). Per-job retry, drop, inspect. Failed-jobs DLQ with one-click retry.
7. **Webhooks live** — tail view (SSE) of incoming webhooks: timestamp, tenant, deal id, signature ok/bad, accepted/duplicate, job id. Useful for debugging customer issues.
8. **Phobs probe** — diagnostic tool: pick a tenant + propertyId + date + nights + occupancy, build the XML, fire it, see the response. No deal mutation. Crucial for support.
9. **Settings → users** (superadmin only) — invite admin users, set roles, reset MFA, deactivate.
10. **Settings → keys** (superadmin only) — view (masked), regenerate token-vault key with progress bar (re-encrypt job).

### Roles
- `superadmin` — everything, can manage other admins and rotate keys.
- `admin` — manage all tenants, view all logs.
- `tenant_admin` (future) — scoped to a single `hub_id`; for end-customer hotel staff to edit their own `property_rules` only.

Role enforcement is centralised in a `requireRole(role[, hubId])` Fastify hook used on every `/api/admin/*` route.

### Auth flow
- **Argon2id** password hashing (`memoryCost: 19456, timeCost: 2, parallelism: 1`).
- **TOTP** (RFC 6238) required for `admin` and `superadmin`. Recovery codes generated once, shown once, stored hashed.
- **Sessions**: server-side session in Redis, opaque cookie `__Host-sid`, `HttpOnly; Secure; SameSite=Strict; Path=/`. 15-min idle / 8-hour absolute TTL. Revocable via the users page.
- **CSRF**: double-submit cookie token for any non-GET; SameSite=Strict already covers most; tokens still issued for defence in depth.
- **Brute force**: per-account + per-IP login rate limit, exponential backoff, lockout after 10 failures.
- **Optional IP allowlist** on `/admin/*` and `/api/admin/*` via env `ADMIN_IP_ALLOWLIST=cidr,cidr`.

### Admin user DB table

```sql
admin_users(
  id              bigserial primary key,
  email           citext unique not null,
  password_hash   text not null,           -- argon2id
  totp_secret_ct  bytea, totp_secret_iv bytea, totp_secret_tag bytea,  -- vault
  totp_enabled    boolean not null default false,
  recovery_hashes text[] not null default '{}',
  role            text not null,           -- superadmin | admin | tenant_admin
  scoped_hub_id   bigint,                  -- non-null only for tenant_admin
  status          text not null default 'active',  -- active | locked | disabled
  last_login_at   timestamptz,
  created_at      timestamptz not null default now()
)
admin_sessions(
  sid             text primary key,
  admin_user_id   bigint not null references admin_users(id),
  ip              inet not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null
)
admin_audit(
  id              bigserial primary key,
  admin_user_id   bigint not null,
  action          text not null,           -- e.g. 'tenant_config.update'
  target          text,                    -- e.g. 'hub_id=...'
  ip              inet,
  before          jsonb,
  after           jsonb,
  created_at      timestamptz not null default now()
)
```

### Initial superadmin
A one-shot CLI `npm run admin:create` (run via DO console / migrations container) creates the first superadmin with a printed password reset token, scoped to a 15-min TTL. No bootstrap user lives in env vars or seeds.

---

## 8c. Monitoring & observability

### Logs (structured, pino → stdout → DO Logs)
Every log line has: `level`, `time`, `msg`, `hub_id`, `deal_id` (when known), `request_id` (uuid v4 per inbound request, propagated to jobs), `job_id`, `kind`, `latency_ms`, `outcome` (`ok` / `retry` / `error`). Sensitive fields redacted by the pino redaction list. Ship to **DO Logs** by default; optional `LOG_HTTP_URL` to mirror to Better Stack / Logtail / Datadog.

### Metrics (Prometheus exposition on `/metrics`, auth-gated)
- `http_requests_total{route,status,hub_id}` — counters
- `http_request_duration_seconds{route}` — histogram
- `webhook_signature_failures_total{hub_id}` — counter (alert if non-zero)
- `webhook_duplicates_total{hub_id}` — counter
- `job_processed_total{outcome="ok|fail|retry",step}` — counter
- `job_duration_seconds{step}` — histogram per pipeline step
- `external_api_calls_total{target="hubspot|phobs",op,status_class}` — counter
- `external_api_duration_seconds{target,op}` — histogram (p50/p95/p99)
- `external_api_retries_total{target,op,reason}` — counter
- `queue_jobs_waiting{queue}` / `queue_jobs_active` / `queue_jobs_failed` — gauges
- `tenant_status{hub_id,status}` — gauge

Scraping: **Grafana Cloud free tier** (or self-hosted Prometheus on a $6 Droplet). Dashboards committed under `infra/grafana/`.

### Tracing (optional, recommended)
OpenTelemetry SDK → OTLP exporter. One trace per inbound webhook spanning: `verify` → `enqueue` → `job` → each external call. Defaults off; flip on via `OTEL_EXPORTER_OTLP_ENDPOINT`.

### Audit log (DB)
The `audit_log` table is the **business record**, not just a debug log. One row per external interaction with `request`/`response` JSONB (redacted) and `latency_ms`. Powers the admin UI activity view, supports replay/forensics.

### Alerts
Routed via DO Alerts or Grafana → Slack / email:
- `webhook_signature_failures_total > 0` over 5 min → page (could be attack)
- `job_processed_total{outcome="fail"} / total > 5%` over 15 min → warn
- `external_api_duration_seconds:p95{target="phobs"} > 5s` over 10 min → warn
- `queue_jobs_waiting > 500` → warn (worker can't keep up)
- `queue_jobs_failed > 0` after 3 attempts → warn (DLQ filling)
- Tenant flips to `suspended` → notify

### Healthchecks
- `/healthz` — liveness, returns 200 if process is up.
- `/readyz` — readiness, returns 200 only if DB + Redis reachable. Used by App Platform to gate traffic.

---

## 8d. Retry policy

### Webhook → queue
- Web service never retries in the request path. It either accepts (200) and the worker handles retries, or refuses (4xx).

### BullMQ job (`processDeal`)
- `attempts: 8`
- `backoff: { type: 'exponential', delay: 5000 }` → 5s, 10s, 20s, 40s, 80s, 160s, 320s, 640s.
- `removeOnComplete: { age: 86400, count: 1000 }`, `removeOnFail: false` (keep failed for DLQ inspection).
- After last attempt: job moves to `failed` state → admin UI shows it → one-click retry.

### External calls (HubSpot, Phobs) — fine-grained retry inside the job step
Per-call retry wrapper (`callWithRetry`) keyed by operation:

| Error class                          | Retry?      | Strategy                                  |
| ------------------------------------ | ----------- | ----------------------------------------- |
| Network / DNS / socket               | yes         | 3 retries, exponential 500ms→2s→8s, jitter |
| HTTP 5xx                             | yes         | same as above                             |
| HTTP 429 (rate limit)                | yes         | honour `Retry-After`; cap 60s; 5 retries  |
| HTTP 408 / 504 / timeout             | yes         | exponential, 3 retries                    |
| HTTP 4xx (other)                     | **no**      | fail the job step, bubble up              |
| XML parse error                      | **no**      | log + audit, fail                         |
| HubSpot OAuth `invalid_grant`        | **no**      | suspend tenant, halt queue for that tenant |

Idempotency where possible:
- HubSpot writes use object-level uniqueness (Product `sku`, line-item dedupe on `(deal, product)`).
- Quote creation is **not retried after success** — once we have a quote id we persist it on the job state so the next attempt skips creation and resumes at "approve / fetch link / email".

### Circuit breaker (per tenant, per target)
A simple in-memory + Redis-mirrored breaker (`opossum`-style). After 5 consecutive failures to the same target within 60s, the breaker opens for 30s; subsequent calls fail fast and bump `external_api_retries_total{reason="open_circuit"}`. Half-open after the cooldown.

### DLQ
Failed jobs stay in BullMQ's `failed` set. Admin UI lists them with reason, last error, payload. Actions: **retry**, **retry with edited payload** (rare, audited), **discard**.

---

---

## 9. DigitalOcean App Platform layout

`.do/app.yaml` (sketch):

```yaml
name: phobs-automated-offers
region: fra
services:
  - name: web
    dockerfile_path: Dockerfile
    instance_size_slug: basic-xs
    instance_count: 1
    http_port: 8080
    health_check:
      http_path: /healthz
    routes:
      - path: /
    envs: [ ... shared ... ]
    run_command: node dist/server.js

workers:
  - name: worker
    dockerfile_path: Dockerfile
    instance_size_slug: basic-xs
    instance_count: 1
    envs: [ ... shared ... ]
    run_command: node dist/worker.js

databases:
  - name: db
    engine: PG
    production: true
  - name: redis
    engine: REDIS
    production: true
```

Estimated cost (Frankfurt): ~$12 web + ~$12 worker + ~$15 Postgres + ~$15 Redis ≈ **$54/mo** starter.

---

## 10. Environment variables

```
# App
NODE_ENV=production
PORT=8080
PUBLIC_BASE_URL=https://app.example.com
LOG_LEVEL=info

# Crypto
TOKEN_VAULT_KEY=<base64 32 bytes>           # generated once, rotated yearly

# HubSpot Public App
HUBSPOT_CLIENT_ID=...
HUBSPOT_CLIENT_SECRET=...
HUBSPOT_APP_ID=...
HUBSPOT_REDIRECT_URI=https://app.example.com/oauth/callback
HUBSPOT_SCOPES=crm.objects.deals.read crm.objects.deals.write ...

# Infra (injected by App Platform)
DATABASE_URL=...
REDIS_URL=...

# Phobs (default endpoint; per-tenant creds live in DB)
PHOBS_DEFAULT_ENDPOINT=https://...
```

---

## 11. Replacing the legacy patterns

| Legacy                                          | Replacement                                          |
| ----------------------------------------------- | ---------------------------------------------------- |
| `process.env.RezzApp` static token              | Per-tenant OAuth refresh + cached access token       |
| Hardcoded `propertyCriteria` map                | `tenant_config.property_rules` JSONB                 |
| Hardcoded `quoteTemplateId`, `ownerId`          | `tenant_config.quote_template_id`, `.owner_id`       |
| `setTimeout(..., 6000)` before fetching quote   | Poll `hs_quote_link` 1s × 10 with backoff           |
| `console.log` everywhere                        | `pino` structured logs + `audit_log` table          |
| HubSpot Workflow Custom Code blocks             | One service handling the whole pipeline transactionally |

---

## 12. Open questions for you

1. **HubDB**: confirm the table schema — which columns hold unit IDs and which the property mapping? The doc currently assumes a single editable `hubdb_table_id` per tenant.
2. **Phobs `<Auth>`**: what credentials go inside (Username/Password? API key?) and is the endpoint per-property or global per Phobs account?
3. **Email**: are you using HubSpot Marketing email Single-Send API, or a separate provider (SendGrid)? The doc assumes HubSpot.
4. **Workflow trigger**: today this is a Custom Code action — are we replacing that with a "Send a webhook" workflow action, or keeping Custom Code that hits our endpoint? (The "Send a webhook" path is cleaner and what HMAC v3 was designed for.)
5. **Product de-dupe**: is it acceptable to create one HubSpot Product per `(unitId, rateId)` tuple per portal? (Recommended; otherwise quotes won't line-item cleanly.)
6. **Admin UI auth**: who needs to log in to edit tenant config — you only, or end-customer hotel staff?

---

## 13. Build order (when you green-light scaffolding)

1. Repo skeleton, TS, lint, Dockerfile, `docker-compose.yml` for local pg+redis.
2. Drizzle schema + migrations (incl. admin tables).
3. Fastify server, `/healthz`, `/readyz`, raw-body parser, HMAC verifier (with tests).
4. Token vault (AES-256-GCM with dual-key rotation support) + tests.
5. OAuth install + callback, encrypted token storage, refresh flow.
6. BullMQ wiring (web enqueues, worker dequeues, DLQ).
7. HubSpot client factory (per-tenant, auto-refresh, `callWithRetry` wrapper).
8. Phobs request builder + response parser (with fixture tests, XXE-safe).
9. Pipeline steps as small, individually-tested functions.
10. `processDeal` job composing them; resumable state for partial success.
11. Audit log writes on every external call.
12. Pino structured logs + Prometheus `/metrics` + request-id propagation.
13. Admin auth: argon2id passwords, TOTP, sessions, CSRF, rate limits, `admin:create` CLI.
14. Admin API + React UI: dashboard, tenants, tenant config, activity, jobs, webhooks live, Phobs probe.
15. Alert rules (DO Alerts / Grafana) and runbook.
16. `.do/app.yaml`, deploy to staging portal, end-to-end test on a real workflow.
17. Production cutover + key-rotation drill.

---

## 14. Make.com feature parity checklist

You're replacing a Make.com scenario (visible in the `{{1.x}}`, `{{formatDate(...)}}`, `{{if(...; ...; ...)}}` syntax in your XML template). To not regress on operability we should match these capabilities:

### Must-have (will block daily operations without them)

| Make.com feature                | Our equivalent                                          | Status      |
| ------------------------------- | ------------------------------------------------------- | ----------- |
| Execution history per scenario  | `audit_log` + Activity page in admin                    | planned     |
| **Per-step input/output bundles** | Add `job_steps` table: row per pipeline step with input, output, status, duration | **NEW**     |
| Replay an execution             | BullMQ "retry" from admin                               | planned     |
| **Replay from a specific step** | Resumable job state already lets us start at step N; add admin button | **NEW**     |
| **Manual / on-demand trigger**  | Admin form: enter a `hs_object_id` (or paste a JSON payload) → enqueue job. No HubSpot webhook needed. | **NEW**     |
| Connections (OAuth, creds)      | `oauth_tokens`, `tenant_config` (Phobs creds)           | planned     |
| **"Test connection" button**    | Per-tenant: HubSpot ping + Phobs availability probe → green/red. Surfaces auth issues before a real deal fails. | **NEW**     |
| Error notifications             | Alerts (§8c) + admin badge per tenant                   | planned     |
| Rate-limit awareness            | `callWithRetry` honours `Retry-After`; per-tenant queue concurrency cap | planned     |
| Secrets / data stores           | Postgres (tenant_config) + Redis (caches)               | planned     |
| Webhook queue with replay       | BullMQ + idempotency keys                               | planned     |

### Should-have (saves you from re-implementing for every new tenant)

| Make.com feature                 | Our equivalent                                                                                   | Status   |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| **Error handler routes**         | Soft-failure branches: e.g. Phobs returns no `RatePlan` → send "no availability" email instead of erroring. Encode as part of the pipeline. | **NEW**  |
| **Conditional skip / filter**    | Per-tenant rule: "skip if `dealstage != X`" or "skip if `numberOfAdults == 0`". Stored as a small DSL or JSON predicate. | **NEW**  |
| **Formulas / expressions**       | Already need this for `donja/gornja`. Generalise to a tiny expression evaluator (e.g. `jsonata` or `expr-eval`) so non-engineers can tweak rules per tenant. | **NEW**  |
| **Scheduled runs**               | Cron jobs (BullMQ repeatable jobs) — e.g. nightly "expire stale quotes", retry tenant whose token refreshes failed. | **NEW**  |
| **Bundle inspector / data viewer** | Admin page: open a job, see each step's bundle (input/output JSON) with redactions. | **NEW**  |
| **Test data / dry-run mode**     | Run the full pipeline against HubSpot **sandbox** portal or with `DRY_RUN=true` flag that skips writes but still calls Phobs. | **NEW**  |
| **Operations counter / quota**   | `usage_log` table: count webhooks / Phobs calls / HubSpot calls per tenant per day. Useful for billing or quota alerts. | **NEW**  |
| **Scenario versioning**          | Git for code; for per-tenant rule changes, keep `tenant_config_history` table with diffs. | **NEW**  |
| **Sleep / delay**                | BullMQ `delay` option on enqueue.                                                                | planned  |
| **Aggregator / Iterator**        | Native JS loops — no equivalent needed.                                                          | —        |
| **Templates / shared modules**   | Code (TS modules).                                                                               | —        |

### Nice-to-have (defer until asked)

| Make.com feature                 | Note                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| Visual flow editor               | Out of scope; pipeline is in code. We'll render a static read-only flowchart in admin instead. |
| Marketplace of pre-built apps    | Out of scope.                                                                                 |
| Webhook URL rotation             | Per-tenant unguessable webhook URL token (e.g. `/webhooks/hubspot/:portalId/:secretToken`) so revealing the URL alone is not enough. Add if customer asks. |
| Slack / Teams notifications      | Hook DO Alerts → Slack webhook. 30-min job.                                                   |
| Multi-region failover            | DO App Platform single-region is fine for v1. Postgres PITR covers DR.                        |

### Locked decisions

- **Rule engine: JSON config only.** No DSL, no scripting. The admin UI exposes a typed form (per-property `donja/gornja` table, dealstage allow-list, toggles). Keeps the security surface small and onboarding fast.
- **No availability: silent.** If Phobs returns zero rate plans, set deal property `phobs_availability_status='no_availability'` and exit the job cleanly. No email is sent. No alert is raised (it's a normal business outcome, not an error). Sales handles it manually.
- **HubDB mapping defined in admin UI.** No hardcoded column names. On tenant setup, we GET the HubDB table schema once, present the columns in the UI, and let the admin map: "which column holds `unitId`?", "which holds `propertyId`?". Mapping stored in `tenant_config.hubdb_column_map` JSONB.
- **Phobs credential storage: Postgres token vault** (AES-256-GCM, master key in DO encrypted env). Bitwarden Secrets Manager rejected for v1 — marginal threat-model improvement, extra vendor + latency + cost. Migration path remains open via the `tokenVault.ts` abstraction.
- **Email sending: deal property update → HubSpot workflow sends email.** We do NOT call the HubSpot Single-Send Transactional API. Instead `processDeal` writes `quote_link_custom`, `quote_id`, `number_of_childrens`, `phobs_availability_status` (and language token if needed) to the deal; a HubSpot workflow listens on those properties and fires the correct email template per language. No transactional email add-on required, marketing team owns the content. Single-Send remains available as escape hatch if a future case needs it.
- **Rate filtering per unit.** Some tenants want to exclude certain rate plans from offers (e.g. unit `17173` should only present BB rates, never HB; or always exclude any `RateId` matching `RATE52580*`). Stored under `tenant_config.rate_filters` JSONB as a typed rule set, editable in the admin UI — no code.

### Rate filtering rules

Per-tenant, per-unit (and/or global) filter applied **after parsing the Phobs response, before creating products and line items**:

```jsonc
// tenant_config.rate_filters
{
  "global": {
    "exclude_rate_ids": ["RATE525800"],         // never offer these, any unit
    "exclude_boards": [],                       // e.g. ["FB"]
    "include_boards": null,                     // null = no allow-list
    "min_available_units": 1,
    "max_price_per_night": null
  },
  "units": {
    "17173": {
      "include_boards": ["BB"],                 // this unit: BB only
      "exclude_rate_ids": [],
      "max_results": 2                          // keep at most N cheapest rates
    },
    "17180": {
      "exclude_boards": ["HB"]
    }
  }
}
```

Engine rules (in order):
1. Drop units with `AvailableUnits < global.min_available_units`.
2. For each unit, drop rate plans whose `RateId` is in `global.exclude_rate_ids` ∪ `units[unitId].exclude_rate_ids`.
3. Drop rate plans whose `Board` is in any `exclude_boards`, or not in `include_boards` if set.
4. Drop rate plans with `Price > max_price_per_night` if set.
5. Sort remaining by price ascending; truncate to `max_results` if set.
6. If a unit has zero rate plans left after filtering, drop the unit.
7. If everything is filtered out → treat as `no_availability` (silent, per locked decision above).

Admin UI exposes this as a typed form: dropdowns for boards, text inputs for rate ID patterns (exact match only — no regex, to avoid ReDoS), number inputs. Changes audited via `tenant_config_history`.

### 14.x Live monitoring

In addition to the persisted `audit_log` + Prometheus metrics, the admin UI provides **streaming live views** (SSE over the same Fastify origin, session-auth-gated):

| View                    | Stream source                                     | Use case                                                              |
| ----------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| **Incoming webhooks**   | Redis pub/sub channel `live:webhooks:<hub_id>`    | Tail signed/duplicate/accepted decisions in real time during a sales demo or customer call |
| **Job activity**        | BullMQ events (`active`, `progress`, `completed`, `failed`) | Watch a deal flow through the pipeline step by step                  |
| **External API calls**  | Redis pub/sub `live:ext:<hub_id>` (HubSpot + Phobs reqs/resps, redacted) | See exactly what we sent to Phobs and what came back, without grepping logs |
| **Filter trace**        | Per-job: which rate plans dropped at which rule  | Debug "why didn't unit X appear in the quote?"                       |
| **Live tenant health**  | Prometheus query polled every 5s                  | Per-tenant counters (last 60s): webhooks, jobs ok, jobs failed, p95 Phobs latency |

Implementation:
- Each step in the worker pipeline calls `liveEmit(hubId, channel, event)` which `PUBLISH`es a JSON event to Redis with TTL hints. The web service holds an open SSE connection per admin viewer, subscribed to the channels they're authorised for.
- Events are best-effort (Redis pub/sub is fire-and-forget) — the **canonical record stays in `audit_log` / `job_steps`** so viewers who arrive late can replay the last N events from DB then upgrade to live.
- Backpressure: cap each SSE connection at 500 events/s; drop with a `meta:overflow` marker if exceeded.
- Secrets/PII redacted at emit time using the same pino redaction list. No raw OAuth tokens or guest birthdates ever hit the stream.
- Auth: admin session cookie required; `tenant_admin` role sees only its own `hub_id`; superadmin sees all.

This is the closest analogue to Make.com's "running scenario" view — and arguably better, since it spans the queue + external calls + filter decisions in one timeline.

### New DB tables introduced by this section

```sql
-- Per-step execution record (powers the bundle inspector + replay-from-step)
job_steps(
  id              bigserial primary key,
  job_id          text not null,            -- BullMQ job id
  hub_id          bigint not null,
  deal_id         bigint,
  step            text not null,            -- 'normalize_ages' | 'hubdb_query' | 'phobs_avail' | ...
  step_index      smallint not null,
  status          text not null,            -- 'ok' | 'skipped' | 'error' | 'retrying'
  input           jsonb,
  output          jsonb,
  error           text,
  duration_ms     integer,
  created_at      timestamptz not null default now()
)
create index on job_steps(job_id);
create index on job_steps(hub_id, created_at desc);

-- Per-tenant version history of config changes
tenant_config_history(
  id              bigserial primary key,
  hub_id          bigint not null,
  admin_user_id   bigint not null,
  before          jsonb not null,
  after           jsonb not null,
  changed_at      timestamptz not null default now()
)

-- Daily usage rollup (for quota / billing visibility)
usage_daily(
  hub_id          bigint not null,
  day             date not null,
  webhooks        integer not null default 0,
  phobs_calls     integer not null default 0,
  hubspot_calls   integer not null default 0,
  quotes_created  integer not null default 0,
  emails_sent     integer not null default 0,
  primary key (hub_id, day)
)
```

### Updated admin UI pages (additions to §8b)

- **Manual run** page — `hs_object_id` input or paste-JSON-payload, "dry run" toggle, fire button → links to the resulting job.
- **Job detail** page — step-by-step bundle inspector, "replay" and "replay from step N" buttons.
- **Connections** page (per tenant) — "Test HubSpot" and "Test Phobs" buttons with last-success timestamps.
- **Rules** page (per tenant) — visual editor for filter predicate + per-property `donja/gornja` table + access-code rule, with history (uses `tenant_config_history`).
- **Usage** page — chart of daily usage per tenant.

---
