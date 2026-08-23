import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, SttProvider } from '../../shared/types';
import { recordingToWavBase64 } from './audioWav';
import {
  listMicrophones,
  MicSttSession,
  webspeechAvailable,
  type MicDevice,
} from './micStt';

export function useMicStt(
  settings: AppSettings | null,
  opts?: {
    onPreferProvider?: (provider: SttProvider) => void;
  },
) {
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const sessionRef = useRef<MicSttSession | null>(null);
  const finalHandlerRef = useRef<((text: string) => void) | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const preferRef = useRef(opts?.onPreferProvider);
  preferRef.current = opts?.onPreferProvider;

  const refreshDevices = useCallback(async () => {
    try {
      const list = await listMicrophones();
      setDevices(list);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not list microphones');
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const onFinal = useCallback((handler: (text: string) => void) => {
    finalHandlerRef.current = handler;
  }, []);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);

  const startWithProvider = useCallback(
    async (provider: SttProvider, opts?: { continuous?: boolean }) => {
      const s = settingsRef.current;
      if (!s) return;
      setError('');
      setPartial('');
      stop();

      const session = new MicSttSession(
        {
          sttProvider: provider,
          sttLanguage: s.sttLanguage,
          micDeviceId: s.micDeviceId,
        },
        {
          onPartial: setPartial,
          onFinal: (text) => {
            setPartial('');
            finalHandlerRef.current?.(text);
          },
          onError: setError,
          onListeningChange: setListening,
          onWebSpeechFailed: (code) => {
            preferRef.current?.('local-whisper');
            void (async () => {
              setError(
                code === 'network'
                  ? 'Web Speech cloud STT failed. Using Local Whisper — click Stop when finished speaking.'
                  : `Web Speech failed (${code}). Using Local Whisper — click Stop when finished speaking.`,
              );
              await startWithProvider('local-whisper');
            })();
          },
        },
        async (blob) => {
          if (provider === 'local-whisper') {
            setPartial('Transcribing locally (first run may download the model)…');
            try {
              const wav = await recordingToWavBase64(blob);
              return window.osmos.transcribeAudio({
                base64: wav.base64,
                mimeType: wav.mimeType,
                fileName: 'speech.wav',
                engine: 'local',
              });
            } catch (e) {
              return {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              };
            }
          }

          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
          return window.osmos.transcribeAudio({
            base64: btoa(binary),
            mimeType: blob.type || 'audio/webm',
            engine: 'openai',
          });
        },
        async (base64, mimeType) => {
          if (provider === 'local-whisper') {
            setPartial('Transcribing locally (first run may download the model)…');
            return window.osmos.transcribeAudio({
              base64,
              mimeType,
              fileName: 'speech.wav',
              engine: 'local',
            });
          }
          return window.osmos.transcribeAudio({
            base64,
            mimeType,
            engine: 'openai',
          });
        },
      );
      sessionRef.current = session;
      await session.start(opts);
    },
    [stop],
  );

  const start = useCallback(
    async (opts?: { continuous?: boolean }) => {
      const s = settingsRef.current;
      if (!s) return;
      await startWithProvider(s.sttProvider, opts);
    },
    [startWithProvider],
  );

  const toggle = useCallback(async () => {
    if (listening) stop();
    else await start();
  }, [listening, start, stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    devices,
    listening,
    partial,
    error,
    webspeechAvailable: webspeechAvailable(),
    refreshDevices,
    start,
    stop,
    toggle,
    onFinal,
  };
}
