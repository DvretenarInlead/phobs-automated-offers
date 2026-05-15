import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface PreviewResponse {
  email: string;
}

export function AcceptInvite(): ReactElement {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('missing token');
      return;
    }
    void (async (): Promise<void> => {
      try {
        const r = await api<PreviewResponse>(`/users/invite/preview?token=${encodeURIComponent(token)}`);
        setEmail(r.email);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'invalid_token');
      }
    })();
  }, [token]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api('/users/invite/accept', { method: 'POST', body: { token, password } });
      setDone(true);
      setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm card">
        <div className="text-emerald-400 text-sm font-semibold mb-1">Phobs Offers</div>
        <h1 className="text-xl font-semibold mb-2">Accept invitation</h1>
        {email && <div className="text-slate-400 text-sm mb-4">for {email}</div>}
        {done ? (
          <div className="text-emerald-400 text-sm">Done. Redirecting to sign in…</div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">Choose a password (≥ 12 chars, mixed case + digit)</label>
              <input
                type="password"
                autoComplete="new-password"
                required
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Confirm password</label>
              <input
                type="password"
                autoComplete="new-password"
                required
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            {error && <div className="text-rose-400 text-sm">{error}</div>}
            <button type="submit" disabled={busy || !email} className="btn-primary w-full">
              {busy ? 'Setting up…' : 'Accept invite'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
