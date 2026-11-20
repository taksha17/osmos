import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseWebProvider, tierOrderFor, type WebProviderDescriptor } from './webAccess.ts';

const t0 = (id: string, local: boolean, priority = 0): WebProviderDescriptor => ({
  id,
  tier: 'T0',
  capabilities: ['search'],
  local,
  priority,
});

const firecrawl = (id: string, tier: 'T1' | 'T2' | 'T3', local: boolean): WebProviderDescriptor => ({
  id,
  tier,
  capabilities: ['search', 'scrape', 'crawl', 'map', ...(tier === 'T2' || tier === 'T3' ? (['extract'] as const) : [])],
  local,
});

test('search keeps the built-in order: SearXNG → DuckDuckGo → Tavily', () => {
  const providers = [
    t0('tavily', false, 3),
    t0('searxng', false, 1),
    t0('duckduckgo', false, 2),
    firecrawl('firecrawl-cloud', 'T3', false),
  ];
  const choice = chooseWebProvider(providers, { capability: 'search' });
  assert.equal(choice.providerId, 'searxng');
  assert.equal(choice.tier, 'T0');
});

test('scrape prefers a local Firecrawl tier over cloud', () => {
  const providers = [firecrawl('firecrawl-cloud', 'T3', false), firecrawl('firecrawl-local', 'T1', true)];
  const choice = chooseWebProvider(providers, { capability: 'scrape' });
  assert.equal(choice.providerId, 'firecrawl-local');
  assert.equal(choice.local, true);
});

test('local-only never falls through to a cloud tier', () => {
  const providers = [t0('duckduckgo', false), firecrawl('firecrawl-cloud', 'T3', false)];
  const choice = chooseWebProvider(providers, { capability: 'scrape', privacy: 'local-only' });
  assert.equal(choice.providerId, null);
  assert.match(choice.reason, /local-only/);
});

test('local-only still answers from a local provider', () => {
  const providers = [t0('searxng', true, 1), firecrawl('firecrawl-local', 'T1', true)];
  const choice = chooseWebProvider(providers, { capability: 'search', privacy: 'local-only' });
  assert.equal(choice.providerId, 'searxng');
  assert.equal(choice.local, true);
});

test('cloud privacy may use any tier', () => {
  const providers = [t0('duckduckgo', false, 2), firecrawl('firecrawl-cloud', 'T3', false)];
  const choice = chooseWebProvider(providers, { capability: 'scrape', privacy: 'cloud' });
  assert.equal(choice.providerId, 'firecrawl-cloud');
});

test('an unhealthy local provider loses to a healthy one', () => {
  const providers: WebProviderDescriptor[] = [
    { ...firecrawl('firecrawl-local', 'T1', true), healthy: false },
    { ...firecrawl('firecrawl-local-2', 'T1', true), healthy: true },
  ];
  assert.equal(chooseWebProvider(providers, { capability: 'scrape' }).providerId, 'firecrawl-local-2');
});

test('an unprobed provider stays eligible', () => {
  const providers: WebProviderDescriptor[] = [{ ...firecrawl('firecrawl-local', 'T1', true), healthy: undefined }];
  assert.equal(chooseWebProvider(providers, { capability: 'map' }).providerId, 'firecrawl-local');
});

test('an unsupported capability reports the gap instead of guessing', () => {
  const choice = chooseWebProvider([t0('duckduckgo', false)], { capability: 'crawl' });
  assert.equal(choice.providerId, null);
  assert.match(choice.reason, /crawl/);
});

test('an empty registry reports the gap', () => {
  const choice = chooseWebProvider([], { capability: 'search' });
  assert.equal(choice.providerId, null);
});

test('T2 is the first extract-capable tier', () => {
  const providers = [firecrawl('firecrawl-local', 'T1', true), firecrawl('firecrawl-stack', 'T2', true)];
  assert.equal(chooseWebProvider(providers, { capability: 'extract' }).providerId, 'firecrawl-stack');
});

test('tierOrderFor exposes the documented preference lists', () => {
  assert.deepEqual(tierOrderFor('search'), ['T0', 'T1', 'T2', 'T3']);
  assert.deepEqual(tierOrderFor('scrape'), ['T1', 'T2', 'T3', 'T0']);
  assert.deepEqual(tierOrderFor('extract'), ['T2', 'T3']);
});
