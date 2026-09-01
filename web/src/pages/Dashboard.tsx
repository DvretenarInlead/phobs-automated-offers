import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { StreamStatusBadge, useLiveStream } from '../components/LiveStream';

interface TenantsResponse {
  tenants: { hubId: string; name: string; status: string; createdAt: string }[];
}

interface LiveJobEvent {
  ts: number;
  type: string;
  hubId?: string;
  dealId?: string;
  jobId?: string;
  data?: Record<string, unknown>;
}

export function Dashboard(): ReactElement {
  const { user } = useAuth();
  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantsResponse>('/tenants'),
  });

  const [activeHubId, setActiveHubId] = useState<string | null>(null);
  useEffect(() => {
    if (activeHubId) return;
    if (user?.role === 'tenant_admin' && user.scopedHubId) setActiveHubId(user.scopedHubId);
    else if (tenantsQ.data?.tenants[0]) setActiveHubId(tenantsQ.data.tenants[0].hubId);
  }, [activeHubId, tenantsQ.data, user]);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Stat label="Tenants" value={tenantsQ.data?.tenants.length ?? '—'} />
        <Stat
          label="Your role"
          value={user?.role === 'superadmin' ? 'Superadmin' : 'Tenant admin'}
        />
        <Stat
          label="MFA"
          value={user?.totpEnabled ? 'enabled' : 'off — enable in Settings'}
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Live job activity</h2>
          {tenantsQ.data && tenantsQ.data.tenants.length > 1 && user?.role === 'superadmin' && (
            <select
              className="input max-w-xs"
              aria-label="Tenant"
              value={activeHubId ?? ''}
              onChange={(e) => setActiveHubId(e.target.value)}
            >
              {tenantsQ.data.tenants.map((t) => (
                <option key={t.hubId} value={t.hubId}>
                  {t.name} ({t.hubId})
                </option>
              ))}
            </select>
          )}
        </div>
        {tenantsQ.error ? (
          <div className="text-rose-400 text-sm">Failed to load tenants.</div>
        ) : activeHubId ? (
          <LiveJobs hubId={activeHubId} />
        ) : tenantsQ.isPending ? (
          <div className="text-slate-500 text-sm">Loading…</div>
        ) : (
          <div className="text-slate-500 text-sm">
            No tenants installed yet. Install the HubSpot app via <code>/oauth/install</code>.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }): ReactElement {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function LiveJobs({ hubId }: { hubId: string }): ReactElement {
  const { events, status, reconnect } = useLiveStream<LiveJobEvent>(
    `/api/admin/live/jobs/${hubId}`,
    200,
  );

  return (
    <div>
      <div className="text-xs text-slate-500 mb-2">
        <StreamStatusBadge status={status} onReconnect={reconnect} />
        <span className="ml-2">hub_id={hubId}</span>
      </div>
      {events.length === 0 ? (
        <div className="text-slate-500 text-sm py-6 text-center">
          Waiting for job activity. Trigger a deal or use the Phobs probe to see events here.
        </div>
      ) : (
        <ul className="space-y-1 max-h-96 overflow-auto pr-2 font-mono text-xs">
          {events.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="flex gap-3 py-1 border-b border-slate-800/60">
              <span className="text-slate-500 shrink-0">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
              <span
                className={
                  e.type === 'step.error'
                    ? 'text-rose-400'
                    : e.type === 'step.ok'
                      ? 'text-emerald-400'
                      : 'text-sky-400'
                }
              >
                {e.type}
              </span>
              <span className="text-slate-300 truncate">
                {e.data ? JSON.stringify(e.data) : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
