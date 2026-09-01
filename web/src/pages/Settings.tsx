import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import QRCode from 'qrcode';
import { api, describeError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface TotpSetupResponse {
  otpauthUri: string;
  base32Secret: string;
}
interface TotpConfirmResponse {
  ok: true;
  recoveryCodes: string[];
}

export function Settings(): ReactElement {
  const { user, refresh } = useAuth();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="text-sm text-slate-400">
        Signed in as <span className="text-slate-200">{user?.email}</span> ·{' '}
        {user?.role === 'superadmin' ? 'Superadmin' : `Tenant admin (hub ${user?.scopedHubId})`}
      </div>
      <ChangePassword />
      <TotpSection
        enabled={Boolean(user?.totpEnabled)}
        onChanged={() => refresh({ background: true })}
      />
    </div>
  );
}

function ChangePassword(): ReactElement {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/.test(next)) {
      setError('Password must be at least 12 characters with upper case, lower case and a digit.');
      return;
    }
    setBusy(true);
    try {
      await api('/password', { method: 'POST', body: { current, next } });
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(describeError(err, 'failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="font-semibold mb-4">Change password</h2>
      <form onSubmit={submit} className="space-y-4 max-w-md">
        <div>
          <label className="label" htmlFor="pw-current">
            Current password
          </label>
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            className="input"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="pw-next">
            New password (≥ 12 chars, mixed case + digit)
          </label>
          <input
            id="pw-next"
            type="password"
            autoComplete="new-password"
            className="input"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="pw-confirm">
            Confirm new password
          </label>
          <input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        {error && <div className="text-rose-400 text-sm">{error}</div>}
        {done && <div className="text-emerald-400 text-sm">Password changed.</div>}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}

function TotpSection({
  enabled,
  onChanged,
}: {
  enabled: boolean;
  onChanged: () => Promise<void>;
}): ReactElement {
  const [setupData, setSetupData] = useState<TotpSetupResponse | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disableRecovery, setDisableRecovery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const beginSetup = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<TotpSetupResponse>('/totp/setup', { method: 'POST' });
      setSetupData(r);
      const png = await QRCode.toDataURL(r.otpauthUri, { margin: 1, scale: 6 });
      setQrUrl(png);
    } catch (err) {
      setError(describeError(err, 'failed'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<TotpConfirmResponse>('/totp/confirm', { method: 'POST', body: { code } });
      // Recovery codes are shown exactly once — keep them in local state and
      // only refresh /me in the background so this component stays mounted.
      setRecovery(r.recoveryCodes);
      setSetupData(null);
      setQrUrl(null);
      setCode('');
      await onChanged();
    } catch (err) {
      setError(describeError(err, 'failed'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api('/totp/disable', {
        method: 'POST',
        body: {
          password: disablePassword,
          code: disableCode || undefined,
          recoveryCode: disableRecovery || undefined,
        },
      });
      setDisablePassword('');
      setDisableCode('');
      setDisableRecovery('');
      setRecovery(null);
      await onChanged();
    } catch (err) {
      setError(describeError(err, 'failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="font-semibold">Two-factor authentication</h2>
        <span className={enabled ? 'pill-ok' : 'pill-warn'}>{enabled ? 'enabled' : 'off'}</span>
      </div>
      {error && <div className="text-rose-400 text-sm mb-4">{error}</div>}

      {recovery && (
        <div className="border border-amber-700 bg-amber-950/30 rounded p-4 mb-4">
          <div className="font-medium text-amber-300 mb-2">
            Save these recovery codes now. They are shown once and each works one time.
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm">
            {recovery.map((c) => (
              <div key={c}>{c}</div>
            ))}
          </div>
          <button
            type="button"
            className="btn-secondary text-xs mt-3"
            onClick={() => setRecovery(null)}
          >
            I have saved them
          </button>
        </div>
      )}

      {setupData ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-300">
            Scan this QR with your authenticator app, then enter the 6-digit code it shows.
          </p>
          {qrUrl && (
            <img
              src={qrUrl}
              alt="TOTP QR code"
              width={192}
              height={192}
              className="rounded bg-white p-2"
            />
          )}
          <details className="text-xs text-slate-400">
            <summary className="cursor-pointer">Can't scan? Enter secret manually</summary>
            <code className="block mt-2 font-mono break-all bg-slate-950 px-2 py-1 rounded">
              {setupData.base32Secret}
            </code>
          </details>
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="label" htmlFor="totp-code">
                Code from your app
              </label>
              <input
                id="totp-code"
                inputMode="numeric"
                maxLength={6}
                className="input tracking-widest text-center text-lg"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={confirm}
              disabled={busy || code.length !== 6}
            >
              Enable
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setSetupData(null);
                setQrUrl(null);
                setCode('');
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : !enabled ? (
        <>
          <p className="text-slate-400 text-sm mb-4">
            TOTP-based MFA using an app like 1Password, Bitwarden, or Authy. Strongly recommended
            for every admin account.
          </p>
          <button type="button" className="btn-secondary" onClick={beginSetup} disabled={busy}>
            {busy ? '…' : 'Set up authenticator app'}
          </button>
        </>
      ) : (
        <div>
          <h3 className="font-medium mb-2 text-sm">Disable TOTP</h3>
          <p className="text-slate-500 text-xs mb-3">
            Requires your current password and a current authenticator code (or one unused
            recovery code). To re-enrol on a new device, disable first, then set up again.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              type="password"
              placeholder="Password"
              aria-label="Password"
              autoComplete="current-password"
              className="input"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
            />
            <input
              inputMode="numeric"
              placeholder="6-digit code"
              aria-label="Authenticator code"
              className="input"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))}
              maxLength={6}
            />
            <input
              placeholder="or recovery code"
              aria-label="Recovery code"
              className="input font-mono"
              value={disableRecovery}
              onChange={(e) => setDisableRecovery(e.target.value.trim())}
              maxLength={64}
            />
            <button
              type="button"
              className="btn-danger"
              onClick={disable}
              disabled={busy || !disablePassword || (!disableCode && !disableRecovery)}
            >
              Disable
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
