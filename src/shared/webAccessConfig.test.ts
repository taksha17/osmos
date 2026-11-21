import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractTierFor, DEFAULT_WEB_ACCESS_CONFIG, resolveWebAccessConfig } from './webAccessConfig.ts';

test('web access defaults to disabled connect-mode local-first', () => {
  assert.equal(DEFAULT_WEB_ACCESS_CONFIG.enabled, false);
  assert.equal(DEFAULT_WEB_ACCESS_CONFIG.mode, 'connect');
  assert.equal(DEFAULT_WEB_ACCESS_CONFIG.privacy, 'local-first');
  assert.equal(DEFAULT_WEB_ACCESS_CONFIG.baseUrl, 'http://127.0.0.1:3002');
});

test('partial stored config merges over defaults', () => {
  const r = resolveWebAccessConfig({ enabled: true, limits: { crawlMaxPages: 10 } } as never);
  assert.equal(r.enabled, true);
  assert.equal(r.limits.crawlMaxPages, 10);
  assert.equal(r.limits.crawlMaxDepth, 2);
});

test('tier mapping matches contract tiers', () => {
  assert.equal(contractTierFor('builtin'), 'T0');
  assert.equal(contractTierFor('firecrawl-local'), 'T1');
  assert.equal(contractTierFor('firecrawl-stack'), 'T2');
  assert.equal(contractTierFor('cloud'), 'T3');
});
