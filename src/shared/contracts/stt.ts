/**
 * Streaming STT contract — Architecture v2, §5.3.
 *
 * Types only: the capture pipeline, the STT worker and the benchmark harness
 * all depend on this surface instead of a concrete engine, so swapping
 * Moonshine for Sherpa/whisper.cpp never touches the orchestrator (§3.3).
 */

export type SttCapabilities = {
  /** Emits partials before the utterance ends. */
  streaming: boolean;
  /** Runs without sending audio off the machine. */
  local: boolean;
  /** BCP-47-ish codes the engine was validated for. */
  languages: string[];
};

export type SttStartOptions = {
  sampleRate: 16000;
  language?: string;
};

export type SttPartial = {
  text: string;
  tsMs: number;
};

export type SttFinal = {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
};

export interface SttSession {
  /** Feed one PCM frame. Must never block the audio path (§3.5). */
  push(frame: Int16Array, tsMs: number): void;
  onPartial(cb: (partial: SttPartial) => void): void;
  onFinal(cb: (final: SttFinal) => void): void;
  close(): Promise<void>;
}

export interface SttProvider {
  /** Stable id, e.g. 'sherpa-streaming' | 'moonshine' | 'whisper-cpp'. */
  id: string;
  capabilities: SttCapabilities;
  start(opts: SttStartOptions): SttSession;
}
