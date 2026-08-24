# Third-party notices — OSMOS

OSMOS itself is MIT-licensed. Packaged Windows builds may include the following
third-party components.

## FFmpeg (Windows)

- **What:** `ffmpeg.exe` shipped under `resources/bin/` in Windows installers
  (downloaded at pack time via `scripts/ensure-ffmpeg-win.mjs`).
- **Source builds:** [gyan.dev FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/)
  (**full** release zip — not essentials; essentials lacks the WASAPI demuxer).
- **Upstream project:** [FFmpeg](https://ffmpeg.org/)
- **License:** FFmpeg is licensed under the **LGPL** and/or **GPL** depending on
  the build configuration. The gyan.dev full builds typically include
  GPL-enabled components.
- **Source availability:** Corresponding FFmpeg source is available from
  https://ffmpeg.org/download.html and the gyan.dev build notes.
- **OSMOS usage:** WASAPI loopback capture for Smart / system-audio assist on
  Windows. OSMOS does not modify FFmpeg.

If you redistribute OSMOS Windows packages, retain this notice and comply with
the applicable FFmpeg LGPL/GPL terms for the bundled binary.
