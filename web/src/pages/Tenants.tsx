import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

interface TenantsResponse {
  tenants: { hubId: string; name: string; status: string; createdAt: string }[];
}

export function Tenants(): ReactElement {
  const q = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantsResponse>('/tenants'),
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Tenants</h1>
      {q.isPending ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : q.error ? (
        <div className="text-rose-400 text-sm">Failed to load tenants.</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>HubSpot portal</th>
                <th>Name</th>
                <th>Status</th>
                <th>Installed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {q.data?.tenants.map((t) => (
                <tr key={t.hubId}>
                  <td className="font-mono">{t.hubId}</td>
                  <td>{t.name}</td>
                  <td>
                    <span className={t.status === 'active' ? 'pill-ok' : 'pill-warn'}>
                      {t.status}
                    </span>
                  </td>
                  <td className="text-slate-400">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </td>
                  <td>
                    <Link
                      to={`/tenants/${t.hubId}`}
                      className="text-emerald-400 hover:text-emerald-300 text-sm"
                    >
                      Configure →
                    </Link>
                  </td>
                </tr>
              ))}
              {q.data && q.data.tenants.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-500 py-6">
                    No tenants installed yet. Open <code>/oauth/install</code> in HubSpot to
                    install the app.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
