/**
 * Browser-side mic + STT for OSMOS.
 * - webspeech: Chromium SpeechRecognition (Google cloud — often fails on Linux)
 * - local-whisper: MediaRecorder → WAV → main process → system Node Whisper worker
 * - openai-whisper: MediaRecorder → main-process Whisper API
 */

import type { AppSettings, SttProvider } from '../../shared/types';
import { CONTINUOUS_CHUNK_MS } from '../../shared/continuousAssist';

export type MicDevice = { deviceId: string; label: string };

export type SttHandlers = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onListeningChange?: (listening: boolean) => void;
  /** Fired when Web Speech hits a hard failure (e.g. network) so UI can switch providers. */
  onWebSpeechFailed?: (code: string) => void;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export async function listMicrophones(): Promise<MicDevice[]> {
  try {
    const native = await window.osmos.listAudioDevices?.();
    if (native?.ok && native.inputs?.length) {
      return native.inputs.map((d) => ({ deviceId: d.id, label: d.name }));
    }
  } catch {
    /* fall back to browser enumeration */
  }

  let granted = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    granted = true;
  } catch {
    /* still try enumerate */
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const audio = devices.filter((d) => d.kind === 'audioinput');
  if (!granted && audio.length === 0) {
    return [];
  }
  return audio.map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label || `Microphone ${i + 1}`,
  }));
}

function shouldUseNativeLinuxMic(provider: SttProvider): boolean {
  return provider !== 'webspeech' && Boolean(window.osmos.captureMicAudio);
}

export function webspeechAvailable(): boolean {
  return Boolean(getSpeechRecognitionCtor());
}

export class MicSttSession {
  private recognition: SpeechRecognitionLike | null = null;
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private listening = false;
  private intentionalStop = false;
  private webSpeechHardFail = false;
  private continuousCapture = false;
  private chunkTimer: ReturnType<typeof setTimeout> | null = null;
  private chunkStop = false;

  constructor(
    private settings: Pick<AppSettings, 'sttProvider' | 'sttLanguage' | 'micDeviceId'>,
    private handlers: SttHandlers,
    private transcribe?: (blob: Blob) => Promise<{ ok: boolean; text?: string; error?: string }>,
    private transcribeBase64?: (
      base64: string,
      mimeType: string,
    ) => Promise<{ ok: boolean; text?: string; error?: string }>,
  ) {}

  get isListening() {
    return this.listening;
  }

  async start(opts?: { continuous?: boolean }): Promise<void> {
    if (this.listening) return;
    this.intentionalStop = false;
    this.webSpeechHardFail = false;
    this.continuousCapture = Boolean(opts?.continuous);
    const provider: SttProvider = this.settings.sttProvider;

    if (provider === 'webspeech') {
      await this.startWebSpeech();
      return;
    }
    if (shouldUseNativeLinuxMic(provider)) {
      await this.startNativeLinuxCapture(
        this.continuousCapture
          ? 'Smart listen — auto-segmenting…'
          : provider === 'local-whisper'
            ? 'Listening… (native mic)'
            : 'Listening… (native mic, Whisper API)',
        opts?.continuous,
      );
      return;
    }
    await this.startCaptureTranscribe(
      this.continuousCapture
        ? 'Smart listen — auto-segmenting…'
        : provider === 'local-whisper'
          ? 'Listening… click Stop when done (local Whisper)'
          : 'Listening… click Stop when done (Whisper API)',
    );
  }

  stop(): void {
    this.intentionalStop = true;
    this.nativeLoopRef = false;
    this.chunkStop = false;
    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* ignore */
      }
      this.recognition = null;
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    } else {
      this.cleanupMedia();
      this.setListening(false);
    }
  }

  private setListening(v: boolean) {
    this.listening = v;
    this.handlers.onListeningChange?.(v);
  }

  private async openMic(): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      audio: this.settings.micDeviceId
        ? { deviceId: { exact: this.settings.micDeviceId } }
        : true,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.mediaStream = stream;
    return stream;
  }

  private cleanupMedia() {
    this.recorder = null;
    this.chunks = [];
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }

  private async startWebSpeech(): Promise<void> {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.handlers.onError?.(
        'Web Speech is unavailable here. Switch STT to Local Whisper (offline) in Settings.',
      );
      this.handlers.onWebSpeechFailed?.('unavailable');
      return;
    }
    try {
      await this.openMic();
      this.cleanupMedia();
    } catch (e) {
      this.handlers.onError?.(
        e instanceof Error ? e.message : 'Microphone permission denied.',
      );
      return;
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.settings.sttLanguage || 'en-US';

    rec.onresult = (event: any) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const piece = result?.[0]?.transcript || '';
        if (result.isFinal) finalText += piece;
        else interim += piece;
      }
      if (interim.trim()) this.handlers.onPartial?.(interim.trim());
      if (finalText.trim()) this.handlers.onFinal?.(finalText.trim());
    };

    rec.onerror = (event: any) => {
      const code = String(event?.error || 'unknown');
      if (code === 'aborted' || code === 'no-speech') return;
      if (code === 'network' || code === 'service-not-allowed' || code === 'not-allowed') {
        this.webSpeechHardFail = true;
        this.intentionalStop = true;
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        this.handlers.onError?.(
          code === 'network'
            ? 'Web Speech needs Google’s cloud STT and failed (network). Switching to Local Whisper (offline)…'
            : `Web Speech failed (${code}). Switching to Local Whisper (offline)…`,
        );
        this.handlers.onWebSpeechFailed?.(code);
        return;
      }
      this.handlers.onError?.(`Speech recognition error: ${code}`);
    };

    rec.onend = () => {
      if (this.webSpeechHardFail) {
        this.setListening(false);
        this.recognition = null;
        return;
      }
      if (!this.intentionalStop && this.listening) {
        try {
          rec.start();
          return;
        } catch {
          /* fall through */
        }
      }
      this.setListening(false);
      this.recognition = null;
    };

    this.recognition = rec;
    rec.start();
    this.setListening(true);
  }

  private async startCaptureTranscribe(partialHint: string): Promise<void> {
    if (!this.transcribe) {
      this.handlers.onError?.('Transcribe bridge missing.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await this.openMic();
    } catch (e) {
      this.handlers.onError?.(
        e instanceof Error ? e.message : 'Microphone permission denied.',
      );
      return;
    }

    this.chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    this.recorder = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.chunks.push(ev.data);
    };

    recorder.onerror = () => {
      this.handlers.onError?.('Microphone recording failed. Try another mic in Settings.');
      this.cleanupMedia();
      this.setListening(false);
    };

    recorder.onstop = () => {
      if (this.chunkTimer) {
        clearTimeout(this.chunkTimer);
        this.chunkTimer = null;
      }
      const wasChunk = this.chunkStop;
      this.chunkStop = false;
      const blob = new Blob(this.chunks, { type: mime });
      const keepContinuous = this.continuousCapture && !this.intentionalStop;
      this.cleanupMedia();
      this.setListening(false);

      if (!wasChunk && this.intentionalStop === false && blob.size < 800) {
        this.handlers.onError?.('Recording stopped unexpectedly — try Start mic again.');
        if (keepContinuous) void this.startCaptureTranscribe('Smart listen — auto-segmenting…');
        return;
      }
      if (blob.size < 800) {
        if (keepContinuous) void this.startCaptureTranscribe('Smart listen — auto-segmenting…');
        else this.handlers.onError?.('Recording too short — speak, then click Stop.');
        return;
      }
      this.handlers.onPartial?.('Transcribing…');
      void this.transcribe!(blob).then((res) => {
        this.handlers.onPartial?.('');
        if (!res.ok) {
          this.handlers.onError?.(res.error || 'Transcription failed');
          if (keepContinuous) void this.startCaptureTranscribe('Smart listen — auto-segmenting…');
          return;
        }
        if (res.text?.trim()) this.handlers.onFinal?.(res.text.trim());
        if (keepContinuous) void this.startCaptureTranscribe('Smart listen — auto-segmenting…');
      });
    };

    try {
      recorder.start(250);
    } catch (e) {
      this.cleanupMedia();
      this.setListening(false);
      this.handlers.onError?.(
        e instanceof Error ? e.message : 'Could not start microphone recorder.',
      );
      return;
    }
    this.setListening(true);
    this.handlers.onPartial?.(partialHint);

    if (this.continuousCapture) {
      this.chunkTimer = setTimeout(() => {
        if (this.recorder?.state === 'recording') {
          this.chunkStop = true;
          this.recorder.stop();
        }
      }, CONTINUOUS_CHUNK_MS);
    }
  }

  private nativeLoopRef = false;

  private async startNativeLinuxCapture(partialHint: string, continuous?: boolean): Promise<void> {
    if (!window.osmos.captureMicAudio) {
      await this.startCaptureTranscribe(partialHint);
      return;
    }
    this.continuousCapture = Boolean(continuous);
    this.nativeLoopRef = true;
    this.setListening(true);
    this.handlers.onPartial?.(partialHint);

    while (this.nativeLoopRef && !this.intentionalStop) {
      this.handlers.onPartial?.(this.continuousCapture ? 'Listening…' : partialHint);
      let capture;
      try {
        capture = await window.osmos.captureMicAudio({
          durationMs: CONTINUOUS_CHUNK_MS,
          device: this.settings.micDeviceId || undefined,
        });
      } catch (e) {
        this.handlers.onError?.(e instanceof Error ? e.message : String(e));
        break;
      }
      if (!this.nativeLoopRef || this.intentionalStop) break;
      if (!capture.ok || !capture.base64) {
        this.handlers.onError?.(capture.error || 'Microphone capture failed');
        break;
      }
      this.handlers.onPartial?.('Transcribing…');
      const runTranscribe =
        this.transcribeBase64 ||
        (async (base64: string, mimeType: string) => {
          if (!this.transcribe) return { ok: false, error: 'Transcribe bridge missing.' };
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          return this.transcribe(new Blob([bytes], { type: mimeType }));
        });
      const res = await runTranscribe(capture.base64, capture.mimeType || 'audio/wav');
      if (!this.nativeLoopRef || this.intentionalStop) break;
      this.handlers.onPartial?.('');
      if (!res.ok) {
        this.handlers.onError?.(res.error || 'Transcription failed');
        if (this.continuousCapture && !this.intentionalStop) continue;
        break;
      }
      if (res.text?.trim()) this.handlers.onFinal?.(res.text.trim());
      if (!this.continuousCapture) break;
    }

    this.nativeLoopRef = false;
    this.setListening(false);
  }
}
