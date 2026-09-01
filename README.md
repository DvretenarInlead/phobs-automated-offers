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

## Deploying to DigitalOcean App Platform

`.do/app.yaml` describes the whole app: a `migrate` PRE_DEPLOY job, the `web`
service, the `worker`, and managed Postgres + Redis. First deploy:

```bash
# 1. Create the app from the spec (or paste app.yaml in the DO console)
doctl apps create --spec .do/app.yaml

# 2. Set the SECRET env vars in the console (both web and worker):
#    TOKEN_VAULT_KEY, SESSION_SECRET      -> node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#    HUBSPOT_CLIENT_ID / _SECRET / _APP_ID -> from the HubSpot developer portal
#    METRICS_TOKEN (optional), ADMIN_IP_ALLOWLIST (recommended, CIDRs)
#    TOKEN_VAULT_KEY_PREV may stay empty.

# 3. After the first successful deploy, open the web component's Console and
#    create the initial superadmin (one-shot; refuses if one exists):
node dist/cli/createAdmin.js
#    or non-interactively:
ADMIN_BOOTSTRAP_EMAIL=you@example.com ADMIN_BOOTSTRAP_PASSWORD='…' node dist/cli/createAdmin.js

# 4. Sign in at https://<app>/admin/, enrol TOTP under Settings, then install
#    the HubSpot app for the first tenant via https://<app>/oauth/install
```

Migrations run automatically before every deploy (`node dist/cli/migrate.js`,
drizzle-orm's migrator over `src/db/migrations`). `HUBSPOT_REDIRECT_URI` is
derived from `${APP_URL}` — register exactly that URL in the HubSpot app.

## Standalone tools

- `standalone/quote-runner/` — single-tenant Node service: POST a booking,
  get a HubSpot quote back synchronously.
- `standalone/phobs-mcp/` — MCP server exposing Phobs availability,
  PCPriceQuoteRQ and HubSpot line-item sync as tools for Claude.
- `do-functions/phobs-availability/` — DigitalOcean Functions: availability
  probe and webhook-triggered line-item sync.

Each has its own README.
