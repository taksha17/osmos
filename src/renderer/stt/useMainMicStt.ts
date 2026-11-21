import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../shared/types';

function engineFor(settings: AppSettings | null): 'local' | 'openai' {
  return settings?.sttProvider === 'openai-whisper' ? 'openai' : 'local';
}

/**
 * Smart-mode microphone STT driven entirely by the main-process mic stream
 * (mic:listen-start → mic:audio-chunk). The renderer only transcribes chunks,
 * so React lifecycle changes can never kill the capture itself.
 */
export function useMainMicStt(settings: AppSettings | null) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const finalRef = useRef<((text: string) => void) | null>(null);
  const genRef = useRef(0);
  const unsubsRef = useRef<Array<() => void>>([]);
  const lastChunkAt = useRef(0);
  const restartingRef = useRef(false);
  /** True once the VAD path has delivered an utterance this session (§5.2). */
  const utterancePathRef = useRef(false);

  const onFinal = useCallback((handler: (text: string) => void) => {
    finalRef.current = handler;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (typeof window.osmos.startMicListen !== 'function') {
      setError('Main-process mic streaming unavailable (needs Linux build).');
      return;
    }
    const gen = ++genRef.current;
    utterancePathRef.current = false;
    setError('');
    setListening(true);
    setPartial('🎙 starting mic…');
    try {
      lastChunkAt.current = Date.now();
      const res = await window.osmos.startMicListen({
        device: settingsRef.current?.micDeviceId || undefined,
        chunkMs: settingsRef.current?.transcribeChunkMs || 4000,
      });
      if (genRef.current !== gen) return;
      if (!res.ok) {
        setError(res.error || 'Mic listen failed');
        setListening(false);
        setPartial('');
        return;
      }
      // VAD-endpointed utterances are the primary path (§5.2): the detector only
      // ships audio that contains speech, so the model is never asked to
      // transcribe a fixed 4 s slice that starts mid-word.
      const transcribeUtterance = async (ev: {
        ok: boolean;
        base64?: string;
        mimeType?: string;
        error?: string;
      }) => {
        if (genRef.current !== gen) return;
        if (!ev.ok || !ev.base64) {
          if (ev.error) setError(ev.error);
          return;
        }
        utterancePathRef.current = true;
        lastChunkAt.current = Date.now();
        setPartial('Transcribing…');
        try {
          const t = await window.osmos.transcribeAudio({
            base64: ev.base64,
            mimeType: ev.mimeType || 'audio/wav',
            fileName: 'mic-utterance.wav',
            engine: engineFor(settingsRef.current),
            model: settingsRef.current?.localSttModel,
          });
          if (genRef.current !== gen) return;
          if (t.ok && t.text?.trim()) {
            setPartial('');
            finalRef.current?.(t.text.trim());
          } else if (
            t.error &&
            !/empty text|too short|silent|no speech/i.test(t.error || '')
          ) {
            setError(t.error);
          } else {
            setPartial('🎙 listening…');
          }
        } catch (e) {
          if (genRef.current !== gen) return;
          setError(e instanceof Error ? e.message : String(e));
          setPartial('🎙 listening…');
        }
      };

      const unsubUtterance = window.osmos.onMicUtterance?.(transcribeUtterance);
      if (unsubUtterance) unsubsRef.current.push(unsubUtterance);

      const unsubChunk = window.osmos.onMicChunk?.(async (chunk) => {
        if (genRef.current !== gen) return;
        if (!chunk.ok) {
          setError(chunk.error || 'Mic stream error');
          return;
        }
        lastChunkAt.current = Date.now();
        if (!chunk.base64) return;
        if (chunk.silent) {
          setPartial('🎙 listening…');
          return;
        }
        // While the VAD path is alive, chunks are telemetry only — transcribing
        // both would repeat the same speech twice.
        if (utterancePathRef.current) return;
        setPartial('Transcribing…');
        try {
          const t = await window.osmos.transcribeAudio({
            base64: chunk.base64,
            mimeType: chunk.mimeType || 'audio/wav',
            fileName: 'mic-chunk.wav',
            engine: engineFor(settingsRef.current),
            model: settingsRef.current?.localSttModel,
          });
          if (genRef.current !== gen) return;
          if (t.ok && t.text?.trim()) {
            setPartial('');
            finalRef.current?.(t.text.trim());
          } else if (
            t.error &&
            !/empty text|too short|silent|no speech/i.test(t.error || '')
          ) {
            setError(t.error);
          } else {
            setPartial('🎙 listening…');
          }
        } catch (e) {
          if (genRef.current !== gen) return;
          setError(e instanceof Error ? e.message : String(e));
          setPartial('🎙 listening…');
        }
      });
      if (unsubChunk) unsubsRef.current.push(unsubChunk);
    } catch (e) {
      if (genRef.current !== gen) return;
      setError(e instanceof Error ? e.message : String(e));
      setListening(false);
      setPartial('');
    }
  }, []);

  const stop = useCallback(async () => {
    genRef.current += 1;
    utterancePathRef.current = false;
    for (const u of unsubsRef.current.splice(0)) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    try {
      await window.osmos.stopMicListen?.();
    } catch {
      /* ignore */
    }
    setListening(false);
    setPartial('');
  }, []);

  const toggle = useCallback(async () => {
    if (listening) await stop();
    else await start();
  }, [listening, start, stop]);

  const startRef = useRef(start);
  startRef.current = start;

  // Stall watchdog: chunks (even silent ones) arrive every ~6s while alive.
  // >15s of starvation means the pipe died without an error — rebuild it.
  useEffect(() => {
    if (!listening) return;
    const t = window.setInterval(() => {
      if (restartingRef.current) return;
      if (!lastChunkAt.current || Date.now() - lastChunkAt.current <= 15_000) return;
      restartingRef.current = true;
      lastChunkAt.current = 0;
      void (async () => {
        try {
          await window.osmos.stopMicListen?.();
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 400));
        genRef.current += 1;
        for (const u of unsubsRef.current.splice(0)) {
          try {
            u();
          } catch {
            /* ignore */
          }
        }
        setPartial('🎙 reconnecting…');
        await startRef.current();
        restartingRef.current = false;
      })();
    }, 4000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  useEffect(
    () => () => {
      genRef.current += 1;
      for (const u of unsubsRef.current.splice(0)) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
      void window.osmos.stopMicListen?.();
    },
    [],
  );

  return { listening, partial, error, start, stop, toggle, onFinal };
}
