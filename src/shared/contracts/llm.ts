/**
 * LLM provider contract — Architecture v2, §8.1.
 *
 * Types only. Existing v0.6 providers are adapted in
 * `src/main/providers/llm/config.ts`; nothing here may import Electron so the
 * benchmark harness can drive the same interface from plain Node.
 */

export type ChatRole = 'user' | 'assistant';

export type ChatTurn = {
  role: ChatRole;
  content: string;
};

/**
 * Reference to an image: a `data:` URL, or a path the adapter resolves itself
 * (never inline base64 across a worker boundary).
 */
export type LlmImageInput = {
  mime: string;
  dataRef: string;
};

export type LlmCapabilities = {
  vision: boolean;
  streaming: boolean;
  /** Tokens; 0 means "unknown for this adapter". */
  maxContext: number;
  local: boolean;
};

export type LlmUsage = {
  promptTokens?: number;
  completionTokens?: number;
};

export type LlmStreamChunk =
  | { kind: 'delta'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'done'; usage?: LlmUsage };

export type LlmStreamRequest = {
  system: string;
  messages: ChatTurn[];
  /** Vision path (§6.4) — adapters without `capabilities.vision` must reject. */
  images?: LlmImageInput[];
  signal?: AbortSignal;
  maxTokens?: number;
};

export interface LlmProvider {
  id: string;
  capabilities: LlmCapabilities;
  stream(req: LlmStreamRequest): AsyncIterable<LlmStreamChunk>;
}
