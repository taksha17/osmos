import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, ChatStreamEvent, StarTemplate } from '../../shared/types';
import { continuousAssistPrompt, shouldAutoAssist } from '@shared/continuousAssist';
import { useMicStt } from '../stt/useMicStt';
import { useSystemAudioStt } from '../stt/useSystemAudioStt';
import { extractTextFromBase64 } from '../stt/ocr';
import { TranscriptTimeline } from './TranscriptTimeline';
import type { TranscriptEntry } from './TranscriptTimeline';
import { EvidencePanel } from './EvidencePanel';
import { OverlayQuickMenu } from './OverlayQuickMenu';

function sttEngine(settings: AppSettings | null): 'local' | 'openai' {
  return settings?.sttProvider === 'openai-whisper' ? 'openai' : 'local';
}

type Msg = {
  role: 'user' | 'assistant';
  content: string;
  evidence?: {
    usedWebSearch: boolean;
    searchHits: number;
    documentCount: number;
    usedRetrieval?: boolean;
  };
};

type OverlayControls = {
  paused: boolean;
  togglePause: () => void;
};

type Props = {
  settings: AppSettings | null;
  compact?: boolean;
  overlay?: boolean;
  title?: string;
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  onPreferSttProvider?: (provider: AppSettings['sttProvider']) => void;
  onRegisterControls?: (controls: OverlayControls) => void;
  onSettingsChange?: (next: AppSettings) => void;
};

const OVERLAY_PROMPTS = {
  assist: 'Help me respond to what is being discussed right now. Be concise and speakable.',
  whatToSay: 'What should I say next? Give a short, natural response I can use immediately.',
  followUp: 'Suggest 3 smart follow-up questions based on the conversation.',
  recap: 'Give me a brief recap of the key points discussed so far.',
} as const;

function starAssistPrompt(t: StarTemplate) {
  return [
    'Help me answer using this STAR story. Keep it speakable and under 90 seconds.',
    `Story: ${t.label}`,
    `Situation: ${t.situation}`,
    `Task: ${t.task}`,
    `Action: ${t.action}`,
    `Result: ${t.result}`,
  ].join('\n');
}

export function ChatPanel({
  settings,
  compact,
  overlay,
  title,
  paused = false,
  onPausedChange,
  onPreferSttProvider,
  onRegisterControls,
  onSettingsChange,
}: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [streamMeta, setStreamMeta] = useState('');
  const [ocrStatus, setOcrStatus] = useState('');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [continuousEnabled, setContinuousEnabled] = useState(false);
  const [starTemplates, setStarTemplates] = useState<StarTemplate[]>([]);
  const continuousRef = useRef(continuousEnabled);
  continuousRef.current = continuousEnabled;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const mic = useMicStt(settings, { onPreferProvider: onPreferSttProvider });
  const system = useSystemAudioStt(settings);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const cancelRef = useRef<null | (() => void)>(null);
  const sessionIdRef = useRef(typeof crypto !== 'undefined' && crypto.randomUUID?.() || `session-${Date.now()}`);
  const micDeviceRef = useRef(settings?.micDeviceId);
  const micStopRef = useRef(mic.stop);
  const micStartRef = useRef(mic.start);
  micStopRef.current = mic.stop;
  micStartRef.current = mic.start;
  const systemStopRef = useRef(system.stop);
  const systemStartRef = useRef(system.start);
  systemStopRef.current = system.stop;
  systemStartRef.current = system.start;
  const lastAssistRef = useRef({ key: '', at: 0 });
  const micFailRef = useRef(0);
  const systemFailRef = useRef(0);

  const assistSource = settings?.assistAudioSource || 'system';
  const wantsSystem =
    continuousEnabled && (assistSource === 'system' || assistSource === 'both');
  const wantsMic = continuousEnabled && (assistSource === 'mic' || assistSource === 'both');

  useEffect(() => {
    if (overlay && !paused) setContinuousEnabled(true);
  }, [overlay, paused]);

  useEffect(() => {
    if (!overlay) return;
    void window.osmos.listStarTemplates().then((res) => {
      if (res.ok && res.templates) setStarTemplates(res.templates);
    });
  }, [overlay]);

  useEffect(() => {
    if (!overlay) return;
    if (paused) {
      micStopRef.current();
      systemStopRef.current();
      cancelRef.current?.();
      cancelRef.current = null;
    }
  }, [overlay, paused]);

  useEffect(() => {
    if (!overlay || paused || !wantsMic || !settings || busy || mic.listening) return;
    if (mic.error && Date.now() - micFailRef.current < 5000) return;
    const useChunk = settings.sttProvider !== 'webspeech';
    void micStartRef.current(useChunk ? { continuous: true } : undefined).catch(() => {
      micFailRef.current = Date.now();
    });
  }, [overlay, paused, wantsMic, settings, busy, mic.listening, mic.error]);

  useEffect(() => {
    if (!overlay || paused || !wantsSystem || !settings || system.listening) return;
    if (system.error && Date.now() - systemFailRef.current < 5000) return;
    void systemStartRef.current().catch(() => {
      systemFailRef.current = Date.now();
    });
  }, [overlay, paused, wantsSystem, settings, system.listening, system.error]);

  useEffect(() => {
    if (settings?.micDeviceId === micDeviceRef.current) return;
    micDeviceRef.current = settings?.micDeviceId;
    if (!overlay || paused || !wantsMic || !settings) return;
    micStopRef.current();
    const useChunk = settings.sttProvider !== 'webspeech';
    if (mic.error && Date.now() - micFailRef.current < 5000) return;
    void micStartRef.current(useChunk ? { continuous: true } : undefined).catch(() => {
      micFailRef.current = Date.now();
    });
  }, [settings?.micDeviceId, overlay, paused, wantsMic, settings]);

  useEffect(() => {
    if (overlay) {
      if ((paused || !wantsMic) && mic.listening) micStopRef.current();
      if ((paused || !wantsSystem) && system.listening) systemStopRef.current();
      return;
    }
    if (continuousEnabled && settings && !busy && !mic.listening) {
      if (mic.error && Date.now() - micFailRef.current < 5000) return;
      void micStartRef.current();
    } else if (!continuousEnabled && mic.listening) {
      micStopRef.current();
    }
  }, [overlay, continuousEnabled, paused, wantsMic, wantsSystem, settings, busy, mic.listening, system.listening, mic.error]);

  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    onPausedChange?.(next);
    if (next) {
      micStopRef.current();
      systemStopRef.current();
      cancelRef.current?.();
      cancelRef.current = null;
    } else if (overlay) {
      micFailRef.current = 0;
      systemFailRef.current = 0;
      setContinuousEnabled(true);
    }
  }, [onPausedChange, overlay]);

  const updateSettingsPatch = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await window.osmos.updateSettings(patch);
      onSettingsChange?.(next);
    },
    [onSettingsChange],
  );

  const sttLabel =
    settings?.sttProvider === 'openai-whisper'
      ? 'Whisper API'
      : settings?.sttProvider === 'local-whisper'
        ? 'Local Whisper'
        : 'Web Speech';

  const modeLabel =
    settings?.activeMode === 'interview'
      ? 'Interview'
      : settings?.activeMode === 'meeting'
        ? 'Meeting'
        : 'General';

  const sendMessage = useCallback(async (textIn?: string) => {
    const text = (textIn ?? input).trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    setStreamMeta('');
    setInput('');
    const history = messagesRef.current;
    const next = [...history, { role: 'user' as const, content: text }];
    setMessages([...next, { role: 'assistant', content: '' }]);

    const stream = window.osmos.askStream({ message: text, history }, (ev: ChatStreamEvent) => {
      if (ev.type === 'meta') {
        setStreamMeta(
          ev.usedWebSearch ? `Searching… ${ev.searchHits} hits` : 'Thinking…',
        );
      } else if (ev.type === 'status') {
        setStreamMeta(ev.text);
      } else if (ev.type === 'delta') {
        setStreamMeta((m) =>
          m.startsWith('Searching') || m.startsWith('Model thinking') ? 'Writing…' : m || 'Writing…',
        );
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          copy[copy.length - 1] = { role: 'assistant', content: last.content + ev.text };
          return copy;
        });
      } else if (ev.type === 'done') {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          const body = (ev.answer || last.content || '').trim();
          copy[copy.length - 1] = {
            role: 'assistant',
            content: body,
            evidence: {
              usedWebSearch: ev.usedWebSearch,
              searchHits: ev.searchHits,
              documentCount:
                settings?.profiles?.find((p) => p.id === settings.activeProfileId)?.documents
                  ?.length ||
                settings?.documents?.length ||
                0,
              usedRetrieval:
                (
                  settings?.profiles?.find((p) => p.id === settings.activeProfileId)?.documents
                    ?.length ||
                  settings?.documents?.length ||
                  0
                ) > 0,
            },
          };
          return copy;
        });
        setStreamMeta('');
      } else if (ev.type === 'error') {
        if (ev.error !== 'Cancelled') setError(ev.error);
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant' && !last.content.trim()) copy.pop();
          return copy;
        });
        setStreamMeta('');
      }
    });

    cancelRef.current = () => {
      void stream.cancel();
    };

    try {
      await stream.done;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      cancelRef.current = null;
      setBusy(false);
      setStreamMeta('');
      if (!overlay || !continuousRef.current || pausedRef.current || !settings) return;
      const source = settings.assistAudioSource || 'system';
      if ((source === 'mic' || source === 'both') && !mic.listening) {
        if (!mic.error || Date.now() - micFailRef.current >= 5000) {
          const useChunk = settings.sttProvider !== 'webspeech';
          void mic.start(useChunk ? { continuous: true } : undefined);
        }
      }
      if ((source === 'system' || source === 'both') && !system.listening) {
        if (!system.error || Date.now() - systemFailRef.current >= 5000) {
          void system.start();
        }
      }
    }
  }, [busy, input, overlay, settings, mic, system]);

  const sendRef = useRef(sendMessage);
  sendRef.current = sendMessage;

  useEffect(() => {
    if (!overlay) return;
    try {
      const raw = sessionStorage.getItem('osmos-resume-session');
      if (!raw) return;
      sessionStorage.removeItem('osmos-resume-session');
      const data = JSON.parse(raw) as {
        id?: string;
        messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
      };
      if (data.id) sessionIdRef.current = data.id;
      if (data.messages?.length) {
        setMessages(data.messages.filter((m) => m.role === 'user' || m.role === 'assistant'));
      }
    } catch {
      /* ignore bad resume payload */
    }
  }, [overlay]);

  const ingestFinal = useCallback(
    (text: string) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      if (pausedRef.current) return;
      setInput(cleaned);
      setTranscript((prev) => [
        ...prev,
        {
          id: crypto.randomUUID?.() || `t-${Date.now()}`,
          text: cleaned,
          timestamp: Date.now(),
          isFinal: true,
        },
      ]);

      const mode = settings?.activeMode || 'general';
      const smart = continuousRef.current && overlay && !pausedRef.current;
      const autoAsk = settings?.autoAskOnFinal || smart;
      if (!autoAsk) return;
      if (smart && !shouldAutoAssist(cleaned, true)) return;

      const key = cleaned.toLowerCase().slice(0, 80);
      const now = Date.now();
      if (key && key === lastAssistRef.current.key && now - lastAssistRef.current.at < 5000) return;
      lastAssistRef.current = { key, at: now };

      const prompt = smart && overlay ? continuousAssistPrompt(cleaned, mode) : cleaned;
      void sendRef.current(prompt);
    },
    [overlay, settings?.activeMode, settings?.autoAskOnFinal],
  );

  useEffect(() => {
    mic.onFinal(ingestFinal);
  }, [mic.onFinal, ingestFinal]);

  useEffect(() => {
    system.onFinal(ingestFinal);
  }, [system.onFinal, ingestFinal]);

  useEffect(() => {
    if (mic.partial) {
      setTranscript((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && !last.isFinal) {
          next[next.length - 1] = { ...last, text: mic.partial };
        } else {
          next.push({ id: `p-${Date.now()}`, text: mic.partial, timestamp: Date.now(), isFinal: false });
        }
        return next;
      });
    }
  }, [mic.partial]);

  useEffect(() => {
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'assistant') return;
    const session = {
      id: sessionIdRef.current,
      mode: settings?.activeMode || 'general',
      messages: messages.map((m) => ({ ...m, createdAt: Date.now() })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    void window.osmos.saveHistory(session).catch(() => {});
  }, [messages, settings?.activeMode]);

  useEffect(() => {
    onRegisterControls?.({
      paused,
      togglePause,
    });
  }, [onRegisterControls, paused, togglePause]);

  const latestAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const answerText =
    busy && messages[messages.length - 1]?.role === 'assistant'
      ? messages[messages.length - 1].content
      : latestAssistant?.content || '';
  const answerPlaceholder =
    system.listening || mic.listening
      ? system.partial || mic.partial || (system.listening ? 'Listening to meeting audio…' : 'Listening…')
      : 'Answers appear here while you interview, meet, or share your screen.';

  const captureScreen = async () => {
    setOcrStatus('Capturing…');
    try {
      const result = await window.osmos.captureRegion();
      if (result.cancelled) {
        setOcrStatus('');
        return;
      }
      setOcrStatus('OCR…');
      const ocr = await extractTextFromBase64(result.dataUrl);
      if (ocr.text) {
        setInput((prev) => (prev ? `${prev}\n\n[Screen]\n${ocr.text}` : `[Screen]\n${ocr.text}`));
      } else {
        setError(ocr.error || 'OCR returned no text');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcrStatus('');
    }
  };

  const captureAudio = async () => {
    if (system.listening) {
      system.stop();
      return;
    }
    // Toggle continuous system listen (Smart loopback). Shift-click path unused —
    // one-shot still available from Chat 🔊.
    void system.start();
  };

  const captureAudioOnce = async () => {
    setOcrStatus('Capturing audio…');
    try {
      const capture = await window.osmos.captureSystemAudio({
        durationMs: 5000,
        device: settings?.systemAudioDevice,
      });
      if (!capture.ok) {
        setError(capture.error || 'System audio capture failed');
        return;
      }
      setOcrStatus('Transcribing…');
      const transcription = await window.osmos.transcribeAudio({
        base64: capture.base64 || '',
        mimeType: capture.mimeType || 'audio/wav',
        fileName: 'system-audio.wav',
        engine: sttEngine(settings),
      });
      if (transcription.ok && transcription.text) {
        setInput((prev) =>
          prev ? `${prev}\n\n[Audio]\n${transcription.text}` : `[Audio]\n${transcription.text}`,
        );
      } else {
        setError(transcription.error || 'Transcription failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcrStatus('');
    }
  };

  if (overlay) {
    return (
      <section className="overlay-panel">
        <div className="overlay-panel__head">
          {settings ? (
            <OverlayQuickMenu
              settings={settings}
              micDevices={mic.devices}
              onRefreshMics={() => void mic.refreshDevices()}
              onUpdate={updateSettingsPatch}
            />
          ) : (
            <span className="meta">Loading…</span>
          )}
          <button
            type="button"
            className="overlay-cta"
            disabled={busy}
            onClick={() => void sendMessage(OVERLAY_PROMPTS.whatToSay)}
          >
            What should I say?
          </button>
        </div>

        <div className="overlay-answer" aria-live="polite">
          {answerText ? (
            <>
              <p className="overlay-answer__text">{answerText || '▍'}</p>
              {latestAssistant?.evidence ? (
                <EvidencePanel
                  usedWebSearch={latestAssistant.evidence.usedWebSearch}
                  searchHits={latestAssistant.evidence.searchHits}
                  documentCount={latestAssistant.evidence.documentCount}
                  usedRetrieval={latestAssistant.evidence.usedRetrieval}
                />
              ) : null}
            </>
          ) : busy ? (
            <div className="overlay-answer__thinking">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="meta">{streamMeta || 'Thinking…'}</span>
            </div>
          ) : (
            <p className="overlay-answer__placeholder">{answerPlaceholder}</p>
          )}
        </div>

        <div className="overlay-actions">
          <button type="button" disabled={busy} onClick={() => void sendMessage(OVERLAY_PROMPTS.assist)}>
            ✦ Assist
          </button>
          <span className="overlay-actions__dot" aria-hidden>·</span>
          <button type="button" disabled={busy} onClick={() => void sendMessage(OVERLAY_PROMPTS.whatToSay)}>
            What should I say?
          </button>
          <span className="overlay-actions__dot" aria-hidden>·</span>
          <button type="button" disabled={busy} onClick={() => void sendMessage(OVERLAY_PROMPTS.followUp)}>
            Follow-up questions
          </button>
          <span className="overlay-actions__dot" aria-hidden>·</span>
          <button type="button" disabled={busy} onClick={() => void sendMessage(OVERLAY_PROMPTS.recap)}>
            ↻ Recap
          </button>
          {starTemplates[0] ? (
            <>
              <span className="overlay-actions__dot" aria-hidden>·</span>
              <button
                type="button"
                disabled={busy}
                title={starTemplates[0].label}
                onClick={() => void sendMessage(starAssistPrompt(starTemplates[0]!))}
              >
                STAR story
              </button>
            </>
          ) : null}
        </div>

        <div className="overlay-tools">
          <button
            type="button"
            className={`overlay-tool${mic.listening ? ' overlay-tool--live' : ''}`}
            onClick={() => void mic.toggle()}
            disabled={busy}
            title="Microphone"
          >
            Mic
          </button>
          <button type="button" className="overlay-tool" onClick={() => void captureScreen()} disabled={busy} title="Screen OCR">
            Screen
          </button>
          <button
            type="button"
            className={`overlay-tool${system.listening ? ' overlay-tool--live' : ''}`}
            onClick={() => void captureAudio()}
            disabled={busy}
            title={system.listening ? 'Stop system audio listen' : 'Listen to system / meeting audio'}
          >
            Audio
          </button>
          {busy ? (
            <button type="button" className="overlay-tool overlay-tool--live" onClick={() => cancelRef.current?.()}>
              Stop
            </button>
          ) : null}
          <span className="overlay-tools__status meta">
            {paused
              ? 'Paused — tap ▶ to resume'
              : `${continuousEnabled ? '⚡ Smart · ' : ''}${
                  ocrStatus ||
                  system.partial ||
                  (system.listening
                    ? 'Meeting audio…'
                    : mic.listening
                      ? continuousEnabled
                        ? 'Listening…'
                        : 'Mic on'
                      : streamMeta || 'Ready')
                }`}
          </span>
        </div>

        {(error || mic.error || system.error) && (
          <div className="overlay-error">{error || mic.error || system.error}</div>
        )}

        <div className="overlay-composer">
          <button
            type="button"
            className={`overlay-smart${continuousEnabled ? ' overlay-smart--on' : ''}`}
            onClick={() => setContinuousEnabled((v) => !v)}
            disabled={busy}
            title="Auto-listen and assist"
          >
            ⚡ Smart
          </button>
          <input
            className="overlay-composer__input"
            value={input}
            placeholder="Ask about your screen or conversation, or Ctrl+Enter for Assist"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
                return;
              }
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void sendMessage(input.trim() || OVERLAY_PROMPTS.assist);
              }
            }}
          />
          <button
            type="button"
            className="overlay-send"
            disabled={busy || !input.trim()}
            onClick={() => void sendMessage()}
            aria-label="Send"
          >
            ▶
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`panel chat ${compact ? 'chat--compact' : ''}`}>
      {title ? <strong style={{ fontFamily: 'var(--font-display)' }}>{title}</strong> : null}
      {!compact && (
        <>
          <h2>Chat</h2>
          <p>
            Speak or type. Replies stream token-by-token from Ollama.
            Mode: {modeLabel} · Mic: {sttLabel}
            {settings?.webSearchProvider && settings.webSearchProvider !== 'off'
              ? ` · Web: ${settings.webSearchProvider}`
              : ''}
          </p>
        </>
      )}

      <div className="mic-bar">
        <button
          type="button"
          className={`mic-btn ${mic.listening ? 'mic-btn--live' : ''}`}
          onClick={() => void mic.toggle()}
          disabled={busy}
          title="Start/stop microphone"
        >
          {mic.listening ? 'Stop mic' : 'Start mic'}
        </button>
        <button
          type="button"
          className={`mic-btn ${continuousEnabled ? 'mic-btn--live' : ''}`}
          onClick={() => setContinuousEnabled((v) => !v)}
          disabled={busy}
          title="Toggle continuous assistant"
        >
          {continuousEnabled ? 'Continuous on' : 'Continuous'}
        </button>
        <button
          type="button"
          className="mic-btn"
          onClick={async () => {
            setOcrStatus('Capturing…');
            try {
              const result = await window.osmos.captureRegion();
              if (result.cancelled) {
                setOcrStatus('');
                return;
              }
              setOcrStatus('OCR…');
              const ocr = await extractTextFromBase64(result.dataUrl);
              if (ocr.text) {
                setInput((prev) => (prev ? `${prev}\n\n[OCR]\n${ocr.text}` : `[OCR]\n${ocr.text}`));
              } else {
                setError(ocr.error || 'OCR returned no text');
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setOcrStatus('');
            }
          }}
          disabled={busy}
          title="Capture screen region and OCR"
        >
          📷
        </button>
        <button
          type="button"
          className="mic-btn"
          onClick={() => void captureAudioOnce()}
          disabled={busy}
          title="Capture 5s of system audio and transcribe"
        >
          🔊
        </button>
        {busy ? (
          <button type="button" className="mic-btn mic-btn--live" onClick={() => cancelRef.current?.()}>
            Stop reply
          </button>
        ) : null}
        <span className="meta">
          {busy
            ? streamMeta || 'Streaming…'
            : ocrStatus
              ? ocrStatus
              : mic.listening
                ? settings?.sttProvider === 'webspeech'
                  ? 'Listening…'
                  : 'Recording… click Stop when done'
                : 'Mic idle'}
        </span>
        {mic.partial ? <span className="partial">{mic.partial}</span> : null}
      </div>

      <TranscriptTimeline entries={transcript} />

      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`} style={{ position: 'relative' }}>
            {m.content || (busy && i === messages.length - 1 && m.role === 'assistant' ? '▍' : '')}
            {m.role === 'assistant' && m.content && !busy && (
              <button
                className="copy-btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(m.content);
                  } catch {
                    // ignore
                  }
                }}
              >
                Copy
              </button>
            )}
            {m.role === 'assistant' && m.evidence ? (
              <EvidencePanel
                usedWebSearch={m.evidence.usedWebSearch}
                searchHits={m.evidence.searchHits}
                documentCount={m.evidence.documentCount}
                usedRetrieval={m.evidence.usedRetrieval}
              />
            ) : null}
          </div>
        ))}
        {busy && messages.length > 0 && messages[messages.length - 1].role === 'user' && (
          <div className="typing-indicator">
            <div className="typing-dot" />
            <div className="typing-dot" />
            <div className="typing-dot" />
          </div>
        )}
      </div>

      {(error || mic.error) && <div className="error">{error || mic.error}</div>}

      <div className="composer">
        <textarea
          value={input}
          placeholder="Ask anything, or use the mic…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button disabled={busy || !input.trim()} onClick={() => void sendMessage()}>
          {busy ? '…' : 'Ask'}
        </button>
      </div>
    </section>
  );
}
