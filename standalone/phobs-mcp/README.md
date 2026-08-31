# phobs-mcp — MCP server for Phobs + HubSpot line-item sync

An MCP (Model Context Protocol) server over stdio that lets Claude (Claude
Code, Claude Desktop, or any MCP client) call Phobs and sync results into
HubSpot as tools in a conversation.

## Tools

| Tool | Writes? | What it does |
| --- | --- | --- |
| `phobs_check_availability` | no | `PCPropertyAvailabilityRQ` → rate plans with units, prices, stay totals, per-day breakdowns |
| `phobs_price_quote` | no | `PCPriceQuoteRQ` for a specific unit/rate → flattened `quote` + full parsed response |
| `phobs_sync_line_items` | **HubSpot** | availability → select offers (price-sorted, capped) → upsert products by `hs_sku` → create line items on a deal → status writeback |

## Install

Requires Node 20+.

```bash
cd standalone/phobs-mcp
npm install
```

## Register in Claude Code

Add to your project's `.mcp.json` (or `claude mcp add`):

```json
{
  "mcpServers": {
    "phobs": {
      "command": "node",
      "args": ["/absolute/path/to/standalone/phobs-mcp/server.js"],
      "env": {
        "PHOBS_ENDPOINT": "https://YOUR-PHOBS-HOST.phobs.net/PATH",
        "PHOBS_SITE_ID": "...",
        "PHOBS_USERNAME": "...",
        "PHOBS_PASSWORD": "...",
        "HUBSPOT_ACCESS_TOKEN": "..."
      }
    }
  }
}
```

## Register in Claude Desktop

Same block in `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`).

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `PHOBS_ENDPOINT` | ✓ | Must be `https://…` |
| `PHOBS_SITE_ID` | ✓ | `<Auth><SiteId>` |
| `PHOBS_USERNAME` | ✓ | `<Auth><Username>` |
| `PHOBS_PASSWORD` | ✓ | `<Auth><Password>` |
| `PHOBS_PRICEQUOTE_ENDPOINT` | ○ | If PCPriceQuoteRQ posts to a different URL than availability; defaults to `PHOBS_ENDPOINT` |
| `HUBSPOT_ACCESS_TOKEN` | ○ | Only for `phobs_sync_line_items`. Private App token with `crm.objects.deals.write`, `crm.objects.products.read/write`, `crm.objects.line_items.write`, `e-commerce` |
| `WRITEBACK_STATUS` | ○ | Set `false` to skip writing `phobs_availability_status` to the deal |

Credentials only ever live in env — tool arguments never carry them, and
responses never echo them.

## Example tool arguments

`phobs_check_availability` / base shape shared by all tools:

```json
{
  "propertyId": "P1",
  "checkInDate": "2026-07-20",
  "nights": 5,
  "adults": 2,
  "childAges": [8, 3],
  "unitIds": ["17173"],
  "accessCode": "LOY-42",
  "lang": "en"
}
```

`phobs_price_quote` adds:

```json
{ "rateId": "RATE525802", "unitId": "17173" }
```

`phobs_sync_line_items` adds:

```json
{ "dealId": "12345678901", "maxResults": 5 }
```

## A note on PCPriceQuoteRQ

The availability request/response shapes in this repo were validated against
a live Phobs endpoint; the price-quote pair was not (nothing in the legacy
Make.com scenario used it). The request mirrors Phobs PC API conventions —
same `<Auth>` and `<UnitFilter>` blocks with the root element swapped to
`PCPriceQuoteRQ` and a concrete `RateId`/`UnitId`. The response parser is
deliberately defensive:

- accepts `PCPriceQuoteRS` or any `*RS` root
- looks for rate plans on the root and in `PriceQuoteList` / `QuoteList` /
  `AvailabilityList` containers
- always returns the full parsed document under `raw`, and the raw XML too
  when called with `"includeRawXml": true`

If the first live call shows a different shape, the `raw` payload is enough
to adjust `parsePriceQuoteResponse` in `phobs.js` in one place.

## Local smoke test

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | node server.js
```

Expect an `initialize` result, then a `tools/list` result naming the three
tools. Tool calls without env return `isError` with the missing var names.

## Security notes

- `phobs_sync_line_items` writes to your CRM and is **not idempotent** —
  approve its calls deliberately; two calls for the same deal create two
  sets of line items.
- XML parsing has external entities disabled (no XXE), endpoints must be
  HTTPS, and upstream error bodies are truncated to 2 000 chars.
