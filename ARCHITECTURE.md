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
│   ├─ GET  /admin/...   (later)          tenant config UI                    │
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

### Webhook
- **HMAC v3** verification, mandatory, before any parsing logic.
- Read raw body via Fastify content-type parser, never trust the parsed JSON for the HMAC input.
- 5-minute clock skew window. `timingSafeEqual` comparison.
- Per-tenant rate limit (sliding window in Redis) to bound damage from a compromised portal.
- Idempotency cache (7-day retention) to absorb HubSpot retries.

### Secrets at rest
- AES-256-GCM with a 32-byte master key from env var `TOKEN_VAULT_KEY` (DO App Platform encrypted env). Each ciphertext stores `iv` (12 bytes) and `tag` (16 bytes) separately. Rotation strategy: dual-key read, single-key write.
- DB encryption-at-rest is provided by DO Managed Postgres but we layer app-level encryption for tokens & Phobs creds so a DB dump alone is not enough.

### Transport
- HTTPS only; HSTS header.
- DO App Platform terminates TLS; behind it use HTTP.
- Outbound to HubSpot/Phobs over HTTPS, validate certificates.

### Code
- All routes through `zod` validation, no string interpolation into XML (use a builder).
- No `eval`/`Function`.
- `helmet`-equivalent headers via `@fastify/helmet`.
- CORS disabled on webhook routes; permissive only on `/admin` later behind auth.
- `pino` redaction list: `req.headers.authorization`, `*.access_token`, `*.refresh_token`, `*.client_secret`, `*.bluesunrewards___loyaltyid`.
- Dependabot + `npm audit` in CI.
- Dockerfile runs as non-root, distroless or `node:22-alpine` minimal.

### OAuth
- `state` parameter signed and verified (CSRF protection).
- Redirect URI strictly allow-listed.
- Refresh tokens stored encrypted; access tokens never persisted to disk.

### Admin UI (future)
- Magic-link or GitHub OAuth login.
- Role: only emails on an allow-list can edit tenant config.
- All mutations go through `audit_log`.

### Operations
- **No prod secrets in repo.** `.env.example` only.
- App Platform env vars marked "Encrypted".
- Logs scrubbed of PII; access logs retain only metadata.
- Quarterly key rotation procedure documented in `RUNBOOK.md`.

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
2. Drizzle schema + migrations.
3. Fastify server, `/healthz`, raw-body parser, HMAC verifier (with tests).
4. OAuth install + callback, token vault, token refresh.
5. BullMQ wiring (web enqueues, worker dequeues).
6. HubSpot client factory (per-tenant, auto-refresh).
7. Phobs request builder + response parser (with fixture tests).
8. Pipeline steps as small, individually-tested functions.
9. `processDeal` job composing them.
10. Audit log writes.
11. `.do/app.yaml`, deploy to a staging portal, end-to-end test.
12. Admin UI (later).
