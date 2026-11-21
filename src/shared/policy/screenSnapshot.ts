/**
 * Screen snapshot classification — Architecture v2, §12 (vision path).
 *
 * Phase 4 needs one answer to "what is on the screen" before it can decide
 * whether an image is required and which instruction the screen section should
 * carry. The OCR text is already there (§12: OCR as an async text path), so this
 * stays a cheap text classifier rather than a model call: a cloud vision model
 * is only demanded when the text is genuinely not enough — a code or problem
 * snapshot, where indentation, brackets and the exact failing line matter.
 *
 * Heuristics, not a learned model. The measured recall on the labelled fixture
 * set in `bench/fixtures/screen/labelled.jsonl` is the contract (§13.2), and a
 * misclassification changes routing, so add a fixture with any new rule instead
 * of widening a pattern on a hunch.
 */

export type SnapshotKind =
  | 'code'
  | 'terminal'
  | 'error'
  | 'slide'
  | 'chat'
  | 'document'
  | 'unknown';

export type SnapshotClassification = {
  kind: SnapshotKind;
  /** 0..1 — how much signal the winning kind collected. */
  confidence: number;
  /** §8.2 hard rule: the answer needs a vision-capable lane. */
  requiresVision: boolean;
  /** Prompt line for the screen section, or '' when there is nothing to add. */
  hint: string;
};

const HINTS: Record<SnapshotKind, string> = {
  code: 'This snapshot is code or a problem statement: explain the bug briefly, then give working code in one block.',
  terminal:
    'This snapshot is a terminal session: read the command and its output, then explain the failure and the fix.',
  error: 'This snapshot is an error dialog or trace: name the error, then give the fix.',
  slide: 'This snapshot is a slide: answer from it and keep any quoted line short.',
  chat: 'This snapshot is a chat or transcript: names are speakers, not code or commands.',
  document: 'This snapshot is a document: answer from it and cite the heading when there is one.',
  unknown: '',
};

type Rule = { kind: SnapshotKind; pattern: RegExp; weight: number };

/** Weighted hints. Each rule counts once, however often it matches. */
const RULES: readonly Rule[] = [
  // Code
  { kind: 'code', pattern: /\b(function|class|interface|struct|enum|impl|fn|def|func)\s+\w+/i, weight: 1.5 },
  { kind: 'code', pattern: /\b(const|let|var|val|auto)\s+\w+\s*[:=]/, weight: 1.5 },
  { kind: 'code', pattern: /=>|===|!==|[{}[\]]\s*$/m, weight: 1 },
  { kind: 'code', pattern: /\b(console\.log|printf|System\.out|print\()/, weight: 1 },
  { kind: 'code', pattern: /\b(public|private|protected|static|void|return)\s/, weight: 0.75 },
  { kind: 'code', pattern: /\bimport\s+[\w{*]+.*\bfrom\b|\bimport\s+\w+(\.\w+)+/, weight: 1 },
  // Problem statements use these labels, and they look like speaker lines.
  { kind: 'code', pattern: /^\s*(Input|Output|Example \d+|Constraints|Explanation):/im, weight: 1.5 },

  // Terminal
  { kind: 'terminal', pattern: /^\s*(\$|>|%|PS [A-Z]:\\|C:\\[^>\n]*>)\s/m, weight: 1.5 },
  { kind: 'terminal', pattern: /(npm ERR!|npm error|command not found|Segmentation fault|Traceback \(most recent call last\))/i, weight: 2 },
  { kind: 'terminal', pattern: /^\s*at\s+[\w.$<>]+\s*\(/m, weight: 1.5 },
  { kind: 'terminal', pattern: /\bexit code\b/i, weight: 1 },

  // Error surfaces
  { kind: 'error', pattern: /\b(TypeError|ReferenceError|SyntaxError|RangeError|ValueError|NullPointerException|ErrorException)\b|\bError:|^Error\b/m, weight: 1.5 },
  { kind: 'error', pattern: /\b(Uncaught|Unhandled|Exception in thread|failed|could not|unable to|cannot read propert)/i, weight: 1 },
  { kind: 'error', pattern: /\b(retry|cancel|dismiss)\b[\s\S]*\b(retry|cancel|dismiss)\b/i, weight: 0.75 },

  // Slides
  { kind: 'slide', pattern: /\b(agenda|roadmap|takeaways|next steps|okrs?|q[1-4])\b/i, weight: 1.5 },
  { kind: 'slide', pattern: /^\s*\d+[.)]\s+\S/m, weight: 0.75 },

  // Documents
  { kind: 'document', pattern: /\b(table of contents|executive summary|abstract|appendix|section \d)\b/i, weight: 1.5 },
  { kind: 'document', pattern: /^#{1,6}\s/m, weight: 1.5 },
];

/** A snapshot with this few signals is not classified by the rules alone. */
const MIN_SCORE = 1.5;
/** Prose this long is a document even when no rule fires. */
const DOCUMENT_MIN_WORDS = 45;
const DOCUMENT_MIN_SENTENCES = 3;

/** Speaker labels. Form labels and problem-statement labels are not speakers. */
const SPEAKER_LINE =
  /^(?!Input|Output|Example|Constraints|Explanation|Note|Warning|Error|Owner|Agenda|Step)[A-Z][A-Za-z.'’-]{1,20}:\s/m;
const BULLET_LINE = /^[ \t]*[•·▪◦]\s/m;

function countMatches(pattern: RegExp, text: string): number {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return (text.match(global) ?? []).length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function result(kind: SnapshotKind, score: number): SnapshotClassification {
  return {
    kind,
    confidence: round(Math.min(1, score / 3)),
    requiresVision: kind === 'code',
    hint: HINTS[kind],
  };
}

/** Classify the OCR text of a screen snapshot (§12). Pure. */
export function classifySnapshot(ocrText?: string): SnapshotClassification {
  const text = (ocrText ?? '').trim();
  if (!text) return { kind: 'unknown', confidence: 0, requiresVision: false, hint: '' };

  const scores = new Map<SnapshotKind, number>();
  const bump = (kind: SnapshotKind, weight: number) => {
    scores.set(kind, (scores.get(kind) ?? 0) + weight);
  };

  for (const rule of RULES) {
    if (rule.pattern.test(text)) bump(rule.kind, rule.weight);
  }

  // Speaker labels only mean "chat" when several of them are present: a single
  // "Owner: Priya" line is a slide, not a conversation.
  const speakerLines = countMatches(SPEAKER_LINE, text);
  if (speakerLines >= 2) bump('chat', 2);
  else if (speakerLines === 1) bump('chat', 0.5);

  // One bullet is a stray glyph; several are a slide (a single mention of
  // "roadmap" is already enough on its own).
  const bulletLines = countMatches(BULLET_LINE, text);
  if (bulletLines >= 2) bump('slide', 1.5);
  else if (bulletLines === 1) bump('slide', 1);

  let bestKind: SnapshotKind = 'unknown';
  let bestScore = 0;
  for (const kind of ['code', 'terminal', 'error', 'slide', 'chat', 'document'] as const) {
    const score = scores.get(kind) ?? 0;
    // Strictly greater keeps the priority order above on ties: code wins a tie
    // with terminal, which is the safer choice for routing (§8.2 hard rule).
    if (score > bestScore) {
      bestScore = score;
      bestKind = kind;
    }
  }

  if (bestScore >= MIN_SCORE) return result(bestKind, bestScore);

  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = countMatches(/[.!?](\s|$)/, text);
  if (words >= DOCUMENT_MIN_WORDS && sentences >= DOCUMENT_MIN_SENTENCES) {
    return result('document', 1.5);
  }

  return result('unknown', bestScore);
}

/** True when the snapshot is code or a problem statement (§12 hard rule). */
export function looksLikeCodeScreen(text?: string): boolean {
  return classifySnapshot(text).kind === 'code';
}
