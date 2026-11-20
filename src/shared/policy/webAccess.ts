/**
 * Web access routing — Architecture v3, §4.3.
 *
 * Pure selection over provider descriptors, so the rules are unit-testable and
 * the Web Access Manager only has to do I/O. Nothing here performs a request.
 *
 * Rules:
 *   1. A provider must declare the capability being asked for.
 *   2. `local-only` never falls through to a cloud tier — it reports the gap.
 *   3. Search keeps the existing user-facing order (T0 first: SearXNG → DDG →
 *      Tavily), while fetch/crawl/map prefer a local Firecrawl tier.
 *   4. Unhealthy providers lose to healthy ones; a provider that has not been
 *      probed yet (`healthy: undefined`) is still eligible.
 */

import type { WebCapability, WebPrivacy, WebTier } from '../contracts/web.ts';

export type WebProviderDescriptor = {
  id: string;
  tier: WebTier;
  capabilities: readonly WebCapability[];
  local: boolean;
  /** Lower runs first within a tier (e.g. SearXNG before DuckDuckGo). */
  priority?: number;
  /** `false` when a health probe failed recently; `undefined` = unknown. */
  healthy?: boolean;
};

export type WebSelectRequest = {
  capability: WebCapability;
  privacy?: WebPrivacy;
};

export type WebSelectResult =
  | { providerId: string; tier: WebTier; local: boolean; reason: string }
  | { providerId: null; reason: string };

/** Tier preference per capability (§4.3). */
const TIER_ORDER: Record<WebCapability, WebTier[]> = {
  search: ['T0', 'T1', 'T2', 'T3'],
  scrape: ['T1', 'T2', 'T3', 'T0'],
  crawl: ['T1', 'T2', 'T3'],
  map: ['T1', 'T2', 'T3'],
  extract: ['T2', 'T3'],
};

export function tierOrderFor(capability: WebCapability): WebTier[] {
  return [...TIER_ORDER[capability]];
}

function tierRank(capability: WebCapability, tier: WebTier): number {
  const rank = TIER_ORDER[capability].indexOf(tier);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * Pick the provider that should serve `capability`, or report why none can.
 * `local-first` prefers a local provider but may fall through; `cloud` treats
 * every tier equally.
 */
export function chooseWebProvider(
  descriptors: readonly WebProviderDescriptor[],
  req: WebSelectRequest,
): WebSelectResult {
  const privacy: WebPrivacy = req.privacy ?? 'local-first';
  const eligible = descriptors.filter((d) => d.capabilities.includes(req.capability));

  if (eligible.length === 0) {
    return { providerId: null, reason: `no provider supports ${req.capability}` };
  }

  const allowed = privacy === 'local-only' ? eligible.filter((d) => d.local) : eligible;
  if (allowed.length === 0) {
    return {
      providerId: null,
      reason: `no local provider supports ${req.capability} (local-only privacy)`,
    };
  }

  const ranked = [...allowed].sort((a, b) => {
    const rank = tierRank(req.capability, a.tier) - tierRank(req.capability, b.tier);
    if (rank !== 0) return rank;

    const health = Number(a.healthy === false) - Number(b.healthy === false);
    if (health !== 0) return health;

    if (privacy === 'local-first') {
      const locality = Number(b.local) - Number(a.local);
      if (locality !== 0) return locality;
    }

    const priority = (a.priority ?? 0) - (b.priority ?? 0);
    if (priority !== 0) return priority;

    return a.id.localeCompare(b.id);
  });

  const winner = ranked[0];
  const locality = winner.local ? 'local' : 'remote';
  return {
    providerId: winner.id,
    tier: winner.tier,
    local: winner.local,
    reason: `${winner.tier} ${locality} provider for ${req.capability}`,
  };
}
