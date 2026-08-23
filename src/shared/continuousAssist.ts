import type { CopilotMode } from './types';

/** Heuristic: does this utterance look like a question or prompt for a reply? */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  return /^(what|how|why|when|where|who|which|can you|could you|would you|tell me|describe|explain|walk me through|do you|have you|is there|are there)\b/i.test(
    t,
  );
}

/** Whether Smart mode should auto-trigger an assist for this transcript chunk. */
export function shouldAutoAssist(text: string, smartMode: boolean): boolean {
  const t = text.trim();
  if (!t || t.length < 6) return false;
  if (!smartMode) return false;
  return looksLikeQuestion(t) || t.length >= 36;
}

/** Build the LLM prompt for a live audio chunk in continuous assist mode. */
export function continuousAssistPrompt(transcript: string, activeMode: CopilotMode): string {
  const ctx =
    activeMode === 'interview'
      ? 'Live interview audio'
      : activeMode === 'meeting'
        ? 'Live meeting audio'
        : 'Live conversation audio';

  if (looksLikeQuestion(transcript)) {
    return `${ctx} picked up:\n"${transcript}"\n\nWhat should I say in response? Give a concise, natural, speakable answer.`;
  }

  return `${ctx} picked up:\n"${transcript}"\n\nBriefly assist — suggest a response or key points if the speaker seems to expect one.`;
}

/** Prompt when continuous screen OCR finds new on-screen text. */
export function continuousScreenPrompt(screenText: string, activeMode: CopilotMode): string {
  const clipped = screenText.trim().slice(0, 3500);
  const ctx =
    activeMode === 'interview'
      ? 'interview'
      : activeMode === 'meeting'
        ? 'meeting'
        : 'session';

  return [
    `Live screen OCR from the current ${ctx} (text visible on screen):`,
    '---',
    clipped,
    '---',
    'Help me respond based on what is on screen. Be concise and speakable. If this looks like a coding/problem question, outline the approach and a short answer I can say aloud.',
  ].join('\n');
}

/** Simple stable fingerprint so unchanged screen text does not re-trigger assist. */
export function screenTextFingerprint(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 1200);
  let h = 0;
  for (let i = 0; i < normalized.length; i++) {
    h = (Math.imul(31, h) + normalized.charCodeAt(i)) | 0;
  }
  return `${normalized.length}:${h}`;
}

export const CONTINUOUS_CHUNK_MS = 6000;

/** How often Smart mode silently re-reads the screen (OCR). */
export const CONTINUOUS_SCREEN_MS = 10_000;

/** Allow one extra capture to start while a prior chunk is still transcribing. */
export const CONTINUOUS_MAX_IN_FLIGHT = 2;
