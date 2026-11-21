/**
 * Answer context — Architecture v2 §7.2 + §8.2 glue.
 *
 * One call turns a request's inputs into the objects the chat path needs: the
 * token-budgeted `ContextPacket` (§7.2), the `LanePlan` (§8.2) and the §12 screen
 * snapshot classification. Pure, so the main-side adapter
 * (`src/main/services/answerContext.ts`) and the bench can share it, and the unit
 * tests can pin the screen heuristics.
 *
 * Prompt assembly lives inline in `src/main/index.ts` (§7 rule 1), so this module
 * is the seam: the handler asks it for the decision, the packet and the hint.
 */

import type { RouteDecision } from '../lumenRoute.ts';
import { buildContextPacket, type ContextBudget, type ContextPacket } from './contextBudget.ts';
import { planLanes, type LanePlan, type RouterThresholds } from './routerV2.ts';
import { classifySnapshot, type SnapshotClassification } from './screenSnapshot.ts';
import type { TriggerMode, TriggerSpeaker } from './triggerPolicy.ts';

export { classifySnapshot, looksLikeCodeScreen } from './screenSnapshot.ts';

export type AnswerContextSources = {
  mode: TriggerMode;
  question: string;
  channel?: TriggerSpeaker;
  isFinal?: boolean;
  transcript?: ReadonlyArray<{ who: string; text: string }>;
  screen?: { snapshotId: string; ocrText?: string; includeImage?: boolean };
  profile?: { resume?: string; jd?: string; companyIntel?: string };
  bankMatch?: { questionId: string; answer: string; score: number };
  retrieved?: ReadonlyArray<{ source: string; text: string; score: number }>;
  /** False when no configured lane accepts images (§6.4). Defaults to true. */
  visionAvailable?: boolean;
};

export type AnswerContext = {
  packet: ContextPacket;
  plan: LanePlan;
  /** §12: what is on the screen, and the prompt line that follows from it. */
  snapshot: SnapshotClassification;
  /** True when the snapshot was classified as code (§12 hard rule). */
  hasCodeScreen: boolean;
  hasScreen: boolean;
  /** §6.4: the lane takes images and the text is not enough, so send the picture too. */
  attachImage: boolean;
};

/**
 * Split a résumé/JD blob into the fact list the packet carries (§7.2's
 * `resumeFacts`). Lines and bullets first, then sentences; long blobs are capped
 * because the packet budgets by fact.
 */
export function splitFacts(text: string | undefined, max = 60): string[] {
  const blob = (text ?? '').trim();
  if (!blob) return [];
  const facts: string[] = [];
  for (const part of blob.split(/\r?\n|(?<=[.!?])\s+/)) {
    const cleaned = part.replace(/^[\s•*\-–—\d.)]+/, '').trim();
    if (cleaned.length < 3) continue;
    facts.push(cleaned);
    if (facts.length >= max) break;
  }
  return facts;
}

/** Build the §7.2 packet, the §8.2 lane plan and the §12 snapshot for one request. */
export function buildAnswerContext(
  sources: AnswerContextSources,
  options: { budget?: ContextBudget; thresholds?: RouterThresholds } = {},
): AnswerContext {
  const screenText = (sources.screen?.ocrText ?? '').trim();
  const hasScreen = screenText.length > 0;
  const snapshot = classifySnapshot(screenText);
  const hasCodeScreen = snapshot.kind === 'code';

  const plan = planLanes(
    {
      question: sources.question,
      // `coding` is not a route hint; §12 handles it through the code-screen rule.
      mode: sources.mode === 'coding' ? undefined : sources.mode,
      hasScreen,
      bankMatch: Boolean(sources.bankMatch),
      hasCodeScreen,
      visionAvailable: sources.visionAvailable,
    },
    { thresholds: options.thresholds },
  );

  // §6.4: a code/problem snapshot goes to the vision lane; when that lane exists
  // the image travels with the request, otherwise the OCR text is the whole answer.
  const attachImage = hasScreen && plan.requiresVision && !plan.visionFallback;

  const packet = buildContextPacket(
    {
      mode: sources.mode,
      question: {
        text: sources.question,
        speaker: sources.channel === 'me' ? 'me' : 'them',
        isFinal: sources.isFinal !== false,
      },
      transcript: sources.transcript,
      ...(hasScreen && sources.screen
        ? {
            screen: {
              snapshotId: sources.screen.snapshotId,
              includeImage: attachImage,
              ocrText: screenText,
            },
          }
        : {}),
      ...(sources.profile
        ? {
            profile: {
              resumeFacts: splitFacts(sources.profile.resume),
              jdFacts: splitFacts(sources.profile.jd),
              companyIntel: sources.profile.companyIntel,
            },
          }
        : {}),
      ...(sources.bankMatch ? { bankMatch: sources.bankMatch } : {}),
      ...(sources.retrieved ? { retrieved: sources.retrieved } : {}),
    },
    options.budget,
  );

  return { packet, plan, snapshot, hasScreen, hasCodeScreen, attachImage };
}

/**
 * The decision the provider planner consumes (`planHybridLanes`), with §8.2's hard
 * rule applied: a code or problem snapshot is never answered by the fast lane, so
 * the lane that starts the request is the vision-capable quality one.
 *
 * Only vision overrides the v0.6 decision. Everything else is returned untouched,
 * so draft-then-upgrade keeps behaving exactly as it does today; the plan's own
 * `primary` describes the lane that streams, which is not always the decision's
 * tier (a draft starts on fast and is replaced).
 */
export function routeDecisionFor(plan: LanePlan): RouteDecision {
  if (plan.requiresVision && !plan.visionFallback && plan.decision.tier !== 'quality') {
    return { tier: 'quality', reason: plan.reason, preferUpgrade: false };
  }
  return plan.decision;
}
