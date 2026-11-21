/**
 * Trigger policy — Architecture v2, §7.3.
 *
 * Pure decision function for "should this utterance produce an answer?".
 *
 * Phase 3 replaced the Phase 0 delegation to `shouldAutoAssist`. The trigger
 * table now follows §7.3 exactly: only a direct question (or a hotkey) answers.
 * Meeting cues become notes, the user's own speech never fires, and repeats are
 * suppressed for 10 s. `triggerPolicy.test.ts` keeps the Phase 0 corpus as a
 * deliberate-diff record, so this change is visible instead of silent.
 */

import type { TriggerReason } from '../events.ts';
import { screenTextFingerprint } from '../continuousAssist.ts';

export type TriggerSpeaker = 'me' | 'them';

/** Copilot modes the policy branches on (coding mode has its own §12 rules). */
export type TriggerMode = 'interview' | 'meeting' | 'general' | 'coding';

export type QuestionSignal = {
  isQuestion: boolean;
  /** 0..1 — rules-based confidence, per §7.3's "classifier confidence" column. */
  confidence: number;
};

/** §7.3: speculative start needs classifier confidence ≥ 0.8. */
export const SPECULATIVE_MIN_CONFIDENCE = 0.8;

/** §7.3: do not re-fire for the same utterance hash within 10 s. */
export const DUPLICATE_WINDOW_MS = 10_000;

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
  /** Copilot mode; `coding` enables the §12 screen rule. */
  mode?: TriggerMode;
  /** The attached snapshot is a code editor or problem statement (§12). */
  codingScreen?: boolean;
  /** User opted into auto-answering a stable coding screen (§7.3). */
  autoFireCodingScreen?: boolean;
  /** Hash of the last utterance that produced an answer (dedupe, §7.3). */
  lastFiredHash?: string | null;
  /** When that answer started, for the 10 s cooldown window. */
  lastFiredAtMs?: number;
  /** Reading of the orchestrator clock. */
  nowMs?: number;
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
  /** §7.3 meeting cue: add to notes, do not answer. */
  notes: boolean;
  /** Classifier confidence behind the decision (telemetry). */
  confidence: number;
};

/** Stable fingerprint of an utterance (reuses the screen-text normaliser). */
export function utteranceHash(text: string): string {
  return screenTextFingerprint(text);
}

const HIGH_STAKES_QUESTION =
  /(tell me about yourself|tell me about a time|walk me through|why do you want|why should we hire|greatest strength|greatest weakness|where do you see yourself|salary|compensation|tell us about)/i;

const QUESTION_STEM =
  /^(what|what's|how|how's|why|why's|when|where|who|whose|which|can you|could you|would you|will you|do you|did you|have you|are you|is there|are there|tell me|describe|explain|walk me through|summarize|outline|compare)\b/i;

/**
 * Rules-based question classifier (§7.3). Confidence is calibrated so that the
 * speculative threshold (0.8) admits stems and explicit questions but not a
 * mid-sentence "?" in a statement like "the queue is fine?".
 */
export function classifyQuestion(text: string): QuestionSignal {
  const t = String(text ?? '').trim();
  if (!t) return { isQuestion: false, confidence: 0 };

  if (HIGH_STAKES_QUESTION.test(t)) return { isQuestion: true, confidence: 0.95 };
  if (t.endsWith('?')) return { isQuestion: true, confidence: 0.9 };
  if (QUESTION_STEM.test(t)) return { isQuestion: true, confidence: 0.8 };
  if (/\?/.test(t)) return { isQuestion: true, confidence: 0.75 };
  return { isQuestion: false, confidence: 0.1 };
}

const MEETING_CUE_PATTERNS: readonly RegExp[] = [
  /\b(action item|next steps?|follow[ -]?up|circle back|take (that|this) offline)\b/i,
  /\b(deadline|blocker|ship(ping)? date|owner|owns)\b/i,
  /\b(we|i) (should|need to|have to|will|are going to|must)\b/i,
  /\b(let'?s|let us) (do|ship|move|start|plan|revisit|schedule|decide)\b/i,
  /\bwe (decided|agreed|settled)\b/i,
];

/** Action item, decision or ownership mention — a note, not an answer (§7.3). */
export function looksLikeMeetingCue(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return MEETING_CUE_PATTERNS.some((pattern) => pattern.test(t));
}

function isDuplicate(input: TriggerInput, hash: string): boolean {
  if (!input.lastFiredHash || input.lastFiredHash !== hash) return false;
  if (input.lastFiredAtMs === undefined || input.nowMs === undefined) return true;
  return input.nowMs - input.lastFiredAtMs < DUPLICATE_WINDOW_MS;
}

function decision(
  partial: Pick<TriggerDecision, 'fire' | 'speculative' | 'reason' | 'notes'>,
  hash: string,
  signal: QuestionSignal,
): TriggerDecision {
  return { ...partial, hash, confidence: signal.confidence };
}

/**
 * Decide whether this utterance should produce an answer.
 *
 * Order matters (§7.3): hotkeys always win, the user's own speech never fires,
 * a repeat inside the cooldown does not re-fire, and only a partial that clears
 * the confidence bar is allowed to start speculatively.
 */
export function decideTrigger(input: TriggerInput): TriggerDecision {
  const text = input.text ?? '';
  const hash = utteranceHash(text);
  const signal = classifyQuestion(text);

  if (input.hotkey || input.forceAssist) {
    return decision({ fire: true, speculative: false, reason: 'hotkey', notes: false }, hash, signal);
  }

  if (input.channel === 'me') {
    return decision(
      { fire: false, speculative: false, reason: 'self-speech', notes: false },
      hash,
      signal,
    );
  }

  if (isDuplicate(input, hash)) {
    return decision(
      { fire: false, speculative: false, reason: 'duplicate', notes: false },
      hash,
      signal,
    );
  }

  if (input.smartMode === false) {
    return decision(
      { fire: false, speculative: false, reason: 'no-trigger', notes: false },
      hash,
      signal,
    );
  }

  if (input.isFinal === false) {
    if (signal.isQuestion && signal.confidence >= SPECULATIVE_MIN_CONFIDENCE) {
      return decision(
        { fire: true, speculative: true, reason: 'speculative', notes: false },
        hash,
        signal,
      );
    }
    return decision(
      { fire: false, speculative: false, reason: 'no-trigger', notes: false },
      hash,
      signal,
    );
  }

  if (signal.isQuestion) {
    return decision(
      { fire: true, speculative: false, reason: 'direct-question', notes: false },
      hash,
      signal,
    );
  }

  // §7.3 coding/problem screen: offer by default, auto-fire only when the user
  // enabled it for coding mode.
  if (input.codingScreen) {
    const autoFire = input.mode === 'coding' && input.autoFireCodingScreen === true;
    return decision(
      { fire: autoFire, speculative: false, reason: 'coding-screen', notes: !autoFire },
      hash,
      signal,
    );
  }

  if (looksLikeMeetingCue(text)) {
    return decision(
      { fire: false, speculative: false, reason: 'meeting-cue', notes: true },
      hash,
      signal,
    );
  }

  return decision(
    { fire: false, speculative: false, reason: 'no-trigger', notes: false },
    hash,
    signal,
  );
}
