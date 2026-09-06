/**
 * Bundled onboard LLM — llama-server + GGUF shipped in resources/llm/.
 * Used as the hybrid "fast" lane so Assist works without Ollama / API keys.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { fileURLToPath } from 'node:url';
import type { ProviderConfig } from '../../shared/types.js';

const PORT = 39281;
const HOST = '127.0.0.1';
export const BUNDLED_LLM_MODEL_ID = 'osmos-fast';

let child: ChildProcess | null = null;
let ready = false;
let startPromise: Promise<boolean> | null = null;

function llmRoot(): string {
  const candidates: string[] = [];
  try {
    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, 'llm'));
    }
  } catch {
    /* app may not be ready */
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist-electron/main/services → repo root
  candidates.push(path.resolve(here, '../../../build/llm'));
  candidates.push(path.resolve(process.cwd(), 'build/llm'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function bundledLlmPaths(): {
  root: string;
  server: string | null;
  model: string | null;
  runtimeDir: string | null;
  meta: { id: string; label: string; file: string; server?: string } | null;
} {
  const root = llmRoot();
  const serverName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  let meta: { id: string; label: string; file: string; server?: string } | null = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(root, 'model.json'), 'utf8'));
  } catch {
    meta = null;
  }
  const modelRel = meta?.file || 'models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf';
  const model = path.join(root, modelRel);
  const serverCandidates = [
    meta?.server ? path.join(root, meta.server) : '',
    path.join(root, 'runtime', serverName),
    path.join(root, serverName),
  ].filter(Boolean);
  const server = serverCandidates.find((p) => fs.existsSync(p)) || null;
  const runtimeDir = server ? path.dirname(server) : null;
  return {
    root,
    server,
    model: fs.existsSync(model) ? model : null,
    runtimeDir,
    meta,
  };
}

export function isBundledLlmAvailable(): boolean {
  const p = bundledLlmPaths();
  return Boolean(p.server && p.model);
}

export function isBundledLlmReady(): boolean {
  return ready;
}

export function bundledLlmProvider(): ProviderConfig {
  return {
    id: 'litellm',
    label: 'OSMOS bundled',
    apiKey: 'osmos',
    baseUrl: `http://${HOST}:${PORT}/v1`,
    model: BUNDLED_LLM_MODEL_ID,
  };
}

async function waitHealthy(timeoutMs = 90_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Start llama-server if bundled weights exist. Idempotent. */
export function startBundledLlm(): Promise<boolean> {
  if (ready) return Promise.resolve(true);
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const { server, model, runtimeDir } = bundledLlmPaths();
    if (!server || !model) {
      console.warn('[bundledLlm] not vendored — run: node scripts/ensure-bundled-llm.mjs');
      return false;
    }

    try {
      const already = await fetch(`http://${HOST}:${PORT}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (already.ok) {
        ready = true;
        return true;
      }
    } catch {
      /* start fresh */
    }

    const env = { ...process.env };
    if (runtimeDir) {
      if (process.platform === 'win32') {
        // Windows loads DLLs from PATH + exe dir; cwd is already runtimeDir.
        env.PATH = [runtimeDir, env.PATH].filter(Boolean).join(path.delimiter);
      } else {
        const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
        env[key] = [runtimeDir, env[key]].filter(Boolean).join(path.delimiter);
      }
    }

    child = spawn(
      server,
      [
        '-m',
        model,
        '--host',
        HOST,
        '--port',
        String(PORT),
        '-c',
        '2048',
        '-n',
        '256',
        '--alias',
        BUNDLED_LLM_MODEL_ID,
      ],
      {
        cwd: runtimeDir || undefined,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    child.stdout?.on('data', (buf) => {
      const line = String(buf);
      if (/listening|server is listening|HTTP server/i.test(line)) {
        /* noisy but useful in dev */
      }
    });
    child.stderr?.on('data', (buf) => {
      const line = String(buf).trim();
      if (line) console.warn('[bundledLlm]', line.slice(0, 240));
    });
    child.on('exit', (code) => {
      console.warn('[bundledLlm] llama-server exited', code);
      ready = false;
      child = null;
      startPromise = null;
    });

    ready = await waitHealthy();
    if (!ready) {
      console.warn('[bundledLlm] server failed to become healthy');
      stopBundledLlm();
    } else {
      console.log(`[bundledLlm] ready on http://${HOST}:${PORT} (${BUNDLED_LLM_MODEL_ID})`);
    }
    return ready;
  })();

  return startPromise;
}

export function stopBundledLlm(): void {
  ready = false;
  startPromise = null;
  if (child && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  child = null;
}
