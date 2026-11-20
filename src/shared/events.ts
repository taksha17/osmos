/**
 * OSMOS event vocabulary — Architecture v2, §7.1.
 *
 * Single source of truth for what flows through the session bus and the replay
 * log (`bench/`), so latency can be measured anywhere ("one pipeline, one
 * clock", §3.1). Pure module: no Electron, no filesystem, no side effects.
 */

import type { CopilotMode } from './types';

/** Log format version — bump when an event shape changes incompatibly. */
export const EVENT_LOG_VERSION = 1;

/** Which audio stream an utterance came from: the user's mic or the meeting. */
export type EventChannel = 'me' | 'them';

export type TriggerReason =
  | 'hotkey'
  | 'direct-question'
  | 'coding-screen'
  | 'meeting-cue'
  | 'speculative';

export type ScreenRegionKind = 'code' | 'text' | 'chart' | 'ui';

/** Snapshot object from §6.3 — image + lazily filled OCR text. */
export type ScreenSnapshot = {
  id: string;
  capturedAtMs: number;
  hash: string;
  activeApp?: string;
  activeTitle?: string;
  /** Path inside the per-session temp dir; deleted on purge. */
  imageRef?: string;
  /** Filled asynchronously by the text path. */
  ocrText?: string;
  regions?: Array<{
    kind: ScreenRegionKind;
    bbox: [number, number, number, number];
  }>;
};

export type WorkerId = 'capture' | 'stt' | 'vision' | 'llm' | 'embed';
export type WorkerState = 'starting' | 'ready' | 'degraded' | 'crashed';

/**
 * Per-answer telemetry. `lane` stays a string so replay logs written against
 * Appendix B (`"fast-local"`) parse without conversion.
 */
export type AnswerStats = {
  firstTokenMs: number;
  totalMs: number;
  lane: string;
  model?: string;
};

export type OsmosEvent =
  | { t: 'session.start'; tsMs: number; mode: CopilotMode; logVersion?: number }
  | { t: 'session.end'; tsMs: number; sessionId?: string }
  | { t: 'utterance.partial'; channel: EventChannel; text: string; tsMs: number }
  | {
      t: 'utterance.final';
      channel: EventChannel;
      text: string;
      startMs: number;
      endMs: number;
      /** Optional so Appendix B logs (no tsMs) replay unchanged. */
      tsMs?: number;
      speakerId?: string;
    }
  | { t: 'screen.snapshot'; tsMs: number; snapshot: ScreenSnapshot }
  | { t: 'trigger.fire'; tsMs: number; reason: TriggerReason }
  | {
      t: 'answer.delta';
      tsMs: number;
      requestId: string;
      text: string;
      phase: 'draft' | 'final';
    }
  | { t: 'answer.done'; tsMs: number; requestId: string; stats: AnswerStats }
  | {
      t: 'worker.status';
      tsMs: number;
      worker: WorkerId;
      state: WorkerState;
      detail?: string;
    };

export type OsmosEventKind = OsmosEvent['t'];

export const OSMOS_EVENT_KINDS: readonly OsmosEventKind[] = [
  'session.start',
  'session.end',
  'utterance.partial',
  'utterance.final',
  'screen.snapshot',
  'trigger.fire',
  'answer.delta',
  'answer.done',
  'worker.status',
];

const EVENT_KINDS = new Set<string>(OSMOS_EVENT_KINDS);

/**
 * Monotonic milliseconds. `performance.now()` is present in Node 16+ and every
 * Electron renderer/main context; `Date.now()` is only a last-resort fallback.
 */
export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Milliseconds since a previously captured `nowMs()` reading. */
export function elapsedMs(since: number): number {
  return Math.max(0, nowMs() - since);
}

export function isOsmosEvent(value: unknown): value is OsmosEvent {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { t?: unknown }).t;
  return typeof kind === 'string' && EVENT_KINDS.has(kind);
}

/** One JSONL line for a session log (trailing newline included). */
export function serializeEvent(event: OsmosEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Parse a JSONL event log (Appendix B). Blank lines and `#` comments are
 * skipped, as are malformed or unknown-kind lines — replay must never crash on
 * a partially written log.
 */
export function parseEventLog(text: string): OsmosEvent[] {
  const events: OsmosEvent[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isOsmosEvent(parsed)) events.push(parsed);
  }
  return events;
}

/** All events of one kind, narrowed. */
export function eventsOfKind<K extends OsmosEventKind>(
  events: readonly OsmosEvent[],
  kind: K,
): Array<Extract<OsmosEvent, { t: K }>> {
  return events.filter((e): e is Extract<OsmosEvent, { t: K }> => e.t === kind);
}
