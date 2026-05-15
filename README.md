# phobs-automated-offers

Multi-tenant service that receives HubSpot deal webhooks, queries Phobs
availability, and writes back products, line items, and quotes. Deployed on
DigitalOcean App Platform, installed into HubSpot as a public OAuth app.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design, security model,
admin UI, monitoring, retry policy, and Make.com feature parity.

## Quick start (local)

Prereqs: Node 22, Docker.

```bash
cp .env.example .env
# Generate two 32-byte base64 keys:
node -e "console.log('TOKEN_VAULT_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
# Paste those into .env and fill in HUBSPOT_* values from your developer portal.

docker compose up -d           # postgres + redis
npm install
npm run db:generate            # generate SQL from Drizzle schema (first run)
npm run db:migrate             # apply migrations

# Run web + worker in two terminals:
npm run dev:web
npm run dev:worker
```

Test the webhook locally:

```bash
curl -sS http://localhost:8080/healthz
curl -sS http://localhost:8080/readyz
```

## Scripts

| Script              | Purpose                                            |
| ------------------- | -------------------------------------------------- |
| `dev:web`           | Run web service in watch mode                      |
| `dev:worker`        | Run BullMQ worker in watch mode                    |
| `build`             | Compile to `dist/`                                 |
| `start:web` / `start:worker` | Production entrypoints                    |
| `test`              | Run vitest suite (signature, vault, Phobs XML)     |
| `typecheck` / `lint`/ `format` | Quality gates                            |
| `db:generate`       | Drizzle: generate SQL migrations from schema       |
| `db:migrate`        | Drizzle: apply migrations                          |
| `admin:create`      | CLI to bootstrap the first superadmin (after admin UI ships) |

## Layout

```
src/
  config.ts           # zod-parsed env + derived AppConfig
  server.ts           # Fastify web entrypoint
  worker.ts           # BullMQ worker entrypoint
  crypto/             # AES-256-GCM token vault
  db/                 # Drizzle schema + client
  hubspot/            # signature (HMAC v3), JWT (workflow extension), client factory
  phobs/              # XML builder, parser, HTTP client (with SSRF allow-list)
  queue/              # BullMQ queue + worker factories
  routes/             # /healthz, /readyz, /webhooks, /oauth
  lib/                # logger, errors, retry, idempotency, requestId
test/                 # vitest specs for security-critical pieces
.do/app.yaml          # DigitalOcean App Platform spec
Dockerfile            # multi-stage, non-root, alpine
docker-compose.yml    # local pg + redis
```

## Security at a glance

- **HMAC v3** verification on every webhook before parsing (with raw-body capture).
- **JWT** verification on workflow-extension calls via cached JWKS.
- **AES-256-GCM** vault for OAuth refresh tokens and Phobs creds, with AAD
  binding ciphertext to its tenant, and `TOKEN_VAULT_KEY_PREV` for rotation.
- **XML parsing** with `processEntities: false` → no XXE.
- **SSRF guard** on tenant-supplied Phobs endpoint (HTTPS + host allow-list).
- **Idempotency** via DB unique keys; HubSpot retries are absorbed.
- **CSP, HSTS, Referrer-Policy, X-Frame-Options: DENY** via @fastify/helmet.
- **Non-root container**, read-only friendly, minimum base image.
- Per-tenant **rate limit** in Redis.
- Structured logs via pino with redaction allow-list (tokens, signatures, PII).
- See ARCHITECTURE.md §8 for the full threat model.

## What's NOT yet implemented (next slice)

- `processDeal` pipeline (`src/queue/jobs/processDeal.ts`)
- HubDB query, product/line-item/quote/email steps
- Admin UI + admin API + auth (argon2 + TOTP)
- Prometheus `/metrics` + alerts
- Live monitoring SSE streams
- Phobs probe endpoint
- `usage_daily` rollup job
