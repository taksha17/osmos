import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchQuestionBank,
  QUESTION_BANK_SIMILARITY_THRESHOLD,
  QUESTION_BANK_MIN_SHARED_TOKENS,
} from './questionBank.ts';
import type { QuestionBankItem } from './types.ts';

const item = (question: string, answer?: string): QuestionBankItem => ({
  id: 'q1',
  companyName: 'Acme',
  question,
  category: 'behavioral',
  difficulty: 'medium',
  tags: [],
  createdAt: 0,
  ...(answer !== undefined ? { answer } : {}),
});

test('exact match returns similarity 1 and surfaces answer', () => {
  const m = matchQuestionBank('Tell me about yourself', [item('Tell me about yourself', 'I build things.')]);
  assert.ok(m);
  assert.equal(m.similarity, 1);
  assert.equal(m.item.answer, 'I build things.');
});

test('paraphrase with synonym swap still matches at threshold', () => {
  // shared {what, your, strength} / min set size 4 = 0.75
  const m = matchQuestionBank('What is your biggest strength?', [item('What is your greatest strength?')]);
  assert.ok(m);
  assert.ok(m.similarity >= QUESTION_BANK_SIMILARITY_THRESHOLD);
});

test('unrelated question does not match', () => {
  assert.equal(matchQuestionBank('Explain the CAP theorem', [item('What is your favorite language?')]), null);
});

test('degenerate short entry and empty bank return null without crashing', () => {
  assert.equal(matchQuestionBank('What is the salary range?', [item('Salary?')]), null);
  assert.equal(matchQuestionBank('Anything', []), null);
});

test('best match wins across multiple entries', () => {
  const bank = [item('Explain microservices'), item('Why do you want to work here?')];
  const m = matchQuestionBank('Why do you want this job?', bank);
  assert.ok(m);
  assert.equal(m.item.question, 'Why do you want to work here?');
  assert.ok(m.similarity >= QUESTION_BANK_MIN_SHARED_TOKENS / 5);
});
