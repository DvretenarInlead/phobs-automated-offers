import { describe, expect, it, vi } from 'vitest';
import { signInvite, verifyInvite } from '../src/admin/inviteTokens.js';

describe('invite tokens', () => {
  it('round-trips a valid payload', () => {
    const t = signInvite({ userId: '42', email: 'a@b.c', iat: Date.now() });
    const p = verifyInvite(t);
    expect(p?.userId).toBe('42');
    expect(p?.email).toBe('a@b.c');
  });

  it('rejects malformed tokens', () => {
    expect(verifyInvite('garbage')).toBeNull();
    expect(verifyInvite('only.one')).toBeNull();
    expect(verifyInvite('a.b.c')).toBeNull();
  });

  it('rejects tampered payload', () => {
    const t = signInvite({ userId: '1', email: 'a@b.c', iat: Date.now() });
    const [body, sig] = t.split('.') as [string, string];
    const tamperedBody = Buffer.from(
      JSON.stringify({ userId: '999', email: 'a@b.c', iat: Date.now() }),
      'utf8',
    ).toString('base64url');
    expect(verifyInvite(`${tamperedBody}.${sig}`)).toBeNull();
    expect(body).toBeTruthy(); // sanity
  });

  it('expires after the TTL window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const t = signInvite({ userId: '1', email: 'a@b.c', iat: Date.now() });
      vi.setSystemTime(new Date('2025-02-01T00:00:00Z')); // ~31 days later
      expect(verifyInvite(t)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
