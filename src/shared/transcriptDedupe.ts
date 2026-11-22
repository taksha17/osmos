/**
 * Smart-mode transcription can deliver the same speech twice: fixed-size
 * chunks and the VAD utterance path can both finish for one question. It also
 * delivers growing prefixes ("Tell me…" then the full sentence) when a chunk
 * ends before endpointing. Keep the Live pane and the orchestrator to one
 * final entry without hiding a genuinely new question later.
 */

export const FINAL_DUPLICATE_WINDOW_MS = 15_000;

export type RecentFinal = {
  text: string;
  at: number;
};

export type FinalDecision =
  | { action: 'add'; text: string }
  | { action: 'replace'; text: string }
  | { action: 'skip' };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide what to do with a final transcript for a single channel.
 *
 * - exact repeat within the window → skip
 * - a longer version of the previous partial → replace it in place
 * - a shorter prefix of the previous final → skip
 * - anything later than the window (or a different question) → add
 */
export function reconcileFinalTranscript(
  previous: RecentFinal | null | undefined,
  incoming: string,
  nowMs: number,
  windowMs = FINAL_DUPLICATE_WINDOW_MS,
): FinalDecision {
  const text = incoming.trim();
  if (!text) return { action: 'skip' };
  if (!previous?.text || nowMs - previous.at > windowMs || nowMs < previous.at) {
    return { action: 'add', text };
  }

  const prev = normalize(previous.text);
  const next = normalize(text);
  if (!prev || !next) return { action: 'add', text };
  if (prev === next) return { action: 'skip' };
  if (next.startsWith(`${prev} `)) return { action: 'replace', text };
  if (prev.startsWith(`${next} `)) return { action: 'skip' };
  return { action: 'add', text };
}
