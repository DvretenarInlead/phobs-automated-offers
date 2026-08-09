import { z } from 'zod';

/**
 * Per-tenant configuration overrides. Everything here can be changed from the
 * admin UI without a code deploy. Stored as a single JSONB column
 * (`tenant_config.overrides`) so the shape is self-describing via zod. Missing
 * keys fall back to the defaults defined below — every field is nullable at
 * the DB level, all defaults live in code.
 *
 * See ARCHITECTURE.md §14: "JSON only" — no DSL, no scripting.
 */

// ---------- input field map -------------------------------------------------
// Maps our internal logical field names to the JSON key the tenant's HubSpot
// workflow (or workflow extension) sends in the webhook body. If a tenant
// renames a HubSpot property, they update this map instead of shipping code.

export const inputFieldMapSchema = z
  .object({
    deal_id: z.string().default('hs_object_id'),
    property_id: z.string().default('rezapp___property_id'),
    language: z.string().default('jezik_ponude'),
    adults: z.string().default('rezzapp___broj_odraslih'),
    /** Fallback read if `adults` is null/missing. */
    fallback_adults: z.string().default('number_of_adults'),
    child_ages: z
      .array(z.string())
      .default(['child_age_1', 'child_age_2', 'child_age_3', 'child_age_4', 'child_age_5']),
    check_in_ms: z.string().default('picker_date_check_in'),
    check_out_ms: z.string().default('picker_date_check_out'),
    nights_ms: z.string().default('reservation___nights'),
    loyalty_id: z.string().default('bluesunrewards___loyaltyid'),
  })
  .default({});
export type InputFieldMap = z.infer<typeof inputFieldMapSchema>;

// ---------- output field map ------------------------------------------------
// Maps our internal output names to HubSpot deal property names.

export const outputFieldMapSchema = z
  .object({
    quote_link: z.string().default('quote_link_custom'),
    quote_id: z.string().default('quote_id'),
    availability_status: z.string().default('phobs_availability_status'),
    num_children: z.string().default('number_of_childrens'),
    adults: z.string().default('rezzapp___broj_odraslih'),
    child_age_slots: z
      .array(z.string())
      .default(['child_age_1', 'child_age_2', 'child_age_3', 'child_age_4', 'child_age_5']),
  })
  .default({});
export type OutputFieldMap = z.infer<typeof outputFieldMapSchema>;

// ---------- quote defaults --------------------------------------------------

export const quoteDefaultsSchema = z
  .object({
    expiration_days: z.number().int().positive().max(365).default(3),
    /**
     * Handlebars-lite: only `{dealId}` and `{portalId}` placeholders are
     * substituted. Other braces pass through literally.
     */
    title_template: z.string().max(500).default('This is your personalized offer #{dealId}'),
    currency_fallback: z.string().min(1).max(8).default('EUR'),
  })
  .default({});
export type QuoteDefaults = z.infer<typeof quoteDefaultsSchema>;

// ---------- skip conditions -------------------------------------------------
// Evaluated against the input payload after field resolution. If ANY condition
// matches, the pipeline exits with status='skipped' (no Phobs call, no
// HubSpot writes). Enum operators only — no expression language.

const SKIP_OP = z.enum(['eq', 'neq', 'in', 'not_in', 'present', 'absent', 'truthy', 'falsy']);
export type SkipOperator = z.infer<typeof SKIP_OP>;

export const skipConditionSchema = z.object({
  property: z.string().min(1).max(128),
  operator: SKIP_OP,
  values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type SkipCondition = z.infer<typeof skipConditionSchema>;

export const skipConditionsSchema = z.array(skipConditionSchema).default([]);

// ---------- loyalty rule ----------------------------------------------------
// Decides whether to attach `access_code` to the Phobs request. Default
// preserves legacy behaviour: "attach if loyalty_id is present in payload".

export const loyaltyRuleSchema = z
  .object({
    trigger_property: z.string().default('bluesunrewards___loyaltyid'),
    trigger_condition: z.enum(['present', 'absent', 'truthy', 'falsy']).default('present'),
  })
  .default({});
export type LoyaltyRule = z.infer<typeof loyaltyRuleSchema>;

// ---------- product SKU template --------------------------------------------

export const skuTemplateSchema = z
  .string()
  .min(1)
  .max(256)
  .default('{portalId}:{unitId}:{rateId}');

// ---------- combined overrides ----------------------------------------------

export const overridesSchema = z
  .object({
    input_field_map: inputFieldMapSchema,
    output_field_map: outputFieldMapSchema,
    quote_defaults: quoteDefaultsSchema,
    skip_conditions: skipConditionsSchema,
    loyalty_rule: loyaltyRuleSchema,
    default_lang: z.string().min(1).max(8).default('en'),
    product_sku_template: skuTemplateSchema,
  })
  .default({});
export type Overrides = z.infer<typeof overridesSchema>;

/**
 * Applies defaults to a raw overrides JSON. Safe on `undefined`, `null`, or
 * missing/partial keys — returns a fully-populated object.
 */
export function resolveOverrides(raw: unknown): Overrides {
  return overridesSchema.parse(raw ?? {});
}

// ---------- resolvers -------------------------------------------------------

/**
 * Reads a mapped field from a payload object. Accepts a chain of fallback
 * property names — first non-null/undefined wins. Returns undefined if none
 * are set.
 */
export function readMapped(payload: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    const v = payload[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Coerces to number; returns 0 on failure. Matches legacy pipeline behaviour. */
export function coerceFloat(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
export function coerceInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Evaluates skip conditions against a payload. Returns { skip, matched }.
 * OR-semantics: any condition matching → skip.
 */
export function evaluateSkip(
  payload: Record<string, unknown>,
  conditions: SkipCondition[],
): { skip: boolean; matched: SkipCondition | null } {
  for (const cond of conditions) {
    if (matches(payload[cond.property], cond)) {
      return { skip: true, matched: cond };
    }
  }
  return { skip: false, matched: null };
}

function matches(value: unknown, cond: SkipCondition): boolean {
  const vs = cond.values ?? [];
  switch (cond.operator) {
    case 'present':
      return value !== undefined && value !== null && value !== '';
    case 'absent':
      return value === undefined || value === null || value === '';
    case 'truthy':
      return Boolean(value);
    case 'falsy':
      return !value;
    case 'eq':
      return vs.length > 0 && strictEq(value, vs[0]);
    case 'neq':
      return vs.length > 0 && !strictEq(value, vs[0]);
    case 'in':
      return vs.some((v) => strictEq(value, v));
    case 'not_in':
      return vs.length > 0 && !vs.some((v) => strictEq(value, v));
    default:
      return false;
  }
}

function strictEq(a: unknown, b: unknown): boolean {
  // Numbers get lenient string↔number coercion because HubSpot properties are
  // strings even for numeric fields, but everything else is strict.
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  return a === b;
}

/**
 * Evaluates the loyalty rule against a payload. Returns whether the tenant's
 * access_code (from tenant_config) should be attached to the Phobs request.
 */
export function shouldAttachLoyalty(
  payload: Record<string, unknown>,
  rule: LoyaltyRule,
): boolean {
  const v = payload[rule.trigger_property];
  switch (rule.trigger_condition) {
    case 'present':
      return v !== undefined && v !== null && v !== '';
    case 'absent':
      return v === undefined || v === null || v === '';
    case 'truthy':
      return Boolean(v);
    case 'falsy':
      return !v;
    default:
      return false;
  }
}

/**
 * Handlebars-lite template renderer. Only supports the whitelisted
 * `{placeholder}` tokens listed in `vars`. Any other braces pass through
 * literally so accidental template markers from source data don't blow up.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = vars[key];
    return typeof v === 'string' ? v : match;
  });
}
