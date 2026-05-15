import { XMLParser } from 'fast-xml-parser';

export interface PhobsRate {
  rateId: string;
  name: string;
  shortDescription: string;
  units: PhobsUnit[];
  stayMinNights: number | null;
}

export interface PhobsUnit {
  unitId: string;
  name: string;
  occupancy: { max: number; min: number; current: number; maxAdult: number; maxChdAge: number };
  availableUnits: number;
  board: string;
  pricePerNight: number;
  stayTotal: number;
  currency: string;
  bookUrl: string;
  priceBreakdown: { date: string; price: number }[];
}

export interface PhobsAvailabilityResponse {
  rates: PhobsRate[];
  sessionId: string | null;
  success: boolean;
  rawXml: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // SECURITY: do not load DTDs or process external entities → no XXE.
  processEntities: false,
  allowBooleanAttributes: false,
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
});

function toArray<T>(v: unknown): T[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

type XmlObj = Record<string, unknown>;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  // Objects (e.g. Phobs sometimes nests `{ '#text': '...' }`) — pull the inner text or fall back.
  if (typeof v === 'object' && '#text' in v) {
    const t = v['#text'];
    if (typeof t === 'string') return t;
    if (typeof t === 'number') return String(t);
  }
  return '';
}

export function parseAvailabilityResponse(xml: string): PhobsAvailabilityResponse {
  // fast-xml-parser returns `any`; isolate the unsafe surface to this single read.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc: XmlObj = parser.parse(xml);
  const rootRaw = doc.PCPropertyAvailabilityRS;
  const root: XmlObj = rootRaw && typeof rootRaw === 'object' ? (rootRaw as XmlObj) : {};

  const availability = (root.AvailabilityList ?? {}) as XmlObj;
  const ratePlansContainer = (availability.RatePlans ?? {}) as XmlObj;
  const ratePlans = toArray<XmlObj>(ratePlansContainer.RatePlan);

  const rates: PhobsRate[] = ratePlans.map((rp): PhobsRate => {
    const unitsContainer = (rp.Units ?? {}) as XmlObj;
    const units = toArray<XmlObj>(unitsContainer.Unit);
    const restrictions = (rp.Restrictions ?? {}) as XmlObj;

    return {
      rateId: str(rp['@_RateId']),
      name: str(rp.Name),
      shortDescription: str(rp.ShortDescription),
      stayMinNights: restrictions.StayMin != null ? num(restrictions.StayMin) : null,
      units: units.map((u): PhobsUnit => {
        const rate = (u.Rate ?? {}) as XmlObj;
        const price = (rate.Price ?? {}) as XmlObj;
        const stayTotal = (rate.StayTotal ?? {}) as XmlObj;
        const breakdown = (rate.PriceBreakdown ?? {}) as XmlObj;
        const days = toArray<XmlObj>(breakdown.PriceDay);

        return {
          unitId: str(u['@_UnitId']),
          name: str(u.Name),
          occupancy: {
            max: num(u['@_OccupancyMax']),
            min: num(u['@_OccupancyMin']),
            current: num(u['@_Occupancy']),
            maxAdult: num(u['@_OccupancyMaxAdult']),
            maxChdAge: num(u['@_OccupancyMaxChdAge']),
          },
          availableUnits: num(u['@_AvailableUnits']),
          board: str(rate.Board),
          pricePerNight: num(
            typeof price === 'object' && price !== null
              ? (price['#text'] ?? rate.Price)
              : rate.Price,
          ),
          stayTotal: num(stayTotal.Price),
          currency: str(stayTotal.Currency ?? price['@_Currency']),
          bookUrl: str(u.BookUrl).trim(),
          priceBreakdown: days.map((d) => {
            const dp = (d.Price ?? {}) as XmlObj;
            return {
              date: str(d.Date),
              price: num(
                typeof dp === 'object' && dp !== null ? (dp['#text'] ?? d.Price) : d.Price,
              ),
            };
          }),
        };
      }),
    };
  });

  const responseType = (root.ResponseType ?? {}) as Record<string, unknown>;
  const success = 'Success' in responseType;
  const sessionId = root.SessionID ? str(root.SessionID) : null;

  return { rates, sessionId, success, rawXml: xml };
}
