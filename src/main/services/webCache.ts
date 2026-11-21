/**
 * Web fetch cache — in-memory now, v2 SQLite later (Architecture v3, §5.4).
 *
 * Key: (kind, url, JSON opts). TTL: 24h static pages, 1h news/prices,
 * 0 for dynamic. Bounded LRU-ish (oldest-first eviction at 500 entries)
 * so a crawl cannot grow memory on a box that also runs a local LLM.
 * The v2 memory service will persist entries with provenance; this keeps
 * the live path within budget until then.
 */

export type WebCacheKind = 'scrape' | 'map' | 'search';

export const TTL_STATIC_MS = 24 * 60 * 60 * 1000;
export const TTL_NEWS_MS = 60 * 60 * 1000;

const MAX_ENTRIES = 500;

type Entry = { value: unknown; expiresAt: number; insertedAt: number };

const store = new Map<string, Entry>();

export function webCacheKey(kind: WebCacheKind, url: string, opts?: unknown): string {
  return `${kind}::${url}::${opts ? JSON.stringify(opts) : ''}`;
}

export function webCacheGet<T>(key: string, now = Date.now()): T | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }
  return e.value as T;
}

export function webCacheSet(key: string, value: unknown, ttlMs: number, now = Date.now()): void {
  if (ttlMs <= 0) return;
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { value, expiresAt: now + ttlMs, insertedAt: now });
}

export function webCacheClear(): void {
  store.clear();
}

/** News-like URLs get the short TTL; everything else gets the static TTL. */
export function ttlForUrl(url: string): number {
  if (/\/(news|prices?|stocks?|quotes?|markets?)([\/?#]|$)/i.test(url)) return TTL_NEWS_MS;
  return TTL_STATIC_MS;
}
