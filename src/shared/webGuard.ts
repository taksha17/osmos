/**
 * Web network guard — pure helpers (Architecture v3, §9.1).
 *
 * No Electron, no DNS, no fetch here — so `bench/` and `node --test`
 * can import it directly. The async DNS-pinning wrapper lives in
 * `src/main/services/urlGuard.ts` and delegates to these checks.
 */

const LOOPBACK_HOST = /^(localhost|.*\.localhost|.*\.localdomain)$/i;

/** Hostnames that must never be fetched as web targets. */
export function isBlockedHostname(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.localdomain')) return true;
  if (h === 'metadata.google.internal') return true;
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(base);
  if (ipN === null || baseN === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

const IPV4_DENY = [
  '127.0.0.0/8', // loopback
  '10.0.0.0/8', // RFC 1918
  '172.16.0.0/12', // RFC 1918
  '192.168.0.0/16', // RFC 1918 (+ LAN targets unless explicitly allowed)
  '169.254.0.0/16', // link-local + cloud metadata (169.254.169.254)
  '192.0.2.0/24', // TEST-NET-1
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '100.64.0.0/10', // CGNAT
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
  '0.0.0.0/8', // unspecified
];

const IPV6_DENY_PREFIX = [
  '::1', // loopback
  '::', // unspecified
  'fe80:', // link-local
  'fc00:', // unique-local
  'fd00:', // unique-local
  'ff00:', // multicast
];

function isDeniedIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!v) return true;
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — check the embedded v4.
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return IPV4_DENY.some((c) => inCidr(mapped[1], c));
  if (v.includes('.') && /^\d+\.\d+\.\d+\.\d+$/.test(v)) {
    return IPV4_DENY.some((c) => inCidr(v, c));
  }
  return IPV6_DENY_PREFIX.some((p) => v === p || v.startsWith(p));
}

/** True when a resolved IP must never be fetched (SSRF guard). */
export function isBlockedIp(ip: string): boolean {
  return isDeniedIp(ip);
}

export type UrlGuardDecision =
  | { ok: true; host: string }
  | { ok: false; reason: string };

/**
 * Synchronous URL shape check (scheme + hostname + literal-IP ranges).
 * DNS resolution + redirect re-check happen in the main-process wrapper.
 */
export function checkUrlShape(raw: string, opts: { allowPrivateTargets?: boolean } = {}): UrlGuardDecision {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `blocked scheme ${u.protocol}` };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'missing hostname' };
  if (isBlockedHostname(host)) return { ok: false, reason: `blocked hostname ${host}` };
  if (!opts.allowPrivateTargets && isDeniedIp(host)) {
    return { ok: false, reason: `blocked IP literal ${host}` };
  }
  return { ok: true, host };
}

export function isLoopbackBaseUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

export { LOOPBACK_HOST };
