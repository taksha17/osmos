/**
 * Hook status strings ("🎙 starting mic…", "Listening to system audio…") are
 * rendered by the STT hooks' own UI, but they can also arrive as partial/final
 * transcript text. They must never reach the Live transcript or the answer
 * pipeline — while real speech that merely *starts* with the same word
 * ("Recording the meeting is fine") must survive.
 *
 * So match the *shape* of a status, not a bare first word: a leading status
 * emoji, or a short line that ends in an ellipsis / carries a qualifier and
 * opens with a known status verb.
 */

const STATUS_EMOJI = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
const STATUS_VERB = /^(starting|listening|waiting|transcribing|reconnecting|ocr|screen read)/i;
const LONG_STATUS = /^no laptop audio/i;
const READY_STATUS =
  /^(system audio|meeting audio|mic|microphone|audio)(?: (?:worker|stream|listener))? (?:is )?ready\b/i;

export function isSttStatusLine(text: string): boolean {
  const raw = (text || '').trim();
  if (!raw) return false;
  if (STATUS_EMOJI.test(raw) && raw.length <= 60) return true;
  const t = raw.replace(/^[^\p{L}\p{N}]+/u, '');
  // "No laptop audio — play media on THIS machine (…)" is the one long status
  // the hooks emit verbatim.
  if (LONG_STATUS.test(t)) return true;
  // Capture workers announce readiness through the same partial-text channel
  // as speech. It is a short status, not something anyone said.
  if (t.length <= 80 && READY_STATUS.test(t)) return true;
  if (t.length > 60) return false;
  const shaped = /(…|\.\.\.)\s*$/.test(t) || /\([^)]*\)/.test(t);
  return shaped && STATUS_VERB.test(t);
}
