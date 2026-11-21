/**
 * Main-side adapter for the Phase 3 answer context (§7.2 packet + §8.2 lane plan).
 *
 * `buildAnswerContext` is pure and unit-tested; this file only maps `AppSettings`
 * onto it. The chat handler in `src/main/index.ts` calls `answerContextForChat`
 * and uses `plan.primary` for routing and `packet` for the prompt sections.
 *
 * Called from `buildChatContext` (which already resolves the question bank and the
 * screen), so both chat handlers route on `routeDecisionFor(context.plan)` and the
 * packet's code-screen flag reaches the prompt.
 */

import type { AppSettings } from '../../shared/types.js';
import { activeSavedProfile } from '../../shared/profiles.js';
import { buildAnswerContext, type AnswerContext } from '../../shared/policy/answerContext.js';

export type ChatScreenSource = { text?: string; at?: number };

/** Settings + request → the packet and lane plan for one answer. */
export function answerContextForChat(
  settings: AppSettings,
  message: string,
  screen?: ChatScreenSource,
  hints: {
    bankMatch?: boolean;
    visionAvailable?: boolean;
    /** §12 coding mode: earlier snapshots of the same session, oldest first. */
    previousSnapshots?: ReadonlyArray<{ at: number; kind?: string; ocrText: string }>;
    /** Phase 5: ranked memories for this question, best first. */
    memory?: ReadonlyArray<{ id: string; kind: string; at: number; text: string; score: number }>;
  } = {},
): AnswerContext {
  const active = activeSavedProfile(settings.profiles, settings.activeProfileId);
  const profile = settings.profile;
  const screenText = (screen?.text ?? '').trim();

  return buildAnswerContext({
    mode: settings.activeMode || 'general',
    question: message,
    // The bank entry itself reaches the prompt from `buildChatContext`; the packet
    // only needs to know the question was anticipated (§8.2 routing hint).
    ...(hints.bankMatch ? { bankMatch: { questionId: 'active-bank', answer: '', score: 1 } } : {}),
    ...(hints.visionAvailable === undefined ? {} : { visionAvailable: hints.visionAvailable }),
    ...(hints.memory?.length ? { memory: hints.memory } : {}),
    ...(screenText
      ? {
          screen: {
            snapshotId: `screen-${screen?.at ?? 0}`,
            ocrText: screenText,
            ...(hints.previousSnapshots?.length
              ? { previous: hints.previousSnapshots }
              : {}),
          },
        }
      : {}),
    ...(profile
      ? {
          profile: {
            resume: profile.resumeText,
            jd: profile.jdText,
            companyIntel: active.companyIntel,
          },
        }
      : {}),
  });
}
