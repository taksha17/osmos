/**
 * Web Access settings — Architecture v3, Appendix A.
 *
 * Additive-only: `AppSettings.webAccess` is OPTIONAL so v0.6 settings files
 * load unchanged and the chat path keeps calling `searchWeb()` until the
 * single coordinated WAM swap. Never stores the API key in plaintext —
 * the main settings store keeps it encrypted (see `secretStore.ts`).
 */

import type { WebPrivacy, WebTier } from './contracts/web.js';

export type WebAccessTierSetting = 'builtin' | 'firecrawl-local' | 'firecrawl-stack' | 'cloud';
export type WebAccessMode = 'connect' | 'managed' | 'remote';

export type WebAccessConfig = {
  /** Master switch — default false so behaviour is unchanged until W1 lands. */
  enabled: boolean;
  tier: WebAccessTierSetting;
  mode: WebAccessMode;
  baseUrl: string;
  /** Encrypted at rest; never logged. */
  apiKeyRef: string;
  privacy: WebPrivacy;
  searchProvider: 'searxng' | 'duckduckgo' | 'tavily' | 'firecrawl';
  searchUrl: string;
  limits: {
    liveConcurrency: number;
    bgConcurrency: number;
    crawlMaxPages: number;
    crawlMaxDepth: number;
    perDomainDelayMs: number;
  };
  cache: { ttlStaticHours: number; ttlNewsHours: number };
  safety: { allowPrivateTargets: boolean; domainAllowlist: string[]; domainDenylist: string[] };
  pauseBackgroundDuringSession: boolean;
};

export const DEFAULT_WEB_ACCESS_CONFIG: WebAccessConfig = {
  enabled: false,
  tier: 'firecrawl-local',
  mode: 'connect',
  baseUrl: 'http://127.0.0.1:3002',
  apiKeyRef: '',
  privacy: 'local-first',
  searchProvider: 'duckduckgo',
  searchUrl: 'http://127.0.0.1:8080',
  limits: {
    liveConcurrency: 2,
    bgConcurrency: 4,
    crawlMaxPages: 50,
    crawlMaxDepth: 2,
    perDomainDelayMs: 1000,
  },
  cache: { ttlStaticHours: 24, ttlNewsHours: 1 },
  safety: { allowPrivateTargets: false, domainAllowlist: [], domainDenylist: [] },
  pauseBackgroundDuringSession: true,
};

/** Merge stored (possibly partial) config over defaults. */
export function resolveWebAccessConfig(stored?: Partial<WebAccessConfig>): WebAccessConfig {
  if (!stored) return { ...DEFAULT_WEB_ACCESS_CONFIG };
  return {
    ...DEFAULT_WEB_ACCESS_CONFIG,
    ...stored,
    limits: { ...DEFAULT_WEB_ACCESS_CONFIG.limits, ...(stored.limits ?? {}) },
    cache: { ...DEFAULT_WEB_ACCESS_CONFIG.cache, ...(stored.cache ?? {}) },
    safety: { ...DEFAULT_WEB_ACCESS_CONFIG.safety, ...(stored.safety ?? {}) },
  };
}

/** Map the settings tier to the contract tier for capability routing. */
export function contractTierFor(setting: WebAccessTierSetting): WebTier {
  switch (setting) {
    case 'firecrawl-local':
      return 'T1';
    case 'firecrawl-stack':
      return 'T2';
    case 'cloud':
      return 'T3';
    default:
      return 'T0';
  }
}
