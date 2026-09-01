import { describe, it, expect } from 'vitest';
import { buildPriceQuoteRequest, parsePriceQuoteResponse } from '../src/phobs/priceQuote.js';
import { parseResponseType, parseXml } from '../src/phobs/parseResponse.js';

const auth = { siteId: 'SITE1', username: 'user', password: 'pw' };

describe('buildPriceQuoteRequest', () => {
  it('emits PCPriceQuoteRQ with auth, rate, unit and stay', () => {
    const xml = buildPriceQuoteRequest({
      lang: 'hr',
      propertyId: 'PROP1',
      rateId: 'RATE525802',
      unitId: '17173',
      date: '2026-07-20',
      nights: 5,
      adults: 2,
      childAges: [8, 3],
      accessCode: 'LOY-42',
      auth,
    });
    expect(xml).toContain('<PCPriceQuoteRQ Lang="hr">');
    expect(xml).toContain('<SiteId>SITE1</SiteId>');
    expect(xml).toContain('<PropertyId>PROP1</PropertyId>');
    expect(xml).toContain('<RateId>RATE525802</RateId>');
    expect(xml).toContain('<UnitId>17173</UnitId>');
    expect(xml).toContain('<Date>2026-07-20</Date>');
    expect(xml).toContain('<Nights>5</Nights>');
    expect(xml).toContain('<Adults>2</Adults>');
    expect(xml).toContain('<ChildAge>8</ChildAge><ChildAge>3</ChildAge>');
    expect(xml).toContain('<AccessCode>LOY-42</AccessCode>');
  });

  it('escapes hostile strings instead of injecting XML', () => {
    const xml = buildPriceQuoteRequest({
      lang: 'en',
      propertyId: 'P',
      rateId: '"><Injected/>',
      unitId: 'U',
      date: '2026-07-20',
      nights: 1,
      adults: 1,
      childAges: [],
      auth: { ...auth, password: 'a&b<c' },
    });
    expect(xml).not.toMatch(/<Injected\/>/);
    expect(xml).toContain('&lt;Injected/&gt;');
    expect(xml).toContain('a&amp;b&lt;c');
  });
});

const okRs = `<?xml version="1.0"?>
<PCPriceQuoteRS>
  <ResponseType><Success/></ResponseType>
  <SessionID>abc123</SessionID>
  <AvailabilityList>
    <RatePlans>
      <RatePlan RateId="RATE525802">
        <Name>Special</Name>
        <Units>
          <Unit UnitId="17173" AvailableUnits="1">
            <Name>Family room</Name>
            <Rate>
              <Board>HB</Board>
              <Price Currency="EUR">620.21</Price>
              <StayTotal><Price>3101.05</Price><Currency>EUR</Currency></StayTotal>
              <PriceBreakdown>
                <PriceDay><Date>2026-07-20</Date><Price>631.84</Price></PriceDay>
                <PriceDay><Date>2026-07-21</Date><Price>608.58</Price></PriceDay>
              </PriceBreakdown>
            </Rate>
          </Unit>
        </Units>
      </RatePlan>
    </RatePlans>
  </AvailabilityList>
</PCPriceQuoteRS>`;

describe('parsePriceQuoteResponse', () => {
  it('flattens the first rate × unit into quote', () => {
    const res = parsePriceQuoteResponse(okRs);
    expect(res.success).toBe(true);
    expect(res.error).toBeNull();
    expect(res.sessionId).toBe('abc123');
    expect(res.quote).toEqual({
      rateId: 'RATE525802',
      rateName: 'Special',
      unitId: '17173',
      unitName: 'Family room',
      board: 'HB',
      pricePerNight: 620.21,
      stayTotal: 3101.05,
      currency: 'EUR',
      priceBreakdown: [
        { date: '2026-07-20', price: 631.84 },
        { date: '2026-07-21', price: 608.58 },
      ],
    });
    expect(res.rates).toHaveLength(1);
    expect(res.rawXml).toBe(okRs);
  });

  it('accepts rate plans directly under the root and any *RS root name', () => {
    const xml = `<PCQuoteRS><ResponseType><Success/></ResponseType>
      <RatePlans><RatePlan RateId="R1"><Name>N</Name><Units><Unit UnitId="U1">
      <Name>Unit</Name><Rate><Board>BB</Board><Price>100</Price>
      <StayTotal><Price>300</Price><Currency>EUR</Currency></StayTotal></Rate>
      </Unit></Units></RatePlan></RatePlans></PCQuoteRS>`;
    const res = parsePriceQuoteResponse(xml);
    expect(res.success).toBe(true);
    expect(res.quote?.rateId).toBe('R1');
    expect(res.quote?.stayTotal).toBe(300);
  });

  it('surfaces Phobs error messages and no quote', () => {
    const xml = `<PCPriceQuoteRS><ResponseType><Errors><Error><Message>Invalid credentials</Message></Error></Errors></ResponseType></PCPriceQuoteRS>`;
    const res = parsePriceQuoteResponse(xml);
    expect(res.success).toBe(false);
    expect(res.error).toBe('Invalid credentials');
    expect(res.quote).toBeNull();
    expect(res.rates).toEqual([]);
  });

  it('refuses external entities outright (XXE) instead of resolving them', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <PCPriceQuoteRS><ResponseType><Success/></ResponseType><SessionID>&xxe;</SessionID></PCPriceQuoteRS>`;
    // fast-xml-parser with processEntities:false fails fast on external
    // entities — the desired behaviour (surfaced as a 502 upstream error).
    expect(() => parsePriceQuoteResponse(xml)).toThrow(/External entities are not supported/);
  });

  it('parseResponseType handles bare error text and missing message', () => {
    expect(parseResponseType(parseXml('<R><ResponseType><Errors><Error>boom</Error></Errors></ResponseType></R>').R as Record<string, unknown>)).toEqual({ success: false, error: 'boom' });
    expect(parseResponseType(parseXml('<R><ResponseType><Errors/></ResponseType></R>').R as Record<string, unknown>)).toEqual({ success: false, error: 'phobs_error' });
  });
});
