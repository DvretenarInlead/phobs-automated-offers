import { describe, expect, it } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import {
  findRecoveryMatch,
  generateRecoveryCodes,
  generateTotp,
  verifyTotp,
  verifyTotpOnce,
} from '../src/admin/totp.js';

function codeFor(base32: string, timestamp: number): string {
  return new TOTP({
    secret: Secret.fromBase32(base32),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    issuer: 'Phobs Offers',
  }).generate({ timestamp });
}

describe('TOTP', () => {
  it('generates a base32 secret and otpauth URI', () => {
    const t = generateTotp('admin@example.com');
    expect(t.base32Secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(t.uri).toMatch(/^otpauth:\/\/totp\//);
  });

  it('verifies the code computed for the current time-step', () => {
    const t = generateTotp('a@b.c');
    const code = codeFor(t.base32Secret, Date.now());
    expect(verifyTotp(t.base32Secret, code)).toBe(true);
  });

  it('rejects garbage codes', () => {
    const t = generateTotp('a@b.c');
    expect(verifyTotp(t.base32Secret, '000000')).toBe(false);
  });

  it('accepts a code once and rejects its replay, even inside the ±1 window', () => {
    const t = generateTotp('a@b.c');
    const now = 1_800_000_000_000;
    const code = codeFor(t.base32Secret, now);

    const step = verifyTotpOnce(t.base32Secret, code, null, now);
    expect(step).toBe(Math.floor(now / 1000 / 30));

    // Same code, same step, with the accepted step persisted → rejected.
    expect(verifyTotpOnce(t.base32Secret, code, step, now)).toBeNull();
    // Still rejected 20s later (same 30s step) and 40s later (previous step
    // is inside the window but <= last used).
    expect(verifyTotpOnce(t.base32Secret, code, step, now + 20_000)).toBeNull();
    expect(verifyTotpOnce(t.base32Secret, code, step, now + 40_000)).toBeNull();

    // The next step's code is accepted and moves the counter forward.
    const next = codeFor(t.base32Secret, now + 30_000);
    expect(verifyTotpOnce(t.base32Secret, next, step, now + 30_000)).toBe(step! + 1);
  });

  it('tolerates one step of clock skew in either direction', () => {
    const t = generateTotp('a@b.c');
    const now = 1_800_000_000_000;
    expect(verifyTotpOnce(t.base32Secret, codeFor(t.base32Secret, now - 30_000), null, now)).not.toBeNull();
    expect(verifyTotpOnce(t.base32Secret, codeFor(t.base32Secret, now + 30_000), null, now)).not.toBeNull();
    expect(verifyTotpOnce(t.base32Secret, codeFor(t.base32Secret, now - 90_000), null, now)).toBeNull();
  });
});

describe('recovery codes', () => {
  it('hashes and matches a known code exactly once', () => {
    const { plain, hashes } = generateRecoveryCodes(3);
    expect(plain).toHaveLength(3);
    expect(hashes).toHaveLength(3);
    expect(findRecoveryMatch(hashes, plain[1]!)).toBe(1);
    expect(findRecoveryMatch(hashes, 'not-a-code')).toBe(-1);
  });
});
