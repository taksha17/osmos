/**
 * Question-bank matcher for profile-harnessed local routing.
 *
 * Pure helper (no Electron/Node imports) so main and renderer can share it.
 * Normalization mirrors `stripOverlayEcho` in `screenContext.ts`: lowercase,
 * non-alphanumerics → space, keep tokens of 3+ characters.
 */

import type { QuestionBankItem } from './types.js';

/** Minimum overlap coefficient before a bank entry is considered "the same question". */
export const QUESTION_BANK_SIMILARITY_THRESHOLD = 0.5;

/** Guard against matching on a single generic word ("salary", "you"). */
export const QUESTION_BANK_MIN_SHARED_TOKENS = 2;

export type QuestionBankMatch = { item: QuestionBankItem; similarity: number };

function tokenSet(text: string): Set<string> {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return new Set();
  return new Set(normalized.split(' ').filter((t) => t.length >= 3));
}

/**
 * Find the saved bank entry that best matches an incoming question.
 * Score is the overlap coefficient |A ∩ B| / min(|A|, |B|) — tolerant of a
 * paraphrase that drops or adds a few words, independent of bank entry length.
 */
export function matchQuestionBank(
  incoming: string,
  bank: QuestionBankItem[],
): QuestionBankMatch | null {
  const incomingTokens = tokenSet(incoming);
  if (incomingTokens.size === 0) return null;
  if (!Array.isArray(bank) || bank.length === 0) return null;

  let best: QuestionBankMatch | null = null;
  for (const item of bank) {
    if (!item || typeof item.question !== 'string') continue;
    const entryTokens = tokenSet(item.question);
    if (entryTokens.size === 0) continue;

    let shared = 0;
    for (const token of entryTokens) {
      if (incomingTokens.has(token)) shared += 1;
    }
    if (shared < QUESTION_BANK_MIN_SHARED_TOKENS) continue;

    const similarity = shared / Math.min(entryTokens.size, incomingTokens.size);
    if (similarity < QUESTION_BANK_SIMILARITY_THRESHOLD) continue;
    if (!best || similarity > best.similarity) best = { item, similarity };
  }

  return best;
}
