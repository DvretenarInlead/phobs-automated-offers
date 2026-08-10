import { describe, expect, it } from 'vitest';
import { compileAllowlist, normaliseClientIp } from '../src/lib/ipAllowlist.js';

describe('compileAllowlist', () => {
  it('empty list = allow-all', () => {
    const a = compileAllowlist([]);
    expect(a.empty).toBe(true);
    expect(a.contains('203.0.113.42')).toBe(true);
    expect(a.contains('2001:db8::1')).toBe(true);
  });

  it('null / undefined = allow-all (safe migration default)', () => {
    expect(compileAllowlist(null).empty).toBe(true);
    expect(compileAllowlist(undefined).empty).toBe(true);
  });

  it('matches IPv4 CIDR', () => {
    const a = compileAllowlist(['203.0.113.0/24']);
    expect(a.contains('203.0.113.1')).toBe(true);
    expect(a.contains('203.0.113.255')).toBe(true);
    expect(a.contains('203.0.114.1')).toBe(false);
  });

  it('matches IPv4 single address (implicit /32)', () => {
    const a = compileAllowlist(['203.0.113.42']);
    expect(a.contains('203.0.113.42')).toBe(true);
    expect(a.contains('203.0.113.43')).toBe(false);
  });

  it('matches IPv6 CIDR', () => {
    const a = compileAllowlist(['2001:db8::/32']);
    expect(a.contains('2001:db8::1')).toBe(true);
    expect(a.contains('2001:db8:ffff::1')).toBe(true);
    expect(a.contains('2001:db9::1')).toBe(false);
  });

  it('multi-entry OR-semantics', () => {
    const a = compileAllowlist(['10.0.0.0/8', '192.168.1.0/24', '2001:db8::/32']);
    expect(a.contains('10.5.5.5')).toBe(true);
    expect(a.contains('192.168.1.100')).toBe(true);
    expect(a.contains('2001:db8::42')).toBe(true);
    expect(a.contains('8.8.8.8')).toBe(false);
  });

  it('drops invalid CIDRs but keeps parsing the rest', () => {
    const a = compileAllowlist(['203.0.113.0/24', 'garbage', '999.999.999.999/24', '10.0.0.0/33']);
    expect(a.size).toBe(1);
    expect(a.invalid).toContain('garbage');
    expect(a.invalid).toContain('999.999.999.999/24');
    expect(a.invalid).toContain('10.0.0.0/33');
    expect(a.contains('203.0.113.5')).toBe(true);
  });

  it('rejects non-IP strings', () => {
    const a = compileAllowlist(['203.0.113.0/24']);
    expect(a.contains('not-an-ip')).toBe(false);
    expect(a.contains('')).toBe(false);
  });

  it('non-empty list with all invalid entries locks everything out', () => {
    const a = compileAllowlist(['garbage-only']);
    expect(a.empty).toBe(false);
    expect(a.size).toBe(0);
    expect(a.invalid).toHaveLength(1);
    expect(a.contains('203.0.113.1')).toBe(false);
  });
});

describe('normaliseClientIp', () => {
  it('strips IPv4-mapped-IPv6 prefix', () => {
    expect(normaliseClientIp('::ffff:203.0.113.42')).toBe('203.0.113.42');
  });
  it('passes IPv4 through', () => {
    expect(normaliseClientIp('203.0.113.42')).toBe('203.0.113.42');
  });
  it('passes IPv6 through', () => {
    expect(normaliseClientIp('2001:db8::1')).toBe('2001:db8::1');
  });
});
