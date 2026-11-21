/**
 * Web grounding need — Architecture v3 seam.
 *
 * Decides whether one question depends on information that changes after a model's
 * training cutoff. The chat path used a bare keyword regex (`search|latest|company|
 * what is`), which missed real freshness questions ("what are the current best
 * practices for RAG evaluation?") while firing on stable interview answers.
 *
 * Rules:
 *   1. An explicit ask ("search the web…", "look it up") always searches.
 *   2. Personal/behavioural interview answers never search — the résumé in the
 *      prompt is the only source of truth there.
 *   3. In interview mode a question searches only when it carries freshness
 *      signals: time anchors, releases, versions, prices, benchmarks, people,
 *      companies, policy or news. Stable knowledge stays on the model.
 *   4. Meeting/general keep v0.6's always-on behaviour; this module changes the
 *      interview gate, not those modes.
 *   5. The query is cleaned and, for terse follow-ups, anchored to the screen so
 *      "what about this?" is not sent to the search provider verbatim.
 *
 * Pure: no I/O, no clock (the caller injects `now`), so it is unit-testable and
 * usable from the bench.
 */

import type { CopilotMode } from '../types.ts';
import { contentTokens } from './textTokens.ts';

export type WebFreshness = 'live' | 'current' | 'stable';

export type WebNeedInput = {
  question: string;
  mode?: CopilotMode | 'coding';
  /** False when the user picked "Off" in Settings → Web. */
  providerEnabled?: boolean;
  /** Current OCR, used only to turn an anaphoric follow-up into a real query. */
  screenText?: string;
  now?: Date;
};

export type WebNeedDecision = {
  search: boolean;
  freshness: WebFreshness;
  explicit: boolean;
  /** Stable code for the status line, logs and tests. */
  reason:
    | 'empty-question'
    | 'web-search-off'
    | 'explicit-request'
    | 'personal-answer'
    | 'date-time-question'
    | 'freshness-sensitive'
    | 'stable-knowledge'
    | 'mode-always-searches';
  /** The signal labels that matched, best first. */
  signals: string[];
  /** Query to hand to the provider (already cleaned and clipped). */
  query: string;
};

/** A question about the clock is answered from the prompt's device date. */
const DATE_TIME_QUESTION =
  /\b(what('s| is)? (the )?(date|time|day)|what day is (it|today)|today'?s (date|day)|current (date|time))\b/i;

/**
 * Interview answers about the user must never be grounded in web results: the
 * résumé/JD in the prompt is authoritative, and search would add unrelated
 * candidates' answers to the context.
 */
const PERSONAL_ANSWER =
  /\b(tell me about (yourself|a time|a project|a situation)|describe (a time|your|a project)|your (experience|background|greatest|biggest|strength|weakness|project|projects|team|role|career|goals|salary|compensation|expectations|notice period)|why (do|would) you (want|leave|choose)|where do you see yourself|introduce yourself|walk me through your|my (resume|résumé|experience|background|project|projects))\b/i;

/**
 * A direct instruction to use the web. Anchored forms at the start avoid
 * matching "binary search for a value" or "look up the table".
 */
const EXPLICIT_REQUEST =
  /\b(search (the )?(web|internet|online)|web search|check (online|the web|the internet)|browse (the web|online)|look (it|this|that) up|google (it|this|that))\b|^(please\s+)?(search|google|look up)\b/i;

type Signal = { label: string; re: RegExp };

/** Signals that alone are enough to need live data (weight 2). */
const STRONG_SIGNALS: Signal[] = [
  { label: 'latest', re: /\b(latest|newest|most recent|up[- ]to[- ]date)\b/i },
  { label: 'now', re: /\b(right now|at the moment|currently|as of (today|now|\d{4}))\b/i },
  { label: 'time-window', re: /\b(today|tonight|this (week|month|quarter|year)|yesterday)\b/i },
  { label: 'year', re: /\b20[2-3]\d\b/ },
  {
    label: 'release',
    re: /\b(released?|launch(ed|es)?|announc(e|ed|es|ement|ements)|deprecat(e|ed|es|ion)|changelog|roadmap|general availability|end of life|eol)\b/i,
  },
  { label: 'pricing', re: /\b(pricing|price|prices|rate limit|quota|subscription|free tier)\b/i },
  { label: 'benchmark', re: /\b(benchmark|benchmarks|leaderboard|state[- ]of[- ]the[- ]art|sota)\b/i },
  {
    label: 'people-company',
    re: /\b(ceo|cto|founder|acquired|acquisition|merger|ipo|valuation|funding|layoffs?|hiring freeze|stock price|earnings|revenue|market share)\b/i,
  },
  {
    label: 'news',
    re: /\b(news|headlines?|weather|election|who won|regulation|legislation|lawsuit|banned)\b/i,
  },
  {
    label: 'change',
    re: /\bwhat('s| is) new\b|\bwhat changed\b|\bhas (changed|shipped)\b|\bjust (shipped|released|launched|came out)\b/i,
  },
];

/** Contextual signals that need a second hit (weight 1). */
const WEAK_SIGNALS: Signal[] = [
  { label: 'current', re: /\b(current|recent|recently|modern)\b/i },
  { label: 'new', re: /\b(new|newly)\b/i },
  { label: 'best', re: /\b(best|top|leading|popular)\b/i },
  { label: 'compare', re: /\b(compare|comparison|versus|vs\.?)\b/i },
  { label: 'market', re: /\b(market|industry|ecosystem|landscape|trend|trends)\b/i },
  { label: 'company', re: /\b(company|organization|startup)\b/i },
  { label: 'surface', re: /\b(api|sdk|docs?|documentation|framework|library|tooling|model)\b/i },
  { label: 'version', re: /\b(version|versions)\b/i },
  { label: 'cost', re: /\b(cost|costs)\b/i },
];

const YEAR_WORTH_ADDING =
  /\b(latest|newest|current|best|top|version|release|pricing|price|benchmark|state[- ]of[- ]the[- ]art|trend|trends)\b/i;

const FILLER_PREFIX =
  /^(hey|hi|ok|okay|so|please|can you|could you|would you|will you|do you know|tell me|i want to know|i need to know)\b[,\s]*/i;

const SCREEN_TOPIC_SKIP =
  /^(osmos|freebuff|settings|search|new chat|send|assist|mic|system audio|live)\b/i;

function normalize(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSignals(question: string): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  for (const signal of STRONG_SIGNALS) {
    if (!signal.re.test(question)) continue;
    score += 2;
    signals.push(signal.label);
  }
  for (const signal of WEAK_SIGNALS) {
    if (!signal.re.test(question)) continue;
    score += 1;
    signals.push(signal.label);
  }
  return { score, signals };
}

function freshnessFor(score: number): WebFreshness {
  if (score >= 4) return 'live';
  if (score >= 2) return 'current';
  return 'stable';
}

/** First meaningful OCR line, used to resolve "what about this?". */
function topicFromScreen(screenText: string | undefined): string {
  const lines = String(screenText ?? '')
    .split(/\r?\n/)
    .map((line) => normalize(line))
    .filter(Boolean);

  // Titles are often short ("Two Sum", "Q3 roadmap"), so the first few lines
  // get a lower bar than the sentence fallback below.
  for (const line of lines.slice(0, 5)) {
    if (line.length < 6 || SCREEN_TOPIC_SKIP.test(line)) continue;
    const words = line.split(' ').filter((word) => /[a-z0-9]/i.test(word));
    if (words.length >= 2) return line.slice(0, 120);
  }

  for (const line of lines.slice(0, 12)) {
    if (line.length < 12 || SCREEN_TOPIC_SKIP.test(line)) continue;
    const words = line.split(' ').filter((word) => /[a-z0-9]/i.test(word));
    if (words.length < 3) continue;
    return line.slice(0, 120);
  }
  return '';
}

function clipQuery(text: string): string {
  return text.trim().slice(0, 240);
}

/**
 * Turn a question into a provider query: strip filler, drop trailing
 * punctuation, resolve terse follow-ups against the screen, and add the current
 * year to "latest/current" questions that do not name one.
 */
export function buildSearchQuery(
  question: string,
  options: { screenText?: string; now?: Date } = {},
): string {
  let query = normalize(question);
  for (let i = 0; i < 3 && FILLER_PREFIX.test(query); i += 1) {
    query = query.replace(FILLER_PREFIX, '').trim();
  }
  query = query.replace(/[?.!]+$/, '').trim();
  if (!query) return '';

  // A few content words ("what about this?") carry no search intent; the screen
  // usually names the topic the user is pointing at.
  if (contentTokens(query).length < 5) {
    const topic = topicFromScreen(options.screenText);
    if (topic && !query.toLowerCase().includes(topic.toLowerCase())) {
      query = `${query} ${topic}`;
    }
  }

  const year = (options.now ?? new Date()).getFullYear();
  if (YEAR_WORTH_ADDING.test(query) && !/\b20\d\d\b/.test(query)) {
    query = `${query} ${year}`;
  }

  return clipQuery(query);
}

/**
 * Decide whether this question should be grounded in live web results, and with
 * what query. See the module comment for the rules.
 */
export function decideWebSearch(input: WebNeedInput): WebNeedDecision {
  const question = normalize(input.question);
  if (!question) {
    return {
      search: false,
      freshness: 'stable',
      explicit: false,
      reason: 'empty-question',
      signals: [],
      query: '',
    };
  }

  const { score, signals } = scoreSignals(question);
  const freshness = freshnessFor(score);
  const explicit = EXPLICIT_REQUEST.test(question);
  const query = buildSearchQuery(question, {
    ...(input.screenText ? { screenText: input.screenText } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  if (input.providerEnabled === false) {
    return {
      search: false,
      freshness,
      explicit,
      reason: 'web-search-off',
      signals,
      query,
    };
  }

  if (explicit) {
    return { search: true, freshness, explicit: true, reason: 'explicit-request', signals, query };
  }

  if (DATE_TIME_QUESTION.test(question)) {
    return {
      search: false,
      freshness: 'stable',
      explicit: false,
      reason: 'date-time-question',
      signals,
      query,
    };
  }

  if (PERSONAL_ANSWER.test(question)) {
    return {
      search: false,
      freshness: 'stable',
      explicit: false,
      reason: 'personal-answer',
      signals,
      query,
    };
  }

  if (input.mode === 'interview') {
    return {
      search: freshness !== 'stable',
      freshness,
      explicit: false,
      reason: freshness === 'stable' ? 'stable-knowledge' : 'freshness-sensitive',
      signals,
      query,
    };
  }

  // Meeting/general keep v0.6's always-on grounding.
  return { search: true, freshness, explicit: false, reason: 'mode-always-searches', signals, query };
}
