import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';

/**
 * Per-tenant / per-token IP allow-list.
 *
 * Uses Node's built-in `net.BlockList` — no external dep. Handles IPv4 and
 * IPv6 CIDRs, single addresses, and address ranges. Case:
 *
 *   "203.0.113.0/24"       IPv4 CIDR
 *   "203.0.113.42"          IPv4 single (implicit /32)
 *   "2001:db8::/32"         IPv6 CIDR
 *   "2001:db8::1"           IPv6 single (implicit /128)
 *
 * Empty list means "no restriction" — allow everything. This is the safe
 * migration default so existing tenants keep working when the column is
 * added.
 *
 * Bad CIDR strings are dropped silently at parse time (with a log line) so
 * one typo can't lock a tenant out of everything. The admin UI surfaces
 * the parsed list back on read so operators can verify.
 */

export interface CompiledAllowlist {
  /** Number of entries successfully compiled. */
  size: number;
  /** Entries that failed to parse. */
  invalid: string[];
  /** True if the caller supplied nothing → allow-all. */
  empty: boolean;
  /** Check whether an IP is allowed. */
  contains: (ip: string) => boolean;
}

export function compileAllowlist(cidrs: readonly string[] | null | undefined): CompiledAllowlist {
  const raw = Array.isArray(cidrs) ? cidrs : [];
  if (raw.length === 0) {
    return { size: 0, invalid: [], empty: true, contains: () => true };
  }

  const list = new BlockList();
  const invalid: string[] = [];
  let ok = 0;

  for (const entry of raw) {
    const trimmed = String(entry).trim();
    if (!trimmed) continue;
    try {
      if (trimmed.includes('/')) {
        const [addr, mask] = trimmed.split('/', 2) as [string, string];
        const bits = Number(mask);
        if (!Number.isInteger(bits) || bits < 0 || bits > 128) {
          invalid.push(trimmed);
          continue;
        }
        const family = detectFamily(addr);
        if (!family) {
          invalid.push(trimmed);
          continue;
        }
        list.addSubnet(addr, bits, family);
      } else {
        const family = detectFamily(trimmed);
        if (!family) {
          invalid.push(trimmed);
          continue;
        }
        list.addAddress(trimmed, family);
      }
      ok++;
    } catch {
      invalid.push(trimmed);
    }
  }

  return {
    size: ok,
    invalid,
    empty: false,
    contains: (ip: string): boolean => {
      const family = detectFamily(ip);
      if (!family) return false;
      try {
        return list.check(ip, family);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Normalises a client IP that may arrive from BlockList in IPv4-mapped-IPv6
 * form (`::ffff:203.0.113.42`) → strips the prefix so the caller can match
 * against IPv4 CIDRs.
 */
export function normaliseClientIp(ip: string): string {
  if (ip.startsWith('::ffff:') && isIPv4(ip.slice(7))) return ip.slice(7);
  return ip;
}

function detectFamily(addr: string): 'ipv4' | 'ipv6' | null {
  if (isIPv4(addr)) return 'ipv4';
  if (isIPv6(addr)) return 'ipv6';
  return null;
}

export { isIP };
