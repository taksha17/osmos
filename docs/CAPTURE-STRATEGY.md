# Capture strategy — OSMOS

Reference for how OSMOS (and Cluely-class copilots) should capture **meeting audio** and
**screen** across platforms. Closeds-source tools are studied only via public APIs and
behavior — never by copying proprietary code.

See also: `AGENTS.md`, `FIXES.md`, `src/shared/captureStrategy.ts`.

---

## Target pipeline

```
Audio (loopback / SCK / PipeWire monitor)
Screen (WGC / SCK / portal-or-CLI)
        │
        ▼
Native or Chromium capture → PCM / frames (chunked)
        │
        ▼
VAD / silence gate  ·  frame hash / OCR cache
        │
        ▼
Local Whisper (or cloud STT)  ·  on-demand OCR
        │
        ▼
LLM stream → overlay (low-profile / capture-excluded where OS allows)
```

**Overlay answers:** gather context continuously; **generate answers only on keybind**
(Ctrl/Cmd+Enter, Assist, ask hotkey) — not on every transcript/OCR tick.

---

## Audio (best practice → OSMOS status)

| Platform | Best practice | OSMOS today |
|---|---|---|
| **Windows** | Native **WASAPI loopback** (`IAudioClient` + `AUDCLNT_STREAMFLAGS_LOOPBACK`), or Electron `getDisplayMedia` + `audio: 'loopback'` | **Electron display-media loopback** (mainline ffmpeg has **no** WASAPI demuxer). Future: optional N-API WASAPI addon for lower latency |
| **macOS** | **ScreenCaptureKit** audio (+ video); BlackHole / Core Audio tap fallback | ffmpeg + BlackHole / virtual device; SCK path planned |
| **Linux** | PipeWire **sink `.monitor`** via `ffmpeg -f pulse` or `pw-record --target=` | **Live:** ffmpeg pulse stream → `linuxLoopbackStream.ts`; pw-record fallback. **Never `parec`** on PipeWire |

### Why not “bundled ffmpeg WASAPI” on Windows?

Public ffmpeg builds (gyan/BtbN) do **not** expose a WASAPI *input* device. Cluely-class
apps either (a) call WASAPI from a **native module**, or (b) use **Chromium/Electron
loopback**. OSMOS uses (b) now; (a) is the latency upgrade path.

---

## Screen (best practice → OSMOS status)

| Platform | Best practice | OSMOS today |
|---|---|---|
| **Windows** | WGC / DXGI via `desktopCapturer` or GDI | PowerShell GDI + `desktopCapturer` fallback; loop-safe continuous OCR uses GDI |
| **macOS** | ScreenCaptureKit | `screencapture -x` for loop-safe; Electron fallback on-demand |
| **Linux** | Portal screencast (Wayland) / X11 capturer | **On-demand** may use portal once. **Continuous** = CLI only (`grim` / `gnome-screenshot` / …). **Never loop portal** |

Continuous screen assist: hash-gated frames → OCR → **context only** until the user hits
a keybind.

---

## Shared techniques (all platforms)

1. **Chunked STT** — small PCM/WebM windows (≈2–6s), not whole-file uploads.
2. **Silence / VAD gate** — skip Whisper on near-silent chunks (`silent` / RMS).
3. **Frame diff** — perceptual / byte hash before OCR+LLM.
4. **Low-profile overlay** — Win `WDA_EXCLUDEFROMCAPTURE`, macOS `NSWindowSharingNone`,
   Linux share-tab guidance.
5. Prefer **in-process / Chromium APIs** over fragile CLI PATH tools for audio on Windows.

---

## `getCaptureStrategy()`

Runtime selection lives in `src/shared/captureStrategy.ts`. Main/renderer should consult it
when wiring Smart listen or continuous screen so platform rules stay in one place.

---

## Future upgrades (roadmap-aligned)

1. Windows: optional Rust/N-API WASAPI loopback (lower latency than MediaRecorder).
2. macOS: ScreenCaptureKit single stream for audio+optional frames.
3. Explicit Silero (or similar) VAD before Whisper.
4. Signed builds + real-device Zoom/Teams/Meet validation.
