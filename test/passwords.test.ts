import { describe, expect, it } from 'vitest';
import { hashPassword, passwordSchema, verifyPassword } from '../src/admin/passwords.js';

describe('passwordSchema', () => {
  it('rejects short passwords', () => {
    expect(() => passwordSchema.parse('Short1')).toThrow();
  });
  it('rejects weak passwords', () => {
    expect(() => passwordSchema.parse('alllowercaseletters')).toThrow();
  });
  it('accepts policy-compliant passwords', () => {
    expect(passwordSchema.parse('Correct-Horse-Battery-Staple-9')).toBeTypeOf('string');
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips a password and rejects the wrong one', async () => {
    const h = await hashPassword('Correct-Horse-Battery-Staple-9');
    expect(await verifyPassword(h, 'Correct-Horse-Battery-Staple-9')).toBe(true);
    expect(await verifyPassword(h, 'wrong-password')).toBe(false);
  });

  it('returns false on a corrupt hash without throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
  });
}, 30_000);
