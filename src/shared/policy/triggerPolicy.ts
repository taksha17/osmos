/**
 * Trigger policy — Architecture v2, §7.3.
 *
 * Phase 0: a pure function whose decision delegates to the existing
 * `shouldAutoAssist` heuristic, so swapping call sites is behaviour-neutral.
 * Phase 3 replaces the body with the full trigger table (speaker channel,
 * classifier confidence, cooldown) behind the parity corpus in
 * `triggerPolicy.test.ts`.
 */

import type { TriggerReason } from '../events.ts';
import { looksLikeQuestion, screenTextFingerprint, shouldAutoAssist } from '../continuousAssist.ts';

export type TriggerSpeaker = 'me' | 'them';

export type TriggerInput = {
  text: string;
  /** Speaker attribution (§5.4 level 1). Defaults to the remote participant. */
  channel?: TriggerSpeaker;
  /** Smart / continuous listen. Off means only hotkeys can fire. */
  smartMode?: boolean;
  /** Fresh screen OCR exists — reserved for the §7.3 screen rule. */
  hasScreen?: boolean;
  /** False while the utterance is still a partial (§7.4 speculative start). */
  isFinal?: boolean;
  /** Assist hotkey — always fires, even with empty context. */
  hotkey?: boolean;
  /** Overlay "What should I say?" button. */
  forceAssist?: boolean;
  /** Hash of the last utterance that produced an answer (dedupe, §7.3). */
  lastFiredHash?: string | null;
};

export type TriggerOutcome =
  | TriggerReason
  | 'self-speech'
  | 'duplicate'
  | 'no-trigger';

export type TriggerDecision = {
  fire: boolean;
  /** True when generation may start on a partial and reconcile later. */
  speculative: boolean;
  reason: TriggerOutcome;
  /** Stable fingerprint of the utterance, for cooldown bookkeeping. */
  hash: string;
};

/** Stable fingerprint of an utterance (reuses the screen-text normaliser). */
export function utteranceHash(text: string): string {
  return screenTextFingerprint(text);
}

/**
 * Decide whether this utterance should produce an answer.
 *
 * Order matters: hotkeys always win, the user's own speech never fires, and an
 * identical utterance is not re-answered.
 */
export function decideTrigger(input: TriggerInput): TriggerDecision {
  const text = input.text ?? '';
  const hash = utteranceHash(text);

  if (input.hotkey || input.forceAssist) {
    return { fire: true, speculative: false, reason: 'hotkey', hash };
  }

  if (input.channel === 'me') {
    return { fire: false, speculative: false, reason: 'self-speech', hash };
  }

  if (input.lastFiredHash && input.lastFiredHash === hash) {
    return { fire: false, speculative: false, reason: 'duplicate', hash };
  }

  if (!shouldAutoAssist(text, input.smartMode !== false)) {
    return { fire: false, speculative: false, reason: 'no-trigger', hash };
  }

  return {
    fire: true,
    speculative: input.isFinal === false,
    reason: looksLikeQuestion(text) ? 'direct-question' : 'meeting-cue',
    hash,
  };
}
