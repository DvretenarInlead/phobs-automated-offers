import { describe, expect, it } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import {
  findRecoveryMatch,
  generateRecoveryCodes,
  generateTotp,
  verifyTotp,
} from '../src/admin/totp.js';

describe('TOTP', () => {
  it('generates a base32 secret and otpauth URI', () => {
    const t = generateTotp('admin@example.com');
    expect(t.base32Secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(t.uri).toMatch(/^otpauth:\/\/totp\//);
  });

  it('verifies the code computed for the current time-step', () => {
    const t = generateTotp('a@b.c');
    const code = new TOTP({
      secret: Secret.fromBase32(t.base32Secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      issuer: 'Phobs Offers',
    }).generate();
    expect(verifyTotp(t.base32Secret, code)).toBe(true);
  });

  it('rejects garbage codes', () => {
    const t = generateTotp('a@b.c');
    expect(verifyTotp(t.base32Secret, '000000')).toBe(false);
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
