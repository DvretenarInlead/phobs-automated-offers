import { describe, expect, it } from 'vitest';
import { issueCsrfToken, verifyCsrfToken } from '../src/admin/csrf.js';

describe('CSRF', () => {
  it('issues and verifies a token', () => {
    const t = issueCsrfToken();
    expect(verifyCsrfToken(t)).toBe(true);
  });

  it('rejects malformed tokens', () => {
    expect(verifyCsrfToken('garbage')).toBe(false);
    expect(verifyCsrfToken('a.b')).toBe(false);
    expect(verifyCsrfToken('xxxx.yyyy.zzzz')).toBe(false);
  });

  it('rejects a token with a tampered signature', () => {
    const t = issueCsrfToken();
    const parts = t.split('.');
    const tampered = `${parts[0]}.${parts[1]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(verifyCsrfToken(tampered)).toBe(false);
  });
});
