#!/usr/bin/env node
/**
 * Vendor a tiny onboard LLM + llama-server for the hybrid "fast" lane.
 *
 * Works on Linux, macOS, and Windows (x64 + arm64). The GGUF is shared;
 * the llama.cpp runtime is host-specific and is selected automatically.
 *
 * Downloads (idempotent — skips when already present):
 *   - Qwen2.5-0.5B-Instruct Q4_K_M GGUF (~400 MB, Apache-2.0)
 *   - llama.cpp runtime dir (llama-server + shared libs/DLLs) for this OS/arch (MIT)
 *
 * Staged under build/llm/ → electron-builder extraResources → resources/llm/
 * Weights are gitignored; never commit the GGUF.
 *
 * Usage:
 *   node scripts/ensure-bundled-llm.mjs
 *   node scripts/ensure-bundled-llm.mjs --platform=win32 --arch=x64   # prefetch only
 *   OSMOS_SKIP_LLM=1  → no-op
 *
 * Pack on each OS host so the matching runtime is embedded:
 *   npm run pack:linux | pack:mac | pack:win
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'build', 'llm');
const modelDir = path.join(outRoot, 'models');
const MODEL_FILE = 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf';
const MODEL_URL =
  'https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf';

/** Pinned llama.cpp release with CPU binaries for win/mac/linux. */
const LLAMA_TAG = 'b10826';
const LLAMA_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`;

const args = process.argv.slice(2);
function argValue(name) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}

const targetPlatform = argValue('platform') || process.env.OSMOS_LLM_PLATFORM || process.platform;
const targetArch = argValue('arch') || process.env.OSMOS_LLM_ARCH || process.arch;
const installAsCurrent = !argValue('platform') && !process.env.OSMOS_LLM_PLATFORM;

function serverNameFor(platform) {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

function runtimeDirFor(platform, arch) {
  if (installAsCurrent) return path.join(outRoot, 'runtime');
  return path.join(outRoot, 'runtimes', `${platform}-${arch}`);
}

function archiveFor(platform, arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'linux') {
    return {
      url: `${LLAMA_BASE}/llama-${LLAMA_TAG}-bin-ubuntu-${a}.tar.gz`,
      ext: 'tar.gz',
    };
  }
  if (platform === 'darwin') {
    return {
      url: `${LLAMA_BASE}/llama-${LLAMA_TAG}-bin-macos-${a}.tar.gz`,
      ext: 'tar.gz',
    };
  }
  if (platform === 'win32') {
    return {
      url: `${LLAMA_BASE}/llama-${LLAMA_TAG}-bin-win-cpu-${a}.zip`,
      ext: 'zip',
    };
  }
  return null;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 8) return reject(new Error('Too many redirects'));
      https
        .get(u, { headers: { 'User-Agent': 'osmos-ensure-bundled-llm' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          const total = Number(res.headers['content-length'] || 0);
          let got = 0;
          let lastPct = -1;
          const file = fs.createWriteStream(dest);
          res.on('data', (chunk) => {
            got += chunk.length;
            if (total > 0) {
              const pct = Math.floor((got / total) * 100);
              if (pct !== lastPct && pct % 5 === 0) {
                lastPct = pct;
                process.stdout.write(`\r[ensure-bundled-llm] ${pct}%`);
              }
            }
          });
          res.pipe(file);
          file.on('finish', () => {
            process.stdout.write('\n');
            file.close(() => resolve());
          });
          file.on('error', reject);
        })
        .on('error', reject);
    };
    get(url);
  });
}

function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (/\.zip$/i.test(archive)) {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${archive.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: 'inherit' },
      );
    } else {
      execFileSync('unzip', ['-o', archive, '-d', dir], { stdio: 'inherit' });
    }
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', dir], { stdio: 'inherit' });
  }
}

function findServerBinary(dir, platform) {
  const want = serverNameFor(platform);
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (e.name === want || e.name === 'llama-server' || e.name === 'llama-server.exe') {
        return full;
      }
    }
  }
  return null;
}

function shouldKeepRuntimeFile(name, platform) {
  const want = serverNameFor(platform);
  if (name === want || name === 'llama-server' || name === 'llama-server.exe') return true;
  if (name === 'LICENSE' || name.startsWith('LICENSE')) return true;
  if (/\.(so|dylib|dll)(\.|$)/i.test(name)) return true;
  if (name.includes('.so.') || name.includes('.dylib')) return true;
  return false;
}

function copyRuntimeTree(serverPath, destDir, platform) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const srcDir = path.dirname(serverPath);
  for (const name of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) continue;
    if (!shouldKeepRuntimeFile(name, platform)) continue;
    fs.copyFileSync(from, to);
    if (platform !== 'win32' && (name === 'llama-server' || name === serverNameFor(platform))) {
      try {
        fs.chmodSync(to, 0o755);
      } catch {
        /* ignore */
      }
    }
  }
}

function runtimeLooksHealthy(runtimeDir, platform) {
  const server = path.join(runtimeDir, serverNameFor(platform));
  if (!fs.existsSync(server)) return false;
  if (platform === 'linux') {
    return (
      fs.existsSync(path.join(runtimeDir, 'libllama-server-impl.so')) ||
      fs.existsSync(path.join(runtimeDir, 'libllama.so'))
    );
  }
  if (platform === 'darwin') {
    return (
      fs.existsSync(path.join(runtimeDir, 'libllama-server-impl.dylib')) ||
      fs.existsSync(path.join(runtimeDir, 'libllama.dylib')) ||
      fs.existsSync(path.join(runtimeDir, 'libllama.0.dylib'))
    );
  }
  if (platform === 'win32') {
    return (
      fs.existsSync(path.join(runtimeDir, 'llama-server-impl.dll')) ||
      fs.existsSync(path.join(runtimeDir, 'llama.dll'))
    );
  }
  return true;
}

async function ensureRuntime(platform, arch) {
  const runtimeDir = runtimeDirFor(platform, arch);
  const serverOut = path.join(runtimeDir, serverNameFor(platform));
  if (runtimeLooksHealthy(runtimeDir, platform)) {
    console.log(`[ensure-bundled-llm] runtime OK (${platform}/${arch}): ${serverOut}`);
    return runtimeDir;
  }

  const asset = archiveFor(platform, arch);
  if (!asset) {
    throw new Error(`unsupported platform ${platform}/${arch}`);
  }

  const extractDir = path.join(outRoot, `_extract-${platform}-${arch}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const archive = path.join(outRoot, `llama-${platform}-${arch}.${asset.ext}`);
  console.log(`[ensure-bundled-llm] downloading llama-server ${LLAMA_TAG} (${platform}/${arch})…`);
  if (!fs.existsSync(archive) || fs.statSync(archive).size < 1_000_000) {
    await download(asset.url, archive);
  }
  extract(archive, extractDir);
  const found = findServerBinary(extractDir, platform);
  if (!found) {
    throw new Error(`llama-server not found in ${platform}/${arch} archive`);
  }
  copyRuntimeTree(found, runtimeDir, platform);
  fs.rmSync(extractDir, { recursive: true, force: true });
  try {
    fs.unlinkSync(archive);
  } catch {
    /* ignore */
  }

  if (!runtimeLooksHealthy(runtimeDir, platform)) {
    throw new Error(`runtime incomplete after extract (${platform}/${arch})`);
  }
  console.log(`[ensure-bundled-llm] vendored → ${runtimeDir}`);
  return runtimeDir;
}

async function main() {
  if (process.env.OSMOS_SKIP_LLM === '1') {
    console.log('[ensure-bundled-llm] skipped (OSMOS_SKIP_LLM=1)');
    return;
  }

  if (!['linux', 'darwin', 'win32'].includes(targetPlatform)) {
    console.error(`[ensure-bundled-llm] bad platform: ${targetPlatform}`);
    process.exit(1);
  }
  if (!['x64', 'arm64', 'ia32'].includes(targetArch) && targetArch !== 'x64') {
    // normalize
  }
  const arch = targetArch === 'arm64' ? 'arm64' : 'x64';

  fs.mkdirSync(modelDir, { recursive: true });
  const modelPath = path.join(modelDir, MODEL_FILE);

  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 50_000_000) {
    const tmp = `${modelPath}.partial`;
    console.log(`[ensure-bundled-llm] downloading ${MODEL_FILE}…`);
    await download(MODEL_URL, tmp);
    fs.renameSync(tmp, modelPath);
  } else {
    console.log(`[ensure-bundled-llm] model present: ${modelPath}`);
  }

  const runtimeDir = await ensureRuntime(targetPlatform, arch);

  // Active install always exposes build/llm/runtime for electron-builder.
  if (installAsCurrent) {
    const legacy = path.join(outRoot, serverNameFor(targetPlatform));
    try {
      if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) fs.unlinkSync(legacy);
    } catch {
      /* ignore */
    }

    fs.writeFileSync(
      path.join(outRoot, 'model.json'),
      JSON.stringify(
        {
          id: 'osmos-fast',
          label: 'OSMOS Fast (Qwen2.5-0.5B)',
          file: `models/${MODEL_FILE}`,
          server: `runtime/${serverNameFor(targetPlatform)}`,
          platform: targetPlatform,
          arch,
          license: 'Apache-2.0',
          source: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
          llamaCppTag: LLAMA_TAG,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[ensure-bundled-llm] prefetch only — left active model.json unchanged (use bare ensure:llm on the pack host)`,
    );
  }

  const mb = (fs.statSync(modelPath).size / (1024 * 1024)).toFixed(1);
  console.log(
    `[ensure-bundled-llm] ready for ${targetPlatform}/${arch} (${mb} MB model + ${serverNameFor(targetPlatform)})`,
  );
}

main().catch((err) => {
  console.error('[ensure-bundled-llm]', err.message || err);
  process.exit(1);
});
