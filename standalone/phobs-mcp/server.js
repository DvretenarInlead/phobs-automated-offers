#!/usr/bin/env node
/**
 * phobs-mcp — MCP server (stdio) exposing three tools:
 *
 *   phobs_check_availability   PCPropertyAvailabilityRQ → parsed rates
 *   phobs_price_quote          PCPriceQuoteRQ → parsed price quote
 *   phobs_sync_line_items      availability → HubSpot products + line items
 *
 * Credentials come from env (set them in the MCP client config, never in
 * tool arguments):
 *   PHOBS_ENDPOINT, PHOBS_SITE_ID, PHOBS_USERNAME, PHOBS_PASSWORD
 *   PHOBS_PRICEQUOTE_ENDPOINT   optional — defaults to PHOBS_ENDPOINT
 *   HUBSPOT_ACCESS_TOKEN        only needed for phobs_sync_line_items
 *   WRITEBACK_STATUS=false      optional — skip the deal status writeback
 *
 * Register in Claude Code (.mcp.json) or Claude Desktop — see README.md.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchAvailability, fetchPriceQuote } from './phobs.js';
import { upsertProductBySku, createLineItem, updateDealProperties } from './hubspot.js';

// ---------- env ------------------------------------------------------------

function phobsCreds() {
  const creds = {
    endpoint: process.env.PHOBS_ENDPOINT || '',
    priceQuoteEndpoint: process.env.PHOBS_PRICEQUOTE_ENDPOINT || '',
    siteId: process.env.PHOBS_SITE_ID || '',
    username: process.env.PHOBS_USERNAME || '',
    password: process.env.PHOBS_PASSWORD || '',
  };
  const missing = [];
  if (!creds.endpoint) missing.push('PHOBS_ENDPOINT');
  if (!creds.siteId) missing.push('PHOBS_SITE_ID');
  if (!creds.username) missing.push('PHOBS_USERNAME');
  if (!creds.password) missing.push('PHOBS_PASSWORD');
  if (missing.length > 0) {
    throw Object.assign(new Error(`missing env: ${missing.join(', ')}`), {
      code: 'server_misconfigured',
    });
  }
  return creds;
}

function hubspotToken() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN || '';
  if (!token) {
    throw Object.assign(new Error('missing env: HUBSPOT_ACCESS_TOKEN'), {
      code: 'server_misconfigured',
    });
  }
  return token;
}

// ---------- shared input shapes -------------------------------------------

const stayShape = {
  propertyId: z.string().min(1).describe('Phobs property ID'),
  checkInDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Check-in date, YYYY-MM-DD'),
  nights: z.number().int().min(1).describe('Number of nights'),
  adults: z.number().int().min(0).describe('Number of adults'),
  childAges: z.array(z.number()).optional().describe('Ages of children, one entry per child'),
  accessCode: z.string().optional().describe('Loyalty / partner access code for special rates'),
  lang: z.string().optional().describe('Response language, default en'),
  includeRestricted: z.boolean().optional().describe('Include restricted rates, default false'),
  timeoutMs: z.number().int().min(1000).max(60000).optional().describe('Phobs HTTP timeout'),
  includeRawXml: z
    .boolean()
    .optional()
    .describe('Include the raw response XML in the result (debugging)'),
};

// ---------- result helpers -------------------------------------------------

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(err) {
  const body = {
    error: err.code || 'error',
    message: err.message,
  };
  if (err.upstreamStatus) body.upstreamStatus = err.upstreamStatus;
  if (err.upstreamBody) body.upstreamBody = err.upstreamBody;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}

function selectOffers(rates, maxResults) {
  const flat = [];
  for (const rate of rates) {
    for (const unit of rate.units) {
      if (unit.availableUnits <= 0) continue;
      if (unit.pricePerNight <= 0) continue;
      flat.push({ rate, unit });
    }
  }
  flat.sort((a, b) => a.unit.pricePerNight - b.unit.pricePerNight);
  return flat.slice(0, maxResults ?? flat.length);
}

// ---------- server ---------------------------------------------------------

const server = new McpServer({ name: 'phobs', version: '1.0.0' });

server.registerTool(
  'phobs_check_availability',
  {
    title: 'Check Phobs availability',
    description:
      'Query Phobs PCPropertyAvailabilityRQ for a property and stay. Returns rate plans with units, ' +
      'per-night prices, stay totals, currency, board, availability counts and per-day price breakdowns. ' +
      'Read-only — makes no changes anywhere.',
    inputSchema: {
      ...stayShape,
      unitIds: z
        .array(z.string())
        .optional()
        .describe('Restrict the query to these Phobs unit IDs'),
    },
  },
  async (args) => {
    try {
      const creds = phobsCreds();
      const result = await fetchAvailability(creds, args);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'phobs_price_quote',
  {
    title: 'Get a Phobs price quote',
    description:
      'Query Phobs PCPriceQuoteRQ for a specific stay — typically one unit and rate. Returns a flattened ' +
      '`quote` (rate, unit, per-night price, stay total, currency, per-day breakdown) plus the full parsed ' +
      'rate list and the raw parsed document under `raw`. Read-only. Set includeRawXml:true when the parsed ' +
      'shape looks wrong so the raw response can be inspected.',
    inputSchema: {
      ...stayShape,
      rateId: z.string().optional().describe('Phobs rate ID to quote (empty = all rates)'),
      unitId: z.string().optional().describe('Phobs unit ID to quote'),
    },
  },
  async (args) => {
    try {
      const creds = phobsCreds();
      const result = await fetchPriceQuote(creds, args);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'phobs_sync_line_items',
  {
    title: 'Sync Phobs availability into HubSpot line items',
    description:
      'WRITES TO HUBSPOT. Fetches Phobs availability for a stay, selects offers (drops unavailable and ' +
      'zero-price rows, sorts by price ascending, caps at maxResults), upserts a HubSpot product per offer ' +
      '(hs_sku = propertyId:unitId:rateId), creates a line item per offer associated to the given deal, and ' +
      'writes phobs_availability_status back to the deal. Returns the created line items. Not idempotent — ' +
      'calling twice for the same deal creates a second set of line items.',
    inputSchema: {
      ...stayShape,
      dealId: z.string().min(1).describe('HubSpot deal ID to attach line items to'),
      unitIds: z
        .array(z.string())
        .optional()
        .describe('Restrict the query to these Phobs unit IDs'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Cap on how many line items to create'),
    },
  },
  async (args) => {
    const started = Date.now();
    try {
      const creds = phobsCreds();
      const token = hubspotToken();
      const writeback = process.env.WRITEBACK_STATUS !== 'false';

      const availability = await fetchAvailability(creds, args);
      if (!availability.success) {
        return fail(
          Object.assign(new Error(availability.error || 'phobs returned no Success'), {
            code: 'phobs_error',
          }),
        );
      }

      const selected = selectOffers(availability.rates, args.maxResults);
      const ratesFound = availability.rates.reduce((sum, r) => sum + r.units.length, 0);

      if (selected.length === 0) {
        if (writeback) {
          try {
            await updateDealProperties(token, args.dealId, {
              phobs_availability_status: 'no_availability',
            });
          } catch {
            // best-effort
          }
        }
        return ok({
          ok: true,
          outcome: 'no_availability',
          rates: { found: ratesFound, selected: 0 },
          lineItems: [],
          latencyMs: Date.now() - started,
        });
      }

      const lineItems = [];
      try {
        for (const sel of selected) {
          const sku = `${args.propertyId}:${sel.unit.unitId}:${sel.rate.rateId}`;
          const product = await upsertProductBySku(token, {
            sku,
            name: `${sel.unit.name} — ${sel.rate.name}`,
            description: sel.rate.shortDescription,
            price: sel.unit.pricePerNight,
          });
          const li = await createLineItem(token, {
            productId: product.id,
            dealId: args.dealId,
            name: `${sel.unit.name} — ${sel.rate.name}`,
            quantity: args.nights,
            price: sel.unit.pricePerNight,
            description: sel.rate.shortDescription,
          });
          lineItems.push({
            id: li.id,
            productId: product.id,
            productCreated: product.created,
            sku,
            name: `${sel.unit.name} — ${sel.rate.name}`,
            quantity: args.nights,
            pricePerNight: sel.unit.pricePerNight,
            stayTotal: sel.unit.stayTotal,
            currency: sel.unit.currency,
            board: sel.unit.board,
            unitId: sel.unit.unitId,
            rateId: sel.rate.rateId,
          });
        }
      } catch (err) {
        // Partial progress is real state in the CRM — report it, don't hide it.
        err.upstreamBody = { createdLineItems: lineItems, cause: err.upstreamBody };
        return fail(err);
      }

      if (writeback) {
        try {
          await updateDealProperties(token, args.dealId, {
            phobs_availability_status: 'available',
          });
        } catch {
          // best-effort
        }
      }

      return ok({
        ok: true,
        dealId: args.dealId,
        rates: { found: ratesFound, selected: selected.length },
        lineItems,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// ---------- start ----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[phobs-mcp] ready (stdio)');
