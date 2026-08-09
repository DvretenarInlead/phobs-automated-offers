import { describe, expect, it } from 'vitest';
import {
  evaluateSkip,
  readMapped,
  renderTemplate,
  resolveOverrides,
  shouldAttachLoyalty,
} from '../src/tenancy/overrides.js';

describe('resolveOverrides', () => {
  it('populates every field with defaults when input is empty', () => {
    const ov = resolveOverrides({});
    expect(ov.input_field_map.deal_id).toBe('hs_object_id');
    expect(ov.output_field_map.quote_link).toBe('quote_link_custom');
    expect(ov.quote_defaults.expiration_days).toBe(3);
    expect(ov.default_lang).toBe('en');
    expect(ov.product_sku_template).toBe('{portalId}:{unitId}:{rateId}');
    expect(ov.loyalty_rule.trigger_property).toBe('bluesunrewards___loyaltyid');
    expect(ov.skip_conditions).toEqual([]);
  });

  it('accepts undefined and null', () => {
    expect(resolveOverrides(undefined).default_lang).toBe('en');
    expect(resolveOverrides(null).default_lang).toBe('en');
  });

  it('deep-merges partial overrides', () => {
    const ov = resolveOverrides({
      input_field_map: { deal_id: 'my_deal_id' },
      quote_defaults: { expiration_days: 7 },
    });
    expect(ov.input_field_map.deal_id).toBe('my_deal_id');
    expect(ov.input_field_map.property_id).toBe('rezapp___property_id'); // default preserved
    expect(ov.quote_defaults.expiration_days).toBe(7);
    expect(ov.quote_defaults.title_template).toContain('{dealId}'); // default preserved
  });

  it('rejects unsafe values', () => {
    expect(() => resolveOverrides({ quote_defaults: { expiration_days: -1 } })).toThrow();
    expect(() => resolveOverrides({ quote_defaults: { expiration_days: 999 } })).toThrow();
    expect(() =>
      resolveOverrides({ skip_conditions: [{ property: '', operator: 'eq', values: [1] }] }),
    ).toThrow();
    expect(() =>
      resolveOverrides({ skip_conditions: [{ property: 'x', operator: 'bogus' }] }),
    ).toThrow();
  });
});

describe('readMapped', () => {
  it('returns the first non-empty value across a chain', () => {
    expect(readMapped({ a: 'x' }, 'a')).toBe('x');
    expect(readMapped({ a: 'x' }, 'missing', 'a')).toBe('x');
    expect(readMapped({ a: '', b: 'y' }, 'a', 'b')).toBe('y');
    expect(readMapped({ a: null, b: 0 }, 'a', 'b')).toBe(0);
    expect(readMapped({}, 'x')).toBeUndefined();
  });
});

describe('evaluateSkip', () => {
  it('does not skip when no conditions', () => {
    expect(evaluateSkip({ dealstage: 'X' }, []).skip).toBe(false);
  });

  it('skips when eq matches', () => {
    const r = evaluateSkip(
      { dealstage: 'lost' },
      [{ property: 'dealstage', operator: 'eq', values: ['lost'] }],
    );
    expect(r.skip).toBe(true);
    expect(r.matched?.property).toBe('dealstage');
  });

  it('handles in / not_in / present / absent', () => {
    expect(
      evaluateSkip(
        { s: 'won' },
        [{ property: 's', operator: 'in', values: ['won', 'lost'] }],
      ).skip,
    ).toBe(true);
    expect(
      evaluateSkip(
        { s: 'won' },
        [{ property: 's', operator: 'not_in', values: ['A', 'B'] }],
      ).skip,
    ).toBe(true);
    expect(evaluateSkip({ x: 'y' }, [{ property: 'x', operator: 'present' }]).skip).toBe(true);
    expect(evaluateSkip({}, [{ property: 'x', operator: 'absent' }]).skip).toBe(true);
    expect(evaluateSkip({ x: '' }, [{ property: 'x', operator: 'absent' }]).skip).toBe(true);
  });

  it('treats numeric HubSpot strings as numbers for eq/in', () => {
    // HubSpot serialises numeric properties as strings.
    expect(
      evaluateSkip(
        { count: '5' },
        [{ property: 'count', operator: 'eq', values: [5] }],
      ).skip,
    ).toBe(true);
    expect(
      evaluateSkip(
        { count: 5 },
        [{ property: 'count', operator: 'in', values: ['5', '10'] }],
      ).skip,
    ).toBe(true);
  });

  it('OR-semantics across multiple conditions', () => {
    const r = evaluateSkip(
      { a: 'X', b: 'Y' },
      [
        { property: 'a', operator: 'eq', values: ['NOT_X'] },
        { property: 'b', operator: 'eq', values: ['Y'] },
      ],
    );
    expect(r.skip).toBe(true);
    expect(r.matched?.property).toBe('b');
  });
});

describe('shouldAttachLoyalty', () => {
  it('present preserves legacy behaviour', () => {
    const rule = { trigger_property: 'loyalty', trigger_condition: 'present' as const };
    expect(shouldAttachLoyalty({ loyalty: 12345 }, rule)).toBe(true);
    expect(shouldAttachLoyalty({ loyalty: null }, rule)).toBe(false);
    expect(shouldAttachLoyalty({ loyalty: '' }, rule)).toBe(false);
    expect(shouldAttachLoyalty({}, rule)).toBe(false);
  });

  it('truthy / falsy / absent operators', () => {
    expect(
      shouldAttachLoyalty(
        { flag: false },
        { trigger_property: 'flag', trigger_condition: 'falsy' },
      ),
    ).toBe(true);
    expect(
      shouldAttachLoyalty(
        { flag: 0 },
        { trigger_property: 'flag', trigger_condition: 'truthy' },
      ),
    ).toBe(false);
    expect(
      shouldAttachLoyalty(
        {},
        { trigger_property: 'x', trigger_condition: 'absent' },
      ),
    ).toBe(true);
  });
});

describe('renderTemplate', () => {
  it('substitutes whitelisted placeholders', () => {
    expect(
      renderTemplate('{portalId}:{unitId}:{rateId}', {
        portalId: '111',
        unitId: '17173',
        rateId: 'RATE525802',
      }),
    ).toBe('111:17173:RATE525802');
  });

  it('leaves unknown placeholders as literal text', () => {
    expect(renderTemplate('{a}-{missing}', { a: '1' })).toBe('1-{missing}');
  });

  it('handles empty and multi-substitution', () => {
    expect(renderTemplate('', { a: '1' })).toBe('');
    expect(renderTemplate('{a}{a}{a}', { a: 'X' })).toBe('XXX');
    expect(renderTemplate('This is your personalized offer #{dealId}', { dealId: '42' })).toBe(
      'This is your personalized offer #42',
    );
  });
});
