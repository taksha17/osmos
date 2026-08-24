import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTINUOUS_SCREEN_MS,
  screenTextFingerprint,
  shouldAutoAssist,
} from '@shared/continuousAssist';
import { extractTextFromBase64 } from './ocr';

/**
 * Continuous silent full-screen → OCR loop for Smart assist.
 * Always uses loopSafe capture (no Wayland portal). LLM assist is fire-and-forget
 * via onScreenText so the poll loop never blocks on inference.
 */
export function useScreenAssist(opts?: {
  enabled?: boolean;
  onScreenText?: (text: string) => void;
  onStatus?: (status: string) => void;
}) {
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState('');
  const [lastText, setLastText] = useState('');
  const activeRef = useRef(false);
  const enabledRef = useRef(Boolean(opts?.enabled));
  enabledRef.current = Boolean(opts?.enabled);
  const onTextRef = useRef(opts?.onScreenText);
  onTextRef.current = opts?.onScreenText;
  const onStatusRef = useRef(opts?.onStatus);
  onStatusRef.current = opts?.onStatus;
  const lastFpRef = useRef('');
  const lastFrameHashRef = useRef('');
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    activeRef.current = false;
    generationRef.current += 1;
    setWatching(false);
    onStatusRef.current?.('');
  }, []);

  const start = useCallback(async () => {
    if (activeRef.current) return;

    if (window.osmos.canLoopSafeScreenCapture) {
      const gate = await window.osmos.canLoopSafeScreenCapture();
      if (!gate?.ok) {
        setError(
          'Continuous screen assist needs a non-portal capture tool (grim, gnome-screenshot, spectacle, or scrot on Linux).',
        );
        onStatusRef.current?.('Screen loop unavailable');
        return;
      }
    }

    activeRef.current = true;
    const gen = ++generationRef.current;
    setWatching(true);
    setError('');
    onStatusRef.current?.('Watching screen…');

    while (activeRef.current && generationRef.current === gen) {
      try {
        const capture = window.osmos.captureFullScreen
          ? await window.osmos.captureFullScreen({ loopSafe: true })
          : await window.osmos.captureRegion();
        if (!activeRef.current || generationRef.current !== gen) break;
        if (capture.cancelled || !capture.dataUrl) {
          if (capture.error) setError(capture.error);
          await sleep(CONTINUOUS_SCREEN_MS);
          continue;
        }

        const frameHash = roughFrameHash(capture.dataUrl);
        if (frameHash && frameHash === lastFrameHashRef.current) {
          onStatusRef.current?.('Watching screen…');
          await sleep(CONTINUOUS_SCREEN_MS);
          continue;
        }
        lastFrameHashRef.current = frameHash;

        onStatusRef.current?.('Reading screen…');
        const ocr = await extractTextFromBase64(capture.dataUrl);
        if (!activeRef.current || generationRef.current !== gen) break;
        const text = (ocr.text || '').trim();
        if (text.length >= 24) {
          const fp = screenTextFingerprint(text);
          if (fp !== lastFpRef.current) {
            lastFpRef.current = fp;
            setLastText(text);
            if (shouldAutoAssist(text, true) || text.length >= 80) {
              // Fire-and-forget — do not await LLM inside the capture loop.
              onTextRef.current?.(text);
            }
          }
        }
        onStatusRef.current?.('Watching screen…');
      } catch (e) {
        if (generationRef.current !== gen) break;
        setError(e instanceof Error ? e.message : String(e));
        await sleep(CONTINUOUS_SCREEN_MS);
        continue;
      }
      await sleep(CONTINUOUS_SCREEN_MS);
    }

    if (generationRef.current === gen) {
      activeRef.current = false;
      setWatching(false);
      onStatusRef.current?.('');
    }
  }, []);

  useEffect(() => {
    if (opts?.enabled) void start();
    else stop();
  }, [opts?.enabled, start, stop]);

  useEffect(() => () => stop(), [stop]);

  return { watching, error, lastText, start, stop };
}

function roughFrameHash(dataUrl: string): string {
  const len = dataUrl.length;
  if (len < 64) return `${len}:0`;
  let h = 0;
  const step = Math.max(1, Math.floor(len / 64));
  for (let i = 0; i < len; i += step) {
    h = (Math.imul(31, h) + dataUrl.charCodeAt(i)) | 0;
  }
  return `${len}:${h}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
