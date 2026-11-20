/**
 * Web access contract — Architecture v3, §4.2.
 *
 * Types only. One interface covers every tier:
 *   T0  built-in search snippets (DuckDuckGo / SearXNG / Tavily)
 *   T1  Firecrawl Local (single binary on 127.0.0.1:3002)
 *   T2  self-hosted Firecrawl stack (Docker Compose, same REST surface)
 *   T3  Firecrawl Cloud or another hosted provider
 *
 * Fetched content is untrusted data, never instructions (§9.3). Nothing here
 * imports Electron, so the Web Access Manager, tests and tools can share it.
 */

export type WebCapability = 'search' | 'scrape' | 'crawl' | 'map' | 'extract';

export type WebTier = 'T0' | 'T1' | 'T2' | 'T3';

/** Privacy preset (§7): governs whether a cloud tier may be used at all. */
export type WebPrivacy = 'local-only' | 'local-first' | 'cloud';

export type CallPurpose = 'live-assist' | 'prep' | 'background';

export type CallOpts = {
  signal: AbortSignal;
  deadlineMs: number;
  purpose: CallPurpose;
};

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export type Page = {
  url: string;
  finalUrl: string;
  title?: string;
  markdown: string;
  fetchedAtMs: number;
  status: number;
  /** Provider id that produced this page, for provenance in answers. */
  source: string;
};

export type WebHealth = {
  ok: boolean;
  version?: string;
  latencyMs: number;
  detail?: string;
};

export interface WebAccessProvider {
  id: string;
  tier: WebTier;
  capabilities: ReadonlySet<WebCapability>;
  /** True when no third party sees the request (T0 local SearXNG, T1/T2). */
  local: boolean;
  health(signal: AbortSignal): Promise<WebHealth>;
  search?(
    q: { query: string; limit?: number; site?: string },
    o: CallOpts,
  ): Promise<SearchHit[]>;
  scrape?(
    q: { url: string; formats?: Array<'markdown' | 'html'>; onlyMainContent?: boolean; waitMs?: number },
    o: CallOpts,
  ): Promise<Page>;
  crawl?(
    q: { url: string; limit: number; maxDepth?: number; includePaths?: string[] },
    o: CallOpts,
  ): AsyncIterable<Page>;
  map?(q: { url: string; limit?: number }, o: CallOpts): Promise<string[]>;
  extract?(
    q: { url: string; schema: Record<string, unknown> },
    o: CallOpts,
  ): Promise<unknown>;
}
