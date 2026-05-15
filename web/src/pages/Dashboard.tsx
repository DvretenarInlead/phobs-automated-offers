import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

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
          label="Scope"
          value={user?.scopedHubId ?? (user?.role === 'superadmin' ? 'All' : '—')}
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Live job activity</h2>
          {tenantsQ.data && tenantsQ.data.tenants.length > 1 && user?.role === 'superadmin' && (
            <select
              className="input max-w-xs"
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
        {activeHubId ? <LiveJobs hubId={activeHubId} /> : (
          <div className="text-slate-500 text-sm">No tenant selected.</div>
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
  const [events, setEvents] = useState<LiveJobEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/api/admin/live/jobs/${hubId}`, { withCredentials: true });
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as LiveJobEvent;
        setEvents((prev) => [parsed, ...prev].slice(0, 200));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [hubId]);

  return (
    <div>
      <div className="text-xs text-slate-500 mb-2">
        {connected ? (
          <span className="text-emerald-400">● Connected</span>
        ) : (
          <span className="text-amber-400">● Reconnecting…</span>
        )}
        <span className="ml-2">hub_id={hubId}</span>
      </div>
      {events.length === 0 ? (
        <div className="text-slate-500 text-sm py-6 text-center">
          Waiting for job activity. Trigger a deal or use the Phobs probe to see events here.
        </div>
      ) : (
        <ul className="space-y-1 max-h-96 overflow-auto pr-2 font-mono text-xs">
          {events.map((e, i) => (
            <li key={i} className="flex gap-3 py-1 border-b border-slate-800/60">
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
