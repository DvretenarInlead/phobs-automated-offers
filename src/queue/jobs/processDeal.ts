import type { Job } from 'bullmq';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { writeAudit, writeJobStep } from '../../lib/audit.js';
import { loadTenantContext } from '../../tenancy/config.js';
import { normalizeChildAges } from '../../tenancy/childAgeRules.js';
import { applyRateFilters } from '../../tenancy/rateFilters.js';
import {
  coerceFloat,
  coerceInt,
  evaluateSkip,
  readMapped,
  renderTemplate,
  shouldAttachLoyalty,
} from '../../tenancy/overrides.js';
import { getHubSpotClient } from '../../hubspot/client.js';
import { updateDeal } from '../../hubspot/deals.js';
import { queryUnitsByPropertyId } from '../../hubspot/hubdb.js';
import { upsertProductBySku } from '../../hubspot/products.js';
import { createLineItem } from '../../hubspot/lineItems.js';
import { createApprovedQuote } from '../../hubspot/quotes.js';
import { fetchAvailability } from '../../phobs/client.js';
import { liveEmit } from '../../lib/liveEmit.js';
import { jobProcessed, jobStepDuration } from '../../metrics/index.js';
import type { ProcessDealPayload } from '../index.js';

// Payload shape is intentionally permissive — tenants may rename HubSpot
// properties, and the input_field_map override tells us which JSON key holds
// which logical value. We only require *something* addressable as the deal.
const permissiveItem = z.record(z.string(), z.unknown());
const payloadSchema = z.union([z.array(permissiveItem).min(1), permissiveItem]);

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().split('T')[0]!;
}

// Safe stringification for values that may come from arbitrary webhook JSON
// (undefined → '', objects/arrays → '' rather than '[object Object]').
function safeStr(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}

export async function processDealJob(job: Job<ProcessDealPayload>): Promise<unknown> {
  const { hubId: hubIdStr, requestId } = job.data;
  const hubId = BigInt(hubIdStr);
  const jobId = job.id ?? 'no-id';

  const parsed = payloadSchema.parse(job.data.rawPayload);
  const item = Array.isArray(parsed) ? parsed[0]! : parsed;

  // ---- Step 1: load tenant context (contains resolved overrides) ------------
  const tenant = await runStep(jobId, hubId, 0n, 1, 'load_tenant', async () => {
    return loadTenantContext(hubId);
  });

  const ov = tenant.overrides;
  const ifm = ov.input_field_map;

  const dealIdRaw = readMapped(item, ifm.deal_id);
  if (dealIdRaw === undefined) {
    throw new Error(`processDeal: missing input field '${ifm.deal_id}' (deal_id)`);
  }
  const dealId =
    typeof dealIdRaw === 'bigint'
      ? dealIdRaw
      : BigInt(safeStr(dealIdRaw) || '0');
  const log = logger.child({ jobId, hubId: hubIdStr, dealId: dealId.toString(), requestId });
  log.info('processDeal start');

  // ---- Step 2: skip conditions ---------------------------------------------
  const skipVerdict = evaluateSkip(item, ov.skip_conditions);
  if (skipVerdict.skip) {
    await writeJobStep({
      jobId,
      hubId,
      dealId,
      step: 'skip_conditions',
      stepIndex: 2,
      status: 'skipped',
      input: { conditions: ov.skip_conditions },
      output: { matched: skipVerdict.matched },
    });
    log.info({ matched: skipVerdict.matched }, 'processDeal skipped by rule');
    await writeAudit({
      hubId,
      dealId,
      requestId,
      kind: 'process_deal.skipped',
      status: 'ok',
      response: { matched: skipVerdict.matched },
    });
    return { acknowledged: true, outcome: 'skipped', matched: skipVerdict.matched };
  }

  // ---- Step 3: apply child-age rules ---------------------------------------
  const childAges = ifm.child_ages
    .map((k) => coerceFloat(readMapped(item, k)))
    .filter((n) => n > 0);

  const adultsInput = coerceInt(readMapped(item, ifm.adults, ifm.fallback_adults), 0);
  const propertyId = safeStr(readMapped(item, ifm.property_id));
  if (!propertyId) throw new Error(`processDeal: missing '${ifm.property_id}' (property_id)`);

  const norm = normalizeChildAges({
    childAges,
    adults: adultsInput,
    propertyId,
    rules: tenant.propertyRules,
  });
  await writeJobStep({
    jobId,
    hubId,
    dealId,
    step: 'normalize_ages',
    stepIndex: 3,
    status: norm.unknownProperty ? 'skipped' : 'ok',
    input: { childAges, adults: adultsInput, propertyId },
    output: norm,
  });

  // Update deal child age slots + adult/child counts — via output_field_map.
  const ofm = ov.output_field_map;
  const dealProps: Record<string, string> = {};
  for (let i = 0; i < ofm.child_age_slots.length; i++) {
    const key = ofm.child_age_slots[i]!;
    const v = norm.childAges[i];
    dealProps[key] = v != null ? v.toString() : '';
  }
  dealProps[ofm.adults] = norm.adults.toString();
  dealProps[ofm.num_children] = norm.numberOfChildren.toString();

  // ---- Step 4: HubSpot client + write normalized deal ----------------------
  const hs = await getHubSpotClient(hubId);
  await runStep(jobId, hubId, dealId, 4, 'deal.update.normalized', async () => {
    await updateDeal(hs, dealId, dealProps);
    return { properties: dealProps };
  });

  // ---- Step 5: HubDB unit lookup -------------------------------------------
  const units = await runStep(jobId, hubId, dealId, 5, 'hubdb.query', () =>
    queryUnitsByPropertyId(hs, tenant.hubdbTableId, tenant.hubdbColumnMap, propertyId),
  );

  // ---- Step 6: Phobs availability ------------------------------------------
  const checkInMs = coerceInt(readMapped(item, ifm.check_in_ms));
  const nightsMs = coerceInt(readMapped(item, ifm.nights_ms));
  const nights = Math.max(1, Math.round(nightsMs / 86_400_000));
  const lang = safeStr(readMapped(item, ifm.language)) || ov.default_lang;
  const attachLoyalty = shouldAttachLoyalty(item, ov.loyalty_rule);

  const availability = await runStep(jobId, hubId, dealId, 6, 'phobs.availability', () =>
    fetchAvailability(
      { endpoint: tenant.phobs.endpoint },
      {
        lang,
        propertyId,
        date: fmtDate(checkInMs),
        nights,
        unitIds: units.map((u) => u.unitId),
        adults: norm.adults,
        childAges: norm.childAges,
        accessCode: attachLoyalty ? (tenant.accessCode ?? undefined) : undefined,
        auth: {
          siteId: tenant.phobs.siteId,
          username: tenant.phobs.username,
          password: tenant.phobs.password,
        },
      },
    ),
  );

  // ---- Step 7: apply rate filters ------------------------------------------
  const filtered = applyRateFilters(availability.rates, tenant.rateFilters);
  await writeJobStep({
    jobId,
    hubId,
    dealId,
    step: 'rate_filters',
    stepIndex: 7,
    status: 'ok',
    input: { rateFilters: tenant.rateFilters, ratesIn: availability.rates.length },
    output: { selectedCount: filtered.selected.length, trace: filtered.trace },
  });
  liveEmit('filter', hubId, {
    ts: Date.now(),
    type: 'rate_filters',
    hubId: hubId.toString(),
    dealId: dealId.toString(),
    jobId,
    data: { in: availability.rates.length, kept: filtered.selected.length, trace: filtered.trace },
  });

  if (filtered.selected.length === 0) {
    log.info('no availability after filtering — marking deal silently');
    await runStep(jobId, hubId, dealId, 8, 'deal.no_availability', async () => {
      await updateDeal(hs, dealId, { [ofm.availability_status]: 'no_availability' });
      return { status: 'no_availability' };
    });
    return { acknowledged: true, outcome: 'no_availability' };
  }

  // ---- Step 8: products (find-or-create) -----------------------------------
  const productIds: string[] = [];
  for (let i = 0; i < filtered.selected.length; i++) {
    const sel = filtered.selected[i]!;
    const sku = renderTemplate(ov.product_sku_template, {
      portalId: hubIdStr,
      unitId: sel.unit.unitId,
      rateId: sel.rate.rateId,
    });
    const product = await runStep(
      jobId,
      hubId,
      dealId,
      9 + i,
      `product.upsert[${i}]`,
      () =>
        upsertProductBySku(hs, {
          sku,
          name: `${sel.unit.name} — ${sel.rate.name}`,
          description: sel.rate.shortDescription,
          price: sel.unit.pricePerNight,
          currency: sel.unit.currency || ov.quote_defaults.currency_fallback,
        }),
    );
    productIds.push(product.id);
  }

  // ---- Step 9: line items --------------------------------------------------
  const lineItemIds: string[] = [];
  for (let i = 0; i < filtered.selected.length; i++) {
    const sel = filtered.selected[i]!;
    const productId = productIds[i]!;
    const li = await runStep(
      jobId,
      hubId,
      dealId,
      100 + i,
      `lineItem.create[${i}]`,
      () =>
        createLineItem(hs, {
          productId,
          dealId,
          name: `${sel.unit.name} — ${sel.rate.name}`,
          quantity: nights,
          price: sel.unit.pricePerNight,
          currency: sel.unit.currency || ov.quote_defaults.currency_fallback,
          description: sel.rate.shortDescription,
        }),
    );
    lineItemIds.push(li.id);
  }

  // ---- Step 10: quote ------------------------------------------------------
  const quoteTitle = renderTemplate(ov.quote_defaults.title_template, {
    dealId: dealId.toString(),
    portalId: hubIdStr,
  });
  const quote = await runStep(jobId, hubId, dealId, 200, 'quote.create_approve_fetch', () =>
    createApprovedQuote(hs, {
      dealId,
      quoteTemplateId: tenant.quoteTemplateId,
      ownerId: tenant.ownerId,
      lineItemIds,
      title: quoteTitle,
      expirationDays: ov.quote_defaults.expiration_days,
      currency: filtered.selected[0]!.unit.currency || ov.quote_defaults.currency_fallback,
    }),
  );

  // ---- Step 11: write quote link back to deal ------------------------------
  await runStep(jobId, hubId, dealId, 201, 'deal.update.quote_link', async () => {
    const props: Record<string, string> = {
      [ofm.quote_id]: quote.id,
      [ofm.availability_status]: 'available',
    };
    if (quote.link) props[ofm.quote_link] = quote.link;
    await updateDeal(hs, dealId, props);
    return props;
  });

  await writeAudit({
    hubId,
    dealId,
    requestId,
    kind: 'process_deal.completed',
    status: 'ok',
    response: {
      quoteId: quote.id,
      quoteLink: quote.link,
      lineItems: lineItemIds.length,
      products: productIds.length,
    },
  });

  jobProcessed.labels('ok').inc();
  log.info({ quoteId: quote.id }, 'processDeal complete');
  return { acknowledged: true, quoteId: quote.id, quoteLink: quote.link };
}

async function runStep<T>(
  jobId: string,
  hubId: bigint,
  dealId: bigint,
  stepIndex: number,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  liveEmit('jobs', hubId, {
    ts: start,
    type: 'step.start',
    hubId: hubId.toString(),
    dealId: dealId.toString(),
    jobId,
    data: { step, stepIndex },
  });
  try {
    const output = await fn();
    const durationMs = Date.now() - start;
    await writeJobStep({
      jobId,
      hubId,
      dealId,
      step,
      stepIndex,
      status: 'ok',
      output,
      durationMs,
    });
    jobStepDuration.labels(step, 'ok').observe(durationMs / 1000);
    liveEmit('jobs', hubId, {
      ts: Date.now(),
      type: 'step.ok',
      hubId: hubId.toString(),
      dealId: dealId.toString(),
      jobId,
      data: { step, stepIndex, durationMs },
    });
    return output;
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    await writeJobStep({
      jobId,
      hubId,
      dealId,
      step,
      stepIndex,
      status: 'error',
      error,
      durationMs,
    });
    jobStepDuration.labels(step, 'error').observe(durationMs / 1000);
    jobProcessed.labels('fail').inc();
    liveEmit('jobs', hubId, {
      ts: Date.now(),
      type: 'step.error',
      hubId: hubId.toString(),
      dealId: dealId.toString(),
      jobId,
      data: { step, stepIndex, durationMs, error },
    });
    throw err;
  }
}

// Used only for the type-only import in worker.ts
export type { ProcessDealPayload };
