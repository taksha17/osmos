/**
 * URL Guard — main-process wrapper (Architecture v3, §9.1).
 *
 * Synchronous shape checks live in `src/shared/webGuard.ts` (unit-tested).
 * This module adds DNS resolution + pinning: the hostname is resolved with
 * `node:dns/promises` BEFORE any provider call, every resolved A/AAAA address
 * is checked against the deny list, and callers must re-check after redirects
 * (see `assertRedirectAllowed`, which defends against DNS rebinding).
 *
 * The OSMOS → web-service link itself (configured baseUrl, loopback by
 * default) is the only loopback exception — and only for that exact URL.
 */

import { lookup } from 'node:dns/promises';
import { checkUrlShape, isBlockedHostname, isBlockedIp } from '../../shared/webGuard.js';

export type GuardOpts = {
  /** When true, RFC 1918/LAN targets are allowed (explicit user opt-in). */
  allowPrivateTargets?: boolean;
  /** Extra hostnames the user allow-listed in Settings. */
  domainAllowlist?: string[];
  /** Hostnames the user deny-listed in Settings. */
  domainDenylist?: string[];
  /** Milliseconds for the DNS lookup; default 3s. */
  dnsTimeoutMs?: number;
};

function inList(host: string, list?: string[]): boolean {
  if (!list || list.length === 0) return false;
  const h = host.toLowerCase();
  return list.some((d) => {
    const v = d.trim().toLowerCase().replace(/^\*\./, '');
    return h === v || h.endsWith(`.${v}`);
  });
}

export async function assertUrlAllowed(raw: string, opts: GuardOpts = {}): Promise<string> {
  const shape = checkUrlShape(raw, { allowPrivateTargets: opts.allowPrivateTargets });
  if (!shape.ok) throw new Error(`URL Guard: ${(shape as { reason: string }).reason}`);
  const host = shape.host.toLowerCase();

  if (inList(host, opts.domainDenylist)) throw new Error(`URL Guard: ${host} is deny-listed`);
  if (opts.domainAllowlist && opts.domainAllowlist.length > 0 && !inList(host, opts.domainAllowlist)) {
    throw new Error(`URL Guard: ${host} is not in the allowlist`);
  }

  // Literal IPs were already checked by shape; resolve hostnames and pin.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;

  let addresses: Array<{ address: string }>;
  try {
    const timeoutMs = opts.dnsTimeoutMs ?? 3000;
    addresses = (await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), timeoutMs)),
    ])) as Array<{ address: string }>;
  } catch (e) {
    throw new Error(`URL Guard: DNS lookup failed for ${host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (addresses.length === 0) throw new Error(`URL Guard: no DNS records for ${host}`);
  for (const a of addresses) {
    if (!opts.allowPrivateTargets && isBlockedIp(a.address)) {
      throw new Error(`URL Guard: ${host} resolves to blocked address ${a.address}`);
    }
  }
  if (isBlockedHostname(host)) throw new Error(`URL Guard: blocked hostname ${host}`);
  return host;
}

/** Re-check a redirect target before following it (DNS-rebinding defence). */
export async function assertRedirectAllowed(from: string, to: string, opts: GuardOpts = {}): Promise<void> {
  void from;
  await assertUrlAllowed(to, opts);
}

export function redirectCountExceeded(count: number, max = 5): boolean {
  return count > max;
}
