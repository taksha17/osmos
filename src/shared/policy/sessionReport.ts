/**
 * Session report — Architecture v2, §15 / Phase 5.
 *
 * Phase 5 promises a `SessionReport` and exports. The store does not exist yet,
 * but the report itself is pure arithmetic over a session, so it can be written
 * and pinned now: pair each user turn with the answer that followed it, keep the
 * ones that never got one, and render a markdown export.
 *
 * Nothing here invents content: an empty answer stays `empty`, an unanswered
 * question stays `unanswered`. A report that quietly dropped either would look
 * better than the session was.
 */

import type { ChatSession } from '../types.ts';

export type ReportEntryStatus = 'answered' | 'empty' | 'unanswered';

export type ReportEntry = {
  at: number;
  question: string;
  answer: string;
  status: ReportEntryStatus;
  /** Assistant answer arrived this long after the question, when it arrived. */
  latencyMs?: number;
};

export type SessionReportMetrics = {
  turns: number;
  questions: number;
  answered: number;
  empty: number;
  unanswered: number;
  /** Assistant messages that had no question to answer. */
  orphanAnswers: number;
  avgAnswerChars: number;
};

export type SessionReport = {
  sessionId: string;
  mode: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  entries: ReportEntry[];
  metrics: SessionReportMetrics;
};

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Pair user turns with the assistant reply that followed. A second user turn
 * before any reply closes the previous one as `unanswered` rather than merging
 * two questions into one answer.
 */
export function buildSessionReport(session: ChatSession): SessionReport {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const entries: ReportEntry[] = [];
  let orphanAnswers = 0;

  let pending: { question: string; at: number } | null = null;

  for (const message of messages) {
    const content = clean(message?.content);
    const at = Number(message?.createdAt);
    const timestamp = Number.isFinite(at) && at > 0 ? at : 0;

    if (clean(message?.role) === 'user') {
      if (pending) {
        entries.push({ at: pending.at, question: pending.question, answer: '', status: 'unanswered' });
      }
      if (!content) continue;
      pending = { question: content, at: timestamp };
      continue;
    }

    if (!pending) {
      if (content) orphanAnswers += 1;
      continue;
    }

    entries.push({
      at: pending.at,
      question: pending.question,
      answer: content,
      status: content ? 'answered' : 'empty',
      ...(timestamp > 0 && pending.at > 0 ? { latencyMs: Math.max(0, timestamp - pending.at) } : {}),
    });
    pending = null;
  }

  if (pending) {
    entries.push({ at: pending.at, question: pending.question, answer: '', status: 'unanswered' });
  }

  const startedAt = Number.isFinite(Number(session?.createdAt)) ? Number(session.createdAt) : 0;
  const lastMessageAt = messages.reduce((latest, message) => {
    const at = Number(message?.createdAt);
    return Number.isFinite(at) && at > latest ? at : latest;
  }, 0);
  const updatedAt = Number.isFinite(Number(session?.updatedAt)) ? Number(session.updatedAt) : 0;
  const endedAt = Math.max(startedAt, lastMessageAt, updatedAt);

  const answered = entries.filter((entry) => entry.status === 'answered').length;
  const empty = entries.filter((entry) => entry.status === 'empty').length;
  const unanswered = entries.filter((entry) => entry.status === 'unanswered').length;
  const totalAnswerChars = entries.reduce((sum, entry) => sum + entry.answer.length, 0);

  return {
    sessionId: clean(session?.id),
    mode: clean(session?.mode) || 'general',
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    entries,
    metrics: {
      turns: messages.length,
      questions: entries.length,
      answered,
      empty,
      unanswered,
      orphanAnswers,
      avgAnswerChars: answered > 0 ? Math.round(totalAnswerChars / answered) : 0,
    },
  };
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s*\n\s*/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/**
 * Default file name for an offline export: stable, sortable, and free of the
 * characters Windows rejects in a file name (an interview mode can contain a
 * slash or a colon).
 */
export function reportFileName(report: SessionReport): string {
  const date = new Date(report.startedAt || Date.now());
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  const mode = clean(report.mode || 'chat')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `osmos-${mode || 'chat'}-${stamp}.md`;
}

/** Markdown export of a report — the format the History panel copies out. */
export function renderReportMarkdown(
  report: SessionReport,
  options: { maxEntryChars?: number } = {},
): string {
  const maxChars = Math.max(40, options.maxEntryChars ?? 280);
  const { metrics } = report;
  const lines = [
    `# ${report.mode} session — ${new Date(report.startedAt || Date.now()).toLocaleString()}`,
    '',
    `- Duration: ${formatDuration(report.durationMs)}`,
    `- Questions: ${metrics.questions} (answered ${metrics.answered}, empty ${metrics.empty}, unanswered ${metrics.unanswered})`,
    `- Turns: ${metrics.turns} · average answer ${metrics.avgAnswerChars} chars`,
  ];
  if (metrics.orphanAnswers > 0) {
    lines.push(`- Assistant messages without a question: ${metrics.orphanAnswers}`);
  }

  let index = 0;
  for (const entry of report.entries) {
    index += 1;
    lines.push('', `## ${index}. ${clip(entry.question, maxChars)}`);
    if (entry.status === 'answered') {
      lines.push('', clip(entry.answer, maxChars));
    } else {
      lines.push('', entry.status === 'empty' ? '_No answer produced._' : '_Not answered._');
    }
  }

  return `${lines.join('\n')}\n`;
}
