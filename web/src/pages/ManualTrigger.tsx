import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface TenantsResponse {
  tenants: { hubId: string; name: string }[];
}

const SAMPLE = {
  hs_object_id: 502682381500,
  jezik_ponude: 'hr',
  rezapp___property_id: 'cc93fa8149adee434840605f4aff301a',
  rezzapp___broj_odraslih: 3,
  number_of_adults: null,
  child_age_1: 10,
  child_age_2: 13,
  child_age_3: null,
  child_age_4: null,
  child_age_5: null,
  picker_date_check_in: 1784505600000,
  picker_date_check_out: 1784937600000,
  reservation___nights: 432000000,
  bluesunrewards___loyaltyid: 104508962,
};

export function ManualTrigger(): ReactElement {
  const { user } = useAuth();
  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantsResponse>('/tenants'),
  });

  const [hubId, setHubId] = useState<string>(user?.scopedHubId ?? '');
  const [payloadText, setPayloadText] = useState(JSON.stringify(SAMPLE, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  if (!hubId && tenantsQ.data?.tenants[0]) setHubId(tenantsQ.data.tenants[0].hubId);

  const submit = async (): Promise<void> => {
    setError(null);
    setJobId(null);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ ok: true; jobId: string }>('/manual-trigger', {
        method: 'POST',
        body: { hubId, payload },
      });
      setJobId(r.jobId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Manual trigger</h1>
        <p className="text-slate-400 text-sm mt-1">
          Enqueue a <code>processDeal</code> job with a hand-crafted payload — useful for
          replaying a customer issue or running a backfill without waiting for a HubSpot
          workflow to fire.
        </p>
      </div>

      <section className="card space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {user?.role === 'superadmin' && tenantsQ.data && (
            <div>
              <label className="label">Tenant</label>
              <select
                className="input"
                value={hubId}
                onChange={(e) => setHubId(e.target.value)}
              >
                {tenantsQ.data.tenants.map((t) => (
                  <option key={t.hubId} value={t.hubId}>
                    {t.name} ({t.hubId})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="md:col-span-2 flex items-end gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setPayloadText(JSON.stringify(SAMPLE, null, 2))}
            >
              Reset to sample
            </button>
          </div>
        </div>

        <div>
          <label className="label">Payload (JSON, mirrors the HubSpot webhook body)</label>
          <textarea
            spellCheck={false}
            className="input font-mono text-xs h-80"
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3">
          <button onClick={submit} disabled={busy || !hubId} className="btn-primary">
            {busy ? 'Enqueuing…' : 'Enqueue'}
          </button>
          {error && <span className="text-rose-400 text-sm">{error}</span>}
          {jobId && (
            <span className="text-emerald-400 text-sm">
              Enqueued. Job:{' '}
              <Link className="underline" to={`/jobs/${jobId}`}>
                {jobId}
              </Link>
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
