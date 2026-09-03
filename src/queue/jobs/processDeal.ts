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
import { withHubSpotClient } from '../../hubspot/client.js';
import { fetchDeal, updateDeal } from '../../hubspot/deals.js';
import { queryUnitsByPropertyId } from '../../hubspot/hubdb.js';
import { upsertProductBySku } from '../../hubspot/products.js';
import { createLineItem } from '../../hubspot/lineItems.js';
import { createApprovedQuote, pollQuoteLink } from '../../hubspot/quotes.js';
import { fetchAvailability, fetchPriceQuote } from '../../phobs/client.js';
import type { PhobsRate, PhobsUnit } from '../../phobs/parseResponse.js';
import { liveEmit } from '../../lib/liveEmit.js';
import { ExternalServiceError, ValidationError } from '../../lib/errors.js';
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

  // Malformed input is permanent — surface it as a ValidationError so the
  // worker dead-letters immediately instead of retrying.
  const parsedResult = payloadSchema.safeParse(job.data.rawPayload);
  if (!parsedResult.success) {
    throw new ValidationError('processDeal: payload is not an object or array of objects');
  }
  const parsed = parsedResult.data;
  const item = Array.isArray(parsed) ? parsed[0]! : parsed;

  // ---- Step 1: load tenant context (contains resolved overrides) ------------
  // The context carries decrypted Phobs credentials and the loyalty access
  // code — only a redacted summary is ever persisted to job_steps.
  const tenant = await runStep(
    jobId,
    hubId,
    0n,
    1,
    'load_tenant',
    () => loadTenantContext(hubId),
    (t) => ({
      hubId: t.hubId.toString(),
      status: t.status,
      triggerMode: t.triggerMode,
      hubdbTableId: t.hubdbTableId,
      quoteTemplateId: t.quoteTemplateId,
      phobsEndpoint: t.phobs.endpoint,
      priceQuoteEnabled: t.overrides.price_quote.enabled,
    }),
  );

  // Resume bookkeeping: HubSpot objects created by an earlier attempt of this
  // same job are reused instead of re-created, so a retry after a mid-run
  // failure never leaves duplicate products / line items / quotes behind.
  const progress = job.data.progress ?? {};
  const createdProducts: Record<string, string> = { ...(progress.products ?? {}) };
  const createdLineItems: Record<string, string> = { ...(progress.lineItems ?? {}) };
  const saveProgress = async (): Promise<void> => {
    await job.updateData({
      ...job.data,
      progress: {
        ...job.data.progress,
        products: createdProducts,
        lineItems: createdLineItems,
      },
    });
  };

  const ov = tenant.overrides;
  const ifm = ov.input_field_map;

  const dealIdRaw = readMapped(item, ifm.deal_id);
  if (dealIdRaw === undefined) {
    throw new ValidationError(`processDeal: missing input field '${ifm.deal_id}' (deal_id)`);
  }
  let dealId: bigint;
  try {
    dealId = typeof dealIdRaw === 'bigint' ? dealIdRaw : BigInt(safeStr(dealIdRaw) || '0');
  } catch {
    throw new ValidationError(`processDeal: input field '${ifm.deal_id}' is not a numeric deal id`);
  }
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
  if (!propertyId) {
    throw new ValidationError(`processDeal: missing '${ifm.property_id}' (property_id)`);
  }

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

  // ---- Step 3b: the deal must exist in THIS tenant's portal ---------------
  // The webhook body is caller-supplied. Before writing anything, fetch the
  // deal with the tenant's own token: a deal id from another portal (or a
  // guessed one) fails here as a validation error, and the property id the
  // CRM holds must agree with the one in the body.
  await runStep(jobId, hubId, dealId, 3, 'deal.verify', async () => {
    let props: Record<string, string | null>;
    try {
      props = await withHubSpotClient(hubId, (hs) => fetchDeal(hs, dealId, [ifm.property_id]));
    } catch (err) {
      if (err instanceof ExternalServiceError && err.upstreamStatus === 404) {
        throw new ValidationError(`deal ${dealId.toString()} not found in portal ${hubIdStr}`);
      }
      throw err;
    }
    const crmPropertyId = props[ifm.property_id];
    if (crmPropertyId && crmPropertyId !== propertyId) {
      throw new ValidationError(
        `payload '${ifm.property_id}' does not match the deal's value in HubSpot`,
      );
    }
    return { exists: true, propertyIdChecked: Boolean(crmPropertyId) };
  });

  // ---- Step 4: write normalized deal ---------------------------------------
  // Every HubSpot call goes through withHubSpotClient: a 401 (token revoked
  // or expired early) forces one token refresh and retries the call, instead
  // of dead-lettering the job until the stored expiry passes.
  await runStep(jobId, hubId, dealId, 4, 'deal.update.normalized', async () => {
    await withHubSpotClient(hubId, (hs) => updateDeal(hs, dealId, dealProps));
    return { properties: dealProps };
  });

  // ---- Step 5: HubDB unit lookup -------------------------------------------
  const units = await runStep(
    jobId,
    hubId,
    dealId,
    5,
    'hubdb.query',
    () =>
      withHubSpotClient(hubId, (hs) =>
        queryUnitsByPropertyId(hs, tenant.hubdbTableId, tenant.hubdbColumnMap, propertyId),
      ),
    // Unit ids only — the full HubDB rows are tenant data we don't need to
    // copy into every job record.
    (rows) => ({ count: rows.length, units: rows.map((r) => ({ unitId: r.unitId, propertyId: r.propertyId })) }),
  );

  // ---- Step 6: Phobs availability ------------------------------------------
  const checkInMs = coerceInt(readMapped(item, ifm.check_in_ms));
  const nightsMs = coerceInt(readMapped(item, ifm.nights_ms));
  const nights = Math.max(1, Math.round(nightsMs / 86_400_000));
  const lang = safeStr(readMapped(item, ifm.language)) || ov.default_lang;
  const attachLoyalty = shouldAttachLoyalty(item, ov.loyalty_rule);

  const availability = await runStep(
    jobId,
    hubId,
    dealId,
    6,
    'phobs.availability',
    () =>
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
    // Persist a compact summary: never the raw XML, and no per-unit bookUrl
    // (Phobs booking URLs may carry the session id / access code) or the
    // per-day price breakdown.
    (r) => ({
      success: r.success,
      sessionId: r.sessionId,
      rateCount: r.rates.length,
      rates: r.rates.map((rate) => ({
        rateId: rate.rateId,
        name: rate.name,
        stayMinNights: rate.stayMinNights,
        units: rate.units.map((u) => ({
          unitId: u.unitId,
          name: u.name,
          availableUnits: u.availableUnits,
          board: u.board,
          pricePerNight: u.pricePerNight,
          stayTotal: u.stayTotal,
          currency: u.currency,
        })),
      })),
    }),
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
      await withHubSpotClient(hubId, (hs) =>
        updateDeal(hs, dealId, { [ofm.availability_status]: 'no_availability' }),
      );
      return { status: 'no_availability' };
    });
    return { acknowledged: true, outcome: 'no_availability' };
  }

  // ---- Step 7b: firm re-price via PCPriceQuoteRQ (opt-in) ------------------
  // Replaces the availability price with a quoted price per offer. On failure
  // either falls back to the availability price (default) or fails the job,
  // per overrides.price_quote.on_failure.
  const offers: { rate: PhobsRate; unit: PhobsUnit }[] = filtered.selected.map((s) => ({
    rate: s.rate,
    unit: s.unit,
  }));
  if (ov.price_quote.enabled) {
    const pqEndpoint = ov.price_quote.endpoint ?? tenant.phobs.endpoint;
    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i]!;
      const priced = await runStep(jobId, hubId, dealId, 50 + i, `phobs.price_quote[${i}]`, async () => {
        const before = {
          pricePerNight: offer.unit.pricePerNight,
          stayTotal: offer.unit.stayTotal,
          currency: offer.unit.currency,
        };
        try {
          const res = await fetchPriceQuote(
            { endpoint: pqEndpoint },
            {
              lang,
              propertyId,
              rateId: offer.rate.rateId,
              unitId: offer.unit.unitId,
              date: fmtDate(checkInMs),
              nights,
              adults: norm.adults,
              childAges: norm.childAges,
              accessCode: attachLoyalty ? (tenant.accessCode ?? undefined) : undefined,
              auth: {
                siteId: tenant.phobs.siteId,
                username: tenant.phobs.username,
                password: tenant.phobs.password,
              },
            },
          );
          const q = res.quote;
          const hasPrice = q !== null && (q.pricePerNight > 0 || q.stayTotal > 0);
          if (!res.success || !hasPrice) {
            const reason = res.error ?? (q === null ? 'no_quote_in_response' : 'no_price');
            if (ov.price_quote.on_failure === 'fail') {
              // Upstream condition → retryable (no status = treated as transient).
              throw new ExternalServiceError('phobs', `price quote failed: ${reason}`);
            }
            log.warn({ reason, rateId: offer.rate.rateId, unitId: offer.unit.unitId }, 'price quote unusable — falling back to availability price');
            return { applied: false, reason, before };
          }
          const pricePerNight = q.pricePerNight > 0 ? q.pricePerNight : q.stayTotal / nights;
          const stayTotal = q.stayTotal > 0 ? q.stayTotal : pricePerNight * nights;
          const after = { pricePerNight, stayTotal, currency: q.currency || before.currency };
          return { applied: true, before, after };
        } catch (err) {
          if (ov.price_quote.on_failure === 'fail') throw err;
          const reason = err instanceof Error ? err.message : String(err);
          log.warn({ reason, rateId: offer.rate.rateId, unitId: offer.unit.unitId }, 'price quote call failed — falling back to availability price');
          return { applied: false, reason, before };
        }
      });
      if (priced.applied && priced.after) {
        offer.unit = { ...offer.unit, ...priced.after };
      }
    }
  }

  // ---- Step 8: products (find-or-create) -----------------------------------
  const productIds: string[] = [];
  for (let i = 0; i < offers.length; i++) {
    const sel = offers[i]!;
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
      async () => {
        const known = createdProducts[sku];
        if (known) return { id: known, sku, resumed: true };
        const p = await withHubSpotClient(hubId, (hs) =>
          upsertProductBySku(hs, {
            sku,
            name: `${sel.unit.name} — ${sel.rate.name}`,
            description: sel.rate.shortDescription,
            price: sel.unit.pricePerNight,
            currency: sel.unit.currency || ov.quote_defaults.currency_fallback,
          }),
        );
        createdProducts[sku] = p.id;
        await saveProgress();
        return { ...p, resumed: false };
      },
    );
    productIds.push(product.id);
  }

  // ---- Step 9: line items --------------------------------------------------
  const lineItemIds: string[] = [];
  for (let i = 0; i < offers.length; i++) {
    const sel = offers[i]!;
    const productId = productIds[i]!;
    const liKey = `${productId}:${sel.unit.unitId}:${sel.rate.rateId}`;
    const li = await runStep(
      jobId,
      hubId,
      dealId,
      100 + i,
      `lineItem.create[${i}]`,
      async () => {
        const known = createdLineItems[liKey];
        if (known) return { id: known, resumed: true };
        const created = await withHubSpotClient(hubId, (hs) =>
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
        createdLineItems[liKey] = created.id;
        await saveProgress();
        return { ...created, resumed: false };
      },
    );
    lineItemIds.push(li.id);
  }

  // ---- Step 10: quote ------------------------------------------------------
  const quoteTitle = renderTemplate(ov.quote_defaults.title_template, {
    dealId: dealId.toString(),
    portalId: hubIdStr,
  });
  const lineItemKey = [...lineItemIds].sort().join(',');
  const quote = await runStep(
    jobId,
    hubId,
    dealId,
    200,
    'quote.create_approve_fetch',
    async () => {
      // Resume only if the earlier attempt's quote was built from exactly
      // this line-item set; if availability changed between attempts a new
      // quote is created so the offer and its line items always agree.
      const known = job.data.progress?.quote;
      if (known && known.lineItemKey === lineItemKey) {
        // The earlier attempt may have timed out waiting for hs_quote_link.
        const link =
          known.link ?? (await withHubSpotClient(hubId, (hs) => pollQuoteLink(hs, known.id)));
        return { id: known.id, link, resumed: true };
      }
      const q = await withHubSpotClient(hubId, (hs) =>
        createApprovedQuote(hs, {
          dealId,
          quoteTemplateId: tenant.quoteTemplateId,
          ownerId: tenant.ownerId,
          lineItemIds,
          title: quoteTitle,
          expirationDays: ov.quote_defaults.expiration_days,
          currency: offers[0]!.unit.currency || ov.quote_defaults.currency_fallback,
        }),
      );
      await job.updateData({
        ...job.data,
        progress: {
          ...job.data.progress,
          products: createdProducts,
          lineItems: createdLineItems,
          quote: { id: q.id, link: q.link, lineItemKey },
        },
      });
      return { ...q, resumed: false };
    },
    // The quote link is a public, unauthenticated URL to the guest's offer —
    // it lives in HubSpot, never in our records.
    (q) => ({ id: q.id, hasLink: q.link !== null, resumed: q.resumed }),
  );

  // ---- Step 11: write quote link back to deal ------------------------------
  await runStep(
    jobId,
    hubId,
    dealId,
    201,
    'deal.update.quote_link',
    async () => {
      const props: Record<string, string> = {
        [ofm.quote_id]: quote.id,
        [ofm.availability_status]: 'available',
      };
      if (quote.link) props[ofm.quote_link] = quote.link;
      await withHubSpotClient(hubId, (hs) => updateDeal(hs, dealId, props));
      return props;
    },
    (props) => ({ ...props, ...(ofm.quote_link in props ? { [ofm.quote_link]: '[set]' } : {}) }),
  );

  await writeAudit({
    hubId,
    dealId,
    requestId,
    kind: 'process_deal.completed',
    status: 'ok',
    response: {
      quoteId: quote.id,
      quoteLinkSet: quote.link !== null,
      lineItems: lineItemIds.length,
      products: productIds.length,
    },
  });

  jobProcessed.labels('ok').inc();
  log.info({ quoteId: quote.id }, 'processDeal complete');
  return { acknowledged: true, quoteId: quote.id, quoteLinkSet: quote.link !== null };
}

/**
 * Runs one pipeline step with live events + job_steps persistence.
 * `summarize` controls what is written to job_steps.output — pass it whenever
 * the step's return value carries secrets or bulk data (raw XML) that must
 * not be stored.
 */
async function runStep<T>(
  jobId: string,
  hubId: bigint,
  dealId: bigint,
  stepIndex: number,
  step: string,
  fn: () => Promise<T>,
  summarize?: (out: T) => unknown,
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
      output: summarize ? summarize(output) : output,
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
