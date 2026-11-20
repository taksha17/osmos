/**
 * T0 web provider — Architecture v3, §2 (built-in tier).
 *
 * Adapts the existing v0.6 search services (DuckDuckGo / SearXNG / Tavily) to
 * the `WebAccessProvider` contract. Behaviour is unchanged: same provider
 * resolution, same errors, same hit count.
 */

import type { AppSettings } from '../../../shared/types.js';
import type {
  CallOpts,
  SearchHit,
  WebAccessProvider,
  WebCapability,
} from '../../../shared/contracts/web.js';
import { resolveWebSearchProvider, testWebSearch } from '../../services/webSearch.js';
import { searchDuckDuckGo } from '../../services/duckduckgo.js';
import { searchSearxng } from '../../services/searxng.js';
import { searchTavily } from '../../services/tavily.js';

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i;

function isLoopback(url?: string): boolean {
  return Boolean(url && LOOPBACK.test(url.trim()));
}

/** True when this T0 configuration keeps the query on the machine. */
export function isBuiltinLocal(settings: AppSettings): boolean {
  return resolveWebSearchProvider(settings) === 'searxng' && isLoopback(settings.searxngBaseUrl);
}

/**
 * A T0 provider bound to the user's current settings. The id carries the
 * resolved search backend so status lines can say which one answered.
 */
export function builtinWebProvider(settings: AppSettings): WebAccessProvider {
  const backend = resolveWebSearchProvider(settings);

  return {
    id: `builtin:${backend}`,
    tier: 'T0',
    capabilities: new Set<WebCapability>(['search']),
    local: isBuiltinLocal(settings),

    async health(signal) {
      const startedAt = Date.now();
      const result = await testWebSearch(settings);
      const latencyMs = Date.now() - startedAt;
      if (signal.aborted) return { ok: false, latencyMs, detail: 'aborted' };
      return {
        ok: result.ok,
        latencyMs,
        detail: result.ok ? `${result.provider} · ${result.resultCount ?? 0} hits` : result.error,
      };
    },

    async search(q, _opts: CallOpts): Promise<SearchHit[]> {
      const query = q.query.trim();
      if (!query) return [];

      let hits;
      if (backend === 'tavily') {
        if (!settings.tavilyApiKey?.trim()) {
          throw new Error('Add a Tavily API key in Settings → Web, or switch to DuckDuckGo (free).');
        }
        hits = await searchTavily(settings.tavilyApiKey, query);
      } else if (backend === 'searxng') {
        if (!settings.searxngBaseUrl?.trim()) {
          throw new Error('Set a SearXNG URL in Settings → Web, or switch to DuckDuckGo (free).');
        }
        hits = await searchSearxng(settings.searxngBaseUrl, query);
      } else {
        hits = await searchDuckDuckGo(query);
      }

      return hits.slice(0, q.limit ?? 8).map((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.content,
      }));
    },

    // T0 returns snippets, not page content (§2.1), so `scrape`/`crawl`/`map`
    // stay unimplemented: the manager falls through to a Firecrawl tier rather
    // than pretending a snippet is a page.
  };
}
