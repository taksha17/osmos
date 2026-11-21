/**
 * Context Engine — Architecture v2, §7.2.
 *
 * Builds the `ContextPacket` for one request. Pure: no Electron, no I/O and no
 * clock, so the bench can replay packets and the unit tests can pin every
 * budgeting rule.
 *
 * Trimming rule (§7.2): each section has a fixed token budget, and what survives
 * is chosen by relevance — recency plus question overlap for the transcript,
 * score for retrieved chunks, overlap for profile facts. Text is cut on a
 * sentence or word boundary, never mid-token.
 *
 * Tokenization lives in `textTokens.ts` so the memory ranking scores text the
 * same way this budget does.
 * The packet is the input the prompt builder will consume in §7.2's "only place
 * prompts are assembled"; it carries raw context, not prompt text.
 */

import type { CopilotMode } from '../types.ts';
import { contentTokens } from './textTokens.ts';

/** Copilot modes plus the first-class coding mode from §12. */
export type ContextMode = CopilotMode | 'coding';

export type ContextBudget = {
  question: number;
  transcript: number;
  profile: number;
  retrieved: number;
  screen: number;
};

/** §7.2's example budgets: transcript 800, profile 600, retrieved 800, screen 600. */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  question: 300,
  transcript: 800,
  profile: 600,
  retrieved: 800,
  screen: 600,
};

/** One earlier screen snapshot, clipped, for coding-mode follow-ups (§12). */
export type ScreenHistoryEntry = { at: number; kind?: string; ocrText: string };

export type ContextPacket = {
  mode: ContextMode;
  question: { text: string; speaker: string; isFinal: boolean };
  recentTranscript: Array<{ who: string; text: string }>;
  screen?: {
    snapshotId: string;
    includeImage: boolean;
    ocrText?: string;
    /** Older snapshots, oldest first; never more than 40 % of the screen budget. */
    previous?: ScreenHistoryEntry[];
  };
  profile?: { resumeFacts: string[]; jdFacts: string[]; companyIntel?: string };
  bankMatch?: { questionId: string; answer: string; score: number };
  retrieved?: Array<{ source: string; text: string; score: number }>;
  constraints: {
    maxSpokenSeconds: number;
    language: string;
    format: 'speakable' | 'bullets' | 'code';
  };
  /** Tokens per section after budgeting — telemetry for the benchmark report. */
  usage: {
    question: number;
    transcript: number;
    profile: number;
    retrieved: number;
    screen: number;
    total: number;
  };
};

export type ContextPacketInput = {
  mode: ContextMode;
  question: { text: string; speaker?: string; isFinal?: boolean };
  transcript?: ReadonlyArray<{ who: string; text: string }>;
  screen?: {
    snapshotId: string;
    includeImage?: boolean;
    ocrText?: string;
    previous?: ReadonlyArray<ScreenHistoryEntry>;
  };
  profile?: { resumeFacts?: string[]; jdFacts?: string[]; companyIntel?: string };
  bankMatch?: { questionId: string; answer: string; score: number };
  retrieved?: ReadonlyArray<{ source: string; text: string; score: number }>;
  language?: string;
  format?: 'speakable' | 'bullets' | 'code';
  maxSpokenSeconds?: number;
};

/** Rough token estimate (4 chars per token) — good enough for budget trimming. */
export function estimateTokens(text: string): number {
  const t = String(text ?? '').trim();
  return t ? Math.ceil(t.length / 4) : 0;
}

/**
 * Cut `text` to at most `maxTokens`, preferring the last sentence boundary and
 * falling back to the last word boundary. Returns '' when the budget is 0.
 */
export function clipToTokens(text: string, maxTokens: number): string {
  const t = String(text ?? '').trim();
  if (!t || maxTokens <= 0) return '';
  if (estimateTokens(t) <= maxTokens) return t;

  const maxChars = maxTokens * 4;
  const window = t.slice(0, maxChars);
  let boundary = -1;
  for (const marker of ['. ', '? ', '! ', '.\n', '?\n', '!\n']) {
    boundary = Math.max(boundary, window.lastIndexOf(marker));
  }
  // Only trust a sentence break if it keeps most of the budget; otherwise a
  // pathological early period would throw away the useful text.
  if (boundary >= maxChars * 0.5) return window.slice(0, boundary + 1).trim();

  const space = window.lastIndexOf(' ');
  return (space > 0 ? window.slice(0, space) : window).trim();
}

function overlap(text: string, questionTokens: ReadonlySet<string>): number {
  if (questionTokens.size === 0) return 0;
  let hits = 0;
  for (const token of new Set(contentTokens(text))) {
    if (questionTokens.has(token)) hits += 1;
  }
  return hits;
}

/**
 * Pick the transcript window that fits `budget`, weighted by recency and overlap
 * with the question, then return it in conversation order.
 */
export function selectTranscript(
  lines: ReadonlyArray<{ who: string; text: string }>,
  budget: number,
  question: string,
): Array<{ who: string; text: string }> {
  if (!lines.length || budget <= 0) return [];
  const questionTokens = new Set(contentTokens(question));

  const scored = lines.map((line, index) => ({
    line,
    index,
    // Recency dominates (a meeting moves on), overlap breaks ties.
    score: (index + 1) / lines.length + overlap(line.text, questionTokens) * 0.5,
    tokens: estimateTokens(line.text),
  }));

  scored.sort((a, b) => b.score - a.score || b.index - a.index);

  const keep = new Set<number>();
  let used = 0;
  for (const item of scored) {
    if (used + item.tokens > budget) continue;
    keep.add(item.index);
    used += item.tokens;
  }

  return scored
    .filter((item) => keep.has(item.index))
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      who: item.line.who,
      text: clipToTokens(item.line.text, budget),
    }));
}

/** Facts ranked by overlap with the question, then in their original order. */
function budgetFacts(facts: readonly string[], budget: number, question: string): string[] {
  if (!facts.length || budget <= 0) return [];
  const questionTokens = new Set(contentTokens(question));
  const scored = facts.map((fact, index) => ({
    fact: clipToTokens(fact, budget),
    index,
    score: overlap(fact, questionTokens),
    tokens: estimateTokens(fact),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const keep = new Set<number>();
  let used = 0;
  for (const item of scored) {
    if (used + item.tokens > budget) continue;
    keep.add(item.index);
    used += item.tokens;
  }
  return scored
    .filter((item) => keep.has(item.index))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.fact);
}

/**
 * Assemble a ContextPacket for one request (§7.2).
 *
 * Sections that exceed budget are trimmed by relevance; sections that fit are
 * passed through whole. `usage.total` never exceeds the sum of the budgets.
 */
export function buildContextPacket(
  input: ContextPacketInput,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): ContextPacket {
  const questionText = clipToTokens(input.question?.text ?? '', budget.question);

  const recentTranscript = selectTranscript(
    input.transcript ?? [],
    budget.transcript,
    questionText,
  );

  let profile: ContextPacket['profile'];
  if (input.profile) {
    profile = {
      resumeFacts: budgetFacts(input.profile.resumeFacts ?? [], budget.profile, questionText),
      jdFacts: budgetFacts(input.profile.jdFacts ?? [], budget.profile, questionText),
      ...(input.profile.companyIntel
        ? { companyIntel: clipToTokens(input.profile.companyIntel, budget.profile) }
        : {}),
    };
  }

  let screen: ContextPacket['screen'];
  if (input.screen) {
    // §12: history helps in coding mode but must never crowd out the snapshot the
    // question is about, so it may take at most 40 % of the screen budget.
    const previousInput = input.screen.previous ?? [];
    const previousBudget = previousInput.length > 0 ? Math.floor(budget.screen * 0.4) : 0;
    const currentBudget = Math.max(0, budget.screen - previousBudget);

    const previous: ScreenHistoryEntry[] = [];
    if (previousBudget > 0) {
      let used = 0;
      // Newest first while choosing, then restored to chronological order.
      for (const item of [...previousInput].sort((a, b) => b.at - a.at)) {
        const text = clipToTokens(item.ocrText ?? '', Math.min(200, previousBudget));
        const tokens = estimateTokens(text);
        if (!text || used + tokens > previousBudget) continue;
        previous.push({
          at: item.at,
          ...(item.kind ? { kind: item.kind } : {}),
          ocrText: text,
        });
        used += tokens;
      }
      previous.sort((a, b) => a.at - b.at);
    }

    screen = {
      snapshotId: input.screen.snapshotId,
      includeImage: input.screen.includeImage === true,
      ...(input.screen.ocrText
        ? { ocrText: clipToTokens(input.screen.ocrText, currentBudget) }
        : {}),
      ...(previous.length > 0 ? { previous } : {}),
    };
  }

  let retrieved: ContextPacket['retrieved'];
  if (input.retrieved?.length) {
    const sorted = [...input.retrieved].sort((a, b) => b.score - a.score);
    const kept: Array<{ source: string; text: string; score: number }> = [];
    let used = 0;
    for (const chunk of sorted) {
      const text = clipToTokens(chunk.text, budget.retrieved);
      const tokens = estimateTokens(text);
      if (used + tokens > budget.retrieved) continue;
      kept.push({ source: chunk.source, text, score: chunk.score });
      used += tokens;
    }
    if (kept.length) retrieved = kept;
  }

  const bankMatch = input.bankMatch
    ? {
        questionId: input.bankMatch.questionId,
        answer: clipToTokens(input.bankMatch.answer, budget.retrieved),
        score: input.bankMatch.score,
      }
    : undefined;

  const usage = {
    question: estimateTokens(questionText),
    transcript: recentTranscript.reduce((sum, line) => sum + estimateTokens(line.text), 0),
    profile: profile
      ? [...(profile.resumeFacts ?? []), ...(profile.jdFacts ?? [])].reduce(
          (sum, fact) => sum + estimateTokens(fact),
          0,
        ) + estimateTokens(profile.companyIntel ?? '')
      : 0,
    retrieved:
      (retrieved ?? []).reduce((sum, chunk) => sum + estimateTokens(chunk.text), 0) +
      estimateTokens(bankMatch?.answer ?? ''),
    screen:
      estimateTokens(screen?.ocrText ?? '') +
      (screen?.previous ?? []).reduce((sum, entry) => sum + estimateTokens(entry.ocrText), 0),
    total: 0,
  };
  usage.total =
    usage.question + usage.transcript + usage.profile + usage.retrieved + usage.screen;

  return {
    mode: input.mode,
    question: {
      text: questionText,
      speaker: input.question?.speaker ?? 'them',
      isFinal: input.question?.isFinal !== false,
    },
    recentTranscript,
    ...(screen ? { screen } : {}),
    ...(profile ? { profile } : {}),
    ...(bankMatch ? { bankMatch } : {}),
    ...(retrieved ? { retrieved } : {}),
    constraints: {
      maxSpokenSeconds: input.maxSpokenSeconds ?? (input.mode === 'coding' ? 90 : 45),
      language: input.language ?? 'en',
      format: input.format ?? (input.mode === 'coding' ? 'code' : 'speakable'),
    },
    usage,
  };
}
