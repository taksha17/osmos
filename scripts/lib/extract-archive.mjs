/**
 * Extract a `.zip` / `.tar.gz` / `.tar.xz` / `.tar.bz2` archive without
 * depending on PowerShell.
 *
 * Why not `Expand-Archive`: on GitHub's Windows runners the step runs under
 * pwsh 7, which exports its own `PSModulePath`. A child `powershell.exe` then
 * loads the **PS7** `Microsoft.PowerShell.Archive` module, whose `-Force` path
 * calls `[System.IO.Compression.ZipFileExtensions]::ExtractToDirectory` with
 * three arguments — an overload that does not exist on that type — and the
 * whole vendor step dies with:
 *
 *   Cannot find an overload for "ExtractToDirectory" and the argument count: "3".
 *   + FullyQualifiedErrorId : MethodCountCouldNotFindBest
 *
 * (Measured on windows-latest, run 44941587402: the download succeeded and
 * extraction failed, so `ensure-ffmpeg` reported "ffmpeg.exe not produced".)
 *
 * `tar` is the portable answer: Windows 10 1803+ ships bsdtar at
 * `C:\Windows\System32\tar.exe`, macOS ships bsdtar, and GNU tar on Linux
 * auto-detects gzip/xz. `tar -xf` reads zip as well as tar on bsdtar, so one
 * call covers every archive we download. The PowerShell path survives only as
 * a last-resort fallback and uses the two-argument .NET overload, which exists
 * in every framework version.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function runTar(archive, dir) {
  // -x extract, -f file; no compression flag on purpose — bsdtar and modern
  // GNU tar both sniff it, and passing the wrong letter (e.g. -z for xz) is a
  // silent failure mode.
  execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: 'pipe' });
}

function runUnzip(archive, dir) {
  execFileSync('unzip', ['-o', archive, '-d', dir], { stdio: 'pipe' });
}

function runDotNetUnzip(archive, dir) {
  // Two-argument overload only: the three-argument one needs .NET 4.5+ *and*
  // binds through the module type that is broken on pwsh 7 hosts.
  const quoted = (value) => value.replace(/'/g, "''");
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${quoted(archive)}', '${quoted(dir)}')`,
    ],
    { stdio: 'pipe' },
  );
}

/**
 * Extract `archive` into `dir` (created if needed). Throws with the original
 * tool's stderr when every strategy fails, because "ffmpeg.exe not produced"
 * on its own says nothing about why.
 */
export function extractArchive(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const isZip = /\.zip$/i.test(archive);

  const attempts = [['tar', () => runTar(archive, dir)]];
  if (isZip && process.platform === 'win32') attempts.push(['.NET zip', () => runDotNetUnzip(archive, dir)]);
  if (isZip && process.platform !== 'win32') attempts.push(['unzip', () => runUnzip(archive, dir)]);

  const failures = [];
  for (const [name, attempt] of attempts) {
    try {
      attempt();
      return;
    } catch (error) {
      const detail = error.stderr ? String(error.stderr).trim().slice(-400) : error.message;
      // Missing tool (`ENOENT`) just means "try the next strategy".
      failures.push(`${name}: ${detail}`);
    }
  }

  const size = fs.existsSync(archive) ? `${fs.statSync(archive).size} bytes` : 'missing';
  throw new Error(
    `could not extract ${archive} (${size}) into ${dir}\n  ${failures.join('\n  ')}`,
  );
}
