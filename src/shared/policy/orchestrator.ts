/**
 * Answer orchestrator — Architecture v2, §7.4.
 *
 * Owns the request lifecycle that sits between the trigger policy and the model
 * lanes: speculative start on a confident partial, reconcile-or-restart on the
 * final, cancel-and-replace when a newer question arrives, and a deadline for
 * every request. It is a pure state machine over injected inputs — no timers, no
 * promises, no Electron — so the replay bench can drive it deterministically and
 * `orchestrator.test.ts` can pin each transition.
 *
 * Actions are returned, never performed: the caller (main, or a future session
 * service) owns spawning model requests and cancelling them.
 */

import type { RouteTier } from '../lumenRoute.ts';
import { planLanes, type LanePlan } from './routerV2.ts';
import { decideTrigger, type TriggerMode, type TriggerSpeaker } from './triggerPolicy.ts';

/** §7.4: every request has a deadline; the fast lane alone gets 2.5 s to start. */
export const DEFAULT_DEADLINE_MS = 15_000;

/**
 * §7.4 step 2: if the final is this close to the partial the draft keeps
 * streaming; otherwise it is cancelled and restarted on the final text.
 */
export const UNCHANGED_EDIT_RATIO = 0.2;

export type Utterance = {
  text: string;
  channel?: TriggerSpeaker;
  mode?: TriggerMode;
  nowMs: number;
  smartMode?: boolean;
  codingScreen?: boolean;
  autoFireCodingScreen?: boolean;
};

export type OrchestratorAction =
  | {
      type: 'start';
      requestId: string;
      text: string;
      speculative: boolean;
      lane: RouteTier;
      tiers: RouteTier[];
      atMs: number;
    }
  | { type: 'keep'; requestId: string; text: string; editRatio: number }
  | {
      type: 'restart';
      requestId: string;
      previousRequestId: string;
      text: string;
      lane: RouteTier;
      tiers: RouteTier[];
      atMs: number;
    }
  | { type: 'cancel'; requestId: string; reason: 'superseded' | 'deadline' | 'stopped'; atMs: number }
  | { type: 'note'; text: string; atMs: number }
  | { type: 'ignore'; reason: string };

export type OrchestratorOptions = {
  /** Lane planner override (tests and the bench pin a plan). */
  planFor?: (text: string, mode?: TriggerMode) => LanePlan;
  /** Request deadline; defaults to {@link DEFAULT_DEADLINE_MS}. */
  deadlineMs?: number;
};

export type OrchestratorState = {
  inFlight: { requestId: string; text: string; speculative: boolean; startedAtMs: number } | null;
  lastFiredHash: string | null;
};

function normaliseForEdit(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein distance divided by the longer string's length, 0..1.
 *
 * Used to decide whether a final utterance is the same question the speculative
 * draft already answered (§7.4 step 2).
 */
export function editDistanceRatio(a: string, b: string): number {
  const left = normaliseForEdit(a).slice(0, 2000);
  const right = normaliseForEdit(b).slice(0, 2000);
  if (!left && !right) return 0;
  if (!left || !right) return 1;
  if (left === right) return 0;

  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  let current = new Array<number>(right.length + 1);

  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }

  return previous[right.length] / Math.max(left.length, right.length);
}

/**
 * Create an orchestrator. Call `partial`, `final`, `hotkey` and `checkDeadline`
 * with the caller's monotonic clock, then execute the returned actions.
 */
export function createOrchestrator(options: OrchestratorOptions = {}) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const planFor =
    options.planFor ??
    ((text: string, mode?: TriggerMode) =>
      planLanes({ question: text, mode: mode === 'coding' ? undefined : mode }));

  let seq = 0;
  let inFlight: OrchestratorState['inFlight'] = null;
  let lastFiredHash: string | null = null;
  let lastFiredAtMs: number | undefined;

  function begin(
    text: string,
    mode: TriggerMode | undefined,
    speculative: boolean,
    nowMs: number,
    hash: string,
  ): OrchestratorAction {
    const plan = planFor(text, mode);
    const requestId = `r${++seq}`;
    inFlight = { requestId, text, speculative, startedAtMs: nowMs };
    lastFiredHash = hash;
    lastFiredAtMs = nowMs;
    return {
      type: 'start',
      requestId,
      text,
      speculative,
      lane: plan.primary,
      tiers: plan.tiers,
      atMs: nowMs,
    };
  }

  function decide(input: Utterance, isFinal: boolean) {
    return decideTrigger({
      text: input.text,
      channel: input.channel,
      mode: input.mode,
      smartMode: input.smartMode,
      codingScreen: input.codingScreen,
      autoFireCodingScreen: input.autoFireCodingScreen,
      isFinal,
      lastFiredHash,
      lastFiredAtMs,
      nowMs: input.nowMs,
    });
  }

  /** §7.4 steps 1–2: speculative start on a partial, reconcile on the final. */
  function partial(input: Utterance): OrchestratorAction[] {
    if (inFlight) return [{ type: 'ignore', reason: 'already-streaming' }];
    const d = decide(input, false);
    if (!d.fire || !d.speculative) return [{ type: 'ignore', reason: d.reason }];
    return [begin(input.text, input.mode, true, input.nowMs, d.hash)];
  }

  function final(input: Utterance): OrchestratorAction[] {
    const d = decide(input, true);

    if (!d.fire) {
      // A skipped answer still may carry a note (§7.3 meeting cue).
      if (d.notes) return [{ type: 'note', text: input.text, atMs: input.nowMs }];
      // A repeat of the question already streaming is not a new question.
      if (d.reason === 'duplicate' && inFlight) {
        return [{ type: 'ignore', reason: 'duplicate' }];
      }
      // The draft was answering something the final no longer asks.
      if (inFlight) {
        const previous = inFlight;
        inFlight = null;
        return [
          { type: 'cancel', requestId: previous.requestId, reason: 'superseded', atMs: input.nowMs },
          { type: 'ignore', reason: d.reason },
        ];
      }
      return [{ type: 'ignore', reason: d.reason }];
    }

    if (inFlight) {
      const previous = inFlight;

      if (previous.speculative) {
        const ratio = editDistanceRatio(previous.text, input.text);
        if (ratio <= UNCHANGED_EDIT_RATIO) {
          inFlight = { ...previous, text: input.text, speculative: false };
          lastFiredHash = d.hash;
          lastFiredAtMs = input.nowMs;
          return [{ type: 'keep', requestId: previous.requestId, text: input.text, editRatio: ratio }];
        }

        // Materially different question: drop the draft, restart on the final.
        const start = begin(input.text, input.mode, false, input.nowMs, d.hash);
        if (start.type !== 'start') return [start];
        return [
          { type: 'cancel', requestId: previous.requestId, reason: 'superseded', atMs: input.nowMs },
          {
            type: 'restart',
            requestId: start.requestId,
            previousRequestId: previous.requestId,
            text: start.text,
            lane: start.lane,
            tiers: start.tiers,
            atMs: start.atMs,
          },
        ];
      }

      // §7.3: a newer question cancels whatever was still streaming.
      const start = begin(input.text, input.mode, false, input.nowMs, d.hash);
      if (start.type !== 'start') return [start];
      return [
        { type: 'cancel', requestId: previous.requestId, reason: 'superseded', atMs: input.nowMs },
        start,
      ];
    }

    return [begin(input.text, input.mode, false, input.nowMs, d.hash)];
  }

  /** Hotkey / "What should I say?": always answers, superseding anything live. */
  function hotkey(input: Utterance): OrchestratorAction[] {
    const previous = inFlight;
    const d = decideTrigger({
      text: input.text,
      channel: input.channel,
      mode: input.mode,
      hotkey: true,
      nowMs: input.nowMs,
    });
    const start = begin(input.text, input.mode, false, input.nowMs, d.hash);
    if (start.type !== 'start' || !previous) return [start];

    return [
      { type: 'cancel', requestId: previous.requestId, reason: 'superseded', atMs: input.nowMs },
      start,
    ];
  }

  /** The caller finished (or gave up on) one request. */
  function complete(requestId: string): boolean {
    if (!inFlight || inFlight.requestId !== requestId) return false;
    inFlight = null;
    return true;
  }

  /** §7.4: cancel a request that ran past its deadline. */
  function checkDeadline(nowMs: number): OrchestratorAction[] {
    if (!inFlight) return [];
    if (nowMs - inFlight.startedAtMs < deadlineMs) return [];
    const expired = inFlight;
    inFlight = null;
    return [{ type: 'cancel', requestId: expired.requestId, reason: 'deadline', atMs: nowMs }];
  }

  function state(): OrchestratorState {
    return { inFlight: inFlight ? { ...inFlight } : null, lastFiredHash };
  }

  return { partial, final, hotkey, complete, checkDeadline, state };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
