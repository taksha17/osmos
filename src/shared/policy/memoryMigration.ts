/**
 * Memory migration — Architecture v2, §15 / Phase 5.
 *
 * Phase 5 replaces the JSON files (`chat-history.json`, the profile blobs inside
 * `osmos-settings.json`) with one queryable store. This module is the half that
 * can be written and tested before any SQLite exists: it turns the legacy JSON
 * into typed records.
 *
 * Two rules make the migration re-runnable and auditable:
 * - **Stable ids.** Every record's id is derived from the legacy identity
 *   (`session:<id>`, `message:<sessionId>:<index>`, …), never generated, so
 *   migrating twice upserts instead of duplicating.
 * - **Nothing silently disappears.** Anything unusable is reported in `skipped`
 *   with the reference and the reason, because a migration that drops a user's
 *   interview prep without saying so is worse than one that fails.
 */

import type {
  ChatSession,
  SavedProfile,
  QuestionBankItem,
  StarTemplate,
  DocumentReference,
} from '../types.ts';

export type MemoryKind = 'session' | 'message' | 'question' | 'star' | 'document';

export type MemoryRecord = {
  /** Deterministic: derived from the legacy identity, never random. */
  id: string;
  kind: MemoryKind;
  /** Epoch ms of the thing itself. */
  at: number;
  /** Searchable body. */
  text: string;
  sessionId?: string;
  profileId?: string;
  title?: string;
  meta?: Record<string, string | number | boolean>;
};

export type MigrationSkip = { ref: string; reason: string };

export type MigrationPlan = {
  records: MemoryRecord[];
  skipped: MigrationSkip[];
  counts: Record<MemoryKind, number>;
};

export type LegacyMemoryInput = {
  sessions?: ReadonlyArray<ChatSession>;
  profiles?: ReadonlyArray<SavedProfile>;
  /** Used only for items that carry no timestamp of their own; pass a fixed value in tests. */
  now?: number;
};

const EMPTY_COUNTS: Record<MemoryKind, number> = {
  session: 0,
  message: 0,
  question: 0,
  star: 0,
  document: 0,
};

function asTimestamp(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One record per session, plus one per message, with the transcript as its text. */
function sessionRecords(
  sessions: ReadonlyArray<ChatSession>,
  records: MemoryRecord[],
  skipped: MigrationSkip[],
): void {
  for (const session of sessions) {
    const sessionId = clean(session?.id);
    if (!sessionId) {
      skipped.push({ ref: '(session without id)', reason: 'missing id' });
      continue;
    }

    const messages = Array.isArray(session.messages) ? session.messages : [];
    const usable: Array<{ role: string; content: string; at: number; index: number }> = [];

    messages.forEach((message, index) => {
      const content = clean(message?.content);
      if (!content) {
        skipped.push({ ref: `${sessionId}#${index}`, reason: 'empty message' });
        return;
      }
      const at = asTimestamp(message?.createdAt) ?? asTimestamp(session?.createdAt);
      if (at === null) {
        skipped.push({ ref: `${sessionId}#${index}`, reason: 'no usable timestamp' });
        return;
      }
      usable.push({ role: clean(message?.role) || 'user', content, at, index });
    });

    if (usable.length === 0) {
      skipped.push({ ref: sessionId, reason: 'session has no usable messages' });
      continue;
    }

    const startedAt = asTimestamp(session?.createdAt) ?? usable[0]!.at;
    records.push({
      id: `session:${sessionId}`,
      kind: 'session',
      at: startedAt,
      text: clip(usable.map((m) => `${m.role}: ${m.content}`).join('\n'), 8_000),
      sessionId,
      title: `${clean(session?.mode) || 'general'} session`,
      meta: { mode: clean(session?.mode) || 'general', messages: usable.length },
    });

    for (const message of usable) {
      records.push({
        id: `message:${sessionId}:${message.index}`,
        kind: 'message',
        at: message.at,
        text: clip(message.content, 8_000),
        sessionId,
        title: message.role,
        meta: { role: message.role, index: message.index },
      });
    }
  }
}

/** Questions, STAR stories and reference documents live inside each profile. */
function profileRecords(
  profiles: ReadonlyArray<SavedProfile>,
  records: MemoryRecord[],
  skipped: MigrationSkip[],
  now: number,
): void {
  for (const profile of profiles) {
    const profileId = clean(profile?.id) || 'default';

    const questions: ReadonlyArray<QuestionBankItem> = Array.isArray(profile?.questions)
      ? profile.questions
      : [];
    questions.forEach((item, index) => {
      const question = clean(item?.question);
      if (!question) {
        skipped.push({ ref: `${profileId}:question#${index}`, reason: 'empty question' });
        return;
      }
      const at = asTimestamp(item?.createdAt) ?? now;
      records.push({
        id: `question:${profileId}:${clean(item?.id) || index}`,
        kind: 'question',
        at,
        text: clip(item?.answer ? `${question}\n\n${clean(item.answer)}` : question, 8_000),
        profileId,
        title: clean(item?.companyName) || undefined,
        meta: {
          category: clean(item?.category) || 'other',
          difficulty: clean(item?.difficulty) || 'medium',
          hasAnswer: Boolean(clean(item?.answer)),
        },
      });
    });

    const stars: ReadonlyArray<StarTemplate> = Array.isArray(profile?.starTemplates)
      ? profile.starTemplates
      : [];
    stars.forEach((template, index) => {
      const parts = [
        clean(template?.situation),
        clean(template?.task),
        clean(template?.action),
        clean(template?.result),
      ].filter(Boolean);
      if (parts.length === 0) {
        skipped.push({ ref: `${profileId}:star#${index}`, reason: 'empty story' });
        return;
      }
      records.push({
        id: `star:${profileId}:${clean(template?.id) || index}`,
        kind: 'star',
        at: now,
        text: clip(parts.join('\n'), 8_000),
        profileId,
        title: clean(template?.label) || undefined,
        meta: { parts: parts.length },
      });
    });

    const documents: ReadonlyArray<DocumentReference> = Array.isArray(profile?.documents)
      ? profile.documents
      : [];
    documents.forEach((document, index) => {
      const name = clean(document?.name) || `document ${index + 1}`;
      const text = clean(document?.text);
      if (!text) {
        skipped.push({ ref: `${profileId}:document:${name}`, reason: 'empty document' });
        return;
      }
      records.push({
        id: `document:${profileId}:${clean(document?.id) || name}`,
        kind: 'document',
        at: asTimestamp(document?.addedAt) ?? now,
        text: clip(text, 8_000),
        profileId,
        title: name,
        meta: { chars: text.length },
      });
    });
  }
}

/**
 * Plan the migration. Deterministic for the same input: same ids, same order
 * (oldest first, ties by id), so the result can be diffed in a test and replayed.
 */
export function planMemoryMigration(input: LegacyMemoryInput = {}): MigrationPlan {
  const records: MemoryRecord[] = [];
  const skipped: MigrationSkip[] = [];
  const now = asTimestamp(input.now) ?? Date.now();

  sessionRecords(input.sessions ?? [], records, skipped);
  profileRecords(input.profiles ?? [], records, skipped, now);

  // Upsert semantics: the same id can appear twice (e.g. a session listed by two
  // paths); keep the newest copy rather than migrating a duplicate.
  const byId = new Map<string, MemoryRecord>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing || record.at >= existing.at) byId.set(record.id, record);
  }

  const deduped = [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const counts = { ...EMPTY_COUNTS };
  for (const record of deduped) counts[record.kind] += 1;

  return { records: deduped, skipped, counts };
}
