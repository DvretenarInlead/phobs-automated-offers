import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface ProbeUnit {
  unitId: string;
  name: string;
  board: string;
  pricePerNight: number;
  stayTotal: number;
  currency: string;
  availableUnits: number;
  priceBreakdown?: { date: string; price: number }[];
}

interface ProbeRate {
  rateId: string;
  name: string;
  units: ProbeUnit[];
}

interface ProbeQuote {
  rateId: string;
  rateName: string;
  unitId: string;
  unitName: string;
  board: string;
  pricePerNight: number;
  stayTotal: number;
  currency: string;
  priceBreakdown: { date: string; price: number }[];
}

interface ProbeResponse {
  mode: 'availability' | 'price_quote';
  success: boolean;
  error?: string | null;
  sessionId: string | null;
  quote?: ProbeQuote | null;
  rates: ProbeRate[];
  rawXml?: string;
}

interface TenantsResponse {
  tenants: { hubId: string; name: string }[];
}

type Mode = 'availability' | 'price_quote';

export function PhobsProbe(): ReactElement {
  const { user } = useAuth();
  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantsResponse>('/tenants'),
  });

  const [mode, setMode] = useState<Mode>('availability');
  const [hubId, setHubId] = useState(user?.scopedHubId ?? '');
  const [propertyId, setPropertyId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [nights, setNights] = useState(5);
  const [adults, setAdults] = useState(2);
  const [childAges, setChildAges] = useState('');
  const [unitIds, setUnitIds] = useState('');
  const [rateId, setRateId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [lang, setLang] = useState('en');
  const [includeRawXml, setIncludeRawXml] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProbeResponse | null>(null);

  const canFire =
    !busy && Boolean(hubId) && Boolean(propertyId.trim()) && (mode === 'availability' || Boolean(unitId.trim()));

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
          unitIds: mode === 'availability' ? parseList(unitIds) : [],
          lang,
          mode,
          rateId: mode === 'price_quote' && rateId.trim() ? rateId.trim() : undefined,
          unitId: mode === 'price_quote' ? unitId.trim() : undefined,
          accessCode: accessCode.trim() || undefined,
          includeRawXml,
        },
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'probe_failed');
    } finally {
      setBusy(false);
    }
  };

  // Clicking a row in an availability result pre-fills a price-quote probe
  // for that rate × unit — the natural "now get me the firm price" flow.
  const quoteThis = (r: ProbeRate, u: ProbeUnit): void => {
    setMode('price_quote');
    setRateId(r.rateId);
    setUnitId(u.unitId);
    setResult(null);
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-2">Phobs probe</h1>
      <p className="text-slate-400 text-sm mb-6">
        Diagnostic: fire a <code>PCPropertyAvailabilityRQ</code> or a{' '}
        <code>PCPriceQuoteRQ</code> against the tenant's Phobs endpoint without touching any
        HubSpot data. Use <em>price quote</em> mode to validate the quote response shape before
        enabling firm re-pricing in the tenant's pipeline overrides.
      </p>

      <section className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Mode">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="availability">Availability (PCPropertyAvailabilityRQ)</option>
              <option value="price_quote">Price quote (PCPriceQuoteRQ)</option>
            </select>
          </Field>
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
              maxLength={8}
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
              max={20}
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
          <Field label="Access code (loyalty, optional)">
            <input
              className="input font-mono"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              maxLength={64}
            />
          </Field>
          {mode === 'availability' ? (
            <Field label="Unit IDs (comma-separated, optional)">
              <input
                className="input"
                value={unitIds}
                onChange={(e) => setUnitIds(e.target.value)}
                placeholder="17173, 17180"
              />
            </Field>
          ) : (
            <>
              <Field label="Unit ID (required)">
                <input
                  className="input font-mono"
                  value={unitId}
                  onChange={(e) => setUnitId(e.target.value)}
                  placeholder="17173"
                  maxLength={64}
                />
              </Field>
              <Field label="Rate ID (blank = all rates)">
                <input
                  className="input font-mono"
                  value={rateId}
                  onChange={(e) => setRateId(e.target.value)}
                  placeholder="RATE525802"
                  maxLength={64}
                />
              </Field>
            </>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-300 self-end pb-2">
            <input
              type="checkbox"
              checked={includeRawXml}
              onChange={(e) => setIncludeRawXml(e.target.checked)}
            />
            Include raw response XML
          </label>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button type="button" onClick={fire} disabled={!canFire} className="btn-primary">
            {busy ? 'Querying…' : mode === 'availability' ? 'Run availability probe' : 'Run price quote'}
          </button>
          {error && <span className="text-rose-400 text-sm">{error}</span>}
        </div>
      </section>

      {result && (
        <section className="card">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="font-semibold">
              {result.mode === 'price_quote' ? 'Price quote' : 'Availability'} result
            </h2>
            <span className={result.success ? 'pill-ok' : 'pill-fail'}>
              {result.success ? 'success' : 'failure'}
            </span>
            {result.error && <span className="text-rose-400 text-xs">{result.error}</span>}
            <span className="text-xs text-slate-500">
              {result.rates.length} rate{result.rates.length === 1 ? '' : 's'}
              {result.sessionId ? ` · session ${result.sessionId}` : ''}
            </span>
          </div>

          {result.mode === 'price_quote' && (
            <div className="mb-4">
              {result.quote ? (
                <div className="rounded border border-emerald-700/50 bg-emerald-950/20 p-3 text-sm">
                  <div className="font-semibold">
                    {result.quote.unitName} — {result.quote.rateName}{' '}
                    <span className="text-slate-500 font-mono text-xs">
                      ({result.quote.unitId} / {result.quote.rateId})
                    </span>
                  </div>
                  <div className="mt-1">
                    Board <b>{result.quote.board || '—'}</b> · per night{' '}
                    <b>
                      {result.quote.pricePerNight.toFixed(2)} {result.quote.currency}
                    </b>{' '}
                    · stay total{' '}
                    <b>
                      {result.quote.stayTotal.toFixed(2)} {result.quote.currency}
                    </b>
                  </div>
                  {result.quote.priceBreakdown.length > 0 && (
                    <div className="mt-2 text-xs text-slate-400 font-mono">
                      {result.quote.priceBreakdown
                        .map((d) => `${d.date}: ${d.price.toFixed(2)}`)
                        .join(' · ')}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-amber-300 text-sm">
                  Phobs answered but no rate/unit price could be extracted. Enable
                  &quot;Include raw response XML&quot; and re-run to see the exact response shape.
                </div>
              )}
            </div>
          )}

          {result.rates.length === 0 ? (
            result.mode === 'availability' && (
              <div className="text-slate-500 text-sm">
                Phobs returned no rate plans. With current rate filters this would mark the deal
                as <code>no_availability</code>.
              </div>
            )
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
                  {result.mode === 'availability' && <th></th>}
                </tr>
              </thead>
              <tbody>
                {result.rates.flatMap((r) =>
                  r.units.map((u) => (
                    <tr key={`${r.rateId}-${u.unitId}`}>
                      <td className="font-mono text-xs">{r.rateId}</td>
                      <td>{u.name}</td>
                      <td>{u.board}</td>
                      <td>
                        {u.pricePerNight.toFixed(2)} {u.currency}
                      </td>
                      <td>
                        {u.stayTotal.toFixed(2)} {u.currency}
                      </td>
                      <td>{u.availableUnits}</td>
                      {result.mode === 'availability' && (
                        <td>
                          <button
                            type="button"
                            className="text-emerald-400 hover:text-emerald-300 text-xs"
                            onClick={() => quoteThis(r, u)}
                          >
                            Quote this →
                          </button>
                        </td>
                      )}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          )}

          {result.rawXml && (
            <details className="mt-4">
              <summary className="text-xs text-slate-400 cursor-pointer">Raw response XML</summary>
              <pre className="mt-2 text-xs bg-slate-950 border border-slate-800 rounded p-2 overflow-auto max-h-96 whitespace-pre-wrap break-all">
                {result.rawXml}
              </pre>
            </details>
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
