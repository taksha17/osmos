/**
 * Vision payloads — Architecture v2, §6.4 / Phase 4.
 *
 * The contract (`LlmImageInput`) has always had an image slot, but nothing could
 * fill it: `capabilities.vision` was hard-coded false and no adapter built image
 * content. This module is the missing half — capability detection, image
 * resolution and the two wire formats we speak (`image_url` content parts for
 * OpenAI-compatible APIs, an `images` array for Ollama).
 *
 * No Electron and no network: `resolveImage` takes a reader, so the mapping is
 * unit-tested with a fake reader and the bench can exercise it in plain Node.
 */

import type { LlmImageInput } from '../../../shared/contracts/llm.js';

/** Data URLs are ~4/3 the byte size; keep the wire under ~5 MB per image. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const SUPPORTED_MIME = /^image\/(png|jpeg|webp|gif)$/i;

const OLLAMA_VISION = /(llava|bakllava|vision|qwen2(\.5)?-vl|gemma3|minicpm-v|moondream)/i;
const OPENAI_VISION = /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o3|o4-mini|o1)/i;
const GENERIC_VISION = /(vision|vl\b|multimodal|omni|-v\d)/i;

export type ResolvedImage = {
  mime: string;
  /** Base64 without the `data:` prefix. */
  base64: string;
  bytes: number;
};

/**
 * Whether a configured provider can take an image.
 *
 * Model-dependent by nature (an OpenAI key does not make `gpt-3.5` multimodal),
 * so this is a name heuristic, not a promise. Aggregators (Groq, OpenRouter,
 * LiteLLM) serve many models, so they are trusted when the model name looks
 * multimodal and rejected otherwise — the adapter still refuses to send an image
 * to a capability that is false, and OCR text remains the fallback (§6.4).
 */
export function providerAcceptsVision(provider: { id?: string; model?: string; visionModel?: string }): boolean {
  // An explicit vision-model override is authoritative: the user has chosen a
  // model for image requests even if the text model's name says nothing about
  // multimodal support.
  if (String(provider.visionModel ?? '').trim()) return true;
  const id = String(provider.id ?? '');
  const model = String(provider.model ?? '');
  switch (id) {
    case 'ollama':
      return OLLAMA_VISION.test(model);
    case 'openai':
      return OPENAI_VISION.test(model);
    case 'groq':
      return GENERIC_VISION.test(model);
    case 'openrouter':
    case 'litellm':
      return OPENAI_VISION.test(model) || GENERIC_VISION.test(model);
    case 'nvidia':
      return GENERIC_VISION.test(model);
    default:
      return false;
  }
}

/**
 * Turn a contract image reference into base64 for the wire.
 *
 * `dataRef` is either a `data:` URL or a path handed to `readFile`. Anything else,
 * an unsupported mime type or an oversized image throws: silently dropping the
 * image would answer from a stale OCR of the wrong screen.
 */
export function resolveImage(
  input: LlmImageInput,
  readFile: (path: string) => Uint8Array,
): ResolvedImage {
  const ref = String(input?.dataRef ?? '').trim();
  if (!ref) throw new Error('image has no dataRef');

  let mime = String(input.mime ?? '').trim().toLowerCase();
  let base64: string;

  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(ref);
  if (dataUrl) {
    mime = mime || dataUrl[1]!.toLowerCase();
    base64 = dataUrl[2]!.replace(/\s+/g, '');
  } else {
    const bytes = readFile(ref);
    base64 = Buffer.from(bytes).toString('base64');
  }

  if (!SUPPORTED_MIME.test(mime)) {
    throw new Error(`unsupported image type ${mime || '(none)'}; expected png, jpeg, webp or gif`);
  }
  if (!base64) throw new Error('image data is empty');

  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`image is ${bytes} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  }
  return { mime, base64, bytes };
}

export function toDataUrl(image: ResolvedImage): string {
  return `data:${image.mime};base64,${image.base64}`;
}

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * OpenAI-compatible message content. With no images this returns the plain string
 * the v0.6 path has always sent, so a text-only request is byte-identical.
 */
export function openAiContentParts(
  text: string,
  images: readonly ResolvedImage[] = [],
): string | OpenAiContentPart[] {
  if (images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((image) => ({ type: 'image_url' as const, image_url: { url: toDataUrl(image) } })),
  ];
}

/** Ollama takes bare base64 strings next to the message content. */
export function ollamaImages(images: readonly ResolvedImage[] = []): string[] {
  return images.map((image) => image.base64);
}

/**
 * Attach images to the last user turn of a message list. Content becomes an array
 * only for OpenAI-compatible providers; Ollama keeps the string and gets the
 * separate `images` array.
 */
export function openAiMessagesWithImages(
  messages: ReadonlyArray<{ role: string; content: string }>,
  images: readonly ResolvedImage[] = [],
): Array<{ role: string; content: string | OpenAiContentPart[] }> {
  if (images.length === 0) return messages.map((message) => ({ ...message }));
  const out = messages.map((message) => ({ ...message }) as { role: string; content: string | OpenAiContentPart[] });
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]!.role === 'user') {
      out[i] = { role: 'user', content: openAiContentParts(out[i]!.content as string, images) };
      break;
    }
  }
  return out;
}
