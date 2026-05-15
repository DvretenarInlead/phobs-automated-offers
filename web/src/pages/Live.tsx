import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

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

  if (!hubId && tenantsQ.data?.tenants[0]) {
    setHubId(tenantsQ.data.tenants[0].hubId);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Live monitoring</h1>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-slate-900 rounded p-1 border border-slate-800">
          {(['webhooks', 'jobs', 'ext', 'filter'] as Channel[]).map((c) => (
            <button
              key={c}
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

      {hubId ? <Stream hubId={hubId} channel={channel} /> : (
        <div className="text-slate-500 text-sm">No tenant selected.</div>
      )}
    </div>
  );
}

function Stream({ hubId, channel }: { hubId: string; channel: Channel }): ReactElement {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setEvents([]);
    const es = new EventSource(`/api/admin/live/${channel}/${hubId}`, {
      withCredentials: true,
    });
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        setEvents((prev) => [JSON.parse(ev.data) as LiveEvent, ...prev].slice(0, 500));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [hubId, channel]);

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-slate-500">
          {connected ? (
            <span className="text-emerald-400">● Connected</span>
          ) : (
            <span className="text-amber-400">● Reconnecting…</span>
          )}
          <span className="ml-2 font-mono">
            channel={channel} hub_id={hubId}
          </span>
        </div>
        <button
          className="text-xs text-slate-400 hover:text-slate-200"
          onClick={() => setEvents([])}
        >
          Clear
        </button>
      </div>
      {events.length === 0 ? (
        <div className="text-slate-500 text-sm py-6 text-center">
          Waiting for events…
        </div>
      ) : (
        <ul className="space-y-1 max-h-[60vh] overflow-auto pr-2 font-mono text-xs">
          {events.map((e, i) => (
            <li key={i} className="flex gap-3 py-1 border-b border-slate-800/60">
              <span className="text-slate-500 shrink-0">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
              <span
                className={
                  e.type.includes('error') || e.type === 'signature_failed'
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
