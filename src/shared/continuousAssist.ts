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
  return fusedAssistPrompt({ transcript, activeMode });
}

/** Prompt when continuous / on-demand screen OCR finds new on-screen text. */
export function continuousScreenPrompt(screenText: string, activeMode: CopilotMode): string {
  return fusedAssistPrompt({ screenText, activeMode });
}

/**
 * Fuse live transcript + optional fresh screen OCR into one assist prompt
 * (Natively-style context packet idea — original OSMOS wording).
 */
export function fusedAssistPrompt(opts: {
  transcript?: string;
  screenText?: string;
  activeMode: CopilotMode;
}): string {
  const mode = opts.activeMode;
  const ctx =
    mode === 'interview' ? 'interview' : mode === 'meeting' ? 'meeting' : 'session';
  const transcript = (opts.transcript || '').trim();
  const screen = (opts.screenText || '').trim().slice(0, 3500);
  const parts: string[] = [`Live ${ctx} assist. Be concise and speakable.`];

  if (transcript) {
    parts.push('', 'Audio transcript:', `"${transcript}"`);
  }
  if (screen) {
    parts.push('', 'On-screen text (OCR):', '---', screen, '---');
  }

  if (transcript && looksLikeQuestion(transcript)) {
    parts.push('', 'What should I say in response?');
  } else if (screen && looksLikeQuestion(screen)) {
    parts.push(
      '',
      'The screen looks like a question or problem. Outline a short spoken answer or approach.',
    );
  } else {
    parts.push('', 'Suggest a response or key points if a reply seems expected.');
  }

  return parts.join('\n');
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

/** How long on-demand screen OCR stays "fresh" for fusion with audio assists. */
export const SCREEN_CONTEXT_FRESH_MS = 45_000;

export const CONTINUOUS_CHUNK_MS = 6000;

/** How often optional loop-safe screen OCR may run (never via Wayland portal loop). */
export const CONTINUOUS_SCREEN_MS = 2_500;

/** Allow one extra capture to start while a prior chunk is still transcribing. */
export const CONTINUOUS_MAX_IN_FLIGHT = 2;
