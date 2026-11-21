/**
 * Memory ranking — Architecture v2, §15 / Phase 5.
 *
 * The store answers *what is in memory*; this module answers *which of it is
 * worth putting in front of the model*. It is deliberately additive and
 * explainable: a hit carries its three components, so a bad ranking can be read
 * off the result instead of guessed at from a black-box score.
 *
 * - **lexical** — IDF-weighted coverage of the query's content tokens. Coverage,
 *   not term frequency: a 4,000-word résumé should not outrank a matching
 *   question just because it repeats a word. No lexical hit at all means no hit.
 * - **recency** — a half-life decay, so yesterday's session beats last month's
 *   when both match equally.
 * - **kind** — a small prior: a prepared answer beats a raw transcript line.
 */

import { contentTokens } from './textTokens.ts';
import type { MemoryKind, MemoryRecord } from './memoryMigration.ts';

export type MemoryRankParts = {
  lexical: number;
  recency: number;
  kind: number;
};

export type MemoryRankHit<T extends RankableRecord = MemoryRecord> = {
  record: T;
  score: number;
  parts: MemoryRankParts;
};

export type RankableRecord = {
  id: string;
  at: number;
  kind: string;
  text: string;
  title?: string;
};

export type MemoryRankOptions = {
  limit?: number;
  /** Reference time for recency; defaults to `Date.now()`. Pass a fixed value in tests. */
  now?: number;
  /** Age at which the recency term halves. */
  halfLifeMs?: number;
  kindWeights?: Partial<Record<MemoryKind, number>>;
};

export const MEMORY_RANK_DEFAULTS = {
  limit: 5,
  halfLifeMs: 14 * 24 * 60 * 60 * 1000,
} as const;

const DEFAULT_KIND_WEIGHTS: Record<MemoryKind, number> = {
  question: 1.2,
  star: 1.1,
  message: 1,
  document: 0.8,
  session: 0.6,
};

const WEIGHTS = { lexical: 0.7, recency: 0.2, kind: 0.1 } as const;

function unique(tokens: ReadonlyArray<string>): string[] {
  return [...new Set(tokens)];
}

function haystack(record: RankableRecord): string {
  return record.title ? `${record.title} ${record.text}` : record.text;
}

/**
 * Rank `records` against `query`. With an empty query every record is eligible
 * and ordering is recency first, which is what an "open memory" panel wants.
 */
export function rankMemories<T extends RankableRecord>(
  records: ReadonlyArray<T>,
  query: string,
  options: MemoryRankOptions = {},
): Array<MemoryRankHit<T>> {
  const limit = Math.max(0, options.limit ?? MEMORY_RANK_DEFAULTS.limit);
  if (!records.length || limit === 0) return [];

  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();
  const halfLife = Math.max(1, options.halfLifeMs ?? MEMORY_RANK_DEFAULTS.halfLifeMs);
  const kindWeights = { ...DEFAULT_KIND_WEIGHTS, ...(options.kindWeights ?? {}) };
  const maxKindWeight = Math.max(...Object.values(kindWeights), 1);

  const queryTokens = unique(contentTokens(query));
  const tokenCache = new Map<string, Set<string>>();
  const tokensOf = (record: T): Set<string> => {
    let tokens = tokenCache.get(record.id);
    if (!tokens) {
      tokens = new Set(contentTokens(haystack(record)));
      tokenCache.set(record.id, tokens);
    }
    return tokens;
  };

  // Document frequency over the candidate set — cheap at personal scale, and it
  // keeps the ranking independent of any corpus the caller did not hand us.
  const documentFrequency = new Map<string, number>();
  for (const record of records) {
    for (const token of tokensOf(record)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const idf = (token: string): number => {
    const df = documentFrequency.get(token) ?? 0;
    return Math.log(1 + records.length / (1 + df));
  };

  const maxLexical = queryTokens.reduce((sum, token) => sum + idf(token), 0) || 1;

  const hits: Array<MemoryRankHit<T>> = [];
  for (const record of records) {
    const tokens = tokensOf(record);

    let lexical = 0;
    for (const token of queryTokens) {
      if (tokens.has(token)) lexical += idf(token);
    }
    lexical = lexical / maxLexical;

    if (queryTokens.length > 0 && lexical === 0) continue;

    const age = Math.max(0, now - Number(record.at || 0));
    const recency = Number.isFinite(age) ? Math.pow(2, -age / halfLife) : 0;
    const kindWeight = kindWeights[record.kind as MemoryKind] ?? 0.5;
    const kind = kindWeight / maxKindWeight;

    hits.push({
      record,
      score: WEIGHTS.lexical * lexical + WEIGHTS.recency * recency + WEIGHTS.kind * kind,
      parts: { lexical, recency, kind },
    });
  }

  hits.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
  return hits.slice(0, limit);
}
