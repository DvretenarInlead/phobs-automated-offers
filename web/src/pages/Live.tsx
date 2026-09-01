import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { StreamStatusBadge, useLiveStream } from '../components/LiveStream';

type Channel = 'webhooks' | 'jobs' | 'ext' | 'filter';

interface LiveEvent {
  ts: number;
  type: string;
  hubId?: string;
  dealId?: string;
  jobId?: string;
  data?: Record<string, unknown>;
}
interface TenantsResponse {
  tenants: { hubId: string; name: string }[];
}

export function Live(): ReactElement {
  const { user } = useAuth();
  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantsResponse>('/tenants'),
  });
  const [hubId, setHubId] = useState<string>(user?.scopedHubId ?? '');
  const [channel, setChannel] = useState<Channel>('jobs');

  useEffect(() => {
    if (!hubId && tenantsQ.data?.tenants[0]) setHubId(tenantsQ.data.tenants[0].hubId);
  }, [hubId, tenantsQ.data]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Live monitoring</h1>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-slate-900 rounded p-1 border border-slate-800" role="tablist">
          {(['webhooks', 'jobs', 'ext', 'filter'] as Channel[]).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={channel === c}
              className={`px-3 py-1.5 rounded text-sm ${
                channel === c
                  ? 'bg-slate-700 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              onClick={() => setChannel(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {user?.role === 'superadmin' && tenantsQ.data && (
          <select
            className="input max-w-xs"
            aria-label="Tenant"
            value={hubId}
            onChange={(e) => setHubId(e.target.value)}
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
      ) : hubId ? (
        <Stream hubId={hubId} channel={channel} />
      ) : tenantsQ.isPending ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : (
        <div className="text-slate-500 text-sm">No tenants installed yet.</div>
      )}
    </div>
  );
}

function Stream({ hubId, channel }: { hubId: string; channel: Channel }): ReactElement {
  const { events, status, clear, reconnect } = useLiveStream<LiveEvent>(
    `/api/admin/live/${channel}/${hubId}`,
    500,
  );

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-slate-500">
          <StreamStatusBadge status={status} onReconnect={reconnect} />
          <span className="ml-2 font-mono">
            channel={channel} hub_id={hubId}
          </span>
        </div>
        <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={clear}>
          Clear
        </button>
      </div>
      {events.length === 0 ? (
        <div className="text-slate-500 text-sm py-6 text-center">Waiting for events…</div>
      ) : (
        <ul className="space-y-1 max-h-[60vh] overflow-auto pr-2 font-mono text-xs">
          {events.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="flex gap-3 py-1 border-b border-slate-800/60">
              <span className="text-slate-500 shrink-0">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
              <span
                className={
                  e.type.includes('error') || e.type === 'signature_failed' || e.type === 'ip_denied'
                    ? 'text-rose-400 shrink-0'
                    : e.type.endsWith('.ok') || e.type === 'accepted'
                      ? 'text-emerald-400 shrink-0'
                      : 'text-sky-400 shrink-0'
                }
              >
                {e.type}
              </span>
              {e.dealId && <span className="text-slate-400 shrink-0">deal {e.dealId}</span>}
              <span className="text-slate-300 truncate">
                {e.data ? JSON.stringify(e.data) : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
