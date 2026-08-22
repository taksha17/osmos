import type { SearchHit } from './searxng.js';

/**
 * Tavily Search API — easy cloud path (paste API key, no self-hosting).
 * https://docs.tavily.com/
 */
export async function searchTavily(apiKey: string, query: string): Promise<SearchHit[]> {
  const key = apiKey.trim();
  const q = query.trim().slice(0, 400);
  if (!key || !q) return [];

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      api_key: key,
      query: q,
      search_depth: 'basic',
      include_answer: false,
      max_results: 8,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily error ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
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
