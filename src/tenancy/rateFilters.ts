import { z } from 'zod';
import type { PhobsRate, PhobsUnit } from '../phobs/parseResponse.js';

const unitFilterSchema = z.object({
  include_boards: z.array(z.string()).nullish(),
  exclude_boards: z.array(z.string()).default([]),
  exclude_rate_ids: z.array(z.string()).default([]),
  max_results: z.number().int().positive().nullish(),
});

const globalFilterSchema = z.object({
  exclude_rate_ids: z.array(z.string()).default([]),
  exclude_boards: z.array(z.string()).default([]),
  include_boards: z.array(z.string()).nullish(),
  min_available_units: z.number().int().nonnegative().default(1),
  max_price_per_night: z.number().positive().nullish(),
});

export const rateFiltersSchema = z
  .object({
    global: globalFilterSchema.default({}),
    units: z.record(z.string(), unitFilterSchema).default({}),
  })
  .default({ global: {}, units: {} });
export type RateFilters = z.infer<typeof rateFiltersSchema>;

export interface FilteredRate {
  rate: PhobsRate;
  unit: PhobsUnit;
}

export interface FilterTrace {
  step: string;
  rateId: string;
  unitId: string;
  reason: string;
}

export interface FilterResult {
  /** Surviving (rate, unit) pairs ready to become products + line items. */
  selected: FilteredRate[];
  /** Audit trail of every drop decision — used by admin "filter trace" view. */
  trace: FilterTrace[];
}

/**
 * Applies global + per-unit filters to the Phobs response.
 *
 * Order matches ARCHITECTURE §14 "Rate filtering rules".
 */
export function applyRateFilters(rates: PhobsRate[], filtersRaw: unknown): FilterResult {
  const filters = rateFiltersSchema.parse(filtersRaw ?? {});
  const trace: FilterTrace[] = [];
  const selected: FilteredRate[] = [];

  for (const rate of rates) {
    for (const unit of rate.units) {
      const drop = (step: string, reason: string): void => {
        trace.push({ step, rateId: rate.rateId, unitId: unit.unitId, reason });
      };

      if (unit.availableUnits < filters.global.min_available_units) {
        drop('min_available_units', `availableUnits=${unit.availableUnits}`);
        continue;
      }

      const unitFilter = filters.units[unit.unitId];

      if (filters.global.exclude_rate_ids.includes(rate.rateId)) {
        drop('global.exclude_rate_ids', rate.rateId);
        continue;
      }
      if (unitFilter?.exclude_rate_ids.includes(rate.rateId)) {
        drop('unit.exclude_rate_ids', rate.rateId);
        continue;
      }

      if (filters.global.exclude_boards.includes(unit.board)) {
        drop('global.exclude_boards', unit.board);
        continue;
      }
      if (unitFilter?.exclude_boards.includes(unit.board)) {
        drop('unit.exclude_boards', unit.board);
        continue;
      }
      if (filters.global.include_boards && !filters.global.include_boards.includes(unit.board)) {
        drop('global.include_boards', unit.board);
        continue;
      }
      if (unitFilter?.include_boards && !unitFilter.include_boards.includes(unit.board)) {
        drop('unit.include_boards', unit.board);
        continue;
      }
      if (
        filters.global.max_price_per_night != null &&
        unit.pricePerNight > filters.global.max_price_per_night
      ) {
        drop('global.max_price_per_night', String(unit.pricePerNight));
        continue;
      }

      selected.push({ rate, unit });
    }
  }

  selected.sort((a, b) => a.unit.pricePerNight - b.unit.pricePerNight);

  const truncated: FilteredRate[] = [];
  const seenPerUnit = new Map<string, number>();
  for (const item of selected) {
    const unitFilter = filters.units[item.unit.unitId];
    const cap = unitFilter?.max_results;
    const count = seenPerUnit.get(item.unit.unitId) ?? 0;
    if (cap != null && count >= cap) {
      trace.push({
        step: 'unit.max_results',
        rateId: item.rate.rateId,
        unitId: item.unit.unitId,
        reason: `cap=${cap}`,
      });
      continue;
    }
    truncated.push(item);
    seenPerUnit.set(item.unit.unitId, count + 1);
  }

  return { selected: truncated, trace };
}
