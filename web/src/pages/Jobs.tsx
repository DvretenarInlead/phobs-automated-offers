import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface FailedJob {
  id: string | undefined;
  name: string;
  attemptsMade: number;
  failedReason: string | null;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  hubId: string | null;
  source: string | null;
}
interface FailedResponse {
  items: FailedJob[];
}
interface QueueStats {
  waiting: number;
  active: number;
  failed: number;
  completed: number;
  delayed: number;
}

export function Jobs(): ReactElement {
  const qc = useQueryClient();
  const statsQ = useQuery({
    queryKey: ['queue-stats'],
    queryFn: () => api<QueueStats>('/queue/stats'),
    refetchInterval: 5_000,
  });
  const failedQ = useQuery({
    queryKey: ['jobs-failed'],
    queryFn: () => api<FailedResponse>('/jobs/failed?limit=100'),
    refetchInterval: 10_000,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api(`/jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['jobs-failed'] });
      await qc.invalidateQueries({ queryKey: ['queue-stats'] });
    },
  });
  const discard = useMutation({
    mutationFn: (id: string) => api(`/jobs/${id}/discard`, { method: 'POST' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['jobs-failed'] });
      await qc.invalidateQueries({ queryKey: ['queue-stats'] });
    },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Jobs</h1>
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Waiting" value={statsQ.data?.waiting ?? '—'} />
        <Stat label="Active" value={statsQ.data?.active ?? '—'} />
        <Stat label="Delayed" value={statsQ.data?.delayed ?? '—'} />
        <Stat label="Failed" value={statsQ.data?.failed ?? '—'} kind="fail" />
        <Stat label="Completed" value={statsQ.data?.completed ?? '—'} kind="ok" />
      </section>

      <section className="card">
        <h2 className="font-semibold mb-4">Failed jobs (dead-letter)</h2>
        {failedQ.isPending ? (
          <div className="text-slate-500 text-sm">Loading…</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Job ID</th>
                <th>Tenant</th>
                <th>Reason</th>
                <th>Attempts</th>
                <th>Failed at</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {failedQ.data?.items.map((j) => (
                <tr key={j.id}>
                  <td className="font-mono text-xs">
                    {j.id ? (
                      <Link className="text-emerald-400 hover:underline" to={`/jobs/${j.id}`}>
                        {j.id}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="font-mono text-xs">{j.hubId ?? ''}</td>
                  <td className="text-rose-300 truncate max-w-md text-xs">
                    {j.failedReason ?? ''}
                  </td>
                  <td>{j.attemptsMade}</td>
                  <td className="text-slate-400 text-xs">
                    {j.finishedOn ? new Date(j.finishedOn).toLocaleString() : '—'}
                  </td>
                  <td className="whitespace-nowrap">
                    {j.id && (
                      <>
                        <button
                          className="text-emerald-400 hover:text-emerald-300 text-sm mr-3"
                          onClick={() => retry.mutate(j.id!)}
                        >
                          Retry
                        </button>
                        <button
                          className="text-rose-400 hover:text-rose-300 text-sm"
                          onClick={() => discard.mutate(j.id!)}
                        >
                          Discard
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {failedQ.data && failedQ.data.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-slate-500 py-6">
                    No failed jobs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  kind,
}: {
  label: string;
  value: number | string;
  kind?: 'ok' | 'fail';
}): ReactElement {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`text-2xl font-semibold mt-1 ${
          kind === 'fail' && typeof value === 'number' && value > 0
            ? 'text-rose-400'
            : kind === 'ok'
              ? 'text-emerald-400'
              : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
