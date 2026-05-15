import { describe, expect, it } from 'vitest';
import { applyRateFilters } from '../src/tenancy/rateFilters.js';
import type { PhobsRate } from '../src/phobs/parseResponse.js';

const baseUnit = {
  unitId: 'U1',
  name: 'Family room',
  occupancy: { max: 4, min: 1, current: 2, maxAdult: 4, maxChdAge: 13 },
  availableUnits: 1,
  board: 'HB',
  pricePerNight: 500,
  stayTotal: 2500,
  currency: 'EUR',
  bookUrl: 'book.php?x=1',
  priceBreakdown: [],
};

const rate = (rateId: string, overrides: Partial<typeof baseUnit> = {}): PhobsRate => ({
  rateId,
  name: rateId,
  shortDescription: '',
  stayMinNights: 1,
  units: [{ ...baseUnit, ...overrides }],
});

describe('applyRateFilters', () => {
  it('keeps everything when filters are empty', () => {
    const rates = [rate('R1'), rate('R2', { board: 'BB' })];
    const r = applyRateFilters(rates, {});
    expect(r.selected).toHaveLength(2);
    expect(r.trace).toHaveLength(0);
  });

  it('honours global.exclude_rate_ids', () => {
    const rates = [rate('R1'), rate('R2')];
    const r = applyRateFilters(rates, { global: { exclude_rate_ids: ['R1'] } });
    expect(r.selected.map((s) => s.rate.rateId)).toEqual(['R2']);
    expect(r.trace[0]!.step).toBe('global.exclude_rate_ids');
  });

  it('honours per-unit include_boards (BB only)', () => {
    const rates = [
      rate('R1', { board: 'HB' }),
      rate('R2', { board: 'BB' }),
      rate('R3', { board: 'FB' }),
    ];
    const r = applyRateFilters(rates, { units: { U1: { include_boards: ['BB'] } } });
    expect(r.selected.map((s) => s.rate.rateId)).toEqual(['R2']);
  });

  it('drops units below min_available_units', () => {
    const rates = [rate('R1', { availableUnits: 0 }), rate('R2', { availableUnits: 1 })];
    const r = applyRateFilters(rates, { global: { min_available_units: 1 } });
    expect(r.selected.map((s) => s.rate.rateId)).toEqual(['R2']);
  });

  it('sorts ascending by price and applies max_results per unit', () => {
    const rates = [
      rate('CHEAP', { pricePerNight: 100 }),
      rate('MID', { pricePerNight: 200 }),
      rate('EXP', { pricePerNight: 300 }),
    ];
    const r = applyRateFilters(rates, { units: { U1: { max_results: 2 } } });
    expect(r.selected.map((s) => s.rate.rateId)).toEqual(['CHEAP', 'MID']);
    expect(r.trace.find((t) => t.step === 'unit.max_results')?.rateId).toBe('EXP');
  });

  it('drops rates above max_price_per_night', () => {
    const rates = [rate('OK', { pricePerNight: 100 }), rate('TOO_EXPENSIVE', { pricePerNight: 999 })];
    const r = applyRateFilters(rates, { global: { max_price_per_night: 500 } });
    expect(r.selected.map((s) => s.rate.rateId)).toEqual(['OK']);
  });

  it('returns empty result when everything is filtered out', () => {
    const rates = [rate('R1', { board: 'HB' })];
    const r = applyRateFilters(rates, { global: { exclude_boards: ['HB'] } });
    expect(r.selected).toEqual([]);
    expect(r.trace[0]!.step).toBe('global.exclude_boards');
  });
});
