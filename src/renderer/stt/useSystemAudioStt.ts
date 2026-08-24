import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../shared/types';
import { CONTINUOUS_CHUNK_MS, CONTINUOUS_MAX_IN_FLIGHT } from '@shared/continuousAssist';
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
  const activeRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const finalHandlerRef = useRef<((text: string) => void) | null>(null);
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
    });

  const start = useCallback(async () => {
    if (activeRef.current) return;
    const s = settingsRef.current;
    if (!s) return;

    activeRef.current = true;
    const gen = ++generationRef.current;
    setListening(true);
    setError('');
    setPartial('Starting meeting audio…');

    const pending = new Set<Promise<void>>();
    let nextEmit = 1;
    let nextSeq = 0;
    const held = new Map<number, string | null>();
    let silentStreak = 0;

    const emitReady = () => {
      while (held.has(nextEmit)) {
        const text = held.get(nextEmit);
        held.delete(nextEmit);
        nextEmit += 1;
        if (text) finalHandlerRef.current?.(text);
      }
    };

    const handleWav = async (base64: string, mimeType: string, silent?: boolean) => {
      if (generationRef.current !== gen || !activeRef.current) return;
      if (silent) {
        silentStreak += 1;
        if (silentStreak >= 4) {
          setError(
            await isWindowsPlatform()
              ? 'Windows loopback is active but still silent. Start Smart with a click once, then play audio on speakers and retry.'
              : 'System audio is active but still silent. Play audio on speakers and retry.',
          );
        }
        setPartial(
          silentStreak > 2
            ? 'Listening… (no audio yet — play something on speakers)'
            : 'Listening to system audio…',
        );
        return;
      }
      silentStreak = 0;
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
          if (transcription.ok && transcription.text?.trim()) {
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
          chunkMs: CONTINUOUS_CHUNK_MS,
        });
        if (res.ok && res.mode === 'stream') {
          useStream = true;
          setPartial(
            res.monitor
              ? `Listening (${res.monitor.split('.').pop() || 'monitor'})…`
              : 'Listening to system audio…',
          );
          const unsubChunk = window.osmos.onSystemAudioChunk?.(async (chunk) => {
            if (generationRef.current !== gen || !activeRef.current) return;
            if (!chunk.ok) {
              setError(chunk.error || 'System audio stream error');
              return;
            }
            if (!chunk.base64) return;
            await handleWav(chunk.base64, chunk.mimeType || 'audio/wav', chunk.silent);
          });
          const unsubStatus = window.osmos.onSystemAudioStatus?.((ev) => {
            if (generationRef.current === gen && ev.text) setPartial(ev.text);
          });
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
            ? await captureElectronLoopback(CONTINUOUS_CHUNK_MS)
            : await window.osmos.captureSystemAudio({
                durationMs: CONTINUOUS_CHUNK_MS,
                device: settingsRef.current?.systemAudioDevice || undefined,
              });
          if (!activeRef.current || generationRef.current !== gen) break;
          if (!capture.ok || !capture.base64) {
            setError(capture.error || 'System audio capture failed');
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

  return { listening, partial, error, start, stop, toggle, onFinal };
}
