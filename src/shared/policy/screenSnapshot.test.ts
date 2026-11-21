import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySnapshot, looksLikeCodeScreen } from './screenSnapshot.ts';

const CODE = [
  'class Solution {',
  '  public int[] twoSum(int[] nums, int target) {',
  '    const seen = new Map();',
  '    return new int[] { 0, 1 };',
  '  }',
  '}',
].join('\n');

test('code snapshots are classified as code and require vision', () => {
  const result = classifySnapshot(CODE);
  assert.equal(result.kind, 'code');
  assert.equal(result.requiresVision, true);
  assert.match(result.hint, /working code/);
  assert.ok(result.confidence > 0.5);
});

test('terminal output is not mistaken for code', () => {
  const result = classifySnapshot(
    'PS C:\\Users\\taksh\\osmos-ci> npm run build\nnpm ERR! code ELIFECYCLE\nnpm error command failed',
  );
  assert.equal(result.kind, 'terminal');
  assert.equal(result.requiresVision, false);
  assert.match(result.hint, /terminal/);
});

test('error dialogs are classified as errors', () => {
  const result = classifySnapshot(
    "Uncaught TypeError: Cannot read properties of undefined (reading 'map')\n\nReload   Dismiss",
  );
  assert.equal(result.kind, 'error');
  assert.match(result.hint, /error/);
});

test('a slide with bullets and a single owner line is a slide', () => {
  const result = classifySnapshot(
    'Q3 roadmap review\n• Ship the billing migration\n• Cut the onboarding rewrite\nOwner: Priya',
  );
  assert.equal(result.kind, 'slide');
});

test('several speaker lines make a chat, one does not', () => {
  const chat = classifySnapshot(
    'Priya: can you take the billing migration?\nSam: yes, but I need the retry queue first',
  );
  assert.equal(chat.kind, 'chat');
  assert.match(chat.hint, /speakers/);

  const single = classifySnapshot('Notes from the call\nPriya: billing');
  assert.notEqual(single.kind, 'chat');

  const bullets = classifySnapshot('Standup notes\n• billing migration\n• retry queue');
  assert.notEqual(bullets.kind, 'chat');
});

test('long prose with no other signal is a document', () => {
  const result = classifySnapshot(
    [
      'The migration moved billing off the legacy cron jobs and onto a single queue.',
      'Rollout took three weeks and touched four services.',
      'Latency improved by 38% at p95, and the error rate fell to 0.2%.',
      'The remaining risk is the retry queue, which still shares a database with the ledger,',
      'so we recommend splitting it before the next quarter because the shared table is the',
      'only place where a slow ledger write can stall billing, and every retry that waits on',
      'that table multiplies the tail latency the queue was meant to remove from the system.',
    ].join(' '),
  );
  assert.equal(result.kind, 'document');
});

test('empty and low-signal screens stay unknown with no hint', () => {
  for (const text of ['', '   ', 'Loading…', 'File  Edit  View  Help', '☰ ✕ ⋮ ⚙']) {
    const result = classifySnapshot(text);
    assert.equal(result.kind, 'unknown', `expected unknown for ${JSON.stringify(text)}`);
    assert.equal(result.hint, '');
    assert.equal(result.requiresVision, false);
  }
});

test('code wins a tie with the prose rules', () => {
  // "return" alone is prose (0.75), so this stays unknown rather than code.
  assert.equal(looksLikeCodeScreen('I will return the deck after the call'), false);
  assert.equal(classifySnapshot('I will return the deck after the call').kind, 'unknown');
});

test('looksLikeCodeScreen agrees with the classifier', () => {
  assert.equal(looksLikeCodeScreen(CODE), true);
  assert.equal(looksLikeCodeScreen('Q3 roadmap review\n• Ship the billing migration'), false);
});
