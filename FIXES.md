# FIXES.md — OSMOS Windows ffmpeg Bundling & Continuous Screen Reading

> Applies to: OSMOS `main` (merged from `Agentic`)
> Covers: (1) Windows system-audio ffmpeg error + bundling for non-technical users,
> (2) one-shot screen reader → continuous listening loop

---

## Fix 1: "Windows system audio needs ffmpeg on PATH with WASAPI loopback support"

### Root cause
OSMOS cannot find a usable `ffmpeg` binary at overlay start. Either ffmpeg is not installed
on the user's machine, or it is installed but the app's detection logic fails to find it.

### Immediate workaround (manual install)

1. Download a Windows build: https://www.gyan.dev/ffmpeg/builds/
   (`ffmpeg-release-essentials.zip`)
2. Extract to `C:\ffmpeg`
3. Add `C:\ffmpeg\bin` to PATH:
   - `Win + R` → `sysdm.cpl` → Advanced → Environment Variables
   - Edit `Path` under your user → add `C:\ffmpeg\bin`
4. **Fully quit and restart OSMOS** — PATH changes do not apply to already-running processes.
5. Verify in a new terminal:

   ```powershell
   ffmpeg -version
   ```

### Permanent fix — bundle ffmpeg with the build

Non-technical Windows users should never need to install anything. Ship ffmpeg inside
the installer.

#### Step 1 — Vendor the binary

Download a **static** Windows build (no DLL dependencies) from gyan.dev, extract only
`ffmpeg.exe`, and place it in:

```
osmos/
├── build/
│   └── bin/
│       ├── win32/ffmpeg.exe
│       ├── darwin/ffmpeg      # optional, for consistency
│       └── linux/ffmpeg       # optional, for consistency
```

`scripts/ensure-ffmpeg-win.mjs` downloads this at pack time (binary is gitignored).

#### Step 2 — Include it in electron-builder config (`package.json`)

```json
{
  "build": {
    "win": {
      "extraResources": [
        {
          "from": "build/bin/win32",
          "to": "bin",
          "filter": ["**/*"]
        }
      ]
    }
  }
}
```

`extraResources` places the binary outside `app.asar` so it remains a real executable
file that can be spawned.

#### Step 3 — Resolve the path at runtime (main process)

Use `getFfmpegPath()` / `resolveFfmpeg()` in `src/main/services/resolveBin.ts`.

**Rule:** pass this resolved absolute path to *every* spawn/execFile call.
Never use bare `'ffmpeg'` in packaged builds.

#### Step 4 — Update the startup check

Change the check from "is ffmpeg on PATH?" to "can we resolve a working binary?" via
`resolveFfmpeg()`. Users should essentially never see the original error again; if they do,
"reinstall" is the only instruction needed.

### Notes & caveats

- **License:** gyan.dev builds include GPL components. Bundling GPL binaries is fine
  provided you offer source / license notice. See `THIRD-PARTY-NOTICES.md`.
- **Size:** static essentials builds are ~80–130 MB. Binary is downloaded at pack/CI time,
  not committed.
- **Auto-update:** extraResources ship with full updates via electron-updater — fine by default.

### Diagnostic (if detection still misbehaves)

Run where you launch OSMOS:

```powershell
where.exe ffmpeg
ffmpeg -hide_banner -f lavfi -i anullsrc -t 1 -f null -
```

If both succeed but OSMOS still errors, search main-process source for the string
`"needs ffmpeg on PATH"` and replace the detection logic with `getFfmpegPath()`.

---

## Fix 2: Screen reader runs one-shot instead of continuously listening

### Symptom
Screenshot is captured, shown on the overlay, one response is generated — then silence.
Expected behavior: continuous capture-and-read loop.

### Root cause
The flow is `capture → OCR → LLM → done` with no loop restarting it. The LLM response is
also awaited inline, which blocks the next capture.

### Fix — persistent loop with change detection

Implemented in `src/renderer/stt/useScreenAssist.ts`, wired from overlay Smart mode when
`continuousScreenAssist` is enabled (Settings). LLM assist is fire-and-forget so capture
keeps polling.

**Hard constraint (Linux/Wayland):** never loop Electron `desktopCapturer` (portal spam).
Loop-safe capture uses CLI / OS APIs only (`screen:capture-full` with `loopSafe: true`).
On Linux without CLI tools (`grim`, `gnome-screenshot`, etc.), continuous screen assist
stays off and status explains the limitation.

### Key principles

1. **Loop, don't trigger once** — wrap capture in a persistent `while` driven by an
   interval or stream subscription.
2. **Don't block on inference** — start the next capture before awaiting the LLM
   response; run capture and inference as parallel pipelines.
3. **Change detection** — hash each frame and act only on changes. Saves tokens and
   makes reading feel continuous instead of repetitive.
4. **Single entry point** — start the loop once; guard against duplicate loops with
   the `listening` flag.

---

## Regression log entries (add to AGENTS.md Symptoms table)

| ID | Symptom | Cause | Fix |
|----|---------|-------|-----|
| J | Windows: "system audio needs ffmpeg" at overlay start | ffmpeg missing from PATH, or detection only probes PATH | Bundle ffmpeg via `extraResources`; resolve via `getFfmpegPath()` fallback chain |
| K | Screen reader captures once then stops | No capture loop; LLM awaited inline blocks pipeline | Persistent poll loop + non-blocking LLM call + frame hashing |

## New hard rules (add to AGENTS.md conventions)

1. **Never rely on bare `ffmpeg` in packaged builds.** Always resolve through
   `getFfmpegPath()` (bundled resource first, then known install locations, then PATH).
2. **Never await LLM inference inline inside a capture loop.** Fire-and-handle;
   keep the capture pipeline running independently.
3. **Always hash/diff frames before OCR+LLM.** Re-processing identical frames wastes
   tokens and breaks the "continuous reading" UX.
4. **Ship third-party license notices** (`THIRD-PARTY-NOTICES.md`) when bundling
   GPL/LGPL binaries such as ffmpeg.

---

## AGENTS.md structural recommendations (separate from code fixes)

These improve agent handoff quality for future contributors/AI agents:

1. **Split the file by concern** to keep each under ~150 lines:
   - `AGENTS.md` — core rules + architecture map
   - `docs/REGRESSIONS.md` — symptoms A–K
   - `docs/PLATFORM-LINUX-AUDIO.md` — PipeWire deep-dive
   - `docs/PLATFORM-WINDOWS-AUDIO.md` — WASAPI/ffmpeg bundling notes
2. **Add a TL;DR priority block at the top** — the five rules an agent must never break:
   1. No `parec` on PipeWire (writes 0 bytes)
   2. No continuous portal capture loops on Wayland
   3. Rebuild electron after main/preload edits
   4. Renderer talks only via `window.osmos` API
   5. Never run Whisper/Tesseract in the renderer
3. **Deduplicate repeated warnings** — state each rule once canonically; reference it elsewhere.
4. **Remove machine-specific facts from general sections** — local paths, LAN IPs, and
   session context belong only in "Session notes."
5. **Point version numbers at `package.json`** as source of truth instead of hardcoding.
6. **Expand the Agentic branch section** — definition of done for the agent layer,
   target interface for `agentMcp.ts`, planned MCP servers.
7. **Add rollback guidance** — last-known-good commit/tag per subsystem.
8. **State the testing story explicitly** — e.g., "no test suite; rely on typecheck +
   manual smoke tests" so agents don't invent test commands.
9. **Strengthen secrets/PII rules** — never echo settings values into logs or error
   messages; never print résumé/JD PII into commits, docs, console output, or examples.
10. **Fix formatting nits** — escape pipes in tables, avoid forward references
    (e.g., Symptom D referenced before it's defined).
