#!/usr/bin/env node
/**
 * Ad-hoc sign the native helpers OSMOS ships on macOS.
 *
 * Why this is required and not cosmetic: on Apple Silicon the kernel refuses to
 * exec a Mach-O binary that has no code signature, and refuses one whose code
 * changed after it was signed. OSMOS vendors three things it does not build:
 *
 *   build/bin/...            ffmpeg (compiled here, unsigned)
 *   build/llm/...            llama-server + its .dylibs (downloaded tarball)
 *   binaries/audio-worker/   optional helper (if present)
 *
 * electron-builder signs the app bundle it assembles, but it does not know
 * about arbitrary files under `extraResources`, and a quarantined download that
 * lands inside the bundle keeps its `com.apple.quarantine` attribute. The
 * result on a real Mac is `spawn llama-server` → `killed: 9` (or Gatekeeper's
 * "cannot be opened because the developer cannot be verified") long after the
 * installer looked fine.
 *
 * `codesign --sign -` (ad-hoc) is enough for the kernel to exec it. It is NOT
 * enough for Gatekeeper on a *downloaded* app — that needs a Developer ID and
 * notarization, which this repository does not have (docs/ARCHITECTURE-V2.md
 * §20). Users still clear quarantine once; see docs/SELF-HOSTING.md.
 *
 * No-op on every non-macOS host so `pack.mjs` can call it unconditionally.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Roots that end up under `extraResources` in the packaged app. */
const VENDOR_ROOTS = [
  path.join(root, 'build', 'bin'),
  path.join(root, 'build', 'llm'),
  path.join(root, 'binaries', 'audio-worker'),
];

/** Directories that only hold data (weights, extraction scratch). */
const SKIP_DIRS = new Set(['models', '_extract', 'node_modules', '.git']);

const MACHO_MAGICS = new Set([
  'feedface', // MH_MAGIC (32-bit, BE)
  'cefaedfe', // MH_CIGAM
  'feedfacf', // MH_MAGIC_64
  'cffaedfe', // MH_CIGAM_64
  'cafebabe', // FAT_MAGIC
  'bebafeca', // FAT_CIGAM
  'cafed00d', // FAT_MAGIC_64
]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    return MACHO_MAGICS.has(head.toString('hex'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function collectMachO(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectMachO(full, out);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks: codesign follows them itself
    if (isMachO(full)) out.push(full);
  }
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('[sign-macos] not macOS — nothing to sign');
    return;
  }

  const targets = VENDOR_ROOTS.filter((dir) => fs.existsSync(dir));
  if (!targets.length) {
    console.log('[sign-macos] no vendored directories present — run ensure-ffmpeg / ensure-bundled-llm first');
    return;
  }

  const files = [];
  for (const dir of targets) collectMachO(dir, files);

  if (!files.length) {
    console.log('[sign-macos] no Mach-O files found under the vendor roots');
    return;
  }

  // Quarantine is inherited by everything extracted from a downloaded archive;
  // stripping it here means the packaged copies never carry it.
  for (const dir of targets) {
    try {
      execFileSync('xattr', ['-cr', dir], { stdio: 'pipe' });
    } catch (error) {
      console.warn(`[sign-macos] xattr -cr ${dir} failed: ${error.message}`);
    }
  }

  const failures = [];
  for (const file of files) {
    // codesign signs what is on disk, so the mode has to be final first.
    const dylib = /\.(dylib|so)$/i.test(file);
    try {
      fs.chmodSync(file, dylib ? 0o644 : 0o755);
    } catch {
      /* codesign will report anything that matters */
    }
    try {
      execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'pipe' });
    } catch (error) {
      const detail = error.stderr ? String(error.stderr).trim() : error.message;
      failures.push(`${path.relative(root, file)}: ${detail}`);
    }
  }

  const label = targets.map((dir) => path.relative(root, dir)).join(', ');
  if (failures.length) {
    console.error(`[sign-macos] ${failures.length} file(s) failed to sign — the packaged app would be killed on arm64:`);
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
  }

  console.log(`[sign-macos] ad-hoc signed ${files.length} Mach-O file(s) under ${label}`);

  // Verify rather than assume: an unsigned arm64 helper is a runtime SIGKILL,
  // so the build fails here instead of shipping it.
  for (const file of files) {
    try {
      execFileSync('codesign', ['--verify', '--strict', file], { stdio: 'pipe' });
    } catch (error) {
      const detail = error.stderr ? String(error.stderr).trim() : error.message;
      console.error(`[sign-macos] verification failed for ${path.relative(root, file)}: ${detail}`);
      process.exit(1);
    }
  }
  console.log('[sign-macos] signatures verified');
}

main();
