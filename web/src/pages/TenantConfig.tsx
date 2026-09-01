import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '../lib/api';
import { RateFiltersEditor } from '../components/RateFiltersEditor';
import type { RateFilters } from '../components/RateFiltersEditor';
import { CidrListEditor } from '../components/CidrListEditor';
import { OverridesEditor } from '../components/OverridesEditor';
import type { Overrides } from '../components/OverridesEditor';

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
  access_code: string | null; // masked when set
  access_code_set: boolean;
  property_rules: Record<string, { name: string; donja: number; gornja: number }>;
  rate_filters: Record<string, unknown>;
  trigger_mode: 'webhook' | 'workflow_extension';
  overrides: Overrides;
}

interface PropertyRow {
  id: string;
  propertyId: string;
  name: string;
  donja: string;
  gornja: string;
}

interface FormState {
  phobs_endpoint: string;
  phobs_site_id: string;
  hubdb_table_id: string;
  hubdb_column_map: Record<string, string>;
  quote_template_id: string;
  owner_id: string;
  trigger_mode: 'webhook' | 'workflow_extension';
  phobs_auth_user_new: string;
  phobs_auth_pass_new: string;
  /** New loyalty access code; blank = keep current. */
  access_code_new: string;
  /** Explicitly remove the stored access code. */
  clear_access_code: boolean;
}

const EMPTY_FORM: FormState = {
  phobs_endpoint: '',
  phobs_site_id: '',
  hubdb_table_id: '',
  hubdb_column_map: {},
  quote_template_id: '',
  owner_id: '',
  trigger_mode: 'webhook',
  phobs_auth_user_new: '',
  phobs_auth_pass_new: '',
  access_code_new: '',
  clear_access_code: false,
};

export function TenantConfig(): ReactElement {
  const { hubId } = useParams<{ hubId: string }>();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['config', hubId],
    queryFn: () => api<ConfigResponse>(`/tenants/${hubId!}/config`),
    enabled: Boolean(hubId),
    // Never let a background refetch overwrite in-progress edits.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [rules, setRules] = useState<PropertyRow[]>([]);
  const [rateFilters, setRateFilters] = useState<RateFilters>({});
  const [overrides, setOverrides] = useState<Overrides | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from the server response exactly once per page load (and again
  // after our own successful save, which resets `hydrated`).
  useEffect(() => {
    if (!q.data || hydrated) return;
    setForm({
      ...EMPTY_FORM,
      phobs_endpoint: q.data.phobs_endpoint,
      phobs_site_id: q.data.phobs_site_id,
      hubdb_table_id: q.data.hubdb_table_id,
      hubdb_column_map: q.data.hubdb_column_map ?? {},
      quote_template_id: q.data.quote_template_id,
      owner_id: q.data.owner_id,
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
    setOverrides(q.data.overrides);
    setHydrated(true);
    setDirty(false);
  }, [q.data, hydrated]);

  // Warn before losing unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const touch = <T,>(setter: (v: T) => void) => (v: T): void => {
    setter(v);
    setDirty(true);
  };
  const setField = <K extends keyof FormState>(k: K, v: FormState[K]): void => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  const validateLocally = (): string | null => {
    if (!/^https:\/\/([a-z0-9-]+\.)*phobs\.net(\/|$)/i.test(form.phobs_endpoint.trim())) {
      return 'Phobs endpoint must be an https://…phobs.net URL.';
    }
    if (!form.phobs_site_id.trim()) return 'Site ID is required.';
    if (!form.hubdb_table_id.trim()) return 'HubDB table ID is required.';
    if (!form.quote_template_id.trim()) return 'Quote template ID is required.';
    if (!/^\d{1,20}$/.test(form.owner_id.trim())) return 'Owner ID must be numeric.';
    for (const r of rules) {
      if (!r.propertyId.trim()) continue;
      const d = Number(r.donja);
      const g = Number(r.gornja);
      if (!Number.isFinite(d) || d < 0) return `Property ${r.propertyId}: "donja" must be a number ≥ 0.`;
      if (!Number.isFinite(g) || g <= 0) return `Property ${r.propertyId}: "gornja" must be a number > 0.`;
      if (g <= d) return `Property ${r.propertyId}: "gornja" must be greater than "donja".`;
    }
    return null;
  };

  const save = useMutation({
    mutationFn: async (): Promise<{ ok: true }> => {
      const localError = validateLocally();
      if (localError) throw new Error(localError);

      const property_rules = Object.fromEntries(
        rules
          .filter((r) => r.propertyId.trim())
          .map((r) => [
            r.propertyId.trim(),
            {
              name: r.name.trim() || r.propertyId.trim(),
              donja: Number(r.donja),
              gornja: Number(r.gornja),
            },
          ]),
      );

      const body: Record<string, unknown> = {
        phobs_endpoint: form.phobs_endpoint.trim(),
        phobs_site_id: form.phobs_site_id.trim(),
        hubdb_table_id: form.hubdb_table_id.trim(),
        hubdb_column_map: form.hubdb_column_map,
        quote_template_id: form.quote_template_id.trim(),
        owner_id: form.owner_id.trim(),
        trigger_mode: form.trigger_mode,
        property_rules,
        rate_filters: rateFilters,
      };
      if (overrides) {
        body.overrides = {
          ...overrides,
          // Rows the user added but never filled in would fail server
          // validation (property min length 1) — drop them silently.
          skip_conditions: overrides.skip_conditions.filter((c) => c.property.trim()),
          price_quote: {
            ...overrides.price_quote,
            endpoint: overrides.price_quote.endpoint?.trim() || null,
          },
        };
      }
      // Secrets: only sent when the operator typed a new value / asked to clear.
      if (form.phobs_auth_user_new) body.phobs_auth_user = form.phobs_auth_user_new;
      if (form.phobs_auth_pass_new) body.phobs_auth_pass = form.phobs_auth_pass_new;
      if (form.clear_access_code) body.access_code = null;
      else if (form.access_code_new.trim()) body.access_code = form.access_code_new.trim();

      return api(`/tenants/${hubId!}/config`, { method: 'PUT', body });
    },
    onSuccess: async () => {
      setSavedAt(new Date());
      setError(null);
      setDirty(false);
      setHydrated(false); // re-hydrate from the fresh server state
      await qc.invalidateQueries({ queryKey: ['config', hubId] });
    },
    onError: (err) => {
      setError(err instanceof Error && !('status' in err) ? err.message : describeError(err, 'save_failed'));
    },
  });

  if (q.isPending) return <div className="text-slate-500 text-sm">Loading…</div>;
  if (q.error) return <div className="text-rose-400 text-sm">{describeError(q.error, 'Failed to load config.')}</div>;

  const accessCodeSet = q.data.access_code_set;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between sticky top-0 z-10 bg-slate-950/90 backdrop-blur py-3 -my-3">
        <div>
          <h1 className="text-2xl font-semibold">Tenant config</h1>
          <div className="text-slate-500 text-sm font-mono">hub_id={hubId}</div>
        </div>
        <div className="flex items-center gap-3">
          {dirty && !save.isPending && <span className="text-amber-300 text-sm">Unsaved changes</span>}
          {savedAt && !dirty && (
            <span className="text-emerald-400 text-sm">Saved {savedAt.toLocaleTimeString()}</span>
          )}
          {error && <span className="text-rose-400 text-sm max-w-md truncate" title={error}>{error}</span>}
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !hydrated}
            className="btn-primary"
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </header>

      <section className="card">
        <h2 className="font-semibold mb-4">Phobs connection</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Endpoint URL (https://…phobs.net)">
            <input
              className="input font-mono"
              value={form.phobs_endpoint}
              onChange={(e) => setField('phobs_endpoint', e.target.value)}
              placeholder="https://api.phobs.net/..."
              maxLength={512}
            />
          </Field>
          <Field label="Site ID">
            <input
              className="input"
              value={form.phobs_site_id}
              onChange={(e) => setField('phobs_site_id', e.target.value)}
              maxLength={128}
            />
          </Field>
          <Field label="Username (leave blank to keep)">
            <input
              className="input"
              autoComplete="off"
              value={form.phobs_auth_user_new}
              onChange={(e) => setField('phobs_auth_user_new', e.target.value)}
              placeholder="••••••••"
              maxLength={256}
            />
          </Field>
          <Field label="Password (leave blank to keep)">
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={form.phobs_auth_pass_new}
              onChange={(e) => setField('phobs_auth_pass_new', e.target.value)}
              placeholder="••••••••"
              maxLength={256}
            />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-4">HubSpot</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="HubDB table ID">
            <input
              className="input font-mono"
              value={form.hubdb_table_id}
              onChange={(e) => setField('hubdb_table_id', e.target.value)}
              maxLength={64}
            />
          </Field>
          <Field label="Quote template ID">
            <input
              className="input font-mono"
              value={form.quote_template_id}
              onChange={(e) => setField('quote_template_id', e.target.value)}
              maxLength={64}
            />
          </Field>
          <Field label="Owner ID (numeric)">
            <input
              className="input font-mono"
              inputMode="numeric"
              pattern="\d+"
              value={form.owner_id}
              onChange={(e) => setField('owner_id', e.target.value.replace(/\D/g, ''))}
              maxLength={20}
            />
          </Field>
          <Field label="Trigger mode">
            <select
              className="input"
              value={form.trigger_mode}
              onChange={(e) => setField('trigger_mode', e.target.value as 'webhook' | 'workflow_extension')}
            >
              <option value="webhook">"Send a webhook" workflow action</option>
              <option value="workflow_extension">Workflow extension (custom action)</option>
            </select>
          </Field>
          <Field
            label={
              accessCodeSet
                ? 'Loyalty access code — currently set (leave blank to keep)'
                : 'Loyalty access code — not set (optional)'
            }
          >
            <input
              className="input font-mono"
              autoComplete="off"
              value={form.access_code_new}
              disabled={form.clear_access_code}
              onChange={(e) => setField('access_code_new', e.target.value)}
              placeholder={accessCodeSet ? '••••••••' : 'e.g. GQ2079H1G069'}
              maxLength={128}
            />
          </Field>
          {accessCodeSet && (
            <label className="flex items-center gap-2 text-sm text-slate-300 self-end pb-2">
              <input
                type="checkbox"
                checked={form.clear_access_code}
                onChange={(e) => setField('clear_access_code', e.target.checked)}
              />
              Remove the stored access code on save
            </label>
          )}
        </div>

        <h3 className="font-medium mt-6 mb-2 text-sm text-slate-300">HubDB column mapping</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Unit ID column name">
            <input
              className="input font-mono"
              value={form.hubdb_column_map.unit_id_column ?? ''}
              onChange={(e) =>
                setField('hubdb_column_map', { ...form.hubdb_column_map, unit_id_column: e.target.value })
              }
              maxLength={128}
            />
          </Field>
          <Field label="Property ID column name">
            <input
              className="input font-mono"
              value={form.hubdb_column_map.property_id_column ?? ''}
              onChange={(e) =>
                setField('hubdb_column_map', {
                  ...form.hubdb_column_map,
                  property_id_column: e.target.value,
                })
              }
              maxLength={128}
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
              touch(setRules)([
                ...rules,
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
                      onChange={(e) => updateRule(touch(setRules), rules, i, { propertyId: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      value={r.name}
                      placeholder={r.propertyId || 'name'}
                      onChange={(e) => updateRule(touch(setRules), rules, i, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      className="input"
                      value={r.donja}
                      onChange={(e) => updateRule(touch(setRules), rules, i, { donja: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min={0.01}
                      className="input"
                      value={r.gornja}
                      onChange={(e) => updateRule(touch(setRules), rules, i, { gornja: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => touch(setRules)(rules.filter((_, j) => j !== i))}
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
        <RateFiltersEditor value={rateFilters} onChange={touch(setRateFilters)} />
      </section>

      <section className="card">
        <h2 className="font-semibold mb-1">Pipeline overrides</h2>
        <p className="text-slate-500 text-xs mb-4">
          Field mappings, quote defaults, skip conditions, loyalty trigger, SKU template and the
          firm price-quote step — all editable without a deploy. Saved together with the rest of
          this page.
        </p>
        {overrides ? (
          <OverridesEditor value={overrides} onChange={touch(setOverrides)} />
        ) : (
          <div className="text-slate-500 text-sm">Loading…</div>
        )}
      </section>

      <WebhookAllowlistSection hubId={hubId!} />

      <section className="card">
        <h2 className="font-semibold mb-2">API tokens</h2>
        <p className="text-sm text-slate-400 mb-3">
          Manage bearer tokens used by external integrations calling{' '}
          <code className="font-mono">POST /api/trigger</code>, and their per-token IP
          allow-lists.
        </p>
        <Link
          to={`/tenants/${hubId!}/api-tokens`}
          className="text-emerald-400 hover:text-emerald-300 text-sm"
        >
          Manage API tokens →
        </Link>
      </section>
    </div>
  );
}

interface WebhookAllowlistResponse {
  webhook_ip_allowlist_cidrs: string[];
}

function WebhookAllowlistSection({ hubId }: { hubId: string }): ReactElement {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['webhook-allowlist', hubId],
    queryFn: () => api<WebhookAllowlistResponse>(`/tenants/${hubId}/webhook-allowlist`),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [cidrs, setCidrs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (q.data && !hydrated) {
      setCidrs(q.data.webhook_ip_allowlist_cidrs);
      setHydrated(true);
    }
  }, [q.data, hydrated]);

  const save = useMutation({
    mutationFn: (): Promise<{ ok: true }> =>
      api(`/tenants/${hubId}/webhook-allowlist`, {
        method: 'PUT',
        body: { webhook_ip_allowlist_cidrs: cidrs },
      }),
    onSuccess: async () => {
      setError(null);
      setSavedAt(new Date());
      await qc.invalidateQueries({ queryKey: ['webhook-allowlist', hubId] });
    },
    onError: (err) => setError(describeError(err, 'save_failed')),
  });

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold">HubSpot webhook IP allow-list</h2>
        <div className="flex items-center gap-3">
          {savedAt && (
            <span className="text-emerald-400 text-xs">
              Saved {savedAt.toLocaleTimeString()}
            </span>
          )}
          {error && <span className="text-rose-400 text-xs">{error}</span>}
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={save.isPending || !hydrated}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-400 mb-3">
        Restrict which client IPs may hit{' '}
        <code className="font-mono">POST /webhooks/hubspot/{hubId}</code> and{' '}
        <code className="font-mono">POST /workflow-actions/process-deal</code> for this
        tenant. HubSpot fires from AWS ranges — leave empty unless you've fronted us with a
        fixed-IP egress proxy. HMAC/JWT verification still runs first; this is
        defence-in-depth.
      </p>
      {q.isPending ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : q.error ? (
        <div className="text-rose-400 text-sm">{describeError(q.error, 'Failed to load allow-list.')}</div>
      ) : (
        <CidrListEditor
          value={cidrs}
          onChange={setCidrs}
          emptyHint="No entries — any IP that passes HMAC/JWT is accepted."
        />
      )}
    </section>
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function updateRule(
  set: (rs: PropertyRow[]) => void,
  rules: PropertyRow[],
  i: number,
  patch: Partial<PropertyRow>,
): void {
  set(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
}
