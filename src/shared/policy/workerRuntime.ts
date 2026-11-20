/**
 * Worker runtime + supervision policy — Architecture v2, §4.1/§5.1/§15.
 *
 * Pure decisions only: which Node runtime launches a worker, how long to wait
 * before restarting, and when a live worker counts as stalled. The supervisor
 * in `src/main/supervisor/` performs the spawns and timers.
 *
 * Bundled runtime = the Electron binary with `ELECTRON_RUN_AS_NODE=1`, so a
 * packaged install never needs `node` on PATH (§15 "zero-dependency runtime").
 */

export type WorkerRuntimeMode = 'bundled' | 'system';

export type WorkerRuntimeHost = {
  /** True when `process.versions.electron` is set. */
  isElectron: boolean;
  /** `process.execPath` (the Electron or Node binary). */
  execPath: string;
  /** A real `node` found on PATH, if any (dev convenience). */
  systemNode: string | null;
  /** Settings flag: prefer the bundled runtime (default true). */
  preferBundled: boolean;
};

export type WorkerLaunch = {
  command: string;
  mode: WorkerRuntimeMode;
  env: Record<string, string>;
  note: string;
};

/**
 * Pick the binary that launches a worker.
 *
 * Bundled first (no dependency on the user's machine), system Node second (dev
 * hosts and `settings.workerRuntime = 'system'`), bundled as the last resort so
 * an Electron app never hands back "node not found".
 */
export function planWorkerCommand(host: WorkerRuntimeHost): WorkerLaunch | null {
  if (host.preferBundled && host.isElectron && host.execPath) {
    return {
      command: host.execPath,
      mode: 'bundled',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      note: 'bundled Electron runtime',
    };
  }

  if (host.systemNode) {
    return { command: host.systemNode, mode: 'system', env: {}, note: 'system node on PATH' };
  }

  if (host.execPath) {
    return {
      command: host.execPath,
      mode: 'bundled',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      note: 'bundled runtime (no system node found)',
    };
  }

  return null;
}

export const RESTART_BASE_MS = 500;
export const RESTART_MAX_MS = 15_000;
export const RESTART_MAX_ATTEMPTS = 6;

/** Exponential backoff with a cap; attempt 1 = base delay. */
export function nextRestartDelay(
  attempt: number,
  base = RESTART_BASE_MS,
  max = RESTART_MAX_MS,
): number {
  if (attempt <= 0) return 0;
  return Math.min(max, base * 2 ** (attempt - 1));
}

export type WorkerState = 'starting' | 'ready' | 'degraded' | 'crashed' | 'stopped';

export type LivenessInput = {
  state: WorkerState;
  /** When the worker last sent anything (message, heartbeat line, chunk). */
  lastActivityAt: number;
  /** When the worker was launched. */
  startedAt: number;
  now: number;
  /** No output for this long while ready = stalled (§5.1 uses 3 s). */
  stallMs: number;
  /** Startup must reach ready within this window. */
  readyTimeoutMs: number;
};

export type LivenessVerdict = 'ok' | 'degraded' | 'restart' | 'ignore';

/**
 * Decide whether a worker is healthy.
 *
 * - stopped/crashed: nothing to do here (restart is handled on exit).
 * - starting past the ready window: restart.
 * - ready and silent past `stallMs`: restart; past half of it: degraded.
 */
export function evaluateWorkerHealth(input: LivenessInput): LivenessVerdict {
  if (input.state === 'stopped' || input.state === 'crashed') return 'ignore';

  if (input.state === 'starting') {
    return input.now - input.startedAt > input.readyTimeoutMs ? 'restart' : 'ok';
  }

  const silentFor = input.now - input.lastActivityAt;
  if (silentFor > input.stallMs) return 'restart';
  if (silentFor > input.stallMs / 2) return 'degraded';
  return 'ok';
}
