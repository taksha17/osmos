/**
 * Worker supervisor — Architecture v2, §4.1 and §5.1.
 *
 * Owns one external worker process: spawn, JSON-lines channel, stderr tail,
 * stall watchdog and restart-with-backoff. The decisions live in
 * `src/shared/policy/workerRuntime.ts`; this class only performs them.
 *
 * Every state change is emitted as a `status` event so main can forward it to
 * the renderer (`worker:status`) instead of silently dying.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import {
  RESTART_MAX_ATTEMPTS,
  evaluateWorkerHealth,
  nextRestartDelay,
  type WorkerState,
} from '../../shared/policy/workerRuntime.js';

export type WorkerSpec = {
  /** Stable id, e.g. 'capture:mic' — used by `worker.status` events. */
  id: string;
  /** Human label for status lines. */
  label: string;
  /** Binary to launch (bundled Electron runtime or system node). */
  command: string;
  /** Script plus any fixed args. */
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** No output for this long while ready means the worker is stalled. */
  stallMs?: number;
  /** Startup must reach ready within this window. */
  readyTimeoutMs?: number;
  /** Restart on unexpected exit (default true). */
  autoRestart?: boolean;
};

export type WorkerStatusEvent = {
  id: string;
  label: string;
  state: WorkerState;
  detail?: string;
  restarts: number;
};

export type WorkerJson = Record<string, unknown> & { type?: string };

const STDERR_TAIL_LIMIT = 16_384;
const WATCHDOG_MS = 1_000;

export class WorkerSupervisor extends EventEmitter {
  private spec: WorkerSpec;
  private child: ChildProcess | null = null;
  private stopping = false;
  private restarts = 0;
  private lastError = '';
  private lastStderr = '';
  private startedAt = 0;
  private lastActivityAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private state: WorkerState = 'stopped';

  constructor(spec: WorkerSpec) {
    super();
    this.spec = spec;
  }

  get currentState(): WorkerState {
    return this.state;
  }

  get isRunning(): boolean {
    return this.state === 'ready' || this.state === 'starting' || this.state === 'degraded';
  }

  getStatus(): WorkerStatusEvent {
    return {
      id: this.spec.id,
      label: this.spec.label,
      state: this.state,
      detail: this.lastError || undefined,
      restarts: this.restarts,
    };
  }

  /** Launch the worker. Idempotent while running. */
  start(): void {
    if (this.isRunning) return;
    this.stopping = false;
    this.spawnWorker();
  }

  /** Send one JSON line. Returns false when the pipe is not writable. */
  send(message: unknown): boolean {
    const child = this.child;
    if (!child?.stdin?.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    const child = this.child;
    this.child = null;
    this.setState('stopped');

    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('close', done);
      try {
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.kill('SIGKILL');
      } catch {
        done();
      }
      setTimeout(done, 2_000);
    });
  }

  private setState(state: WorkerState, detail?: string) {
    this.state = state;
    this.emit('status', {
      ...this.getStatus(),
      state,
      detail: detail ?? (this.lastError || undefined),
    });
  }

  private clearTimers() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private spawnWorker() {
    this.clearTimers();

    let child: ChildProcess;
    try {
      child = spawn(this.spec.command, this.spec.args, {
        cwd: this.spec.cwd,
        env: { ...process.env, ...this.spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setState('crashed', this.lastError);
      this.scheduleRestart('spawn failed');
      return;
    }

    this.child = child;
    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;
    this.lastStderr = '';
    this.setState('starting');

    const touch = () => {
      this.lastActivityAt = Date.now();
    };

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        touch();
        let message: WorkerJson;
        try {
          message = JSON.parse(trimmed) as WorkerJson;
        } catch {
          return;
        }
        if (message.type === 'ready' && this.state === 'starting') {
          this.restarts = 0;
          this.lastError = '';
          this.setState('ready');
        } else if (this.state === 'ready' || this.state === 'starting') {
          if (message.type === 'error' && typeof message.error === 'string') {
            this.lastError = message.error;
          }
          this.emit('message', message);
        } else {
          this.emit('message', message);
        }
      });
    }

    child.stderr?.on('data', (buf: Buffer) => {
      this.lastStderr += buf.toString('utf8');
      if (this.lastStderr.length > STDERR_TAIL_LIMIT) {
        this.lastStderr = this.lastStderr.slice(-STDERR_TAIL_LIMIT);
      }
    });

    child.on('error', (error) => {
      this.lastError = error.message || 'worker process error';
      this.lastStderr = this.lastError;
    });

    child.on('close', (code) => {
      this.child = null;
      if (this.stopping) {
        this.setState('stopped');
        return;
      }
      const tail = (this.lastStderr.trim() || '').slice(-800);
      this.lastError = `${this.spec.label} exited (code ${code ?? 'null'})${tail ? ` · ${tail}` : ''}`;
      this.setState('crashed', this.lastError);
      this.emit('exit', { code, stderr: this.lastStderr });
      this.scheduleRestart(`exit ${code}`);
    });

    this.watchdog = setInterval(() => {
      const verdict = evaluateWorkerHealth({
        state: this.state,
        lastActivityAt: this.lastActivityAt,
        startedAt: this.startedAt,
        now: Date.now(),
        stallMs: this.spec.stallMs ?? 4_000,
        readyTimeoutMs: this.spec.readyTimeoutMs ?? 15_000,
      });

      if (verdict === 'degraded' && this.state !== 'degraded') {
        this.setState('degraded', `${this.spec.label} is quiet`);
      } else if (verdict === 'restart') {
        this.emit('status', {
          ...this.getStatus(),
          state: 'degraded',
          detail: `${this.spec.label} stalled — restarting`,
        });
        this.killForRestart('stalled');
      }
    }, WATCHDOG_MS);
    this.watchdog.unref?.();
  }

  private killForRestart(reason: string) {
    this.clearTimers();
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.removeAllListeners();
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    this.lastError = reason;
    this.setState('crashed', reason);
    this.scheduleRestart(reason);
  }

  private scheduleRestart(reason: string) {
    if (this.stopping) return;
    if (this.spec.autoRestart === false) return;

    if (this.restarts >= RESTART_MAX_ATTEMPTS) {
      this.setState(
        'crashed',
        `${this.spec.label} stopped after ${RESTART_MAX_ATTEMPTS} restarts · ${reason}`,
      );
      return;
    }

    this.restarts += 1;
    const delay = nextRestartDelay(this.restarts);
    this.emit('status', {
      ...this.getStatus(),
      state: 'degraded',
      detail: `${this.spec.label} restarting (${this.restarts}/${RESTART_MAX_ATTEMPTS}) in ${delay} ms`,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnWorker();
    }, delay);
    this.restartTimer.unref?.();
  }
}
