export type SearchHit = {
  title: string;
  url: string;
  content: string;
};

/**
 * Free, no-key DuckDuckGo Instant Answer + HTML lite fallback.
 * Quality is lower than Tavily/SearXNG but works out of the box.
 */
export async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 240);
  if (!q) return [];

  const hits: SearchHit[] = [];

  try {
    const endpoint = new URL('https://api.duckduckgo.com/');
    endpoint.searchParams.set('q', q);
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('no_redirect', '1');
    endpoint.searchParams.set('no_html', '1');
    endpoint.searchParams.set('skip_disambig', '1');

    const res = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'OSMOS/0.5' },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        Abstract?: string;
        AbstractText?: string;
        AbstractURL?: string;
        Heading?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const abstract = String(data.AbstractText || data.Abstract || '').trim();
      if (abstract) {
        hits.push({
          title: String(data.Heading || 'DuckDuckGo').trim() || 'Summary',
          url: String(data.AbstractURL || '').trim(),
          content: abstract,
        });
      }

      const pushTopic = (text?: string, url?: string) => {
        const title = String(text || '').trim();
        if (!title) return;
        hits.push({
          title: title.slice(0, 120),
          url: String(url || '').trim(),
          content: title,
        });
      };

      for (const r of data.Results || []) pushTopic(r.Text, r.FirstURL);
      for (const topic of data.RelatedTopics || []) {
        if (topic.Topics) {
          for (const nested of topic.Topics) pushTopic(nested.Text, nested.FirstURL);
        } else {
          pushTopic(topic.Text, topic.FirstURL);
        }
      }
    }
  } catch {
    /* fall through to HTML */
  }

  if (hits.length >= 3) return hits.slice(0, 8);

  try {
    const htmlUrl = new URL('https://html.duckduckgo.com/html/');
    htmlUrl.searchParams.set('q', q);
    const res = await fetch(htmlUrl, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'OSMOS/0.5 (desktop AI copilot)',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return hits.slice(0, 8);
    const html = await res.text();
    const re =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>)?/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) && hits.length < 8) {
      const url = decodeDuckRedirect(String(match[1] || '').trim());
      const title = stripTags(String(match[2] || '')).trim();
      const content = stripTags(String(match[3] || '')).trim();
      if (!title && !url) continue;
      hits.push({ title: title || url, url, content });
    }
  } catch {
    /* ignore */
  }

  return hits.slice(0, 8);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeDuckRedirect(href: string): string {
  try {
    if (href.includes('uddg=')) {
      const u = new URL(href, 'https://duckduckgo.com');
      const target = u.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
  } catch {
    /* ignore */
  }
  return href;
}
