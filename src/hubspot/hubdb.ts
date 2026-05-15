import type { Client as HubSpotClient } from '@hubspot/api-client';
import { callWithRetry } from '../lib/retry.js';
import { ExternalServiceError } from '../lib/errors.js';
import type { HubdbColumnMap } from '../tenancy/config.js';

export interface HubDbUnitRow {
  unitId: string;
  propertyId: string;
  /** All other columns as raw strings, for future use without re-querying. */
  extras: Record<string, unknown>;
}

interface HubDbRow {
  id?: string;
  values?: Record<string, unknown>;
}

function scalarString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}

/**
 * Queries the tenant's HubDB units table and returns rows matching the given
 * `propertyId`. The column names are admin-defined via `tenant_config.hubdb_column_map`.
 */
export async function queryUnitsByPropertyId(
  hs: HubSpotClient,
  tableId: string,
  map: HubdbColumnMap,
  propertyId: string,
): Promise<HubDbUnitRow[]> {
  const propertyColumn = map.property_id_column;
  const unitColumn = map.unit_id_column;
  if (!propertyColumn || !unitColumn) {
    throw new ExternalServiceError(
      'hubspot',
      'hubdb_column_map missing property_id_column or unit_id_column',
    );
  }

  return callWithRetry('hubspot', 'hubdb.query', async () => {
    try {
      // The HubSpot SDK's HubDB rows API supports `getTableRows(tableId, ...)`.
      // We fetch live (published) rows, then filter in-memory — HubDB filters
      // require column id (not name) and are dialect-specific. A small table
      // of unit definitions is fine to filter in JS.
      const res = await hs.cms.hubdb.rowsApi.getTableRows(tableId);
      const rows: HubDbRow[] = res.results ?? [];

      const matches: HubDbUnitRow[] = [];
      for (const row of rows) {
        const values = row.values ?? {};
        const propVal = values[propertyColumn];
        const unitVal = values[unitColumn];
        const propStr = scalarString(propVal);
        const unitStr = scalarString(unitVal);
        if (propStr !== propertyId) continue;
        if (!unitStr) continue;
        matches.push({ unitId: unitStr, propertyId, extras: values });
      }
      return matches;
    } catch (err) {
      const status =
        typeof err === 'object' && err !== null
          ? ((err as { code?: number }).code ??
            (err as { response?: { status?: number } }).response?.status)
          : undefined;
      throw new ExternalServiceError('hubspot', `hubdb.query failed: ${String(err)}`, status, err);
    }
  });
}
