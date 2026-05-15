import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface AdminUser {
  id: string;
  email: string;
  role: 'superadmin' | 'tenant_admin';
  scopedHubId: string | null;
  status: string;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
interface UsersResponse {
  users: AdminUser[];
}
interface InviteResponse {
  ok: true;
  userId: string;
  email: string;
  acceptUrl: string;
  expiresInDays: number;
}
interface TenantsResponse {
  tenants: { hubId: string; name: string }[];
}

export function Users(): ReactElement {
  const { user } = useAuth();
  if (user?.role !== 'superadmin') {
    return <div className="text-rose-400 text-sm">Superadmin only.</div>;
  }
  return <UsersInner />;
}

function UsersInner(): ReactElement {
  const qc = useQueryClient();
  const usersQ = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<UsersResponse>('/users'),
  });
  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantsResponse>('/tenants'),
  });

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteHubId, setInviteHubId] = useState('');
  const [issuedInvite, setIssuedInvite] = useState<InviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: () =>
      api<InviteResponse>('/users/invite', {
        method: 'POST',
        body: { email: inviteEmail, hubId: inviteHubId },
      }),
    onSuccess: async (data) => {
      setIssuedInvite(data);
      setInviteEmail('');
      setInviteHubId('');
      setError(null);
      await qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'invite_failed'),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api(`/users/${id}/deactivate`, { method: 'POST' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Admin users</h1>

      <section className="card">
        <h2 className="font-semibold mb-4">Invite a tenant admin</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <input
            type="email"
            placeholder="email@example.com"
            className="input"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <select
            className="input"
            value={inviteHubId}
            onChange={(e) => setInviteHubId(e.target.value)}
          >
            <option value="">Pick tenant…</option>
            {tenantsQ.data?.tenants.map((t) => (
              <option key={t.hubId} value={t.hubId}>
                {t.name} ({t.hubId})
              </option>
            ))}
          </select>
          <button
            className="btn-primary"
            disabled={invite.isPending || !inviteEmail || !inviteHubId}
            onClick={() => invite.mutate()}
          >
            {invite.isPending ? 'Sending…' : 'Invite'}
          </button>
        </div>
        {error && <div className="text-rose-400 text-sm">{error}</div>}
        {issuedInvite && (
          <div className="mt-4 border border-emerald-800 bg-emerald-950/40 rounded p-3">
            <div className="text-emerald-300 text-sm mb-1">Invite issued for {issuedInvite.email}</div>
            <div className="text-xs text-slate-400">
              Expires in {issuedInvite.expiresInDays} days. Share this link out-of-band:
            </div>
            <input
              className="input mt-2 font-mono text-xs"
              readOnly
              value={issuedInvite.acceptUrl}
              onFocus={(e) => e.target.select()}
            />
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-4">All admin users</h2>
        {usersQ.isPending ? (
          <div className="text-slate-500 text-sm">Loading…</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Scope</th>
                <th>Status</th>
                <th>MFA</th>
                <th>Last login</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {usersQ.data?.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.role}</td>
                  <td className="font-mono">{u.scopedHubId ?? '—'}</td>
                  <td>
                    <span
                      className={
                        u.status === 'active'
                          ? 'pill-ok'
                          : u.status === 'pending'
                            ? 'pill-warn'
                            : 'pill-fail'
                      }
                    >
                      {u.status}
                    </span>
                  </td>
                  <td>{u.totpEnabled ? <span className="pill-ok">on</span> : <span className="pill-warn">off</span>}</td>
                  <td className="text-slate-400">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}
                  </td>
                  <td>
                    {u.status !== 'disabled' && (
                      <button
                        className="text-rose-400 hover:text-rose-300 text-sm"
                        onClick={() => deactivate.mutate(u.id)}
                      >
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
