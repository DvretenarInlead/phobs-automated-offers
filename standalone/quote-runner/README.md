# Quote Runner (standalone)

A single-tenant, self-contained Node service. POST a booking payload, get back a
HubSpot quote for the matching Phobs rate. No queue, no database, no Redis —
just an HTTP endpoint that runs the pipeline synchronously and returns the
result.

Use this when you want a portable service you can drop on Cloud Run, AWS
Lambda (behind a URL adapter), Fly, a VPS, or `node server.js` on your laptop.
For the full multi-tenant app with admin UI, audit logs, retries, and
per-tenant credential vault, use the main project in this repo instead.

## What it does

For a given HubSpot deal + booking (property, dates, guests):

1. Calls **Phobs `PCPropertyAvailabilityRQ`** and parses the XML response.
2. Sorts the returned rate × unit pairs by price ascending (drops
   zero-availability and zero-price rows). Optionally caps to `maxResults`.
3. **Upserts a HubSpot product** for each selected rate (`hs_sku` =
   `<propertyId>:<unitId>:<rateId>`).
4. **Creates a HubSpot line item** for each product, associated to the deal.
5. **Creates a HubSpot quote** from the configured template, associates it to
   the deal + all line items, sets `hs_status = APPROVED`, then polls for
   `hs_quote_link` (up to 10s).
6. Writes `quote_id`, `quote_link_custom`, `phobs_availability_status` back to
   the deal (best-effort; set `QUOTE_WRITEBACK_STATUS=false` to skip).
7. Returns the quote id, link, and the list of line items in the HTTP
   response.

## Install & run

Requires Node 20+.

```bash
cd standalone/quote-runner
cp .env.example .env      # fill in secrets
npm install
npm start                 # listens on $PORT (default 8080)
```

## Endpoint

```
POST /run
Content-Type: application/json
Authorization: Bearer <API_TOKEN>     # only if API_TOKEN is set in env
```

### Request body

```json
{
  "dealId": "12345",             // HubSpot deal to attach the quote to
  "propertyId": "P1",            // Phobs property id
  "checkInDate": "2026-07-20",   // YYYY-MM-DD
  "nights": 5,
  "adults": 2,
  "childAges": [8, 3],           // optional
  "unitIds": ["U1", "U2"],       // optional filter (else all units)
  "lang": "en",                  // optional (Phobs Lang)
  "accessCode": "LOY-42",        // optional (loyalty rates)
  "currency": "EUR",             // optional; falls back to Phobs response
  "title": "Your offer",         // optional; a default is generated
  "expirationDays": 3,           // optional; falls back to env
  "maxResults": 5                // optional cap on line items
}
```

### Response — success

```json
{
  "ok": true,
  "quote": {
    "id": "1234567890",
    "link": "https://app.hubspot.com/documents/.../view",
    "expirationDate": "2026-07-23"
  },
  "lineItems": [
    {
      "id": "9876543210",
      "productId": "555",
      "name": "Deluxe Suite — Bed & Breakfast",
      "quantity": 5,
      "price": 240,
      "currency": "EUR",
      "unitId": "U1",
      "rateId": "R-BB"
    }
  ],
  "rates": { "found": 12, "selected": 3 },
  "latencyMs": 4213
}
```

### Response — no availability

```json
{
  "ok": true,
  "outcome": "no_availability",
  "rates": { "found": 0, "selected": 0 },
  "latencyMs": 1810
}
```

### Response — error

```json
{
  "error": "phobs_error",
  "message": "..."
}
```

Status codes: 200 (ok / no_availability), 400 (validation), 401 (bad token),
413 (payload > 128 KiB), 500 (missing env), 502 (upstream Phobs or HubSpot
error).

## Example call

```bash
curl -sS -X POST http://localhost:8080/run \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "dealId": "12345",
    "propertyId": "P1",
    "checkInDate": "2026-07-20",
    "nights": 5,
    "adults": 2,
    "childAges": [8],
    "maxResults": 3
  }' | jq .
```

## Env vars

See `.env.example`. Required: `PHOBS_ENDPOINT`, `PHOBS_SITE_ID`,
`PHOBS_USERNAME`, `PHOBS_PASSWORD`, `HUBSPOT_ACCESS_TOKEN`,
`HUBSPOT_QUOTE_TEMPLATE_ID`. Optional: `HUBSPOT_OWNER_ID`,
`QUOTE_EXPIRATION_DAYS`, `QUOTE_DEFAULT_CURRENCY`, `QUOTE_WRITEBACK_STATUS`,
`PORT`, `API_TOKEN`.

## HubSpot Private App scopes

Grant your Private App:

- `crm.objects.deals.read`, `crm.objects.deals.write`
- `crm.objects.products.read`, `crm.objects.products.write`
- `crm.objects.line_items.read`, `crm.objects.line_items.write`
- `crm.objects.quotes.read`, `crm.objects.quotes.write`
- `e-commerce` (some accounts need this for `hs_sku` search on products)

## Health check

```
GET /healthz  →  200 { "ok": true }
```

Use for load-balancer health probes. Does not verify Phobs/HubSpot
connectivity.

## Security notes

- Bearer token on `/run` is compared with a timing-safe equality check. If
  `API_TOKEN` is unset the endpoint is open — put your own auth (mTLS, Cloud
  Run IAM, API Gateway, etc.) in front, or set the token.
- Body cap is 128 KiB — booking payloads are typically < 1 KiB.
- The Phobs endpoint must be `https://`. External-entity resolution is
  disabled in the XML parser (no XXE).
- No secrets are ever echoed in responses. `latencyMs` is included so you can
  spot Phobs/HubSpot degradation.

## What's intentionally missing

Compared to the full app in this repo:

- No retries — a single 5xx from HubSpot fails the whole request. Wrap the
  caller in your own retry if you need it.
- No idempotency — calling `/run` twice with the same `dealId` creates two
  quotes.
- No rate filters (board/rate-id exclusion, min-availability, etc.). Selection
  is just "sort by price, cap at maxResults".
- No child-age rule normalization. Send `childAges` already normalized.
- No BullMQ worker, no Redis, no audit log, no live monitoring, no per-tenant
  vault.

If you find yourself needing any of these, use the main app.
