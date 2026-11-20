# Bench fixtures

Inputs for `npm run bench` (Architecture v2, §13.1/§13.2). Everything here is
synthetic or public-domain text — never a real user's résumé, transcript or
screen.

| Dir | Phase | Format | Provenance |
|---|---|---|---|
| `transcripts/` | 0 | JSONL `OsmosEvent` logs (Appendix B) | Hand-written from the RFC's examples; every line could plausibly come from a recorded session |
| `audio/` | 2 | 16 kHz mono WAV/FLAC + reference `.txt` | Clips recorded locally or from public-domain sources; add a `SOURCES.md` entry per clip |
| `screens/` | 4 | PNG/JPEG + `expected.json` key facts | Screenshots of public docs, synthetic slides and self-authored code problems |

Rules:

- No PII, no customer data, no recordings of real interviews.
- Keep each transcript fixture short; the harness reports per-utterance latency.
- A fixture is only added with the phase that consumes it.
