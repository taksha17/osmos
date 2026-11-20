/**
 * Web Access Manager (WAM) — Architecture v3, §4.1.
 *
 * Owns the provider registry, health checks and capability routing. Main-process
 * only; the renderer never talks to a provider directly.
 *
 * Phase W0 scope: register the built-in (T0) provider, expose the health and
 * selection surface, and keep the existing chat path untouched — the chat path
 * still calls `searchWeb()` from `buildChatContext()`. Wiring the context engine
 * through the WAM lands in W1 together with the Firecrawl adapter and URL guard.
 */

import type { AppSettings } from '../../shared/types.js';
import type {
  SearchHit,
  WebAccessProvider,
  WebCapability,
  WebHealth,
  WebPrivacy,
} from '../../shared/contracts/web.js';
import {
  chooseWebProvider,
  type WebProviderDescriptor,
  type WebSelectResult,
} from '../../shared/policy/webAccess.js';
import { builtinWebProvider } from '../providers/web/builtin.js';

export type RegisteredWebProvider = {
  provider: WebAccessProvider;
  priority: number;
  /** Result of the last probe; undefined until probed. */
  health?: WebHealth;
  probedAt?: number;
};

const HEALTH_TTL_MS = 60_000;

const registry = new Map<string, RegisteredWebProvider>();

/** Replace the registry with the built-in provider for these settings. */
export function resetWebProviders(settings: AppSettings): void {
  registry.clear();
  registerWebProvider(builtinWebProvider(settings), 0);
}

export function registerWebProvider(provider: WebAccessProvider, priority = 0): void {
  registry.set(provider.id, { provider, priority });
}

export function listWebProviders(): RegisteredWebProvider[] {
  return [...registry.values()];
}

/** Descriptors for the pure chooser, with cached health folded in. */
export function webProviderDescriptors(): WebProviderDescriptor[] {
  return [...registry.values()].map(({ provider, priority, health }) => ({
    id: provider.id,
    tier: provider.tier,
    capabilities: [...provider.capabilities],
    local: provider.local,
    priority,
    healthy: health?.ok,
  }));
}

export function chooseWebProviderFor(
  capability: WebCapability,
  privacy?: WebPrivacy,
): WebSelectResult {
  return chooseWebProvider(webProviderDescriptors(), { capability, privacy });
}

/**
 * Probe every registered provider, refreshing cached health. Concurrent probes
 * are capped implicitly by the registry size (T0 + one Firecrawl tier today).
 */
export async function probeWebProviders(now = Date.now()): Promise<RegisteredWebProvider[]> {
  const results = await Promise.all(
    [...registry.values()].map(async (entry) => {
      if (entry.health && entry.probedAt !== undefined && now - entry.probedAt < HEALTH_TTL_MS) {
        return entry;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const health = await entry.provider.health(controller.signal);
        return { ...entry, health, probedAt: now };
      } catch (error) {
        const health: WebHealth = {
          ok: false,
          latencyMs: 0,
          detail: error instanceof Error ? error.message : String(error),
        };
        return { ...entry, health, probedAt: now };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  for (const entry of results) registry.set(entry.provider.id, entry);
  return results;
}

/**
 * Search through the best available provider. Returns `[]` instead of throwing
 * when the chosen provider errors, so a web failure can never break an answer
 * (§4.3 "respect locality, show provenance, degrade").
 */
export async function webSearchVia(
  query: string,
  opts: { privacy?: WebPrivacy; limit?: number } = {},
): Promise<{ hits: SearchHit[]; providerId: string | null; error?: string }> {
  const choice = chooseWebProviderFor('search', opts.privacy);
  if (!choice.providerId) return { hits: [], providerId: null, error: choice.reason };

  const entry = registry.get(choice.providerId);
  if (!entry?.provider.search) {
    return { hits: [], providerId: choice.providerId, error: 'chosen provider cannot search' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const hits = await entry.provider.search(
      { query, limit: opts.limit },
      { signal: controller.signal, deadlineMs: 12_000, purpose: 'live-assist' },
    );
    return { hits, providerId: choice.providerId };
  } catch (error) {
    return {
      hits: [],
      providerId: choice.providerId,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function webAccessStatus(): string {
  const entries = [...registry.values()];
  if (entries.length === 0) return 'Web: off';
  const local = entries.filter((e) => e.provider.local).length;
  const down = entries.filter((e) => e.health && !e.health.ok).length;
  if (down === entries.length) return 'Web: degraded';
  return local > 0 ? 'Web: local ✓' : 'Web: cloud';
}
