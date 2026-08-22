import type { TranscribeRequest, TranscribeResponse } from '../../shared/types.js';
import { getSettings } from './settingsStore.js';

/**
 * Transcribe an audio blob via OpenAI-compatible Whisper endpoint.
 * Works with api.openai.com and many compatible proxies.
 */
export async function transcribeWithWhisper(
  req: TranscribeRequest,
): Promise<TranscribeResponse> {
  const s = getSettings();
  const key = (s.openaiApiKey || '').trim();
  if (!key) {
    return { ok: false, error: 'Add an OpenAI API key in Settings for Whisper STT.' };
  }

  const base = (s.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const bytes = Buffer.from(req.base64, 'base64');
  const mime = req.mimeType || 'audio/webm';
  const fileName = req.fileName || `speech.${mime.includes('mp4') ? 'mp4' : 'webm'}`;

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName);
  form.append('model', s.openaiWhisperModel || 'whisper-1');
  if (s.sttLanguage) {
    // Whisper wants ISO-639-1; take the primary subtag.
    form.append('language', s.sttLanguage.split('-')[0] || 'en');
  }

  try {
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Whisper failed (${res.status}): ${body.slice(0, 240)}` };
    }
    const data = (await res.json()) as { text?: string };
    const text = (data.text || '').trim();
    if (!text) return { ok: false, error: 'Whisper returned empty text.' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
