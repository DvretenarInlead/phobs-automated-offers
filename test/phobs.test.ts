import { describe, it, expect } from 'vitest';
import { buildAvailabilityRequest } from '../src/phobs/buildRequest.js';
import { parseAvailabilityResponse } from '../src/phobs/parseResponse.js';

describe('buildAvailabilityRequest', () => {
  it('emits valid XML with auth, property, and unit filter', () => {
    const xml = buildAvailabilityRequest({
      lang: 'hr',
      propertyId: 'PROP1',
      date: '2026-07-20',
      nights: 5,
      unitIds: ['17173'],
      adults: 3,
      childAges: [10, 13],
      accessCode: 'GQ2079H1G069',
      auth: { siteId: 'SITE1', username: 'user', password: 'pw' },
    });
    expect(xml).toContain('<PCPropertyAvailabilityRQ Lang="hr">');
    expect(xml).toContain('<SiteId>SITE1</SiteId>');
    expect(xml).toContain('<Username>user</Username>');
    expect(xml).toContain('<Password>pw</Password>');
    expect(xml).toContain('<PropertyId>PROP1</PropertyId>');
    expect(xml).toContain('<UnitId>17173</UnitId>');
    expect(xml).toContain('<AccessCode>GQ2079H1G069</AccessCode>');
    expect(xml).toContain('<ChildAge>10</ChildAge>');
    expect(xml).toContain('<ChildAge>13</ChildAge>');
  });

  it('escapes hostile strings instead of injecting XML', () => {
    const xml = buildAvailabilityRequest({
      lang: 'hr',
      propertyId: 'PROP1',
      date: '2026-07-20',
      nights: 5,
      unitIds: [],
      adults: 1,
      childAges: [],
      auth: { siteId: 'SITE1', username: '"><x>', password: 'a&b' },
    });
    expect(xml).not.toMatch(/<x>/);
    expect(xml).toContain('a&amp;b');
  });

  it('omits Children element when no child ages provided', () => {
    const xml = buildAvailabilityRequest({
      lang: 'hr',
      propertyId: 'P',
      date: '2026-07-20',
      nights: 5,
      unitIds: [],
      adults: 2,
      childAges: [],
      auth: { siteId: 'S', username: 'u', password: 'p' },
    });
    expect(xml).not.toMatch(/<Children>/);
  });
});

describe('parseAvailabilityResponse', () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<PCPropertyAvailabilityRS xmlns="http://www.phobs.net/phobs/connect/2013/">
  <AvailabilityList>
    <RatePlans>
      <RatePlan RateId="RATE525802">
        <Name>Half board</Name>
        <ShortDescription>Test</ShortDescription>
        <Units>
          <Unit OccupancyMax="5" OccupancyMin="2" Occupancy="2" UnitId="17173" AvailableUnits="1" OccupancyMaxAdult="4" OccupancyMinAdult="1" OccupancyMaxChd="4" OccupancyMinChd="0" OccupancyMaxChdAge="13">
            <Name>Family room</Name>
            <Rate>
              <Board>HB</Board>
              <Price Currency="EUR" PriceType="PerNight">620.21</Price>
              <PriceBreakdown>
                <PriceDay><Date>2026-07-20</Date><Price Currency="EUR" PriceType="PerNight">631.84</Price></PriceDay>
              </PriceBreakdown>
              <StayTotal Currency="EUR" PriceType="PerStay">
                <Price>3876.33</Price><Currency>EUR</Currency><PriceType>PerStay</PriceType>
              </StayTotal>
            </Rate>
            <BookUrl>book.php?company_id=abc</BookUrl>
          </Unit>
        </Units>
        <Restrictions><StayMin>1</StayMin></Restrictions>
      </RatePlan>
    </RatePlans>
  </AvailabilityList>
  <SessionID>sess1</SessionID>
  <ResponseType><Success/></ResponseType>
</PCPropertyAvailabilityRS>`;

  it('parses rates, units, prices, breakdown', () => {
    const r = parseAvailabilityResponse(sampleXml);
    expect(r.success).toBe(true);
    expect(r.sessionId).toBe('sess1');
    expect(r.rates).toHaveLength(1);
    const rate = r.rates[0]!;
    expect(rate.rateId).toBe('RATE525802');
    expect(rate.stayMinNights).toBe(1);
    const unit = rate.units[0]!;
    expect(unit.unitId).toBe('17173');
    expect(unit.board).toBe('HB');
    expect(unit.pricePerNight).toBe(620.21);
    expect(unit.stayTotal).toBe(3876.33);
    expect(unit.currency).toBe('EUR');
    expect(unit.priceBreakdown).toHaveLength(1);
    expect(unit.priceBreakdown[0]!.date).toBe('2026-07-20');
    expect(unit.priceBreakdown[0]!.price).toBe(631.84);
    expect(unit.bookUrl).toContain('book.php');
  });

  it('refuses to parse external entities (XXE-safe)', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<PCPropertyAvailabilityRS>
  <AvailabilityList>
    <RatePlans>
      <RatePlan RateId="&xxe;">
        <Name>n</Name>
        <ShortDescription>d</ShortDescription>
        <Units></Units>
      </RatePlan>
    </RatePlans>
  </AvailabilityList>
  <ResponseType><Success/></ResponseType>
</PCPropertyAvailabilityRS>`;
    // Parser should throw on DTD external entity rather than resolve it.
    expect(() => parseAvailabilityResponse(xxe)).toThrow(/External entities are not supported/);
  });
});
