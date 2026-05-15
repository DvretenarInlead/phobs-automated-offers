import { describe, expect, it } from 'vitest';
import { normalizeChildAges } from '../src/tenancy/childAgeRules.js';

const rules = {
  PROP_A: { name: 'A', donja: 2.99, gornja: 13.99 },
  PROP_B: { name: 'B', donja: 2.99, gornja: 11.99 },
};

describe('normalizeChildAges', () => {
  it('drops infants (age <= donja)', () => {
    const r = normalizeChildAges({
      childAges: [2, 2.5, 1],
      adults: 2,
      propertyId: 'PROP_A',
      rules,
    });
    expect(r.childAges).toEqual([]);
    expect(r.adults).toBe(2);
    expect(r.numberOfChildren).toBe(0);
  });

  it('keeps children within (donja, gornja]', () => {
    const r = normalizeChildAges({
      childAges: [3, 10, 13.99],
      adults: 2,
      propertyId: 'PROP_A',
      rules,
    });
    expect(r.childAges).toEqual([3, 10, 13.99]);
    expect(r.adults).toBe(2);
    expect(r.numberOfChildren).toBe(3);
  });

  it('promotes children older than gornja to adults', () => {
    const r = normalizeChildAges({
      childAges: [12, 15, 17],
      adults: 1,
      propertyId: 'PROP_B', // gornja 11.99
      rules,
    });
    // 12,15,17 all > 11.99 → +3 adults, 0 children
    expect(r.adults).toBe(4);
    expect(r.childAges).toEqual([]);
    expect(r.numberOfChildren).toBe(0);
  });

  it('mixes infant / child / adult correctly (matches legacy Make scenario)', () => {
    const r = normalizeChildAges({
      childAges: [10, 13],
      adults: 3,
      propertyId: 'PROP_A',
      rules,
    });
    expect(r.adults).toBe(3);
    expect(r.childAges).toEqual([10, 13]);
    expect(r.numberOfChildren).toBe(2);
  });

  it('marks unknown property and passes input through unchanged', () => {
    const r = normalizeChildAges({
      childAges: [5, 7],
      adults: 2,
      propertyId: 'NOPE',
      rules,
    });
    expect(r.unknownProperty).toBe(true);
    expect(r.childAges).toEqual([5, 7]);
    expect(r.adults).toBe(2);
  });
});
