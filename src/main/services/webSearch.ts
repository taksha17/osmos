import type { AppSettings, WebSearchProvider } from '../../shared/types.js';
import { searchDuckDuckGo } from './duckduckgo.js';
import { formatHitsForPrompt, searchSearxng, type SearchHit } from './searxng.js';
import { searchTavily } from './tavily.js';

export type { SearchHit };
export { formatHitsForPrompt };

export function resolveWebSearchProvider(settings: AppSettings): WebSearchProvider {
  if (settings.webSearchProvider) return settings.webSearchProvider;
  if (settings.useWebSearch === false) return 'off';
  return 'duckduckgo';
}

export function webSearchEnabled(settings: AppSettings): boolean {
  return resolveWebSearchProvider(settings) !== 'off';
}

export function webSearchLabel(provider: WebSearchProvider): string {
  switch (provider) {
    case 'off':
      return 'Off';
    case 'duckduckgo':
      return 'DuckDuckGo';
    case 'tavily':
      return 'Tavily';
    case 'searxng':
      return 'SearXNG';
    default:
      return provider;
  }
}

export async function searchWeb(settings: AppSettings, query: string): Promise<SearchHit[]> {
  const provider = resolveWebSearchProvider(settings);
  if (provider === 'off') return [];

  if (provider === 'tavily') {
    if (!settings.tavilyApiKey?.trim()) {
      throw new Error('Add a Tavily API key in Settings → Web, or switch to DuckDuckGo (free).');
    }
    return searchTavily(settings.tavilyApiKey, query);
  }

  if (provider === 'searxng') {
    if (!settings.searxngBaseUrl?.trim()) {
      throw new Error('Set a SearXNG URL in Settings → Web, or switch to DuckDuckGo (free).');
    }
    return searchSearxng(settings.searxngBaseUrl, query);
  }

  return searchDuckDuckGo(query);
}

export async function testWebSearch(
  settings: AppSettings,
  override?: Partial<Pick<AppSettings, 'webSearchProvider' | 'tavilyApiKey' | 'searxngBaseUrl'>>,
): Promise<{ ok: boolean; provider: WebSearchProvider; resultCount?: number; error?: string }> {
  const merged: AppSettings = { ...settings, ...override };
  const provider = resolveWebSearchProvider(merged);
  if (provider === 'off') {
    return { ok: true, provider, resultCount: 0 };
  }
  try {
    const hits = await searchWeb(merged, 'osmos connectivity test');
    return { ok: true, provider, resultCount: hits.length };
  } catch (e) {
    return {
      ok: false,
      provider,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
