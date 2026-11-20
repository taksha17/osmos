/**
 * Router v2 — Architecture v2, §8.2.
 *
 * Phase 0: a thin, pure wrapper over the existing v0.6 `routeDecision` that
 * exposes the shape v2 needs (an ordered lane plan instead of a single tier).
 * The decision itself is delegated unchanged, so nothing can regress before the
 * benchmark harness exists. `routerV2.test.ts` pins that parity.
 */

import {
  routeDecision,
  type RouteDecision,
  type RouteHints,
  type RouteTier,
} from '../lumenRoute.ts';

export type ContextFeatures = {
  question: string;
  mode?: RouteHints['mode'];
  hasScreen?: boolean;
  bankMatch?: boolean;
  forceTier?: RouteHints['forceTier'];
};

export type RoutePlan = {
  /** Unchanged v0.6 decision, kept so callers and status lines keep working. */
  decision: RouteDecision;
  /** Ordered lanes to try, e.g. ['fast', 'quality']. */
  tiers: RouteTier[];
  reason: string;
};

/**
 * Ordered lane plan for one request.
 *
 * A single tier today; `preferUpgrade` means "draft on the fast lane, then
 * replace with the quality lane" (§7.4), which is expressed as two tiers.
 */
export function planLanes(features: ContextFeatures): RoutePlan {
  const decision = routeDecision(features.question, {
    mode: features.mode,
    hasScreen: features.hasScreen,
    bankMatch: features.bankMatch,
    forceTier: features.forceTier,
  });

  const tiers: RouteTier[] = decision.preferUpgrade
    ? ['fast', 'quality']
    : [decision.tier];

  return { decision, tiers, reason: decision.reason };
}
