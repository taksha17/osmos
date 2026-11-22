import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../shared/types';
import { CONTINUOUS_MAX_IN_FLIGHT } from '@shared/continuousAssist';
import { isFatalSystemAudioError } from '@shared/policy/audioRecovery';
import { captureElectronLoopback, isWindowsPlatform } from './electronLoopback';

function engineForSettings(settings: AppSettings | null): 'local' | 'openai' {
  if (!settings) return 'local';
  if (settings.sttProvider === 'openai-whisper') return 'openai';
  return 'local';
}

/**
 * Continuous system-audio → STT for Smart assist.
 * Linux: long-lived ffmpeg pulse / pw-record stream via startSystemAudioListen.
 * Windows: Chromium desktop loopback (ffmpeg has no WASAPI input in modern builds).
 * Elsewhere / fallback: repeated captureSystemAudio chunks.
 */
export function useSystemAudioStt(settings: AppSettings | null) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  /**
   * Set when capture cannot succeed until the user fixes a device. The Smart
   * watchdog must not restart such a listener: a loop of failing captures
   * floods the console and keeps the UI claiming to listen.
   */
  const [fatal, setFatal] = useState(false);
  const activeRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const finalHandlerRef = useRef<((text: string) => void) | null>(null);
  /** True once the VAD path has delivered an utterance this session (§5.2). */
  const utterancePathRef = useRef(false);
  const generationRef = useRef(0);
  const unsubsRef = useRef<Array<() => void>>([]);

  const onFinal = useCallback((handler: (text: string) => void) => {
    finalHandlerRef.current = handler;
  }, []);

  const cleanupListen = useCallback(() => {
    for (const u of unsubsRef.current) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    unsubsRef.current = [];
    void window.osmos.stopSystemAudioListen?.().catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    generationRef.current += 1;
    cleanupListen();
    void import('./electronLoopback').then((m) => m.stopElectronLoopbackStream());
    setListening(false);
    setPartial('');
  }, [cleanupListen]);

  const transcribeBase64 = async (base64: string, mimeType: string) =>
    window.osmos.transcribeAudio({
      base64,
      mimeType: mimeType || 'audio/wav',
      fileName: 'system-audio.wav',
      engine: engineForSettings(settingsRef.current),
      model: settingsRef.current?.localSttModel,
    });

  const start = useCallback(async () => {
    if (activeRef.current) return;
    const s = settingsRef.current;
    if (!s) return;

    activeRef.current = true;
    const gen = ++generationRef.current;
    utterancePathRef.current = false;
    setListening(true);
    setError('');
    setFatal(false);
    setPartial('Starting meeting audio…');

    const pending = new Set<Promise<void>>();
    let nextEmit = 1;
    let nextSeq = 0;
    const held = new Map<number, string | null>();
    let silentStreak = 0;
    /** Once any speech has transcribed, silence is normal, not an error. */
    let heardSpeech = false;
    /** Chunk jobs already in flight are stale once VAD endpointing fires. */
    let utteranceEpoch = 0;
    let lastWinDiagnostics: { trackLevel?: number; wavRms?: number } | null = null;

    const emitReady = () => {
      while (held.has(nextEmit)) {
        const text = held.get(nextEmit);
        held.delete(nextEmit);
        nextEmit += 1;
        if (text) finalHandlerRef.current?.(text);
      }
    };

    const handleWav = async (
      base64: string,
      mimeType: string,
      silent?: boolean,
      source: 'chunk' | 'utterance' = 'chunk',
    ) => {
      if (generationRef.current !== gen || !activeRef.current) return;
      if (silent) {
        silentStreak += 1;
        // Only a listener that has never heard speech can have a device
        // problem. After normal speech, pauses are not an error.
        if (silentStreak >= 4 && !heardSpeech) {
          const win = await isWindowsPlatform();
          if (win && lastWinDiagnostics) {
            const { trackLevel, wavRms } = lastWinDiagnostics;
            if ((trackLevel ?? 0) > 0.01 && (wavRms ?? 0) < 0.006) {
              // Track carries audio but our recorder/decoder flattened it —
              // that is OUR bug, say so plainly.
              setError(
                `Windows loopback bug: track has audio (level ${trackLevel}) but converted WAV is silent. Please report this with your Windows audio device name.`,
              );
            } else {
              setError(
                'Hearing silence from Windows loopback. Check: ① media plays through the DEFAULT output device (Settings → Sound), ② Spatial sound (Atmos/Realtek enhancements) is off for that device, ③ no app holds the device in exclusive mode.',
              );
            }
          } else if (win) {
            setError(
              'Windows loopback is active but still silent. Play audio on speakers, then toggle Listen off/on once.',
            );
          }
        }
        setPartial(
          heardSpeech
            ? 'Listening to system audio…'
            : 'Waiting for meeting audio…',
        );
        return;
      }
      silentStreak = 0;
      const epochAtStart = utteranceEpoch;
      while (pending.size >= CONTINUOUS_MAX_IN_FLIGHT) {
        setPartial('Transcribing (queue)…');
        await Promise.race(pending);
        if (generationRef.current !== gen) return;
      }
      setPartial('Transcribing meeting audio…');
      const seq = ++nextSeq;
      const job = (async () => {
        try {
          const transcription = await transcribeBase64(base64, mimeType);
          if (generationRef.current !== gen) return;
          // A fixed chunk that was already transcribing when VAD endpointed
          // the same speech must not emit a second final behind it.
          if (source === 'chunk' && epochAtStart !== utteranceEpoch) {
            held.set(seq, null);
            emitReady();
            return;
          }
          if (transcription.ok && transcription.text?.trim()) {
            heardSpeech = true;
            held.set(seq, transcription.text.trim());
            setError('');
          } else {
            if (transcription.error && !/too short|empty|silent/i.test(transcription.error || '')) {
              setError(transcription.error);
            }
            held.set(seq, null);
          }
          emitReady();
        } catch (e) {
          held.set(seq, null);
          emitReady();
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
      pending.add(job);
      void job.finally(() => pending.delete(job));
    };

    let useStream = false;
    if (typeof window.osmos.startSystemAudioListen === 'function') {
      try {
        const res = await window.osmos.startSystemAudioListen({
          device: s.systemAudioDevice || undefined,
          chunkMs: s.transcribeChunkMs || 4000,
        });
        if (res.ok && res.mode === 'stream') {
          useStream = true;
          setPartial(
            res.monitor
              ? `Listening (${res.monitor.split('.').pop() || 'monitor'})…`
              : 'Listening to system audio…',
          );
          const unsubUtterance = window.osmos.onSystemAudioUtterance?.(
            async (ev: { ok: boolean; base64?: string; mimeType?: string; error?: string }) => {
              if (generationRef.current !== gen || !activeRef.current) return;
              if (!ev.ok || !ev.base64) {
                if (ev.error) setError(ev.error);
                return;
              }
              utterancePathRef.current = true;
              utteranceEpoch += 1;
              setPartial('Transcribing meeting audio…');
              await handleWav(ev.base64, ev.mimeType || 'audio/wav', false, 'utterance');
            },
          );
          const unsubChunk = window.osmos.onSystemAudioChunk?.(async (chunk) => {
            if (generationRef.current !== gen || !activeRef.current) return;
            if (!chunk.ok) {
              setError(chunk.error || 'System audio stream error');
              return;
            }
            if (!chunk.base64) return;
            // While the VAD path is alive, non-silent chunks are telemetry only.
            if (utterancePathRef.current && !chunk.silent) return;
            await handleWav(chunk.base64, chunk.mimeType || 'audio/wav', chunk.silent);
          });
          const unsubStatus = window.osmos.onSystemAudioStatus?.((ev) => {
            if (generationRef.current === gen && ev.text) setPartial(ev.text);
          });
          if (unsubUtterance) unsubsRef.current.push(unsubUtterance);
          if (unsubChunk) unsubsRef.current.push(unsubChunk);
          if (unsubStatus) unsubsRef.current.push(unsubStatus);

          while (activeRef.current && generationRef.current === gen) {
            await new Promise((r) => setTimeout(r, 400));
          }
        } else if (!res.ok && res.error) {
          setError(res.error);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    if (!useStream && activeRef.current && generationRef.current === gen) {
      const preferElectronLoopback = await isWindowsPlatform();
      setPartial(
        preferElectronLoopback
          ? 'Listening (Windows loopback)…'
          : 'Listening (chunked capture)…',
      );
      while (activeRef.current && generationRef.current === gen) {
        while (pending.size >= CONTINUOUS_MAX_IN_FLIGHT && activeRef.current) {
          await Promise.race(pending);
        }
        if (!activeRef.current || generationRef.current !== gen) break;
        try {
          const capture = preferElectronLoopback
            ? await captureElectronLoopback(s.transcribeChunkMs || 4000).then((r) => {
                lastWinDiagnostics = r as { trackLevel?: number; wavRms?: number };
                return r;
              })
            : await window.osmos.captureSystemAudio({
                durationMs: s.transcribeChunkMs || 4000,
                device: settingsRef.current?.systemAudioDevice || undefined,
              });
          if (!activeRef.current || generationRef.current !== gen) break;
          if (!capture.ok || !capture.base64) {
            const message = capture.error || 'System audio capture failed';
            setError(message);
            // A missing playback endpoint never fixes itself — stop instead of
            // retrying every few seconds and leave the UI honest.
            if (isFatalSystemAudioError(message)) {
              setFatal(true);
              activeRef.current = false;
              generationRef.current += 1;
              setListening(false);
              setPartial('');
              break;
            }
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          await handleWav(
            capture.base64,
            capture.mimeType || 'audio/wav',
            Boolean((capture as { silent?: boolean }).silent),
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    if (pending.size) await Promise.allSettled([...pending]);
    cleanupListen();
    if (generationRef.current === gen) {
      activeRef.current = false;
      setListening(false);
      setPartial('');
    }
  }, [cleanupListen]);

  const toggle = useCallback(async () => {
    if (activeRef.current) stop();
    else await start();
  }, [start, stop]);

  useEffect(() => () => stop(), [stop]);

  return { listening, partial, error, fatal, start, stop, toggle, onFinal };
}
