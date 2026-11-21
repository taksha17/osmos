/**
 * Router v2 — Architecture v2, §8.2.
 *
 * Phase 0 kept a thin wrapper over the v0.6 `routeDecision` so nothing could
 * regress before the harness existed. Phase 3 adds what §8.2 asks for on top of
 * that same decision:
 *
 * - **Hard rules** that always hold (a code/problem snapshot needs a vision lane;
 *   with no vision model the answer is built from OCR text).
 * - **Benchmarked thresholds**: the "easy question goes local" boundary is an
 *   explicit input (`RouterThresholds.easyMaxWords`) instead of a constant, so a
 *   measured value can replace `EASY_MAX_WORDS` without touching this file.
 * - **Fallback chain**: every plan ends with the quality lane, and a lane that
 *   misses `firstTokenBudgetMs` hands over to the next one.
 *
 * `decision` is still the untouched v0.6 result, so call sites, status lines and
 * the parity tests keep working while the plan gains the v2 behaviour.
 */

import {
  EASY_MAX_WORDS,
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
  /** Snapshot/OCR classified as code or a problem statement (§12). */
  hasCodeScreen?: boolean;
  /** Whether any configured lane can accept images (§6.4). Defaults to true. */
  visionAvailable?: boolean;
};

export type RouterThresholds = {
  /** Word count at or below which a low-stakes question may answer locally. */
  easyMaxWords: number;
};

/** v0.6's `EASY_MAX_WORDS` stays the default until a benchmark replaces it. */
export const DEFAULT_ROUTER_THRESHOLDS: RouterThresholds = { easyMaxWords: EASY_MAX_WORDS };

/** §8.2: a lane that has produced no first token by now is abandoned. */
export const FIRST_TOKEN_BUDGET_MS = 2500;

export type LanePlan = {
  /** Unchanged v0.6 decision, kept so callers and status lines keep working. */
  decision: RouteDecision;
  /** Ordered lanes to try, e.g. ['fast', 'quality'] — last entry is the fallback. */
  tiers: RouteTier[];
  /** The lane that starts the request. */
  primary: RouteTier;
  reason: string;
  /** Hard rule: the request needs a vision-capable lane. */
  requiresVision: boolean;
  /** Hard rule failed: no vision model is configured, so OCR text is used. */
  visionFallback: boolean;
  firstTokenBudgetMs: number;
};

export type PlanOptions = {
  thresholds?: RouterThresholds;
};

/**
 * Pick the "easy question" boundary from eval accuracy (§8.2 rule 2).
 *
 * `observations` record, per evaluated question, how long it was and whether the
 * fast lane answered it correctly. Raising the boundary sends more questions to
 * the fast lane, so the measured boundary is the largest one that no incorrect
 * fast answer sits below. With no observations, or with the fast lane wrong on
 * the shortest question, the v0.6 default is kept rather than guessed.
 */
export function pickEasyMaxWords(
  observations: ReadonlyArray<{ words: number; fastCorrect: boolean }>,
  fallback: number = EASY_MAX_WORDS,
): number {
  if (!observations.length) return fallback;

  const sorted = [...observations].sort((a, b) => a.words - b.words);
  let boundary = 0;
  for (const observation of sorted) {
    if (!observation.fastCorrect) break;
    boundary = observation.words;
  }
  return boundary > 0 ? boundary : fallback;
}

/** Ordered lane plan for one request (§8.2). */
export function planLanes(features: ContextFeatures, options: PlanOptions = {}): LanePlan {
  const thresholds = options.thresholds ?? DEFAULT_ROUTER_THRESHOLDS;
  const decision = routeDecision(
    features.question,
    {
      mode: features.mode,
      hasScreen: features.hasScreen,
      bankMatch: features.bankMatch,
      forceTier: features.forceTier,
    },
    { easyMaxWords: thresholds.easyMaxWords },
  );

  const requiresVision = features.hasCodeScreen === true;
  const visionFallback = requiresVision && features.visionAvailable === false;

  // Hard rule (§8.2, §12): a problem statement or code snapshot is never answered
  // by the fast lane — it goes to the vision-capable quality lane.
  let primary: RouteTier = decision.tier;
  if (requiresVision && !visionFallback) primary = 'quality';
  // §7.4 draft-then-upgrade: the draft starts on the fast lane and is replaced by
  // the quality answer, so the fast lane is the lane that begins the request.
  else if (decision.preferUpgrade && !features.forceTier && primary !== 'fast') primary = 'fast';

  const tiers: RouteTier[] = [primary];
  // §7.4: draft-then-upgrade when the decision wants quality on top of a draft.
  if (decision.preferUpgrade && !features.forceTier && !tiers.includes('quality')) {
    tiers.push('quality');
  }
  // §8.2 fallback chain: a timeout or error moves on to the quality lane.
  if (!tiers.includes('quality')) tiers.push('quality');

  const reason = visionFallback
    ? `${decision.reason}; no vision lane configured, OCR text only`
    : requiresVision
      ? `${decision.reason}; vision lane required`
      : decision.reason;

  return {
    decision,
    tiers,
    primary,
    reason,
    requiresVision,
    visionFallback,
    firstTokenBudgetMs: FIRST_TOKEN_BUDGET_MS,
  };
}

/** The lane to try after `from`, or null when the chain is exhausted (§8.2). */
export function nextLane(plan: LanePlan, from: RouteTier): RouteTier | null {
  const index = plan.tiers.indexOf(from);
  if (index < 0) {
    // A lane outside the plan still falls back to the chain's last entry.
    const last = plan.tiers[plan.tiers.length - 1];
    return last && last !== from ? last : null;
  }
  return plan.tiers[index + 1] ?? null;
}
