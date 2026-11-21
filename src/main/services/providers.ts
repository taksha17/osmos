import fs from 'node:fs';
import { chatOllama, streamChatOllama } from './ollama.js';
import type { ProviderConfig } from '../../shared/types.js';
import type { LlmImageInput } from '../../shared/contracts/llm.js';
import {
  ollamaImages,
  openAiMessagesWithImages,
  resolveImage,
  type ResolvedImage,
} from '../providers/llm/vision.js';

/** §6.4: a path or data URL becomes base64 once, at the wire boundary. */
function resolveImages(images: readonly LlmImageInput[] = []): ResolvedImage[] {
  return images.map((image) => resolveImage(image, (path) => fs.readFileSync(path)));
}

export type ProviderStreamChunk =
  | { kind: 'thinking'; text: string }
  | { kind: 'content'; text: string };

function isOpenAICompatible(provider: ProviderConfig): boolean {
  return ['openai', 'groq', 'openrouter', 'nvidia', 'litellm'].includes(provider.id);
}

async function chatOpenAICompatible(provider: ProviderConfig, system: string, messages: Array<{ role: string; content: string }>, signal?: AbortSignal, images: readonly ResolvedImage[] = []): Promise<{ text: string }> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        ...openAiMessagesWithImages(messages, images),
      ],
    }),
    signal: signal ?? AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${provider.label} chat failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content || '';
  return { text: String(text).trim() };
}

export async function* streamOpenAICompatible(provider: ProviderConfig, system: string, messages: Array<{ role: string; content: string }>, signal?: AbortSignal, images: readonly ResolvedImage[] = []): AsyncGenerator<ProviderStreamChunk, void, unknown> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model,
      stream: true,
      messages: [
        { role: 'system', content: system },
        ...openAiMessagesWithImages(messages, images),
      ],
    }),
    signal: signal ?? AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${provider.label} stream failed (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new Error(`${provider.label} returned an empty stream body`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        const content = parsed.choices?.[0]?.delta?.content || '';
        if (content) yield { kind: 'content', text: content };
      } catch {
        // ignore malformed JSON
      }
    }
  }
}

export async function chatWithProvider(
  provider: ProviderConfig,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
  images: readonly LlmImageInput[] = [],
): Promise<string> {
  const resolved = resolveImages(images);
  if (provider.id === 'ollama') {
    return chatOllama({
      baseUrl: provider.baseUrl,
      model: provider.model,
      system,
      messages,
      signal,
      images: ollamaImages(resolved),
    });
  }

  if (isOpenAICompatible(provider)) {
    const { text } = await chatOpenAICompatible(provider, system, messages, signal, resolved);
    return text;
  }

  throw new Error(`Unsupported provider: ${provider.id}`);
}

export async function* streamWithProvider(
  provider: ProviderConfig,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
  images: readonly LlmImageInput[] = [],
): AsyncGenerator<ProviderStreamChunk, void, unknown> {
  const resolved = resolveImages(images);
  if (provider.id === 'ollama') {
    yield* streamChatOllama({
      baseUrl: provider.baseUrl,
      model: provider.model,
      system,
      messages,
      signal,
      images: ollamaImages(resolved),
    });
    return;
  }

  if (isOpenAICompatible(provider)) {
    yield* streamOpenAICompatible(provider, system, messages, signal, resolved);
    return;
  }

  throw new Error(`Unsupported provider: ${provider.id}`);
}
