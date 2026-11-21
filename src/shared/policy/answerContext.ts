/**
 * Answer context — Architecture v2 §7.2 + §8.2 glue.
 *
 * One call turns a request's inputs into the two objects the chat path needs:
 * the token-budgeted `ContextPacket` (§7.2) and the `LanePlan` (§8.2). Pure, so
 * the main-side adapter (`src/main/services/answerContext.ts`) and the bench can
 * share it, and the unit tests can pin the screen/coding heuristics.
 *
 * The only production step left is the chat handler calling the adapter: prompt
 * assembly lives inline in `src/main/index.ts` (§7 rule 1 keeps it there until the
 * handler is split), so this module is the seam, not the wiring.
 */

import type { RouteDecision } from '../lumenRoute.ts';
import { buildContextPacket, type ContextBudget, type ContextPacket } from './contextBudget.ts';
import { planLanes, type LanePlan, type RouterThresholds } from './routerV2.ts';
import type { TriggerMode, TriggerSpeaker } from './triggerPolicy.ts';

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
  hasScreen: boolean;
  hasCodeScreen: boolean;
};

/**
 * Signals that a screen is a code editor or a problem statement rather than a
 * slide or a chat (§12). Two independent hints are required, so prose that
 * happens to contain "return" is not mistaken for code.
 */
const CODE_HINTS: readonly RegExp[] = [
  /\b(function|class|interface|struct|enum)\s+\w+/i,
  /\b(const|let|var)\s+\w+\s*=/,
  /\b(def|import|from|public|private|protected|static|void)\b/,
  /=>|===|!==|[{}]\s*$/m,
  /\b(console\.log|printf|System\.out|print\()/,
  /\b(leetcode|hackerrank|codility|hackerrank)\b/i,
];

export function looksLikeCodeScreen(text?: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return CODE_HINTS.filter((pattern) => pattern.test(t)).length >= 2;
}

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

/** Build the §7.2 packet and the §8.2 lane plan for one request. */
export function buildAnswerContext(
  sources: AnswerContextSources,
  options: { budget?: ContextBudget; thresholds?: RouterThresholds } = {},
): AnswerContext {
  const screenText = (sources.screen?.ocrText ?? '').trim();
  const hasScreen = screenText.length > 0;
  const hasCodeScreen = looksLikeCodeScreen(screenText);

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
              includeImage: sources.screen.includeImage === true,
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

  return { packet, plan, hasScreen, hasCodeScreen };
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
