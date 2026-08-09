import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { CidrListEditor } from '../components/CidrListEditor';

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  ip_allowlist_cidrs: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ListResponse {
  tokens: TokenRow[];
}

interface MintResponse {
  ok: true;
  id: string;
  name: string;
  prefix: string;
  ip_allowlist_cidrs: string[];
  token: string;
  createdAt: string;
  warning: string;
}

export function ApiTokens(): ReactElement {
  const { hubId } = useParams<{ hubId: string }>();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['api-tokens', hubId],
    queryFn: () => api<ListResponse>(`/tenants/${hubId!}/api-tokens`),
    enabled: Boolean(hubId),
  });

  const [name, setName] = useState('');
  const [newCidrs, setNewCidrs] = useState<string[]>([]);
  const [minted, setMinted] = useState<MintResponse | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);

  const mint = useMutation({
    mutationFn: (): Promise<MintResponse> =>
      api<MintResponse>(`/tenants/${hubId!}/api-tokens`, {
        method: 'POST',
        body: { name: name.trim(), ip_allowlist_cidrs: newCidrs },
      }),
    onSuccess: async (data) => {
      setMinted(data);
      setName('');
      setNewCidrs([]);
      setMintError(null);
      await qc.invalidateQueries({ queryKey: ['api-tokens', hubId] });
    },
    onError: (err) => {
      setMintError(formatError(err));
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">API tokens</h1>
          <div className="text-slate-500 text-sm font-mono">hub_id={hubId}</div>
        </div>
        <Link
          to={`/tenants/${hubId!}`}
          className="text-emerald-400 hover:text-emerald-300 text-sm"
        >
          ← Back to tenant config
        </Link>
      </header>

      <section className="card">
        <h2 className="font-semibold mb-2">About API tokens</h2>
        <p className="text-sm text-slate-400">
          Tokens are used with <code className="font-mono">POST /api/trigger</code> and the
          <code className="font-mono"> Authorization: Bearer phk_…</code> header. Each token is
          scoped to this tenant only. Optionally restrict which client IPs can present a token
          — leave the list empty to allow any IP.
        </p>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-4">Mint new token</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Name (for you to identify it)</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. zapier-prod or ops-manual"
              maxLength={128}
            />
          </div>
          <div>
            <label className="label">IP allow-list (optional)</label>
            <CidrListEditor
              value={newCidrs}
              onChange={setNewCidrs}
              emptyHint="No entries — any IP may present this token."
            />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={!name.trim() || mint.isPending}
            onClick={() => mint.mutate()}
          >
            {mint.isPending ? 'Minting…' : 'Mint token'}
          </button>
          {mintError && <span className="text-rose-400 text-sm">{mintError}</span>}
        </div>

        {minted && (
          <div className="mt-4 rounded border border-amber-600/50 bg-amber-950/30 p-3">
            <div className="text-amber-300 text-sm font-semibold mb-1">
              Copy this token now — it will not be shown again.
            </div>
            <div className="font-mono text-xs break-all bg-slate-950 rounded p-2 border border-slate-800">
              {minted.token}
            </div>
            <div className="text-xs text-slate-500 mt-2">{minted.warning}</div>
            <button
              type="button"
              className="btn-secondary text-xs mt-2"
              onClick={() => setMinted(null)}
            >
              Dismiss
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-4">Existing tokens</h2>
        {q.isPending ? (
          <div className="text-slate-500 text-sm">Loading…</div>
        ) : q.error ? (
          <div className="text-rose-400 text-sm">Failed to load tokens.</div>
        ) : q.data && q.data.tokens.length === 0 ? (
          <div className="text-slate-500 text-sm">No tokens yet.</div>
        ) : (
          <div className="space-y-3">
            {q.data?.tokens.map((t) => (
              <TokenCard key={t.id} hubId={hubId!} token={t} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function TokenCard({ hubId, token }: { hubId: string; token: TokenRow }): ReactElement {
  const qc = useQueryClient();
  const [cidrs, setCidrs] = useState<string[]>(token.ip_allowlist_cidrs);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const revoked = Boolean(token.revokedAt);

  const save = useMutation({
    mutationFn: (): Promise<{ ok: true }> =>
      api(`/tenants/${hubId}/api-tokens/${token.id}/allowlist`, {
        method: 'PUT',
        body: { ip_allowlist_cidrs: cidrs },
      }),
    onSuccess: async () => {
      setEditing(false);
      setErr(null);
      await qc.invalidateQueries({ queryKey: ['api-tokens', hubId] });
    },
    onError: (e) => setErr(formatError(e)),
  });

  const revoke = useMutation({
    mutationFn: (): Promise<{ ok: true }> =>
      api(`/tenants/${hubId}/api-tokens/${token.id}/revoke`, { method: 'POST' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['api-tokens', hubId] });
    },
  });

  return (
    <div className={`rounded border p-3 ${revoked ? 'border-slate-800 opacity-60' : 'border-slate-800'}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-semibold truncate">
            {token.name}
            {revoked && <span className="ml-2 text-xs text-rose-400">revoked</span>}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            {token.prefix}… · created {new Date(token.createdAt).toLocaleDateString()} ·{' '}
            {token.lastUsedAt
              ? `last used ${new Date(token.lastUsedAt).toLocaleString()}`
              : 'never used'}
          </div>
        </div>
        {!revoked && (
          <button
            type="button"
            className="text-xs text-rose-400 hover:text-rose-300"
            onClick={() => {
              if (window.confirm(`Revoke token "${token.name}"? Any client using it will start getting 401.`)) {
                revoke.mutate();
              }
            }}
            disabled={revoke.isPending}
          >
            Revoke
          </button>
        )}
      </div>

      {!revoked && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              IP allow-list ({token.ip_allowlist_cidrs.length})
            </div>
            {!editing ? (
              <button
                type="button"
                className="text-xs text-emerald-400 hover:text-emerald-300"
                onClick={() => {
                  setCidrs(token.ip_allowlist_cidrs);
                  setEditing(true);
                }}
              >
                Edit
              </button>
            ) : (
              <div className="flex items-center gap-3">
                {err && <span className="text-rose-400 text-xs">{err}</span>}
                <button
                  type="button"
                  className="text-xs text-slate-400 hover:text-slate-200"
                  onClick={() => {
                    setCidrs(token.ip_allowlist_cidrs);
                    setEditing(false);
                    setErr(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                  disabled={save.isPending}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </div>
          {editing ? (
            <CidrListEditor
              value={cidrs}
              onChange={setCidrs}
              emptyHint="No entries — any IP may present this token."
            />
          ) : token.ip_allowlist_cidrs.length === 0 ? (
            <div className="text-xs text-slate-500">Any IP allowed.</div>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {token.ip_allowlist_cidrs.map((c) => (
                <li
                  key={c}
                  className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono"
                >
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function formatError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'request_failed';
  const detail = err.detail as { invalid?: string[] } | null;
  if (err.message === 'invalid_cidrs' && detail?.invalid?.length) {
    return `Invalid entries: ${detail.invalid.join(', ')}`;
  }
  return err.message;
}
