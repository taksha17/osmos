/**
 * LLM provider adapter — Architecture v2, §8.1.
 *
 * Wraps the existing v0.6 provider plumbing behind the `LlmProvider` contract
 * without changing behaviour: same request, same chunks, same errors. When the
 * router v2 rewrites lanes, only this adapter has to move.
 *
 * Imports no Electron APIs, so `bench/run.mjs` can drive it from plain Node.
 */

import type { ProviderConfig } from '../../../shared/types.js';
import type {
  LlmCapabilities,
  LlmProvider,
  LlmStreamChunk,
  LlmStreamRequest,
} from '../../../shared/contracts/llm.js';
import { chatWithProvider, streamWithProvider } from '../../services/providers.js';

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i;

function capabilitiesFor(provider: ProviderConfig): LlmCapabilities {
  return {
    // v0.6 has no image path (§6.4 lands in Phase 4); callers get OCR text.
    vision: false,
    streaming: true,
    // Unknown per model — the v0.6 config does not carry a context window.
    maxContext: 0,
    local: provider.id === 'ollama' || LOOPBACK.test(provider.baseUrl || ''),
  };
}

/** Adapt a v0.6 `ProviderConfig` to the v2 `LlmProvider` contract. */
export function llmProviderFromConfig(provider: ProviderConfig): LlmProvider {
  const capabilities = capabilitiesFor(provider);

  return {
    id: `${provider.id}:${provider.model}`,
    capabilities,
    async *stream(req: LlmStreamRequest): AsyncGenerator<LlmStreamChunk, void, unknown> {
      if (req.images?.length && !capabilities.vision) {
        throw new Error(
          `${provider.label || provider.id} has no vision support; pass OCR text instead`,
        );
      }

      for await (const chunk of streamWithProvider(
        provider,
        req.system,
        req.messages,
        req.signal,
      )) {
        if (chunk.kind === 'content') yield { kind: 'delta', text: chunk.text };
        else yield { kind: 'thinking', text: chunk.text };
      }

      yield { kind: 'done' };
    },
  };
}

/** Non-streaming completion through the same contract (chat:ask path, tests). */
export function completeWithConfig(
  provider: ProviderConfig,
  req: Pick<LlmStreamRequest, 'system' | 'messages' | 'signal'>,
): Promise<string> {
  return chatWithProvider(provider, req.system, req.messages, req.signal);
}
