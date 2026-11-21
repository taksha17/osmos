/**
 * Firecrawl-compatible adapter — T1 (local binary) + T2 (self-hosted stack).
 *
 * Speaks the Firecrawl v2 REST surface both tiers expose on `:3002`
 * (Architecture v3, §2/§4): POST /v2/scrape, POST /v2/map, POST /v2/crawl
 * with polling, POST /v2/extract with polling (T2/T3 only — Local has no
 * extract route). Health probes `/health` (Local) then
 * `/v0/health/readiness` (Docker stack) then `/` (bench mock). Never linked
 * or vendored — plain HTTP to a service the user runs (AGPL separation, §10).
 *
 * Safety: every target URL passes through the URL Guard (DNS pinning +
 * redirect re-check) before any request, with a 5-redirect cap. Timeouts
 * come from CallOpts.deadlineMs so the live path never blocks (§5.3).
 */

import type {
  CallOpts,
  Page,
  WebAccessProvider,
  WebCapability,
  WebHealth,
  WebTier,
} from '../../../shared/contracts/web.js';
import {
  assertRedirectAllowed,
  assertUrlAllowed,
  redirectCountExceeded,
} from '../../services/urlGuard.js';

export type FirecrawlConfig = {
  baseUrl: string;
  apiKey?: string;
  tier?: WebTier;
  local?: boolean;
};

const MAX_REDIRECTS = 5;

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'OSMOS/0.6 (Firecrawl-compatible client)',
  };
  if (apiKey?.trim()) h.Authorization = `Bearer ${apiKey.trim()}`;
  return h;
}

function withDeadline(signal: AbortSignal, deadlineMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('deadline exceeded')), Math.max(1, deadlineMs));
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function toPage(raw: Record<string, unknown>, fallbackUrl: string, source: string): Page {
  const data = (raw.data ?? raw) as Record<string, unknown>;
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  const finalUrl = String(
    data.url ?? data.finalUrl ?? meta.sourceURL ?? meta.url ?? fallbackUrl,
  );
  const title =
    typeof data.title === 'string'
      ? data.title
      : typeof meta.title === 'string'
        ? meta.title
        : undefined;
  const status =
    typeof data.statusCode === 'number'
      ? data.statusCode
      : typeof meta.statusCode === 'number'
        ? meta.statusCode
        : 200;
  return {
    url: fallbackUrl,
    finalUrl,
    title,
    markdown: String(data.markdown ?? data.content ?? ''),
    fetchedAtMs: Date.now(),
    status,
    source,
  };
}

function toLinkList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item === 'string') {
      if (item) out.push(item);
    } else if (item && typeof item === 'object') {
      const u = (item as { url?: unknown }).url;
      if (typeof u === 'string' && u) out.push(u);
    }
  }
  return out;
}

export function firecrawlWebProvider(config: FirecrawlConfig): WebAccessProvider {
  const base = normalizeBase(config.baseUrl || 'http://127.0.0.1:3002');
  const tier: WebTier = config.tier ?? 'T1';
  const local = config.local ?? true;
  const id = tier === 'T2' ? 'firecrawl:stack' : tier === 'T3' ? 'firecrawl:cloud' : 'firecrawl:local';

  return {
    id,
    tier,
    // Local binary has no extract route (needs an AI provider) — T2/T3 only.
    capabilities: new Set<WebCapability>(
      tier === 'T1' ? ['scrape', 'crawl', 'map'] : ['scrape', 'crawl', 'map', 'extract'],
    ),
    local,

    async health(signal): Promise<WebHealth> {
      const startedAt = Date.now();
      const gate = withDeadline(signal, 3000);
      try {
        // Local: GET /health · Docker stack: GET /v0/health/readiness ·
        // bench mock: GET / returns { version }.
        for (const path of ['/health', '/v0/health/readiness', '/']) {
          try {
            const res = await fetch(`${base}${path}`, {
              headers: headers(config.apiKey),
              signal: gate.signal,
            });
            if (!res.ok) continue;
            const body = (await readJson(res)) as {
              version?: unknown;
              status?: unknown;
              engine?: unknown;
            };
            const version =
              typeof body.version === 'string' ? body.version : undefined;
            const status =
              typeof body.status === 'string' ? body.status : undefined;
            return {
              ok: true,
              latencyMs: Date.now() - startedAt,
              version,
              detail: `${id} · ${Date.now() - startedAt}ms${status ? ` · ${status}` : ''}`,
            };
          } catch {
            // Try the next health path.
          }
          if (gate.signal.aborted) break;
        }
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          detail: 'no health route answered',
        };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - startedAt, detail: e instanceof Error ? e.message : String(e) };
      } finally {
        gate.done();
      }
    },

    async scrape(q, o: CallOpts): Promise<Page> {
      await assertUrlAllowed(q.url);
      const gate = withDeadline(o.signal, o.deadlineMs || 1200);
      try {
        const res = await fetch(`${base}/v2/scrape`, {
          method: 'POST',
          headers: headers(config.apiKey),
          signal: gate.signal,
          body: JSON.stringify({
            url: q.url,
            formats: q.formats ?? ['markdown'],
            onlyMainContent: q.onlyMainContent ?? true,
            waitFor: q.waitMs ?? 0,
          }),
        });
        if (!res.ok) throw new Error(`Firecrawl scrape HTTP ${res.status}`);
        return toPage((await readJson(res)) as Record<string, unknown>, q.url, id);
      } finally {
        gate.done();
      }
    },

    async map(q, o: CallOpts): Promise<string[]> {
      await assertUrlAllowed(q.url);
      const gate = withDeadline(o.signal, o.deadlineMs || 5000);
      try {
        const res = await fetch(`${base}/v2/map`, {
          method: 'POST',
          headers: headers(config.apiKey),
          signal: gate.signal,
          body: JSON.stringify({ url: q.url, limit: q.limit ?? 50 }),
        });
        if (!res.ok) throw new Error(`Firecrawl map HTTP ${res.status}`);
        const body = (await readJson(res)) as {
          links?: unknown;
          data?: unknown;
        };
        // Cloud/stack: { success, links: [{url}] } · bench mock: { links: [str] }.
        const rawLinks = Array.isArray(body.links)
          ? body.links
          : body.data && typeof body.data === 'object' && Array.isArray((body.data as { links?: unknown }).links)
            ? (body.data as { links: unknown }).links
            : Array.isArray(body.data)
              ? body.data
              : [];
        return toLinkList(rawLinks);
      } finally {
        gate.done();
      }
    },

    async *crawl(q, o: CallOpts): AsyncIterable<Page> {
      await assertUrlAllowed(q.url);
      const gate = withDeadline(o.signal, o.deadlineMs || 60_000);
      try {
        const start = await fetch(`${base}/v2/crawl`, {
          method: 'POST',
          headers: headers(config.apiKey),
          signal: gate.signal,
          body: JSON.stringify({
            url: q.url,
            limit: q.limit,
            maxDepth: q.maxDepth ?? 2,
            includePaths: q.includePaths,
          }),
        });
        if (!start.ok) throw new Error(`Firecrawl crawl HTTP ${start.status}`);
        const started = (await readJson(start)) as {
          id?: string;
          jobId?: string;
          data?: Array<Record<string, unknown>>;
        };
        // Some servers/mocks return pages synchronously.
        if (Array.isArray(started.data)) {
          for (const raw of started.data) yield toPage(raw, q.url, id);
          return;
        }
        const jobId = started.id ?? started.jobId;
        if (!jobId) return;
        let redirects = 0;
        for (;;) {
          if (gate.signal.aborted) return;
          const poll = await fetch(`${base}/v2/crawl/${encodeURIComponent(jobId)}`, {
            headers: headers(config.apiKey),
            signal: gate.signal,
          });
          if (!poll.ok) throw new Error(`Firecrawl crawl status HTTP ${poll.status}`);
          const status = (await readJson(poll)) as {
            status?: string;
            data?: Array<Record<string, unknown>>;
            next?: string;
          };
          for (const raw of status.data ?? []) {
            const page = toPage(raw, q.url, id);
            if (page.finalUrl && page.finalUrl !== q.url) {
              redirects += 1;
              if (redirectCountExceeded(redirects, MAX_REDIRECTS)) {
                throw new Error('URL Guard: too many redirects');
              }
              await assertRedirectAllowed(q.url, page.finalUrl);
            }
            yield page;
          }
          const done =
            status.status === 'completed' ||
            status.status === 'done' ||
            status.status === 'succeeded' ||
            !status.next;
          if (done) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
      } finally {
        gate.done();
      }
    },

    async extract(q, o: CallOpts): Promise<unknown> {
      if (tier === 'T1') {
        throw new Error('Firecrawl Local has no /v2/extract route — use the self-hosted stack (T2) or cloud (T3)');
      }
      await assertUrlAllowed(q.url);
      const gate = withDeadline(o.signal, o.deadlineMs || 60_000);
      try {
        const start = await fetch(`${base}/v2/extract`, {
          method: 'POST',
          headers: headers(config.apiKey),
          signal: gate.signal,
          body: JSON.stringify({ urls: [q.url], schema: q.schema }),
        });
        if (!start.ok) throw new Error(`Firecrawl extract HTTP ${start.status}`);
        const started = (await readJson(start)) as {
          id?: string;
          data?: unknown;
          status?: string;
        };
        // Synchronous success (some proxies) — return immediately.
        if (started.data !== undefined && !started.id) return started.data;
        const jobId = started.id;
        if (!jobId) return started;
        for (;;) {
          if (gate.signal.aborted) throw new Error('extract aborted');
          const poll = await fetch(`${base}/v2/extract/${encodeURIComponent(jobId)}`, {
            headers: headers(config.apiKey),
            signal: gate.signal,
          });
          if (!poll.ok) throw new Error(`Firecrawl extract status HTTP ${poll.status}`);
          const status = (await readJson(poll)) as {
            status?: string;
            data?: unknown;
          };
          if (
            status.status === 'completed' ||
            status.status === 'done' ||
            status.status === 'succeeded'
          ) {
            return status.data ?? status;
          }
          if (status.status === 'failed' || status.status === 'cancelled') {
            throw new Error(`Firecrawl extract ${status.status}`);
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      } finally {
        gate.done();
      }
    },
  };
}
