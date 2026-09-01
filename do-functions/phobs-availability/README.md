# Phobs DigitalOcean Functions

Two **self-contained** Node.js webhook handlers, deployed together as one DO
Functions project:

| Action | What it does |
| --- | --- |
| `phobs/availability` | Read-only probe: queries Phobs `PCPropertyAvailabilityRQ`, returns the parsed rates as JSON. No HubSpot. |
| `phobs/sync-line-items` | Availability sync + writes: queries Phobs, picks the best offers, **upserts HubSpot products and creates line items on a deal**. No quote (see `standalone/quote-runner` for that). |

Credentials (`PHOBS_*`, `HUBSPOT_ACCESS_TOKEN`) live in the function's
**environment**, never in the request body or response.

## Layout

```
phobs-availability/
├── project.yml                                # DO Functions project spec (both actions)
├── .env.example                               # copy to .env, fill, deploy
└── packages/phobs/
    ├── availability/
    │   ├── index.js                           # read-only probe handler
    │   ├── package.json                       # only dep: fast-xml-parser
    │   └── example-input.json
    └── sync-line-items/
        ├── index.js                           # availability → products → line items
        ├── package.json                       # only dep: fast-xml-parser
        └── example-input.json
```

Once deployed the actions are at:

```
POST https://<namespace>.doserverless.co/api/v1/web/fn-<id>/phobs/availability
POST https://<namespace>.doserverless.co/api/v1/web/fn-<id>/phobs/sync-line-items
```

## Local testing (before deploy)

```bash
cd packages/phobs/availability
npm install

export PHOBS_ENDPOINT='https://YOUR-PHOBS-HOST.phobs.net/PATH'
export PHOBS_SITE_ID='...'
export PHOBS_USERNAME='...'
export PHOBS_PASSWORD='...'

node index.js "$(cat example-input.json)"
```

Sample output:

```json
{
  "statusCode": 200,
  "body": {
    "ok": true,
    "sessionId": "431va4nr7ert8rufmm407jglje",
    "error": null,
    "rateCount": 4,
    "unitCount": 4,
    "latencyMs": 1123,
    "rates": [
      {
        "rateId": "RATE525802",
        "name": "2| Posebna cijena…",
        "units": [
          {
            "unitId": "17173",
            "name": "Obiteljska soba plus, morska strana, balkon",
            "board": "HB",
            "pricePerNight": 620.21,
            "stayTotal": 3876.33,
            "currency": "EUR",
            "availableUnits": 1,
            "occupancy": { "max": 5, "min": 2, "current": 2, "maxAdult": 4, "maxChdAge": 13 },
            "bookUrl": "book.php?…",
            "priceBreakdown": [ { "date": "2026-07-20", "price": 631.84 }, … ]
          }
        ],
        "stayMinNights": 1
      }
    ]
  }
}
```

## Deploy to DigitalOcean Functions

```bash
# One-time
doctl serverless install
doctl serverless connect

# From this folder
cp .env.example .env         # fill in real values (.env is gitignored)
doctl serverless deploy . --env .env

# Grab the invoke URL
doctl serverless functions get phobs/availability --url
```

Invoke over HTTPS:

```bash
URL=$(doctl serverless functions get phobs/availability --url)
curl -sS -X POST "$URL" \
  -H 'content-type: application/json' \
  -d @packages/phobs/availability/example-input.json | jq
```

Or via `doctl` directly (no HTTPS round-trip):

```bash
doctl serverless functions invoke phobs/availability \
  --param-file packages/phobs/availability/example-input.json
```

Rotate creds later without redeploying code:

```bash
# Edit .env, then:
doctl serverless deploy . --env .env
# or, via the UI: Functions -> namespace -> phobs -> Environment Variables
```

## Environment variables (function-side)

| Var | Required | Notes |
| --- | --- | --- |
| `PHOBS_ENDPOINT` | ✓ | Must be `https://…`. Enforced at request time. |
| `PHOBS_SITE_ID` | ✓ | Goes into `<Auth><SiteId>` |
| `PHOBS_USERNAME` | ✓ | Goes into `<Auth><Username>` |
| `PHOBS_PASSWORD` | ✓ | Goes into `<Auth><Password>` |
| `API_TOKEN` | ✓ | Bearer token callers must present. Generate with `openssl rand -base64 32`. |
| `HUBSPOT_ACCESS_TOKEN` | sync-line-items | HubSpot Private App token |
| `WRITEBACK_STATUS` | ○ | `false` to skip the deal status writeback (sync-line-items) |

Credentials are read from the environment only. `endpoint` / `siteId` /
`username` / `password` fields in the request body are ignored, so a caller
can neither redirect the function to another host nor substitute their own
Phobs account.

## Input schema (request body)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `propertyId` | string | ✓ | Phobs property ID |
| `checkInDate` | string `YYYY-MM-DD` | ✓ | |
| `nights` | number ≥ 1 | ✓ | |
| `adults` | number ≥ 0 | ✓ | |
| `childAges` | number[] | ○ | Empty array or omit if no children |
| `unitIds` | string[] | ○ | If set, restricts to these units |
| `lang` | string | ○ | Defaults to `en` |
| `accessCode` | string | ○ | Loyalty / partner access code |
| `includeRestricted` | bool | ○ | Defaults to `false` |
| `timeoutMs` | number | ○ | HTTP timeout, default 15000 |
| `includeRawXml` | bool | ○ | Include the raw *response* XML (first 50 kB) for shape debugging. The request XML is never returned — it contains the credentials. |

Both actions require `Authorization: Bearer <API_TOKEN>` (see env table). The
`availability` action refuses to run at all (`500 server_misconfigured`) when
`API_TOKEN` is unset, so a deploy can never accidentally expose an open Phobs
relay.

## Output

- `statusCode: 200` — Phobs answered; `body.ok` reflects `<ResponseType><Success/>`
- `statusCode: 400` — input validation failed; `body.details` lists missing / bad fields (env vars named explicitly if not set)
- `statusCode: 502` — network error, upstream 4xx/5xx, or unparseable XML

## phobs/sync-line-items — webhook that creates line items

Everything above describes the read-only `availability` probe. The
`sync-line-items` action shares the same Phobs input fields and adds a HubSpot
write leg: after fetching availability it drops zero-availability /
zero-price rows, sorts by price ascending, caps at `maxResults`, then for
each remaining offer upserts a product (`hs_sku` =
`propertyId:unitId:rateId`) and creates a line item associated to `dealId`.
Finally it writes `phobs_availability_status` (`available` /
`no_availability`) back to the deal (disable with env
`WRITEBACK_STATUS=false`).

### Webhook payload

```json
{
  "dealId": "12345678901",
  "propertyId": "P1",
  "checkInDate": "2026-07-20",
  "nights": 5,
  "adults": 2,
  "childAges": [8, 3],
  "unitIds": ["17173", "17174"],
  "accessCode": "LOY-42",
  "lang": "en",
  "maxResults": 5
}
```

Required: `dealId`, `propertyId`, `checkInDate`, `nights`, `adults`.
Optional: `childAges`, `unitIds`, `accessCode`, `lang`, `includeRestricted`,
`maxResults`, `timeoutMs`.

### Invoke

```bash
URL=$(doctl serverless functions get phobs/sync-line-items --url)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' \
  -d @packages/phobs/sync-line-items/example-input.json | jq
```

### Response

```json
{
  "ok": true,
  "dealId": "12345678901",
  "rates": { "found": 12, "selected": 3 },
  "lineItems": [
    {
      "id": "9876543210",
      "productId": "555",
      "productCreated": false,
      "sku": "P1:17173:RATE525802",
      "name": "Obiteljska soba plus — Posebna cijena",
      "quantity": 5,
      "pricePerNight": 620.21,
      "stayTotal": 3101.05,
      "currency": "EUR",
      "board": "HB",
      "unitId": "17173",
      "rateId": "RATE525802"
    }
  ],
  "latencyMs": 5210
}
```

No availability → `200` with `"outcome": "no_availability"` and an empty
`lineItems` array. HubSpot failures → `502` with `createdLineItems` listing
whatever was created before the failure (calls are sequential, so a partial
run is visible, not silent).

### Auth + extra env

Set `API_TOKEN` in the function env and every call must carry
`Authorization: Bearer <API_TOKEN>` (timing-safe comparison; `401` otherwise).
`HUBSPOT_ACCESS_TOKEN` must be a Private App token with scopes:
`crm.objects.deals.write`, `crm.objects.products.read/write`,
`crm.objects.line_items.write`, `e-commerce`.

Note: there is no idempotency — firing the webhook twice for the same deal
creates a second set of line items.

## Security notes

- Credentials never round-trip through the request body in production.
- The function keeps no state; credentials only exist in memory during an
  invocation (plus the DO Functions env store, which is encrypted at rest).
- The XML parser is configured with `processEntities: false`, so hostile
  responses containing external entities (`<!DOCTYPE … [<!ENTITY xxe SYSTEM
  …>]>`) fail fast instead of exfiltrating files. Same defence as the main
  service.
- The request XML (which contains the credentials) is never echoed. Only the
  raw *response* can be returned, and only when `includeRawXml` is set.
- Both actions are gated by `API_TOKEN` (timing-safe bearer compare). You can
  additionally set `webSecure: true` in `project.yml` and pass
  `X-Require-Whisk-Auth: <secret>` for a second, platform-level gate.
- Array inputs are typed strictly (`childAges`: numbers 0–17, `unitIds`:
  strings) and capped, so a caller cannot smuggle nested elements into the
  XML through the builder.
