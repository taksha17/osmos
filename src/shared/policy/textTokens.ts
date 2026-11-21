/**
 * One tokenizer for every policy module that scores text.
 *
 * `contextBudget.ts` grew the first copy of this (Phase 3); `memoryRanking.ts`
 * needs the identical rules, and two silently different tokenizers would make a
 * retrieval score and a budget score incomparable. Keep the rules here only.
 */

export const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'do', 'does', 'did',
  'you', 'your', 'yours', 'i', 'me', 'my', 'we', 'our', 'they', 'them', 'their', 'it',
  'its', 'to', 'of', 'and', 'or', 'but', 'in', 'on', 'at', 'for', 'with', 'that', 'this',
  'these', 'those', 'what', 'how', 'why', 'when', 'where', 'who', 'which', 'about', 'so',
  'if', 'then', 'than', 'there', 'here', 'as', 'by', 'from', 'can', 'could', 'would',
]);

/** Content tokens: lowercased, punctuation-stripped, stopwords and 1-char tokens removed. */
export function contentTokens(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}
