import { XMLBuilder } from 'fast-xml-parser';

export interface PhobsAuth {
  siteId: string;
  username: string;
  password: string;
}

export interface PhobsAvailabilityRequest {
  lang: string;
  propertyId: string;
  date: string; // YYYY-MM-DD
  nights: number;
  unitIds: string[];
  adults: number;
  childAges: number[]; // empty array OK
  includeRestricted?: boolean;
  accessCode?: string;
  auth: PhobsAuth;
}

interface XmlNode {
  [k: string]: unknown;
}

/**
 * Builds a PCPropertyAvailabilityRQ XML document.
 *
 * Critically, we use a structured builder — never string interpolation — so
 * tenant-supplied strings cannot inject XML elements or attributes.
 */
export function buildAvailabilityRequest(input: PhobsAvailabilityRequest): string {
  const unitFilter: XmlNode = {
    Date: input.date,
    Nights: input.nights,
    UnitItem: {
      Item: {
        Adults: input.adults,
        ...(input.childAges.length > 0
          ? { Children: { ChildAge: input.childAges } }
          : {}),
      },
    },
    IncludeRestricted: input.includeRestricted ?? false,
  };
  if (input.unitIds.length > 0) unitFilter.UnitId = input.unitIds;
  if (input.accessCode) unitFilter.AccessCode = input.accessCode;

  const doc: XmlNode = {
    '?xml': { '@_version': '1.0', '@_encoding': 'utf-8' },
    PCPropertyAvailabilityRQ: {
      '@_Lang': input.lang,
      Auth: {
        SiteId: input.auth.siteId,
        Username: input.auth.username,
        Password: input.auth.password,
      },
      PropertyId: input.propertyId,
      RateId: '',
      UnitFilter: unitFilter,
    },
  };

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
    suppressEmptyNode: false,
    processEntities: true,
  });
  return builder.build(doc);
}
