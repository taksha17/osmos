/**
 * OSMOS hybrid router — MIT reimplementation of Lumen Stream Lab's keyword
 * tier ideas (fast / balanced / quality). Does not import the Lumen lab.
 *
 * Goal: short / low-stakes prompts → instant local model; interview / long /
 * complex prompts → the user's configured quality provider (cloud or large Ollama).
 */

export type RouteTier = 'fast' | 'balanced' | 'quality';

export type RouteDecision = {
  tier: RouteTier;
  reason: string;
  /** Prefer draft-then-upgrade when quality is selected and a fast lane exists. */
  preferUpgrade: boolean;
};

const QUALITY_MIN_WORDS = 50;
const QUALITY_KEYWORD_MIN_WORDS = 35;

/** Interview / meeting stakes — always prefer the quality lane. */
const HIGH_STAKES_KEYWORDS = [
  'tell me about yourself',
  'tell me about a time',
  'walk me through',
  'behavioral',
  'star method',
  'system design',
  'whiteboard',
  'coding challenge',
  'leetcode',
  'what should i say',
  'how should i answer',
  'interview question',
  'salary',
  'negotiate',
  'weakness',
  'strengths',
  'why should we hire',
  'why do you want',
] as const;

const QUALITY_KEYWORDS = [
  'detailed',
  'comprehensive',
  'thorough',
  'in-depth',
  'in depth',
  'essay',
  'code review',
  'design a system',
  'best answer',
  'high quality',
  'expert',
  'research',
  'proofread',
  'refactor',
  'production-grade',
  'step by step',
] as const;

const COMPLEX_KEYWORDS = [
  'explain',
  'analyze',
  'compare',
  'describe',
  'why',
  'how does',
  'algorithm',
  'architecture',
  'implement',
  'debug',
  'pros and cons',
  'summarize',
  'difference between',
  'trade-off',
  'tradeoff',
] as const;

const SIMPLE_PATTERNS = [
  /^\s*what is \d+\s*[+\-*/]\s*\d+/i,
  /^\s*\d+\s*[+\-*/]\s*\d+\s*\??\s*$/,
  /^(hi|hello|hey)\b/i,
  /^(yes|no|thanks|thank you|ok|okay)\b/i,
  /^\s*capital of\b/i,
] as const;

function kwMatch(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

export type RouteHints = {
  /** Copilot mode from settings. */
  mode?: 'interview' | 'meeting' | 'general';
  /** Fresh screen OCR attached — treat as higher stakes. */
  hasScreen?: boolean;
  /** Force a tier (Settings / debug). */
  forceTier?: RouteTier | 'auto';
};

/**
 * Decide which lane should answer this prompt.
 * Pure function — safe to call from main or renderer.
 */
export function routeDecision(prompt: string, hints: RouteHints = {}): RouteDecision {
  const text = (prompt || '').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const force = hints.forceTier && hints.forceTier !== 'auto' ? hints.forceTier : null;

  if (force) {
    return {
      tier: force,
      reason: `forced tier=${force}`,
      preferUpgrade: force === 'quality' || force === 'balanced',
    };
  }

  for (const pat of SIMPLE_PATTERNS) {
    if (pat.test(text)) {
      return { tier: 'fast', reason: 'simple pattern match', preferUpgrade: false };
    }
  }

  if (kwMatch(text, HIGH_STAKES_KEYWORDS) || hints.mode === 'interview') {
    // Interview mode defaults to quality unless the prompt is tiny chitchat.
    if (hints.mode === 'interview' && words <= 6 && !kwMatch(text, HIGH_STAKES_KEYWORDS)) {
      return {
        tier: 'balanced',
        reason: `interview short (${words} words)`,
        preferUpgrade: true,
      };
    }
    return {
      tier: 'quality',
      reason: hints.mode === 'interview' ? 'interview mode' : 'high-stakes keyword',
      preferUpgrade: true,
    };
  }

  if (hints.hasScreen && words > 4) {
    return {
      tier: 'quality',
      reason: 'screen context attached',
      preferUpgrade: true,
    };
  }

  if (words > QUALITY_MIN_WORDS || (words > QUALITY_KEYWORD_MIN_WORDS && kwMatch(text, QUALITY_KEYWORDS))) {
    return {
      tier: 'quality',
      reason: `quality/long (${words} words)`,
      preferUpgrade: true,
    };
  }

  if (words <= 12 && !kwMatch(text, COMPLEX_KEYWORDS)) {
    return { tier: 'fast', reason: `short/simple (${words} words)`, preferUpgrade: false };
  }

  if (kwMatch(text, COMPLEX_KEYWORDS) || words > 20) {
    return { tier: 'balanced', reason: 'complex / medium length', preferUpgrade: true };
  }

  return { tier: 'balanced', reason: 'default balanced', preferUpgrade: true };
}

/** Human label for overlay status. */
export function routeTierLabel(tier: RouteTier): string {
  switch (tier) {
    case 'fast':
      return 'Quick local';
    case 'balanced':
      return 'Balanced';
    case 'quality':
      return 'Full model';
  }
}
