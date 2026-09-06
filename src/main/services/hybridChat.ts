/**
 * Resolve fast / quality lanes for hybrid routing and stream helpers.
 */
import type { AppSettings, ChatRouteMeta, ProviderConfig } from '../../shared/types.js';
import type { RouteDecision } from '../../shared/lumenRoute.js';
import { routeTierLabel } from '../../shared/lumenRoute.js';
import { listOllamaModels } from './ollama.js';
import { isProviderWarm, probeLumenGateway } from './providerWarmup.js';
import {
  bundledLlmProvider,
  isBundledLlmAvailable,
  isBundledLlmReady,
  startBundledLlm,
} from './bundledLlm.js';
import { streamWithProvider, type ProviderStreamChunk } from './providers.js';

export type LanePlan = {
  decision: RouteDecision;
  quality: ProviderConfig;
  fast: ProviderConfig | null;
  useDraftUpgrade: boolean;
  route: ChatRouteMeta;
};

let ollamaTagsCache: { at: number; baseUrl: string; tags: string[] } | null = null;

async function ollamaHasModel(baseUrl: string, model: string): Promise<boolean> {
  const want = model.trim();
  if (!want) return false;
  const now = Date.now();
  if (
    !ollamaTagsCache ||
    ollamaTagsCache.baseUrl !== baseUrl ||
    now - ollamaTagsCache.at > 60_000
  ) {
    try {
      const tags = await listOllamaModels(baseUrl);
      ollamaTagsCache = { at: now, baseUrl, tags };
    } catch {
      ollamaTagsCache = { at: now, baseUrl, tags: [] };
    }
  }
  const tags = ollamaTagsCache.tags;
  return tags.some((t) => {
    if (t === want) return true;
    if (!want.includes(':') && (t === want || t.startsWith(`${want}:`))) return true;
    return false;
  });
}

function lumenAsProvider(settings: AppSettings): ProviderConfig {
  const root = (settings.lumenGatewayUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const baseUrl = root.endsWith('/v1') ? root : `${root}/v1`;
  return {
    id: 'litellm',
    label: 'Lumen gateway',
    apiKey: 'lumen',
    baseUrl,
    model: 'lumen-hybrid',
  };
}

export async function planHybridLanes(
  settings: AppSettings,
  decision: RouteDecision,
  qualityProvider: ProviderConfig,
): Promise<LanePlan> {
  const hybridOn = settings.hybridRouting !== false;
  let fast: ProviderConfig | null = null;

  if (hybridOn) {
    // 1) Bundled onboard GGUF (preferred — no Ollama required)
    if (isBundledLlmAvailable()) {
      const up = isBundledLlmReady() || (await startBundledLlm());
      if (up) fast = bundledLlmProvider();
    }

    // 2) Optional Lumen gateway
    if (!fast && settings.lumenGatewayEnabled) {
      const probe = await probeLumenGateway(settings.lumenGatewayUrl || 'http://127.0.0.1:8080');
      if (probe.ok) {
        fast = lumenAsProvider(settings);
      }
    }

    // 3) Ollama fast model fallback
    if (!fast) {
      const ollama = settings.providers?.ollama;
      const fastModel = (settings.hybridFastModel || 'osmos-fast').trim();
      if (ollama?.baseUrl && fastModel && fastModel !== 'osmos-fast') {
        const has = await ollamaHasModel(ollama.baseUrl, fastModel);
        if (has) {
          fast = { ...ollama, id: 'ollama', model: fastModel, label: 'Ollama (fast)' };
        }
      }
    }
  }

  const sameLane =
    !!fast &&
    fast.id === qualityProvider.id &&
    fast.baseUrl === qualityProvider.baseUrl &&
    fast.model === qualityProvider.model;

  const wantUpgrade =
    hybridOn &&
    settings.draftThenUpgrade !== false &&
    decision.preferUpgrade &&
    !!fast &&
    !sameLane;

  let lane: ChatRouteMeta['lane'] = 'quality';
  let activeForDirect: ProviderConfig = qualityProvider;

  if (!hybridOn || !fast) {
    lane = 'quality';
    activeForDirect = qualityProvider;
  } else if (decision.tier === 'fast') {
    lane = 'fast';
    activeForDirect = fast;
  } else if (wantUpgrade) {
    lane = 'draft-upgrade';
    activeForDirect = qualityProvider;
  } else if (decision.tier === 'balanced' && !isProviderWarm() && fast) {
    lane = 'fast';
    activeForDirect = fast;
  } else {
    lane = 'quality';
    activeForDirect = qualityProvider;
  }

  const model =
    lane === 'draft-upgrade'
      ? `${fast!.model} → ${qualityProvider.model}`
      : activeForDirect.model;

  return {
    decision,
    quality: qualityProvider,
    fast,
    useDraftUpgrade: lane === 'draft-upgrade',
    route: {
      tier: decision.tier,
      reason: decision.reason,
      model,
      lane,
    },
  };
}

export function statusForRoute(route: ChatRouteMeta): string {
  if (route.lane === 'draft-upgrade') {
    return `${routeTierLabel(route.tier)} · quick draft then upgrade (${route.model})`;
  }
  if (route.lane === 'fast') {
    return `${routeTierLabel(route.tier)} · ${route.model}`;
  }
  return `${routeTierLabel(route.tier)} · ${route.model}`;
}

export async function* streamLane(
  provider: ProviderConfig,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
): AsyncGenerator<ProviderStreamChunk, void, unknown> {
  yield* streamWithProvider(provider, system, messages, signal);
}

/** Provider to use for a non-upgrade (direct) stream given the plan. */
export function directProvider(plan: LanePlan): ProviderConfig {
  if (plan.route.lane === 'fast' && plan.fast) return plan.fast;
  return plan.quality;
}
