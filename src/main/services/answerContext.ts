/**
 * Main-side adapter for the Phase 3 answer context (§7.2 packet + §8.2 lane plan).
 *
 * `buildAnswerContext` is pure and unit-tested; this file only maps `AppSettings`
 * onto it. The chat handler in `src/main/index.ts` calls `answerContextForChat`
 * and uses `plan.primary` for routing and `packet` for the prompt sections.
 *
 * It is deliberately not called yet: prompt assembly is still inline in that file,
 * which currently carries unrelated uncommitted work. Wiring is two lines:
 *
 *   const ctx = answerContextForChat(s, message, screen);
 *   // then route on ctx.plan.primary and read ctx.packet instead of re-clipping.
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
): AnswerContext {
  const active = activeSavedProfile(settings.profiles, settings.activeProfileId);
  const profile = settings.profile;
  const screenText = (screen?.text ?? '').trim();

  return buildAnswerContext({
    mode: settings.activeMode || 'general',
    question: message,
    ...(screenText
      ? { screen: { snapshotId: `screen-${screen?.at ?? 0}`, ocrText: screenText } }
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
