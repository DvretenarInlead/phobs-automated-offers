import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

interface TenantsResponse {
  tenants: { hubId: string; name: string }[];
}

interface AuditItem {
  id: string;
  hubId: string;
  dealId: string | null;
  kind: string;
  status: string;
  latencyMs: number | null;
  error: string | null;
  createdAt: string;
  request: unknown;
  response: unknown;
}
interface AuditResponse {
  items: AuditItem[];
}

export function Activity(): ReactElement {
  const { user } = useAuth();
  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantsResponse>('/tenants'),
  });
  const [hubId, setHubId] = useState<string>(user?.scopedHubId ?? '');

  // Default to the only tenant when one becomes available
  if (!hubId && tenantsQ.data?.tenants[0]) {
    setHubId(tenantsQ.data.tenants[0].hubId);
  }

  const auditQ = useQuery({
    queryKey: ['audit', hubId],
    enabled: Boolean(hubId),
    queryFn: () => api<AuditResponse>(`/tenants/${hubId}/audit`),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Activity</h1>
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

      <section className="card overflow-hidden">
        {auditQ.isPending ? (
          <div className="text-slate-500 text-sm">Loading…</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Deal</th>
                <th>Latency</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {auditQ.data?.items.map((row) => (
                <tr key={row.id}>
                  <td className="text-slate-400">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="font-mono text-xs">{row.kind}</td>
                  <td>
                    <span className={row.status === 'ok' ? 'pill-ok' : 'pill-fail'}>
                      {row.status}
                    </span>
                  </td>
                  <td className="font-mono text-xs">{row.dealId ?? ''}</td>
                  <td className="text-slate-400">
                    {row.latencyMs != null ? `${row.latencyMs} ms` : ''}
                  </td>
                  <td className="text-rose-400 text-xs truncate max-w-md">
                    {row.error ?? ''}
                  </td>
                </tr>
              ))}
              {auditQ.data && auditQ.data.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-slate-500 py-6">
                    No activity yet.
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
