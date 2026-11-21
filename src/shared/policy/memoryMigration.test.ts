import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSession, SavedProfile } from '../types.ts';
import { planMemoryMigration } from './memoryMigration.ts';

const NOW = 1_700_000_003_000;

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    mode: 'interview',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_002_000,
    messages: [
      { role: 'user', content: 'Tell me about yourself', createdAt: 1_700_000_000_500 },
      { role: 'assistant', content: 'I build desktop AI tools.', createdAt: 1_700_000_001_000 },
      { role: 'user', content: '   ', createdAt: 1_700_000_001_500 },
    ],
    ...overrides,
  };
}

function profile(overrides: Partial<SavedProfile> = {}): SavedProfile {
  const base = {
    id: 'p1',
    label: 'Interview @ Acme',
    companyName: 'Acme',
    companyUrl: '',
    companyIntel: '',
    documents: [],
    questions: [],
    starTemplates: [],
  } as unknown as SavedProfile;
  return { ...base, ...overrides };
}

test('migrates a session into one session record plus each non-empty message', () => {
  const plan = planMemoryMigration({ sessions: [session()], now: NOW });

  assert.deepEqual(
    plan.records.map((record) => record.id),
    ['session:s1', 'message:s1:0', 'message:s1:1'],
  );
  assert.equal(plan.counts.session, 1);
  assert.equal(plan.counts.message, 2);
  assert.match(plan.records[0]!.text, /user: Tell me about yourself/);
  assert.deepEqual(plan.records[1]!.meta, { role: 'user', index: 0 });
});

test('an empty message is skipped with a reference instead of vanishing', () => {
  const plan = planMemoryMigration({ sessions: [session()], now: NOW });
  assert.deepEqual(plan.skipped, [{ ref: 's1#2', reason: 'empty message' }]);
});

test('a session with no usable messages is skipped as a whole', () => {
  const plan = planMemoryMigration({
    sessions: [session({ id: 'empty', messages: [{ role: 'user', content: '  ', createdAt: 1 }] })],
    now: NOW,
  });
  assert.deepEqual(plan.records, []);
  assert.deepEqual(
    plan.skipped.map((entry) => entry.ref),
    ['empty#0', 'empty'],
  );
});

test('ids are derived, so running the migration twice yields the same plan', () => {
  const input = { sessions: [session()], now: NOW };
  assert.deepEqual(planMemoryMigration(input), planMemoryMigration(input));
});

test('a duplicate id keeps the newer copy', () => {
  const older = session({
    id: 'dup',
    createdAt: 10,
    messages: [{ role: 'user', content: 'old', createdAt: 10 }],
  });
  const newer = session({
    id: 'dup',
    createdAt: 20,
    messages: [{ role: 'user', content: 'new', createdAt: 20 }],
  });
  const plan = planMemoryMigration({ sessions: [newer, older], now: NOW });
  assert.equal(plan.records.find((record) => record.id === 'message:dup:0')!.text, 'new');
});

test('records are ordered oldest first', () => {
  const plan = planMemoryMigration({
    sessions: [
      session({ id: 'late', createdAt: 900, messages: [{ role: 'user', content: 'b', createdAt: 900 }] }),
      session({ id: 'early', createdAt: 100, messages: [{ role: 'user', content: 'a', createdAt: 100 }] }),
    ],
    now: NOW,
  });
  const times = plan.records.map((record) => record.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('profile questions, STAR stories and documents migrate with their metadata', () => {
  const plan = planMemoryMigration({
    profiles: [
      profile({
        questions: [
          {
            id: 'q1',
            companyName: 'Acme',
            question: 'Why Acme?',
            answer: 'Because of the product.',
            category: 'behavioral',
            difficulty: 'easy',
            tags: [],
            createdAt: 1_700_000_004_000,
          } as never,
        ],
        starTemplates: [
          {
            id: 't1',
            label: 'Migration',
            situation: 'S',
            task: 'T',
            action: 'A',
            result: 'R',
          } as never,
        ],
        documents: [
          { id: 'd1', name: 'Resume', text: 'Ten years of desktop apps.', addedAt: 1_700_000_005_000 },
        ],
      }),
    ],
    now: NOW,
  });

  // A STAR story carries no timestamp of its own, so it sorts at `now` — after the
  // question that was created before the migration ran. Order is by time, not kind.
  assert.deepEqual(
    plan.records.map((record) => record.id),
    ['star:p1:t1', 'question:p1:q1', 'document:p1:d1'],
  );
  assert.equal(plan.records[0]!.at, NOW);
  assert.equal(plan.records[0]!.title, 'Migration');
  assert.equal(plan.records[1]!.meta?.category, 'behavioral');
  assert.equal(plan.records[1]!.meta?.hasAnswer, true);
  assert.match(plan.records[1]!.text, /Because of the product\./);
  assert.equal(plan.records[2]!.title, 'Resume');
  assert.deepEqual(plan.counts, { session: 0, message: 0, question: 1, star: 1, document: 1 });
});

test('profile items without timestamps use the supplied now, keeping the plan deterministic', () => {
  const input = {
    profiles: [profile({ starTemplates: [{ id: 't2', label: 'X', situation: 'S' } as never] })],
    now: NOW,
  };
  const plan = planMemoryMigration(input);
  assert.equal(plan.records[0]!.at, NOW);
  assert.deepEqual(planMemoryMigration(input), plan);
});

test('empty profile items are reported, not dropped silently', () => {
  const plan = planMemoryMigration({
    profiles: [
      profile({
        questions: [{ id: 'q2', question: '   ' } as never],
        documents: [{ id: 'd2', name: 'Blank', text: '   ', addedAt: 1 }],
      }),
    ],
    now: NOW,
  });
  assert.deepEqual(plan.records, []);
  assert.deepEqual(plan.skipped, [
    { ref: 'p1:question#0', reason: 'empty question' },
    { ref: 'p1:document:Blank', reason: 'empty document' },
  ]);
});

test('an empty input plans an empty migration rather than throwing', () => {
  assert.deepEqual(planMemoryMigration(), {
    records: [],
    skipped: [],
    counts: { session: 0, message: 0, question: 0, star: 0, document: 0 },
  });
});
