# Third-party notices — OSMOS

OSMOS itself is MIT-licensed. Packaged builds bundle the following third-party
components, staged at pack time and never committed to git.

## FFmpeg (all platforms)

- **What:** `ffmpeg` staged into `build/bin/current/` → `resources/bin/` by
  `scripts/ensure-ffmpeg.mjs` and resolved at runtime through
  `getFfmpegPath()` / `resolveFfmpeg()` — never assumed to be on `PATH`.
- **Source builds:** [BtbN FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
  `*-lgpl` assets for Windows and Linux; macOS compiles a pinned upstream source
  tarball (BtbN stopped publishing macOS assets).
- **Upstream project:** [FFmpeg](https://ffmpeg.org/)
- **License:** **LGPL-2.1-or-later** for the BtbN LGPL assets and the macOS
  minimal build. GPL applies only to builds configured with GPL components;
  these assets are LGPL.
- **Source availability:** Corresponding FFmpeg source is at
  https://ffmpeg.org/download.html (and the pinned version in
  `scripts/ensure-ffmpeg.mjs`).
- **OSMOS usage:** loopback and microphone capture on Linux (Pulse/PipeWire via
  `ffmpeg -f pulse`) and macOS (BlackHole). Windows Smart audio uses Electron's
  desktop loopback instead. OSMOS does not modify FFmpeg.

If you redistribute OSMOS packages, retain this notice and comply with the
applicable FFmpeg LGPL terms for the bundled binary.

## Bundled onboard LLM (all platforms)

- **What:** `resources/llm/` — Qwen2.5-1.5B-Instruct Q4_K_M GGUF (~986 MB) +
  `llama-server` (downloaded at pack time via `scripts/ensure-bundled-llm.mjs`).
- **Model:** [bartowski/Qwen2.5-1.5B-Instruct-GGUF](https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF)
  (base [Qwen/Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct)), **Apache-2.0**.
- **Runtime:** [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` binary (pin `b10826`), **MIT**.
- **OSMOS usage:** hybrid “fast” lane for instant Assist drafts and
  profile-grounded easy answers without Ollama or API keys. Resident memory stays
  under the 2 GB budget. Weights are not committed to git; they are fetched at
  pack time and shipped inside installers.
