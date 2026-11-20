/**
 * Utterance endpointing — Architecture v2, §5.2.
 *
 * Energy-based VAD state machine over fixed 20 ms frames:
 *   silence → speech → hangover → endpoint
 *
 * It decides *when* an utterance starts and ends; the STT engine only ever sees
 * completed utterances, which is what removes the fixed 4–6 s chunking that
 * cost seconds of dead time (§1 problem 2).
 *
 * Parameters are the RFC defaults and are benchmark-tunable (§5.2). Silero VAD
 * replaces the energy test later without changing this state machine: the
 * detector only needs a per-frame `isSpeech` signal.
 */

export type VadParams = {
  /** Frame length the caller sends. 20 ms by default. */
  frameMs: number;
  /** RMS above which a frame counts as speech. */
  speechThreshold: number;
  /** Voice needed before an utterance is announced (drops coughs/click noise). */
  minSpeechMs: number;
  /** Silence after the last voice frame that ends the utterance. */
  endpointHangoverMs: number;
  /** Force a flush so a monologue cannot grow without bound. */
  maxUtteranceMs: number;
  /** Audio kept before speech onset so the first syllable is not clipped. */
  preRollMs: number;
};

export const VAD_DEFAULTS: VadParams = {
  frameMs: 20,
  speechThreshold: 0.012,
  minSpeechMs: 250,
  endpointHangoverMs: 450,
  maxUtteranceMs: 25_000,
  preRollMs: 300,
};

export type VadEvent =
  | {
      t: 'utterance.start';
      atMs: number;
      /** Timestamp the caller should include audio from (start − pre-roll). */
      startMs: number;
    }
  | {
      t: 'utterance.end';
      atMs: number;
      startMs: number;
      endMs: number;
      speechMs: number;
      reason: 'endpoint' | 'max-length';
    };

type State = 'silence' | 'speech' | 'hangover';

export class EndpointDetector {
  private params: VadParams;
  private state: State = 'silence';
  private started = false;
  private startMs = 0;
  private lastVoiceMs = 0;
  private speechMs = 0;

  constructor(params: Partial<VadParams> = {}) {
    this.params = { ...VAD_DEFAULTS, ...params };
  }

  get currentState(): State {
    return this.state;
  }

  /** Feed one frame; returns the events it produced (usually none). */
  push(rms: number, tsMs: number): VadEvent[] {
    const events: VadEvent[] = [];
    const voice = rms >= this.params.speechThreshold;

    if (voice) {
      if (this.state === 'silence') {
        this.state = 'speech';
        this.speechMs = this.params.frameMs;
        this.startMs = Math.max(0, tsMs - this.params.preRollMs);
        this.lastVoiceMs = tsMs;
      } else {
        // speech or hangover → back to speech
        this.state = 'speech';
        this.speechMs += this.params.frameMs;
        this.lastVoiceMs = tsMs;
      }

      if (!this.started && this.speechMs >= this.params.minSpeechMs) {
        this.started = true;
        events.push({ t: 'utterance.start', atMs: tsMs, startMs: this.startMs });
      }

      if (this.started && tsMs - this.startMs >= this.params.maxUtteranceMs) {
        events.push(this.end(tsMs, 'max-length'));
        // Continue speaking: open the next utterance immediately.
        this.state = 'speech';
        this.started = true;
        this.startMs = tsMs;
        this.lastVoiceMs = tsMs;
        this.speechMs = this.params.frameMs;
        events.push({ t: 'utterance.start', atMs: tsMs, startMs: tsMs });
      }

      return events;
    }

    if (this.state === 'speech') {
      this.state = 'hangover';
    }

    if (this.state === 'hangover' && tsMs - this.lastVoiceMs >= this.params.endpointHangoverMs) {
      if (this.started) events.push(this.end(this.lastVoiceMs + this.params.frameMs, 'endpoint'));
      this.reset();
    }

    return events;
  }

  /** Force-close the current utterance (user hotkey, stream stop). */
  flush(tsMs: number): VadEvent[] {
    if (!this.started) {
      this.reset();
      return [];
    }
    const event = this.end(tsMs, 'endpoint');
    this.reset();
    return [event];
  }

  reset(): void {
    this.state = 'silence';
    this.started = false;
    this.startMs = 0;
    this.lastVoiceMs = 0;
    this.speechMs = 0;
  }

  private end(atMs: number, reason: 'endpoint' | 'max-length'): VadEvent {
    return {
      t: 'utterance.end',
      atMs,
      startMs: this.startMs,
      endMs: Math.max(this.startMs, atMs),
      speechMs: this.speechMs,
      reason,
    };
  }
}

/**
 * Split a PCM buffer into fixed frames, returning whole frames plus the
 * remainder to carry into the next call. Keeps the detector frame-exact when
 * ffmpeg delivers arbitrary block sizes.
 */
export function splitFrames(
  buffer: Buffer,
  frameBytes: number,
): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset + frameBytes <= buffer.length) {
    frames.push(buffer.subarray(offset, offset + frameBytes));
    offset += frameBytes;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** Bytes per 20 ms frame at 16 kHz mono s16le. */
export const FRAME_BYTES_16K_MONO = 640;
