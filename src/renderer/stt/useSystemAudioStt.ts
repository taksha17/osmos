import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../shared/types';
import { CONTINUOUS_CHUNK_MS, CONTINUOUS_MAX_IN_FLIGHT } from '@shared/continuousAssist';

function engineForSettings(settings: AppSettings | null): 'local' | 'openai' {
  if (!settings) return 'local';
  // System audio cannot use Web Speech — prefer local Whisper, else OpenAI Whisper API.
  if (settings.sttProvider === 'openai-whisper') return 'openai';
  return 'local';
}

/**
 * Continuous system-audio (loopback) → STT loop for Smart / meeting assist.
 * Captures the next chunk while the previous one is still transcribing so meeting
 * audio is not dropped during Whisper latency.
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

  const onFinal = useCallback((handler: (text: string) => void) => {
    finalHandlerRef.current = handler;
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    generationRef.current += 1;
    setListening(false);
    setPartial('');
  }, []);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    const s = settingsRef.current;
    if (!s) return;

    activeRef.current = true;
    const gen = ++generationRef.current;
    setListening(true);
    setError('');
    setPartial('Listening to system audio…');

    const chunkMs = CONTINUOUS_CHUNK_MS;
    const maxInFlight = CONTINUOUS_MAX_IN_FLIGHT;
    const pending = new Set<Promise<void>>();
    let nextEmit = 1;
    let nextSeq = 0;
    const held = new Map<number, string | null>();

    const emitReady = () => {
      while (held.has(nextEmit)) {
        const text = held.get(nextEmit);
        held.delete(nextEmit);
        nextEmit += 1;
        if (text) finalHandlerRef.current?.(text);
      }
    };

    const transcribeChunk = async (
      seq: number,
      capture: { base64: string; mimeType?: string },
    ) => {
      try {
        const transcription = await window.osmos.transcribeAudio({
          base64: capture.base64,
          mimeType: capture.mimeType || 'audio/wav',
          fileName: 'system-audio.wav',
          engine: engineForSettings(settingsRef.current),
        });
        if (generationRef.current !== gen) return;
        if (transcription.ok && transcription.text?.trim()) {
          held.set(seq, transcription.text.trim());
          emitReady();
          return;
        }
        if (!transcription.ok && transcription.error && !/too short|empty/i.test(transcription.error)) {
          setError(transcription.error);
          activeRef.current = false;
        }
        held.set(seq, null);
        emitReady();
      } catch (e) {
        if (generationRef.current !== gen) return;
        setError(e instanceof Error ? e.message : String(e));
        activeRef.current = false;
        held.set(seq, null);
        emitReady();
      }
    };

    while (activeRef.current && generationRef.current === gen) {
      while (pending.size >= maxInFlight && activeRef.current && generationRef.current === gen) {
        setPartial('Transcribing (next capture waiting)…');
        await Promise.race(pending);
      }
      if (!activeRef.current || generationRef.current !== gen) break;

      setPartial(pending.size ? 'Listening + transcribing…' : 'Listening to system audio…');
      let capture;
      try {
        capture = await window.osmos.captureSystemAudio({
          durationMs: chunkMs,
          device: settingsRef.current?.systemAudioDevice,
        });
      } catch (e) {
        if (generationRef.current !== gen) break;
        setError(e instanceof Error ? e.message : String(e));
        break;
      }
      if (!activeRef.current || generationRef.current !== gen) break;

      if (!capture.ok || !capture.base64) {
        setError(capture.error || 'System audio capture failed');
        break;
      }

      const seq = ++nextSeq;
      const job = transcribeChunk(seq, { base64: capture.base64, mimeType: capture.mimeType });
      pending.add(job);
      void job.finally(() => pending.delete(job));
    }

    if (pending.size) await Promise.allSettled([...pending]);

    if (generationRef.current === gen) {
      activeRef.current = false;
      setListening(false);
      setPartial('');
    }
  }, []);

  const toggle = useCallback(async () => {
    if (activeRef.current) stop();
    else await start();
  }, [start, stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    listening,
    partial,
    error,
    start,
    stop,
    toggle,
    onFinal,
  };
}
