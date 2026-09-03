# Go-live checklist

State of the main app as of this pass: fresh-clone `npm ci` + `npm run build`
succeed, `tsc` / `eslint` clean, 83/83 unit tests pass, the production
bundle boots and serves `/admin/`, deep links, `/healthz`, and returns the
opaque error shapes on every route. Two independent audits (security and
admin-UI QA) were run against the tree and every Blocker/High and the large
majority of Medium/Low findings were fixed — see "Fixed in this pass".

What is left is configuration and live verification that can only happen
against your real HubSpot portal, Phobs account and DigitalOcean project.

## 1. Things only you can do (in order)

1. **HubSpot public app** (developer portal)
   - Scopes: `crm.objects.deals.read/write`, `crm.objects.line_items.read/write`,
     `crm.objects.quotes.read/write`, `crm.objects.products.read/write`, `hubdb`.
   - Redirect URL: exactly `https://<your-app-domain>/oauth/callback`
     (`.do/app.yaml` derives `HUBSPOT_REDIRECT_URI` from `${APP_URL}`).
   - Copy Client ID, Client Secret, App ID into DO secrets.
   - Deal properties the pipeline reads/writes must exist in the portal (or be
     remapped under *Pipeline overrides* in the tenant config):
     `rezapp___property_id`, `picker_date_check_in`, `reservation___nights`,
     `rezzapp___broj_odraslih` / `number_of_adults`, `child_age_1..5`,
     `jezik_ponude`, `bluesunrewards___loyaltyid` (inputs);
     `quote_id`, `quote_link_custom`, `phobs_availability_status`,
     `number_of_childrens`, `child_age_1..5` (outputs).
   - Start with trigger mode **"Send a webhook"** (HMAC v3). The workflow
     *extension* path (JWT) is implemented but the JWT issuer/JWKS assumptions
     are unverified against a live HubSpot custom action — treat it as beta.

2. **DigitalOcean App Platform**
   - `doctl apps create --spec .do/app.yaml` (managed Postgres 17 + Valkey 8, the Redis-compatible engine DO offers now).
   - Set SECRET envs on **web and worker**: `TOKEN_VAULT_KEY`, `SESSION_SECRET`
     (32 random bytes, base64 — see README), `HUBSPOT_CLIENT_ID/_SECRET/_APP_ID`;
     optional `METRICS_TOKEN`. Leave `TOKEN_VAULT_KEY_PREV` empty.
   - Set `ADMIN_IP_ALLOWLIST` (comma-separated IPs/CIDRs of your office/VPN).
     It gates the whole admin surface including `/login`.
   - Deploy. The `migrate` PRE_DEPLOY job applies `src/db/migrations` (0000–0004).
   - Escrow `TOKEN_VAULT_KEY` somewhere safe: losing it means every tenant's
     Phobs credentials and HubSpot refresh tokens are unrecoverable.
   - Web console → `node dist/cli/createAdmin.js` (one-shot; refuses if a
     superadmin exists). Sign in at `/admin/`, **enable TOTP immediately**
     (Settings), save the recovery codes.

3. **First tenant**
   - `https://<app>/oauth/install` from the HubSpot portal's admin user.
   - Admin → Tenants → Configure. The page opens in "Set up tenant" mode:
     Phobs endpoint (must be `https://*.phobs.net`), Site ID, username,
     password, HubDB table ID + column names, quote template ID, owner ID,
     loyalty access code (optional). *Create configuration* stores it and
     shows the **webhook URL once** — it carries a per-tenant token
     (`/webhooks/hubspot/<portalId>/<token>`). Copy it straight into the
     HubSpot workflow. It can be rotated later from the same page.
   - Then property rules, rate filters, pipeline overrides.
   - Optionally invite a `tenant_admin` (Users page → invite link).

4. **Phobs live verification** (admin → Phobs probe)
   - Mode *availability*: confirm rates/units/prices for a known stay.
   - Mode *price quote*: pick a unit from the availability result ("Quote
     this →"). **This is the first-ever live `PCPriceQuoteRQ` call** — the
     request follows Phobs PC conventions but the response layout is
     unverified. If `quote` comes back empty, tick *Include raw response XML*
     and adjust `parsePriceQuoteResponse` in `src/phobs/priceQuote.ts` (one
     place; `raw`/`rawXml` show the exact shape). Only then enable
     *Firm price quote* under Pipeline overrides for the tenant.

5. **HubSpot webhook live verification**
   - Create the workflow ("Send a webhook", POST to the tenant's webhook URL
     from step 3 — it includes the per-tenant token — request signature from
     this app, include the deal properties above) and fire it for a test deal.
   - Watch admin → Live (webhooks) and Jobs. If the webhook is rejected with
     `signature_failed`, the log line carries the reason
     (`bad_signature` / `stale_timestamp` / `bad_token`). The v3 base string
     was corrected to HubSpot's documented `method + uri + body + timestamp`
     order in this pass; a real delivery is the confirmation.
   - Why the token: HubSpot signs with the public app's client secret, which
     is the same for every portal the app is installed on. The signature
     alone proves the request came from HubSpot, not from *this* tenant's
     portal. The token in the signed URL provides that binding, and the
     pipeline additionally verifies the deal exists in the tenant's portal
     (with the tenant's own OAuth token) before writing anything.
   - Check the deal: line items, quote (APPROVED) with link, properties
     written back.

6. **Ops**
   - Point Prometheus at `/metrics` with `Authorization: Bearer $METRICS_TOKEN`;
     alert on `jobs failed`, `webhook_signature_failures`, `/readyz` 503.
   - Optional: `OTEL_EXPORTER_OTLP_ENDPOINT` for tracing.
   - Confirm DO backups are on for Postgres. Redis holds only queue state,
     rate-limit counters and login counters.
   - Build the Docker image in CI once (`docker build .`) — this sandbox had
     no Docker daemon, so the Dockerfile was reviewed but not executed here.

## 1b. Data protection (guest personal data)

The pipeline handles booking details of EU guests (dates, party size, child
ages, loyalty ids; anything else the tenant's workflow chooses to send).
What the system does with them after the data-protection audit:

- **Retention is enforced daily** by the worker's maintenance job. Defaults:
  `job_steps` and `audit_log` 90 days, `admin_audit` / `tenant_config_history`
  2 years, failed queue jobs (raw payload in Redis) 7 days, completed jobs
  24 h. Override with `RETENTION_*_DAYS` per your DPA.
- **What is stored per deal**: deal id, normalised party (adults, child ages),
  rate/unit ids and prices, HubSpot object ids, error categories. Never: raw
  Phobs XML, Phobs booking URLs, HubDB rows, HubSpot error bodies/headers,
  the public quote link, credentials.
- **Erasure**: `node dist/cli/eraseDeal.js --hub <hubId> --deal <dealId>
  [--dry-run]` removes every record for a deal (Postgres + queue). Resolve a
  contact to their deal ids in HubSpot first — nothing here is keyed by
  guest identity. Platform logs and database backups age out on the
  provider's schedule; note that in your record of processing.
- **Logs** never contain request bodies, headers or query strings (OAuth
  codes and invite tokens travel in the query string). Failed admin logins
  log the admin email + IP at `warn` — staff data, list it in the RoPA.
- **Tracing** (`OTEL_EXPORTER_OTLP_ENDPOINT`) is off by default. If enabled,
  the ioredis/http instrumentations are configured not to export job
  payloads or query strings; keep the collector in the EU.
- **Vault** covers OAuth tokens, Phobs credentials, TOTP secrets and (from
  migration 0005) the loyalty access code.
- **Subprocessors**: DigitalOcean (hosting, EU region), Phobs (availability
  and pricing; receives stay dates, party size, child ages), HubSpot (CRM;
  receives everything written back to the deal).
- **Verify on first deploy**: `REDIS_URL` should be `rediss://` (TLS); DO's
  Redis certificate must chain to the system store or boot fails closed.
  Turn on Postgres backups/PITR in the DO console and note their retention.
  Send only the listed deal properties from the HubSpot workflow — the
  webhook accepts extra fields but every extra field is more data to hold.

## 2. Fixed in this pass

Build / deploy blockers
- Stale `package-lock.json` broke `npm ci`; Fastify 5.12 `trustProxy` type;
  lint ignores for standalone tools.
- `npm run build` wiped `dist/admin/` (server auth/session modules) with the
  UI bundle → the image could not start. UI now builds to `dist/admin-ui/`.
- Custom error handler was registered after routes and therefore never used
  (Fastify binds handlers at route registration) — every route leaked default
  Fastify/driver error messages. Handlers now installed first; verified live.
- Worker env in `.do/app.yaml` was missing half the required vars → crash
  loop. Added; plus a `migrate` PRE_DEPLOY job (`src/cli/migrate.ts`, works in
  the prod image without drizzle-kit) and a non-interactive superadmin
  bootstrap.
- SPA deep links / page refresh returned 500 (`reply.sendFile` undefined);
  `/admin` without slash 404. Fixed; assets cached immutable, index no-store.

Security (from the audit)
- DO availability function: was unauthenticated and `debug:true` echoed the
  request XML including Phobs username/password; env fallbacks allowed
  pointing it at any host. Now bearer-gated, creds env-only, no request echo.
- Decrypted Phobs credentials + loyalty code were written to `job_steps.output`
  on every job (and shown in Job Detail). Step outputs are now summarised;
  migration 0004 scrubs existing rows.
- `/api/trigger` with an `Idempotency-Key` header produced a BullMQ-invalid
  job id (colon) → 500 after claiming the key → deal never processed, all
  retries "duplicate". Job ids are hashed; a failed enqueue releases the key
  (same in the webhook route).
- HubSpot v3 signature base string was `timestamp+method+uri+body`; corrected
  to `method+uri+body+timestamp` with HubSpot's URI decode list.
- Admin auth hook matched on the raw URL — `/api/%61dmin/…` skipped it. Now
  matches on the routed path; verified live.
- Invite accept/preview were behind the session hook (invites unusable).
- Login lockout: counters bumped before CSRF/password checks and keyed by
  email only → anyone could lock any admin. Now bump-on-failure, hard lock
  per email+IP, superadmin `POST /users/:id/unlock`.
- TOTP replay within the ±1 window; MFA "set up" silently disabled existing
  MFA; password change / MFA change did not revoke other sessions; `/me`
  lacked `totpEnabled`. All fixed; `totp_last_step` column added.
- OAuth `state` was not bound to the browser; now paired with a
  `__Host-oauth_nonce` cookie.
- Postgres TLS accepted any certificate in production; now verified
  (`DATABASE_CA_CERT` ← `${db.CA_CERT}`).
- `TRUST_PROXY_HOPS` default 1 → 0 (app.yaml sets 1 for DO).
- Rate-limit buckets were attacker-mintable (token prefix / portal id); keys
  now include the source IP; Redis clients on request paths fail fast
  (fail-closed) instead of hanging.
- Metrics label cardinality from unmatched URLs; failed-job list window for
  tenant filtering; `/queue/stats` superadmin-only; prototype-chain lookups
  (`constructor` as propertyId/unitId) in rules, rate filters and overrides;
  loyalty access code in config history/audit; Phobs endpoint host validated
  at save; mask string can no longer be round-tripped into secrets; vault key
  must be exactly 32 bytes; empty secrets treated as unset.
- Job retries: non-retryable errors go straight to the dead-letter set; a
  retry after a mid-run HubSpot failure resumes with the products / line
  items / quote already created (no duplicates). Idempotency keys and
  sessions are purged daily.
- Standalone quote-runner refuses to start without `API_TOKEN`; all
  standalone/DO tools type-check array inputs and cap sizes.

Admin UI (from the QA pass)
- Tenant config: saving overwrote the loyalty access code with the mask
  string; the Pipeline overrides editor was never mounted; unsaved edits could
  be wiped by a refetch. Rewritten: explicit "new value / clear" handling for
  the access code, overrides mounted and saved, hydrate-once + dirty tracking,
  local validation with field-level server messages.
- Recovery codes were unmounted before the user could read them; MFA status
  now shown; disable via recovery code supported.
- Every auth error displayed as "unauthorized"; now distinct codes with
  friendly text; 403 vs 401 corrected server-side.
- Session expiry: global 401 → bounce to login with a message; Sign out
  works after expiry; deep link preserved through login.
- Live/Dashboard: permanent SSE closes (401/429) shown as "Disconnected"
  with reconnect; Activity/Jobs/Users/Workflow pages have error + empty
  states; job retry/discard show errors; self-deactivate hidden; duplicate
  invite → clear message; rules-of-hooks violation removed; numeric guards on
  probe inputs; rate-filter limit seeds are saveable.

Data protection (from the second audit)
- Retention job for `job_steps`, `audit_log`, `admin_audit`,
  `tenant_config_history`; failed-job payloads in Redis 7 days (was 30).
- Request log serializer logs the path only (invite tokens / OAuth codes were
  in the query string).
- HubSpot SDK errors reduced to status + category + short message before
  they reach `job_steps.error`, `failedReason`, SSE or the UI.
- Public quote links, Phobs booking URLs, per-day price breakdowns and full
  HubDB rows no longer persisted; migration 0005 scrubs existing rows.
- Loyalty access code vaulted (migration 0005 + maintenance re-seal).
- OTel instrumentation configured not to export Redis command arguments or
  HTTP query strings.
- `eraseDeal` CLI + `job_steps.deal_id` index.
- Correctness: HubSpot 401 now forces a token refresh and retries instead of
  dead-lettering; malformed input is a `ValidationError` (no retries); a
  resumed job re-polls a missing quote link and only reuses a quote built
  from the same line items; job attempts 8 → 4; TOTP step update is atomic;
  `PUBLIC_BASE_URL` trailing slash tolerated; `sync-line-items` DO function
  requires `API_TOKEN`.

## 3. Known gaps (deliberately left)

- Workflow-extension JWT verification is unvalidated against a live HubSpot
  custom action (see §1.1).
- `TOKEN_VAULT_KEY_PREV` allows decrypting old ciphertext during rotation,
  but there is no re-encrypt CLI yet, so PREV can't be retired automatically.
- The admin UI is not linted (eslint ignores `web/**`); no browser e2e tests.
- Activity page has no pagination (last 100 rows, 10 s polling).
- `ADMIN_IP_ALLOWLIST` is process-wide; per-tenant admin IP restrictions
  exist only for webhooks and API tokens.
- No email sending — quote delivery is a HubSpot workflow reading
  `quote_link_custom`, as designed.
