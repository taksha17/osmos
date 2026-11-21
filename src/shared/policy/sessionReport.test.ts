import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSession } from '../types.ts';
import { buildSessionReport, renderReportMarkdown } from './sessionReport.ts';

const START = 1_700_000_000_000;

function session(
  messages: ChatSession['messages'],
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return { id: 's1', mode: 'interview', createdAt: START, updatedAt: START, messages, ...overrides };
}

test('pairs each question with the answer that followed and measures latency', () => {
  const report = buildSessionReport(
    session([
      { role: 'user', content: 'Why this role?', createdAt: START + 1_000 },
      { role: 'assistant', content: 'Because of the product.', createdAt: START + 2_500 },
    ]),
  );

  assert.deepEqual(report.entries, [
    {
      at: START + 1_000,
      question: 'Why this role?',
      answer: 'Because of the product.',
      status: 'answered',
      latencyMs: 1_500,
    },
  ]);
  assert.equal(report.metrics.questions, 1);
  assert.equal(report.metrics.answered, 1);
  assert.equal(report.metrics.empty, 0);
  assert.equal(report.metrics.unanswered, 0);
});

test('an empty assistant reply is reported as empty, not as an answer', () => {
  const report = buildSessionReport(
    session([
      { role: 'user', content: 'Ping', createdAt: START },
      { role: 'assistant', content: '   ', createdAt: START + 10 },
    ]),
  );
  assert.equal(report.entries[0]!.status, 'empty');
  assert.equal(report.metrics.empty, 1);
  assert.equal(report.metrics.answered, 0);
});

test('a second question before any reply closes the first as unanswered', () => {
  const report = buildSessionReport(
    session([
      { role: 'user', content: 'First?', createdAt: START },
      { role: 'user', content: 'Second?', createdAt: START + 100 },
      { role: 'assistant', content: 'Answer to the second.', createdAt: START + 200 },
    ]),
  );
  assert.deepEqual(
    report.entries.map((entry) => [entry.question, entry.status]),
    [
      ['First?', 'unanswered'],
      ['Second?', 'answered'],
    ],
  );
});

test('a trailing question with no reply stays unanswered', () => {
  const report = buildSessionReport(
    session([
      { role: 'user', content: 'One', createdAt: START },
      { role: 'assistant', content: 'Done', createdAt: START + 5 },
      { role: 'user', content: 'Two', createdAt: START + 6 },
    ]),
  );
  const last = report.entries[report.entries.length - 1]!;
  assert.equal(last.question, 'Two');
  assert.equal(last.status, 'unanswered');
  assert.equal(report.metrics.unanswered, 1);
});

test('assistant messages without a question are counted, not invented into entries', () => {
  const report = buildSessionReport(
    session([{ role: 'assistant', content: 'Unsolicited', createdAt: START + 1 }]),
  );
  assert.deepEqual(report.entries, []);
  assert.equal(report.metrics.orphanAnswers, 1);
});

test('duration spans from creation to the last message, never negative', () => {
  const report = buildSessionReport(
    session([{ role: 'user', content: 'Hi', createdAt: START + 60_000 }], {
      updatedAt: START - 5_000,
    }),
  );
  assert.equal(report.startedAt, START);
  assert.equal(report.endedAt, START + 60_000);
  assert.equal(report.durationMs, 60_000);
});

test('an empty session reports zeroes instead of NaN', () => {
  const report = buildSessionReport(session([]));
  assert.deepEqual(report.metrics, {
    turns: 0,
    questions: 0,
    answered: 0,
    empty: 0,
    unanswered: 0,
    orphanAnswers: 0,
    avgAnswerChars: 0,
  });
  assert.equal(report.durationMs, 0);
});

test('markdown export states the outcome for each question', () => {
  const report = buildSessionReport(
    session([
      { role: 'user', content: 'Why us?', createdAt: START },
      { role: 'assistant', content: 'Product.', createdAt: START + 2_000 },
      { role: 'user', content: 'Salary?', createdAt: START + 3_000 },
    ]),
  );
  const markdown = renderReportMarkdown(report, { maxEntryChars: 80 });

  assert.match(markdown, /# interview session/);
  assert.match(markdown, /- Questions: 2 \(answered 1, empty 0, unanswered 1\)/);
  assert.match(markdown, /## 1\. Why us\?/);
  assert.match(markdown, /Product\./);
  assert.match(markdown, /_Not answered\._/);
});

test('the export clips long answers instead of pasting the transcript', () => {
  const long = 'word '.repeat(400);
  const report = buildSessionReport(
    session([
      { role: 'user', content: 'Explain', createdAt: START },
      { role: 'assistant', content: long, createdAt: START + 1 },
    ]),
  );
  const markdown = renderReportMarkdown(report, { maxEntryChars: 60 });
  const answerLine = markdown.split('\n').find((line) => line.startsWith('word word'));
  assert.ok(answerLine, 'the clipped answer should still be present');
  assert.ok(answerLine!.length <= 60, `expected ≤ 60 chars, got ${answerLine!.length}`);
  assert.ok(answerLine!.endsWith('…'), 'a clipped answer should be marked as clipped');
});
