import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, login } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Login(): ReactElement {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login({
        email,
        password,
        ...(useRecovery
          ? recoveryCode
            ? { recoveryCode }
            : {}
          : totpCode
            ? { totpCode }
            : {}),
      });
      if ('needsMfa' in res) {
        setNeedsMfa(true);
        return;
      }
      setUser(res.user);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Unexpected error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm card">
        <div className="text-emerald-400 text-sm font-semibold mb-1">Phobs Offers</div>
        <h1 className="text-xl font-semibold mb-6">Admin sign in</h1>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              autoComplete="username"
              required
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={needsMfa}
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              type="password"
              autoComplete="current-password"
              required
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={needsMfa}
            />
          </div>
          {needsMfa && !useRecovery && (
            <div>
              <label className="label">Authenticator code</label>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                className="input tracking-widest text-center text-lg"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-200 mt-2"
                onClick={() => setUseRecovery(true)}
              >
                Use a recovery code instead
              </button>
            </div>
          )}
          {needsMfa && useRecovery && (
            <div>
              <label className="label">Recovery code</label>
              <input
                required
                className="input"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value.trim())}
                autoFocus
              />
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-200 mt-2"
                onClick={() => setUseRecovery(false)}
              >
                Use authenticator code instead
              </button>
            </div>
          )}
          {error && (
            <div className="text-rose-400 text-sm bg-rose-950/40 border border-rose-900 rounded px-3 py-2">
              {error}
            </div>
          )}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? 'Signing in…' : needsMfa ? 'Verify' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
