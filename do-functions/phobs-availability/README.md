# Phobs availability probe — DigitalOcean Function

A **self-contained** Node.js handler that queries a Phobs
`PCPropertyAvailabilityRQ` endpoint and returns the parsed response as JSON.
Zero coupling to the main service — no DB, no queue, no HubSpot. Handy for
isolating Phobs integration issues.

Credentials (`PHOBS_ENDPOINT`, `PHOBS_SITE_ID`, `PHOBS_USERNAME`,
`PHOBS_PASSWORD`) live in the function's **environment**, never in the
request body or response.

## Layout

```
phobs-availability/
├── project.yml                                # DO Functions project spec
├── .env.example                               # copy to .env, fill, deploy
└── packages/phobs/availability/
    ├── index.js                               # the handler
    ├── package.json                           # only dep: fast-xml-parser
    └── example-input.json                     # only the query params, no creds
```

Once deployed the action is at:

```
POST https://<namespace>.doserverless.co/api/v1/web/fn-<id>/phobs/availability
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

The handler ignores any `endpoint` / `siteId` / `username` / `password`
fields that appear in the request body **if** the env var is set. This makes
it impossible to override credentials by injecting them via query string.

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
| `debug` | bool | ○ | Include the request XML in the response (**leaks credentials — dev only**) |

## Output

- `statusCode: 200` — Phobs answered; `body.ok` reflects `<ResponseType><Success/>`
- `statusCode: 400` — input validation failed; `body.details` lists missing / bad fields (env vars named explicitly if not set)
- `statusCode: 502` — network error, upstream 4xx/5xx, or unparseable XML

## Security notes

- Credentials never round-trip through the request body in production.
- The function keeps no state; credentials only exist in memory during an
  invocation (plus the DO Functions env store, which is encrypted at rest).
- The XML parser is configured with `processEntities: false`, so hostile
  responses containing external entities (`<!DOCTYPE … [<!ENTITY xxe SYSTEM
  …>]>`) fail fast instead of exfiltrating files. Same defence as the main
  service.
- Don't leave `"debug": true` in production input — it echoes the request XML
  (which contains the credentials) in the response.
- For long-lived exposure over HTTPS, set `webSecure: true` in `project.yml`
  and pass `X-Require-Whisk-Auth: <secret>` on every call.
