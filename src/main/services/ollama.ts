export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/tags`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Ollama unreachable (${res.status})`);
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  return (data.models ?? []).map((m) => m.name || '').filter(Boolean);
}

export async function chatOllama(opts: {
  baseUrl: string;
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
}): Promise<string> {
  let full = '';
  for await (const chunk of streamChatOllama(opts)) {
    if (chunk.kind === 'content') full += chunk.text;
  }
  return full.trim();
}

export type OllamaStreamChunk =
  | { kind: 'thinking'; text: string }
  | { kind: 'content'; text: string };

/**
 * Stream assistant tokens from Ollama /api/chat (NDJSON).
 * Some models (e.g. gemma4) emit long `thinking` before any `content`.
 */
export async function* streamChatOllama(opts: {
  baseUrl: string;
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
}): AsyncGenerator<OllamaStreamChunk, void, unknown> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/chat`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      messages: [
        { role: 'system', content: opts.system },
        ...opts.messages,
      ],
    }),
    signal: opts.signal ?? AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama chat failed (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.body) {
    throw new Error('Ollama returned an empty stream body');
  }

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
      if (!trimmed) continue;
      let parsed: { message?: { content?: string; thinking?: string }; done?: boolean };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const thinking = parsed.message?.thinking || '';
      const content = parsed.message?.content || '';
      if (thinking) yield { kind: 'thinking', text: thinking };
      if (content) yield { kind: 'content', text: content };
    }
  }

  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer.trim()) as {
        message?: { content?: string; thinking?: string };
      };
      const thinking = parsed.message?.thinking || '';
      const content = parsed.message?.content || '';
      if (thinking) yield { kind: 'thinking', text: thinking };
      if (content) yield { kind: 'content', text: content };
    } catch {
      /* ignore trailing partial */
    }
  }
}
