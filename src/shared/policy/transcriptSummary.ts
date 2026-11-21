/**
 * Session summary — Architecture v2, §15 / Phase 5.
 *
 * The exit row asks for a summary of a 30-minute transcript in ≤ 60 s locally.
 * Getting there is mostly a context problem: a 4,500-word meeting fits one small
 * model's window easily *if* the input is signals (questions, decisions, actions)
 * rather than every filler word. This module does that reduction deterministically
 * and builds the prompt, so the only variable left to measure is the model.
 *
 * Pure: no clock, no I/O. The bench drives it, the app can too.
 */

export type SummaryLine = { who: string; text: string };

export type SummaryStats = {
  lines: number;
  included: number;
  chars: number;
  words: number;
};

export type SummaryExtraction = {
  /** Speaker-labelled transcript, clipped to `maxChars`. */
  transcript: string;
  questions: string[];
  decisions: string[];
  actions: string[];
  stats: SummaryStats;
};

export type SummaryPrompt = { system: string; user: string };

const QUESTION_START =
  /^(can|could|would|should|do|does|did|is|are|was|were|will|how|what|when|where|who|which|why)\b/i;
const DECISION = /\b(we (?:decided|agreed|are going to|will)|let'?s|final (?:decision|call)|the plan is)\b/i;
const ACTION = /\b(i'?ll|we'?ll|will (?:send|share|follow up|schedule|check|prepare)|action item|follow up|todo|by (?:monday|tuesday|wednesday|thursday|friday|next week|eod|tomorrow))\b/i;

const MAX_PER_BUCKET = 8;

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function push(list: string[], text: string): void {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  const key = norm(cleaned);
  if (list.some((entry) => norm(entry) === key)) return;
  if (list.length >= MAX_PER_BUCKET) return;
  list.push(cleaned);
}

function who(who: string): string {
  const label = String(who ?? '').trim();
  if (!label) return 'speaker';
  if (label === 'me') return 'me';
  return label;
}

/**
 * Reduce a meeting transcript to what a summary needs: the clipped transcript
 * plus the questions, decisions and action items found in it.
 */
export function extractSessionSignals(
  lines: ReadonlyArray<SummaryLine>,
  options: { maxChars?: number } = {},
): SummaryExtraction {
  const maxChars = Math.max(200, options.maxChars ?? 12_000);
  const questions: string[] = [];
  const decisions: string[] = [];
  const actions: string[] = [];

  const rendered: string[] = [];
  let used = 0;
  let words = 0;

  for (const line of lines) {
    const text = String(line?.text ?? '').trim();
    if (!text) continue;

    if (/\?$/.test(text) || QUESTION_START.test(text)) push(questions, text);
    if (DECISION.test(text)) push(decisions, text);
    if (ACTION.test(text)) push(actions, text);

    const entry = `${who(line.who)}: ${text}`;
    // Stop adding once the budget is reached, but keep scanning for signals:
    // a decision at minute 29 still matters even if its line is clipped.
    if (used + entry.length + 1 <= maxChars) {
      rendered.push(entry);
      used += entry.length + 1;
      words += text.split(/\s+/).length;
    }
  }

  return {
    transcript: rendered.join('\n'),
    questions,
    decisions,
    actions,
    stats: { lines: lines.length, included: rendered.length, chars: used, words },
  };
}

/** Prompt for the summarising model. Small on purpose: signals, then transcript. */
export function buildSummaryPrompt(extraction: SummaryExtraction): SummaryPrompt {
  const section = (title: string, items: string[]) =>
    items.length ? `\n${title}:\n${items.map((item) => `- ${item}`).join('\n')}\n` : '';

  const system = [
    'You summarise meetings for the person who was in them.',
    'Use only what the transcript and extracted items contain; never invent names, numbers or outcomes.',
    'Group the result under Decisions, Open questions and Action items, then add a two-sentence overview.',
    'Keep it under 250 words.',
  ].join(' ');

  const user = [
    `Meeting transcript${extraction.stats.included < extraction.stats.lines ? ' (excerpt)' : ''}:`,
    extraction.transcript || '(no transcript)',
    section('Questions detected', extraction.questions),
    section('Decisions detected', extraction.decisions),
    section('Action items detected', extraction.actions),
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}
