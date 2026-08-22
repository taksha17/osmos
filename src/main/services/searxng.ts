export type SearchHit = {
  title: string;
  url: string;
  content: string;
};

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function searchSearxng(baseUrl: string, query: string): Promise<SearchHit[]> {
  const base = normalizeBase(baseUrl);
  if (!base || !query.trim()) return [];

  const endpoint = new URL('search', `${base}/`);
  endpoint.searchParams.set('q', query.trim().slice(0, 240));
  endpoint.searchParams.set('format', 'json');

  const res = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'OSMOS/0.5',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 429) {
    throw new Error('SearXNG rate-limited. For a private instance set server.limiter: false.');
  }
  if (!res.ok) {
    throw new Error(`SearXNG error ${res.status}`);
  }

  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? [])
    .map((r) => ({
      title: String(r.title || '').trim(),
      url: String(r.url || '').trim(),
      content: String(r.content || '').trim(),
    }))
    .filter((r) => r.title || r.url || r.content)
    .slice(0, 8);
}

export function formatHitsForPrompt(hits: SearchHit[], today: string): string {
  if (!hits.length) return '';
  const body = hits
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.content}`)
    .join('\n\n');
  return [
    `Authoritative device date: ${today}.`,
    'Prefer these live web snippets over training-cutoff assumptions.',
    '',
    body,
  ].join('\n');
}
