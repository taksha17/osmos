/**
 * Keep the quality provider warm so the first Assist after overlay open
 * does not pay cold-start latency on Groq / OpenAI / Ollama.
 */
import type { ProviderConfig } from '../../shared/types.js';

export type WarmupStatus = {
  ok: boolean;
  providerId: string;
  model: string;
  ms: number;
  error?: string;
  at: number;
};

let lastWarmup: WarmupStatus | null = null;
let inflight: Promise<WarmupStatus> | null = null;

export function getLastWarmup(): WarmupStatus | null {
  return lastWarmup;
}

/** True if we warmed successfully within the last N ms. */
export function isProviderWarm(maxAgeMs = 8 * 60_000): boolean {
  if (!lastWarmup?.ok || !lastWarmup.at) return false;
  return Date.now() - lastWarmup.at < maxAgeMs;
}

async function pingOllama(provider: ProviderConfig): Promise<void> {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(6_000) });
  if (!tags.ok) throw new Error(`Ollama unreachable (${tags.status})`);
  // Soft keep-alive: tiny generate so the model stays resident.
  if (provider.model) {
    await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        prompt: 'hi',
        stream: false,
        keep_alive: '10m',
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(45_000),
    }).catch(() => {
      /* tags already proved the daemon is up */
    });
  }
}

async function pingOpenAICompatible(provider: ProviderConfig): Promise<void> {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  // Prefer /models (cheap). Fall back to a 1-token chat if the host has no models list.
  const modelsRes = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (modelsRes?.ok) return;

  const chatRes = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!chatRes.ok) {
    const text = await chatRes.text().catch(() => '');
    throw new Error(`${provider.label || provider.id} warmup failed (${chatRes.status}): ${text.slice(0, 120)}`);
  }
}

export async function warmupProvider(provider: ProviderConfig | undefined | null): Promise<WarmupStatus> {
  if (!provider?.id) {
    const status: WarmupStatus = {
      ok: false,
      providerId: '',
      model: '',
      ms: 0,
      error: 'No provider configured',
      at: Date.now(),
    };
    lastWarmup = status;
    return status;
  }

  if (inflight) return inflight;

  inflight = (async () => {
    const started = Date.now();
    try {
      if (provider.id === 'ollama') {
        await pingOllama(provider);
      } else if (provider.id === 'anthropic') {
        // Anthropic has no /models list in the same shape; skip deep ping —
        // TLS + DNS to the host is enough for "wake".
        const res = await fetch(provider.baseUrl.replace(/\/+$/, '') || 'https://api.anthropic.com', {
          method: 'GET',
          signal: AbortSignal.timeout(8_000),
        }).catch(() => null);
        if (!res) throw new Error('Anthropic unreachable');
      } else {
        await pingOpenAICompatible(provider);
      }
      const status: WarmupStatus = {
        ok: true,
        providerId: provider.id,
        model: provider.model,
        ms: Date.now() - started,
        at: Date.now(),
      };
      lastWarmup = status;
      return status;
    } catch (e) {
      const status: WarmupStatus = {
        ok: false,
        providerId: provider.id,
        model: provider.model,
        ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
        at: Date.now(),
      };
      lastWarmup = status;
      return status;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Probe optional Lumen HTTP gateway (OpenAI-compatible /v1). */
export async function probeLumenGateway(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  try {
    const res = await fetch(`${root}/v1/health`, { signal: AbortSignal.timeout(3_000) });
    if (res.ok) return { ok: true };
    // Some builds only expose /v1/models
    const models = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(3_000) });
    if (models.ok) return { ok: true };
    return { ok: false, error: `Gateway HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
