import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrlShape, isBlockedHostname, isBlockedIp } from './webGuard.ts';

test('blocks non-http schemes', () => {
  assert.equal(checkUrlShape('file:///etc/passwd').ok, false);
  assert.equal(checkUrlShape('ftp://example.com/x').ok, false);
});

test('blocks loopback and private IPv4 literals', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.4', '172.16.5.4', '169.254.169.254', '0.0.0.0']) {
    assert.equal(isBlockedIp(ip), true, ip);
    assert.equal(checkUrlShape(`http://${ip}/`).ok, false, ip);
  }
});

test('blocks IPv6 loopback/link-local and mapped v4', () => {
  assert.equal(isBlockedIp('::1'), true);
  assert.equal(isBlockedIp('fe80::1'), true);
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true);
  assert.equal(checkUrlShape('http://[::1]/').ok, false);
});

test('blocks localhost and metadata hostnames', () => {
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(checkUrlShape('http://localhost:3002/x').ok, false);
});

test('allows public https URLs', () => {
  const r = checkUrlShape('https://example.com/docs?q=1');
  assert.equal(r.ok, true);
});

test('allowPrivateTargets permits LAN literals at shape level (DNS still checked)', () => {
  const r = checkUrlShape('http://192.168.1.4:3002/', { allowPrivateTargets: true });
  assert.equal(r.ok, true);
});
