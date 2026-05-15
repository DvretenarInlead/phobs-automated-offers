import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface ProbeResponse {
  success: boolean;
  sessionId: string | null;
  rates: {
    rateId: string;
    name: string;
    units: {
      unitId: string;
      name: string;
      board: string;
      pricePerNight: number;
      stayTotal: number;
      currency: string;
      availableUnits: number;
    }[];
  }[];
}

interface TenantsResponse {
  tenants: { hubId: string; name: string }[];
}

export function PhobsProbe(): ReactElement {
  const { user } = useAuth();
  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantsResponse>('/tenants'),
  });

  const [hubId, setHubId] = useState(user?.scopedHubId ?? '');
  const [propertyId, setPropertyId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [nights, setNights] = useState(5);
  const [adults, setAdults] = useState(2);
  const [childAges, setChildAges] = useState('');
  const [unitIds, setUnitIds] = useState('');
  const [lang, setLang] = useState('en');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProbeResponse | null>(null);

  const fire = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<ProbeResponse>('/phobs-probe', {
        method: 'POST',
        body: {
          hubId: hubId.trim(),
          propertyId: propertyId.trim(),
          date,
          nights,
          adults,
          childAges: parseNums(childAges),
          unitIds: parseList(unitIds),
          lang,
        },
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'probe_failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-2">Phobs probe</h1>
      <p className="text-slate-400 text-sm mb-6">
        Diagnostic: fire a <code>PCPropertyAvailabilityRQ</code> against the tenant's Phobs
        endpoint without touching any HubSpot data.
      </p>

      <section className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {user?.role === 'superadmin' && (
            <Field label="Tenant">
              <select className="input" value={hubId} onChange={(e) => setHubId(e.target.value)}>
                <option value="">Select…</option>
                {tenantsQ.data?.tenants.map((t) => (
                  <option key={t.hubId} value={t.hubId}>
                    {t.name} ({t.hubId})
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Property ID">
            <input
              className="input font-mono"
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              placeholder="cc93fa8149..."
            />
          </Field>
          <Field label="Language">
            <input
              className="input"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              maxLength={5}
            />
          </Field>
          <Field label="Check-in date">
            <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Nights">
            <input
              type="number"
              min={1}
              max={60}
              className="input"
              value={nights}
              onChange={(e) => setNights(Number(e.target.value))}
            />
          </Field>
          <Field label="Adults">
            <input
              type="number"
              min={0}
              className="input"
              value={adults}
              onChange={(e) => setAdults(Number(e.target.value))}
            />
          </Field>
          <Field label="Child ages (comma-separated)">
            <input
              className="input"
              value={childAges}
              onChange={(e) => setChildAges(e.target.value)}
              placeholder="3, 8, 12"
            />
          </Field>
          <Field label="Unit IDs (comma-separated, optional)">
            <input
              className="input"
              value={unitIds}
              onChange={(e) => setUnitIds(e.target.value)}
              placeholder="17173, 17180"
            />
          </Field>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button onClick={fire} disabled={busy || !hubId || !propertyId} className="btn-primary">
            {busy ? 'Querying…' : 'Run probe'}
          </button>
          {error && <span className="text-rose-400 text-sm">{error}</span>}
        </div>
      </section>

      {result && (
        <section className="card">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="font-semibold">Result</h2>
            <span className={result.success ? 'pill-ok' : 'pill-fail'}>
              {result.success ? 'success' : 'failure'}
            </span>
            <span className="text-xs text-slate-500">
              {result.rates.length} rate{result.rates.length === 1 ? '' : 's'}
            </span>
          </div>
          {result.rates.length === 0 ? (
            <div className="text-slate-500 text-sm">
              Phobs returned no rate plans. With current rate filters this would mark the deal
              as <code>no_availability</code>.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Rate</th>
                  <th>Unit</th>
                  <th>Board</th>
                  <th>Price/night</th>
                  <th>Stay total</th>
                  <th>Avail.</th>
                </tr>
              </thead>
              <tbody>
                {result.rates.flatMap((r) =>
                  r.units.map((u) => (
                    <tr key={`${r.rateId}-${u.unitId}`}>
                      <td className="font-mono text-xs">{r.rateId}</td>
                      <td>{u.name}</td>
                      <td>{u.board}</td>
                      <td>{u.pricePerNight.toFixed(2)} {u.currency}</td>
                      <td>{u.stayTotal.toFixed(2)} {u.currency}</td>
                      <td>{u.availableUnits}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function parseNums(s: string): number[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function parseList(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
