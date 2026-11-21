# Audio fixtures

30 clips for the Phase 2 exit criteria (`BENCH_STT=1 npm run bench`).

| Property | Value |
|---|---|
| Format | 16 kHz mono s16le WAV, 1 s of silence at each end |
| Content | 24 interview/meeting sentences, 6 of them also as noisy variants |
| Synthesis | Windows SAPI (Microsoft David / Zira, en-US), rate 0 |
| Noise | white noise mixed at −20 dB (`anoise src amplitude=0.06`) on `*-noisy.wav` |
| Reference | `<id>.txt` next to each clip — exactly the sentence that was spoken |
| Generator | Windows-only SAPI + ffmpeg script, kept out of the repo by design |

The clips are synthetic speech, so the corpus has no accent variety and no
crosstalk; it measures engine and endpointing behaviour, not human-ASR quality.
A real recording set should replace it before WER is quoted as a general number.

`a12` and `a17` decided a product fix: Moonshine returned an empty transcript on
both clean clips until the STT worker started trimming the silence pad, which is
why `scripts/whisper-worker.mjs` now trims before inference.
