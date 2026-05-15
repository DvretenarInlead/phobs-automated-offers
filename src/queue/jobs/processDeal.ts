import type { Job } from 'bullmq';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { writeAudit, writeJobStep } from '../../lib/audit.js';
import { loadTenantContext } from '../../tenancy/config.js';
import { normalizeChildAges } from '../../tenancy/childAgeRules.js';
import { applyRateFilters } from '../../tenancy/rateFilters.js';
import { getHubSpotClient } from '../../hubspot/client.js';
import { updateDeal } from '../../hubspot/deals.js';
import { queryUnitsByPropertyId } from '../../hubspot/hubdb.js';
import { upsertProductBySku } from '../../hubspot/products.js';
import { createLineItem } from '../../hubspot/lineItems.js';
import { createApprovedQuote } from '../../hubspot/quotes.js';
import { fetchAvailability } from '../../phobs/client.js';
import type { ProcessDealPayload } from '../index.js';

const itemSchema = z
  .object({
    hs_object_id: z.union([z.number(), z.string()]),
    child_age_1: z.union([z.number(), z.string(), z.null()]).nullish(),
    child_age_2: z.union([z.number(), z.string(), z.null()]).nullish(),
    child_age_3: z.union([z.number(), z.string(), z.null()]).nullish(),
    child_age_4: z.union([z.number(), z.string(), z.null()]).nullish(),
    child_age_5: z.union([z.number(), z.string(), z.null()]).nullish(),
    jezik_ponude: z.string().default('en'),
    number_of_adults: z.union([z.number(), z.string(), z.null()]).nullish(),
    rezzapp___broj_odraslih: z.union([z.number(), z.string(), z.null()]).nullish(),
    picker_date_check_in: z.union([z.number(), z.string()]),
    reservation___nights: z.union([z.number(), z.string()]),
    rezapp___property_id: z.string(),
    picker_date_check_out: z.union([z.number(), z.string()]).optional(),
    rezzapp___broj_djece: z.unknown().optional(),
    bluesunrewards___loyaltyid: z.union([z.number(), z.string(), z.null()]).nullish(),
  })
  .passthrough();
const payloadSchema = z.union([z.array(itemSchema).min(1), itemSchema]);

function toFloat(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function toInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().split('T')[0]!;
}

export async function processDealJob(job: Job<ProcessDealPayload>): Promise<unknown> {
  const { hubId: hubIdStr, requestId } = job.data;
  const hubId = BigInt(hubIdStr);
  const jobId = job.id ?? 'no-id';

  const parsed = payloadSchema.parse(job.data.rawPayload);
  const item = Array.isArray(parsed) ? parsed[0]! : parsed;
  const dealId = BigInt(item.hs_object_id);
  const log = logger.child({ jobId, hubId: hubIdStr, dealId: dealId.toString(), requestId });

  log.info('processDeal start');

  // ---- Step 1: load tenant context ------------------------------------------
  const tenant = await runStep(jobId, hubId, dealId, 1, 'load_tenant', async () => {
    return loadTenantContext(hubId);
  });

  // ---- Step 2: apply child-age rules ----------------------------------------
  const childAges = [
    item.child_age_1,
    item.child_age_2,
    item.child_age_3,
    item.child_age_4,
    item.child_age_5,
  ]
    .map(toFloat)
    .filter((n) => n > 0);

  const adultsInput = toInt(item.rezzapp___broj_odraslih ?? item.number_of_adults, 0);
  const propertyId = item.rezapp___property_id;
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
    stepIndex: 2,
    status: norm.unknownProperty ? 'skipped' : 'ok',
    input: { childAges, adults: adultsInput, propertyId },
    output: norm,
  });

  // Update deal child age slots + adult/child counts (legacy contract)
  const dealProps = childAgeProperties(norm.childAges);
  dealProps.rezzapp___broj_odraslih = norm.adults.toString();
  dealProps.number_of_childrens = norm.numberOfChildren.toString();

  // ---- Step 3: HubSpot client + write normalized deal -----------------------
  const hs = await getHubSpotClient(hubId);
  await runStep(jobId, hubId, dealId, 3, 'deal.update.normalized', async () => {
    await updateDeal(hs, dealId, dealProps);
    return { properties: dealProps };
  });

  // ---- Step 4: HubDB unit lookup --------------------------------------------
  const units = await runStep(jobId, hubId, dealId, 4, 'hubdb.query', () =>
    queryUnitsByPropertyId(hs, tenant.hubdbTableId, tenant.hubdbColumnMap, propertyId),
  );

  // ---- Step 5: Phobs availability -------------------------------------------
  const checkInMs = toInt(item.picker_date_check_in);
  const nightsMs = toInt(item.reservation___nights);
  const nights = Math.max(1, Math.round(nightsMs / 86_400_000));
  const hasLoyalty =
    item.bluesunrewards___loyaltyid !== null && item.bluesunrewards___loyaltyid !== undefined;

  const availability = await runStep(jobId, hubId, dealId, 5, 'phobs.availability', () =>
    fetchAvailability(
      { endpoint: tenant.phobs.endpoint },
      {
        lang: item.jezik_ponude,
        propertyId,
        date: fmtDate(checkInMs),
        nights,
        unitIds: units.map((u) => u.unitId),
        adults: norm.adults,
        childAges: norm.childAges,
        accessCode: hasLoyalty ? (tenant.accessCode ?? undefined) : undefined,
        auth: {
          siteId: tenant.phobs.siteId,
          username: tenant.phobs.username,
          password: tenant.phobs.password,
        },
      },
    ),
  );

  // ---- Step 6: apply rate filters -------------------------------------------
  const filtered = applyRateFilters(availability.rates, tenant.rateFilters);
  await writeJobStep({
    jobId,
    hubId,
    dealId,
    step: 'rate_filters',
    stepIndex: 6,
    status: 'ok',
    input: { rateFilters: tenant.rateFilters, ratesIn: availability.rates.length },
    output: { selectedCount: filtered.selected.length, trace: filtered.trace },
  });

  if (filtered.selected.length === 0) {
    log.info('no availability after filtering — marking deal silently');
    await runStep(jobId, hubId, dealId, 7, 'deal.no_availability', async () => {
      await updateDeal(hs, dealId, { phobs_availability_status: 'no_availability' });
      return { status: 'no_availability' };
    });
    return { acknowledged: true, outcome: 'no_availability' };
  }

  // ---- Step 7: products (find-or-create) ------------------------------------
  const productIds: string[] = [];
  for (let i = 0; i < filtered.selected.length; i++) {
    const item = filtered.selected[i]!;
    const sku = `${hubIdStr}:${item.unit.unitId}:${item.rate.rateId}`;
    const product = await runStep(
      jobId,
      hubId,
      dealId,
      8 + i,
      `product.upsert[${i}]`,
      () =>
        upsertProductBySku(hs, {
          sku,
          name: `${item.unit.name} — ${item.rate.name}`,
          description: item.rate.shortDescription,
          price: item.unit.pricePerNight,
          currency: item.unit.currency || 'EUR',
        }),
    );
    productIds.push(product.id);
  }

  // ---- Step 8: line items ---------------------------------------------------
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
          currency: sel.unit.currency || 'EUR',
          description: sel.rate.shortDescription,
        }),
    );
    lineItemIds.push(li.id);
  }

  // ---- Step 9: quote --------------------------------------------------------
  const quote = await runStep(jobId, hubId, dealId, 200, 'quote.create_approve_fetch', () =>
    createApprovedQuote(hs, {
      dealId,
      quoteTemplateId: tenant.quoteTemplateId,
      ownerId: tenant.ownerId,
      lineItemIds,
      title: `This is your personalized offer #${dealId.toString()}`,
      expirationDays: 3,
      currency: filtered.selected[0]!.unit.currency || 'EUR',
    }),
  );

  // ---- Step 10: write quote link back to deal -------------------------------
  await runStep(jobId, hubId, dealId, 201, 'deal.update.quote_link', async () => {
    const props: Record<string, string> = {
      quote_id: quote.id,
      phobs_availability_status: 'available',
    };
    if (quote.link) props.quote_link_custom = quote.link;
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

  log.info({ quoteId: quote.id }, 'processDeal complete');
  return { acknowledged: true, quoteId: quote.id, quoteLink: quote.link };
}

function childAgeProperties(ages: number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= 5; i++) {
    const v = ages[i - 1];
    out[`child_age_${i}`] = v != null ? v.toString() : '';
  }
  return out;
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
  try {
    const output = await fn();
    await writeJobStep({
      jobId,
      hubId,
      dealId,
      step,
      stepIndex,
      status: 'ok',
      output,
      durationMs: Date.now() - start,
    });
    return output;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await writeJobStep({
      jobId,
      hubId,
      dealId,
      step,
      stepIndex,
      status: 'error',
      error,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

// Used only for the type-only import in worker.ts
export type { ProcessDealPayload };
