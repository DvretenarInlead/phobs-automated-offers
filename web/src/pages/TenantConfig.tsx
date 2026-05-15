import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { RateFiltersEditor } from '../components/RateFiltersEditor';
import type { RateFilters } from '../components/RateFiltersEditor';

interface ConfigResponse {
  hubId: string;
  phobs_endpoint: string;
  phobs_site_id: string;
  phobs_auth_user: string; // masked
  phobs_auth_pass: string; // masked
  hubdb_table_id: string;
  hubdb_column_map: Record<string, string>;
  quote_template_id: string;
  owner_id: string;
  access_code: string | null;
  property_rules: Record<string, { name: string; donja: number; gornja: number }>;
  rate_filters: Record<string, unknown>;
  trigger_mode: 'webhook' | 'workflow_extension';
}

interface PropertyRow {
  id: string;
  propertyId: string;
  name: string;
  donja: string;
  gornja: string;
}

export function TenantConfig(): ReactElement {
  const { hubId } = useParams<{ hubId: string }>();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['config', hubId],
    queryFn: () => api<ConfigResponse>(`/tenants/${hubId!}/config`),
    enabled: Boolean(hubId),
  });

  const [form, setForm] = useState<Partial<ConfigResponse> & {
    phobs_auth_user_new?: string;
    phobs_auth_pass_new?: string;
  }>({});
  const [rules, setRules] = useState<PropertyRow[]>([]);
  const [rateFilters, setRateFilters] = useState<RateFilters>({});
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from server response once.
  useEffect(() => {
    if (!q.data) return;
    setForm({
      phobs_endpoint: q.data.phobs_endpoint,
      phobs_site_id: q.data.phobs_site_id,
      hubdb_table_id: q.data.hubdb_table_id,
      hubdb_column_map: q.data.hubdb_column_map,
      quote_template_id: q.data.quote_template_id,
      owner_id: q.data.owner_id,
      access_code: q.data.access_code,
      trigger_mode: q.data.trigger_mode,
    });
    setRules(
      Object.entries(q.data.property_rules ?? {}).map(([propertyId, r], i) => ({
        id: `r${String(i)}`,
        propertyId,
        name: r.name,
        donja: String(r.donja),
        gornja: String(r.gornja),
      })),
    );
    setRateFilters((q.data.rate_filters as RateFilters) ?? {});
  }, [q.data]);

  const save = useMutation({
    mutationFn: async (): Promise<{ ok: true }> => {
      const property_rules = Object.fromEntries(
        rules
          .filter((r) => r.propertyId.trim())
          .map((r) => [
            r.propertyId.trim(),
            { name: r.name.trim(), donja: Number(r.donja), gornja: Number(r.gornja) },
          ]),
      );

      const body: Record<string, unknown> = {
        phobs_endpoint: form.phobs_endpoint,
        phobs_site_id: form.phobs_site_id,
        hubdb_table_id: form.hubdb_table_id,
        hubdb_column_map: form.hubdb_column_map,
        quote_template_id: form.quote_template_id,
        owner_id: form.owner_id,
        access_code: form.access_code ?? null,
        trigger_mode: form.trigger_mode,
        property_rules,
        rate_filters: rateFilters,
      };
      if (form.phobs_auth_user_new) body.phobs_auth_user = form.phobs_auth_user_new;
      if (form.phobs_auth_pass_new) body.phobs_auth_pass = form.phobs_auth_pass_new;
      return api(`/tenants/${hubId!}/config`, { method: 'PUT', body });
    },
    onSuccess: async () => {
      setSavedAt(new Date());
      setError(null);
      setForm((f) => ({ ...f, phobs_auth_user_new: '', phobs_auth_pass_new: '' }));
      await qc.invalidateQueries({ queryKey: ['config', hubId] });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'save_failed');
    },
  });

  if (q.isPending) return <div className="text-slate-500 text-sm">Loading…</div>;
  if (q.error) return <div className="text-rose-400 text-sm">Failed to load config.</div>;

  const setField = <K extends keyof ConfigResponse>(k: K, v: ConfigResponse[K]): void => {
    setForm((f) => ({ ...f, [k]: v }));
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tenant config</h1>
          <div className="text-slate-500 text-sm font-mono">hub_id={hubId}</div>
        </div>
        <div className="flex items-center gap-3">
          {savedAt && <span className="text-emerald-400 text-sm">Saved {savedAt.toLocaleTimeString()}</span>}
          {error && <span className="text-rose-400 text-sm">{error}</span>}
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="btn-primary"
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </header>

      <section className="card">
        <h2 className="font-semibold mb-4">Phobs connection</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Endpoint URL">
            <input
              className="input"
              value={form.phobs_endpoint ?? ''}
              onChange={(e) => setField('phobs_endpoint', e.target.value)}
              placeholder="https://api.phobs.net/..."
            />
          </Field>
          <Field label="Site ID">
            <input
              className="input"
              value={form.phobs_site_id ?? ''}
              onChange={(e) => setField('phobs_site_id', e.target.value)}
            />
          </Field>
          <Field label="Username (leave blank to keep)">
            <input
              className="input"
              autoComplete="off"
              value={form.phobs_auth_user_new ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, phobs_auth_user_new: e.target.value }))}
              placeholder="••••••••"
            />
          </Field>
          <Field label="Password (leave blank to keep)">
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={form.phobs_auth_pass_new ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, phobs_auth_pass_new: e.target.value }))}
              placeholder="••••••••"
            />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-4">HubSpot</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="HubDB table ID">
            <input
              className="input"
              value={form.hubdb_table_id ?? ''}
              onChange={(e) => setField('hubdb_table_id', e.target.value)}
            />
          </Field>
          <Field label="Quote template ID">
            <input
              className="input"
              value={form.quote_template_id ?? ''}
              onChange={(e) => setField('quote_template_id', e.target.value)}
            />
          </Field>
          <Field label="Owner ID">
            <input
              className="input"
              value={form.owner_id ?? ''}
              onChange={(e) => setField('owner_id', e.target.value)}
            />
          </Field>
          <Field label="Access code (loyalty)">
            <input
              className="input"
              value={form.access_code ?? ''}
              onChange={(e) => setField('access_code', e.target.value || null)}
              placeholder="(optional)"
            />
          </Field>
          <Field label="Trigger mode">
            <select
              className="input"
              value={form.trigger_mode ?? 'webhook'}
              onChange={(e) => setField('trigger_mode', e.target.value as 'webhook' | 'workflow_extension')}
            >
              <option value="webhook">"Send a webhook" workflow action</option>
              <option value="workflow_extension">Workflow extension (custom action)</option>
            </select>
          </Field>
        </div>

        <h3 className="font-medium mt-6 mb-2 text-sm text-slate-300">HubDB column mapping</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Unit ID column name">
            <input
              className="input"
              value={form.hubdb_column_map?.unit_id_column ?? ''}
              onChange={(e) =>
                setField('hubdb_column_map', {
                  ...(form.hubdb_column_map ?? {}),
                  unit_id_column: e.target.value,
                })
              }
            />
          </Field>
          <Field label="Property ID column name">
            <input
              className="input"
              value={form.hubdb_column_map?.property_id_column ?? ''}
              onChange={(e) =>
                setField('hubdb_column_map', {
                  ...(form.hubdb_column_map ?? {}),
                  property_id_column: e.target.value,
                })
              }
            />
          </Field>
        </div>
      </section>

      <section className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Property rules (child age)</h2>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() =>
              setRules((rs) => [
                ...rs,
                {
                  id: `r${String(Date.now())}`,
                  propertyId: '',
                  name: '',
                  donja: '2.99',
                  gornja: '13.99',
                },
              ])
            }
          >
            + Add property
          </button>
        </div>
        {rules.length === 0 ? (
          <div className="text-slate-500 text-sm py-2">
            No rules configured. Without a matching rule for a propertyId, child ages pass through
            unchanged.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>HubSpot property ID</th>
                <th>Display name</th>
                <th>Donja (infant if ≤)</th>
                <th>Gornja (adult if &gt;)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={r.id}>
                  <td>
                    <input
                      className="input font-mono"
                      value={r.propertyId}
                      onChange={(e) => updateRule(setRules, i, { propertyId: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      value={r.name}
                      onChange={(e) => updateRule(setRules, i, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      className="input"
                      value={r.donja}
                      onChange={(e) => updateRule(setRules, i, { donja: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      className="input"
                      value={r.gornja}
                      onChange={(e) => updateRule(setRules, i, { gornja: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                      className="text-rose-400 hover:text-rose-300 text-sm"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-4">Rate filters</h2>
        <RateFiltersEditor value={rateFilters} onChange={setRateFilters} />
      </section>
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

function updateRule(
  setRules: (fn: (rs: PropertyRow[]) => PropertyRow[]) => void,
  i: number,
  patch: Partial<PropertyRow>,
): void {
  setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
}
