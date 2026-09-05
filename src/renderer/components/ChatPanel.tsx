import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, ChatStreamEvent, StarTemplate } from '../../shared/types';
import {
  fusedAssistPrompt,
  SCREEN_CONTEXT_FRESH_MS,
  shouldAutoAssist,
} from '@shared/continuousAssist';
import { prepareScreenContext, SCREEN_CONTEXT_MAX_CHARS } from '@shared/screenContext';
import { useMainMicStt } from '../stt/useMainMicStt';
import { useSystemAudioStt } from '../stt/useSystemAudioStt';
import { extractTextFromBase64 } from '../stt/ocr';
import {
  getLatestLiveFrame,
  startLiveScreenStream,
  stopLiveScreenStream,
} from '../stt/liveScreenStream';
import { TranscriptTimeline } from './TranscriptTimeline';
import type { TranscriptEntry } from './TranscriptTimeline';
import { MarkdownText } from './MarkdownText';
import { EvidencePanel } from './EvidencePanel';
import { OverlayQuickMenu } from './OverlayQuickMenu';

function sttEngine(settings: AppSettings | null): 'local' | 'openai' {
  return settings?.sttProvider === 'openai-whisper' ? 'openai' : 'local';
}

/** Status strings from the STT hooks — not words the user/meeting just said. */
function isSttStatusLine(text: string): boolean {
  return /^(starting|listening|waiting|ready|no laptop|ocr|screen read|👁|📄)/i.test(text.trim());
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
  onRegisterControls,
  onSettingsChange,
}: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [streamMeta, setStreamMeta] = useState('');
  const [ocrStatus, setOcrStatus] = useState('');
  const [liveScreen, setLiveScreen] = useState(false);
  const [liveScreenStatus, setLiveScreenStatus] = useState('');
  /** UI mirror of lastScreenRef so the status line can show "screen ctx · N chars". */
  const [screenInfo, setScreenInfo] = useState<{ chars: number; at: number; preview: string }>({
    chars: 0,
    at: 0,
    preview: '',
  });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [continuousEnabled, setContinuousEnabled] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [starTemplates, setStarTemplates] = useState<StarTemplate[]>([]);
  const continuousRef = useRef(continuousEnabled);
  continuousRef.current = continuousEnabled;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const mainMic = useMainMicStt(settings);
  const system = useSystemAudioStt(settings);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const cancelRef = useRef<null | (() => void)>(null);
  const sessionIdRef = useRef(typeof crypto !== 'undefined' && crypto.randomUUID?.() || `session-${Date.now()}`);
  const mainMicStopRef = useRef(mainMic.stop);
  const mainMicStartRef = useRef(() => mainMic.start());
  mainMicStopRef.current = mainMic.stop;
  mainMicStartRef.current = () => mainMic.start();
  const systemStopRef = useRef(system.stop);
  const systemStartRef = useRef(system.start);
  systemStopRef.current = system.stop;
  systemStartRef.current = system.start;
  const lastAssistRef = useRef({ key: '', at: 0 });
  const lastScreenRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  transcriptRef.current = transcript;
  const inputRef = useRef('');
  inputRef.current = input;
  const micFailRef = useRef(0);
  const systemFailRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const assistSource = settings?.assistAudioSource || 'system';
  const wantsSystem =
    continuousEnabled && (assistSource === 'system' || assistSource === 'both');
  const wantsMic = continuousEnabled && (assistSource === 'mic' || assistSource === 'both');

  // Mic device list for the overlay's quick-pick menu. Refreshed on demand —
  // mainMic doesn't own devices, so we go through the platform listAudioDevices
  // IPC whenever the menu opens or refresh is requested.
  const [micDevices, setMicDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const refreshMicDevices = useCallback(async () => {
    try {
      const res = await window.osmos.listAudioDevices();
      if (res?.ok) {
        setMicDevices(
          (res.inputs ?? []).map((d) => ({ deviceId: d.id, label: d.name })),
        );
      }
    } catch {
      /* non-fatal */
    }
  }, []);

  /**
   * Self-healing listener watchdog.
   *
   * Historically ears only (re)started inside sendMessage's completion handler,
   * so a fresh Smart session captured nothing until the first manual assist —
   * and any listener death stayed dead. This watchdog starts each wanted ear
   * as soon as Smart is on and revives it after failures with a 5s backoff.
   */
  useEffect(() => {
    if (!wantsMic && !wantsSystem) return;
    let cancelled = false;
    const lastAttempt = { mic: 0, system: 0 };

    const tick = () => {
      if (cancelled || pausedRef.current) return;
      const now = Date.now();

      // Never fire a start while a previous attempt may still be initializing
      // (start() tears down any existing session first).
      if (wantsMic && !mainMic.listening && now - lastAttempt.mic >= 4000) {
        lastAttempt.mic = now;
        const cooledDown = !mainMic.error || now - micFailRef.current >= 5000;
        if (cooledDown) {
          if (mainMic.error) micFailRef.current = now;
          void mainMicStartRef.current();
        }
      }
      if (wantsSystem && !system.listening && now - lastAttempt.system >= 4000) {
        lastAttempt.system = now;
        const cooledDown = !system.error || now - systemFailRef.current >= 5000;
        if (cooledDown) {
          if (system.error) systemFailRef.current = now;
          void systemStartRef.current();
        }
      }
    };

    tick();
    const t = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [wantsMic, wantsSystem, mainMic.listening, system.listening, mainMic.error, system.error]);

  /**
   * Text the overlay itself is showing right now. Linux has no capture
   * exclusion, so full-screen frames include OSMOS — strip it before the OCR
   * text becomes "screen context", or the model reads its own last answer.
   */
  const ownOverlayTexts = useCallback((): string[] => {
    const msgs = messagesRef.current.slice(-4).map((m) => m.content);
    const tx = transcriptRef.current.slice(-10).map((t) => t.text);
    return [...msgs, ...tx, inputRef.current, title || ''];
  }, [title]);

  /** Clean + de-echo raw OCR, then publish it as the current screen context. */
  const applyScreenText = useCallback(
    (rawOcr: string, at: number, source: 'live' | 'shot'): number => {
      const text = prepareScreenContext(rawOcr, ownOverlayTexts()).slice(0, SCREEN_CONTEXT_MAX_CHARS);
      if (text.length < 12) return 0;
      lastScreenRef.current = { text, at };
      setScreenInfo({ chars: text.length, at, preview: text.slice(0, 280) });
      if (source === 'live') setLiveScreenStatus(`👁 screen read · ${text.length} chars`);
      return text.length;
    },
    [ownOverlayTexts],
  );

  /** Fresh screen context (≤ SCREEN_CONTEXT_FRESH_MS old) for the next ask. */
  const freshScreen = useCallback((): { text: string; at: number } | null => {
    const cur = lastScreenRef.current;
    if (!cur.text) return null;
    if (Date.now() - cur.at > SCREEN_CONTEXT_FRESH_MS) return null;
    return cur;
  }, []);

  /**
   * 👁 Live — background screen reading.
   * All OSes try the silent main-process engine first:
   *   GNOME → Mutter ScreenCast; Win → GDI; macOS → screencapture; KDE/wlroots → CLI.
   * getDisplayMedia is Windows/macOS fallback only (Electron auto-grants).
   * Never open the Linux share picker.
   */
  const liveTextUnsubRef = useRef<null | (() => void)>(null);
  const liveOcrBusyRef = useRef(false);

  const stopLiveScreen = useCallback(() => {
    stopLiveScreenStream();
    liveTextUnsubRef.current?.();
    liveTextUnsubRef.current = null;
    void window.osmos.stopScreenLive?.();
    setLiveScreen(false);
    setLiveScreenStatus('');
  }, []);

  // Wire the main-process engine's OCR text (Mutter ScreenCast / silent CLI)
  // into the same applyScreenText path the stream uses.
  const wireMainEngineText = useCallback(() => {
    liveTextUnsubRef.current?.();
    liveTextUnsubRef.current =
      window.osmos.onScreenLiveText?.((ev) => {
        if (ev.error) {
          setError(ev.error);
          setLiveScreen(false);
          setLiveScreenStatus('');
          return;
        }
        if (!ev.text?.trim()) return;
        applyScreenText(ev.text, ev.at || Date.now(), 'live');
      }) ?? null;
  }, [applyScreenText]);

  const startLiveScreen = useCallback(async () => {
    if (settings?.continuousScreenAssist === false) {
      setError('Continuous screen assist is off — enable it in Settings → General.');
      return;
    }
    setError('');
    setLiveScreen(true);
    setLiveScreenStatus('👁 starting screen read…');

    const isLinux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

    // Silent main engine first on every OS (Mutter / GDI / screencapture / CLI).
    const main = await window.osmos.startScreenLive({ intervalMs: 2000 });
    if (main.ok) {
      wireMainEngineText();
      setLiveScreenStatus(
        main.backend === 'mutter-screencast'
          ? '👁 watching (no prompt)'
          : `👁 watching${main.backend ? ` (${main.backend})` : ''}`,
      );
      console.log('[liveScreen] main engine started:', main.backend);
      return;
    }
    console.warn('[liveScreen] main engine unavailable:', main.error);

    if (isLinux) {
      setError(main.error || 'Live screen unavailable (no silent backend).');
      setLiveScreen(false);
      setLiveScreenStatus('');
      return;
    }

    // Windows / macOS only: getDisplayMedia (usually auto-granted).
    try {
      const { label } = await startLiveScreenStream({
        intervalMs: 2000,
        onFrame: async (frame) => {
          if (liveOcrBusyRef.current) return;
          liveOcrBusyRef.current = true;
          try {
            const res = await window.osmos.ocrExtract({ base64: frame.dataUrl });
            if (res.ok && res.text?.trim()) {
              const n = applyScreenText(res.text, frame.at, 'live');
              if (!n) setLiveScreenStatus('👁 watching · no readable text');
            } else if (res.error && !/no text/i.test(res.error)) {
              setLiveScreenStatus(`👁 OCR: ${res.error}`);
            } else {
              setLiveScreenStatus('👁 watching · no readable text');
            }
          } finally {
            liveOcrBusyRef.current = false;
          }
        },
        onStatus: (text) => setLiveScreenStatus((prev) => (prev.startsWith('👁 screen read') && /unchanged/.test(text) ? prev : text)),
        onError: (err) => {
          setError(err);
          setLiveScreen(false);
          setLiveScreenStatus('');
        },
      });
      console.log('[liveScreen] stream started on', label);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[liveScreen] stream path unavailable:', msg);
      // User dismissed the picker — respect it, do not fall into a flashing loop.
      if (/NotAllowedError|Permission denied|denied|cancel/i.test(msg)) {
        setError('Screen share was cancelled. Click 👁 again and pick your screen or meeting window.');
        setLiveScreen(false);
        setLiveScreenStatus('');
        return;
      }
    }

    const res = await window.osmos.startScreenLive({ intervalMs: 2500 });
    if (!res.ok) {
      setError(res.error || 'Live screen unavailable on this system.');
      setLiveScreen(false);
      setLiveScreenStatus('');
      return;
    }
    setLiveScreenStatus(`👁 watching${res.backend ? ` (${res.backend})` : ''}`);
    wireMainEngineText();
  }, [applyScreenText, settings?.continuousScreenAssist, wireMainEngineText]);

  const toggleLiveScreen = useCallback(() => {
    if (liveScreen) stopLiveScreen();
    else void startLiveScreen();
  }, [liveScreen, startLiveScreen, stopLiveScreen]);

  // Leaving the overlay / pausing / unmount always tears the stream down.
  const stopLiveScreenRef = useRef(stopLiveScreen);
  stopLiveScreenRef.current = stopLiveScreen;
  useEffect(() => {
    if (!overlay || paused) stopLiveScreenRef.current();
  }, [overlay, paused]);
  useEffect(() => () => stopLiveScreenRef.current(), []);

  useEffect(() => {
    if (overlay && !paused) setContinuousEnabled(true);
  }, [overlay, paused]);

  useEffect(() => {
    if (!overlay) return;
    void window.osmos.listStarTemplates().then((res) => {
      if (res.ok && res.templates) setStarTemplates(res.templates);
    });
    void refreshMicDevices();
  }, [overlay, refreshMicDevices]);

  useEffect(() => {
    if (!overlay) return;
    if (paused) {
      mainMicStopRef.current();
      systemStopRef.current();
      cancelRef.current?.();
      cancelRef.current = null;
    }
  }, [overlay, paused]);

  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    onPausedChange?.(next);
    if (next) {
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

  // Press "?" anywhere in the overlay to open the shortcuts panel.
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target && /^(input|textarea|select)$/i.test(target.tagName);
      if (e.key === '?' && !inField && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      } else if (e.key === 'Escape' && showShortcuts) {
        setShowShortcuts(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, showShortcuts]);

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

    // Attach fresh screen context (📷 or 👁 Live). Main injects it into the
    // system prompt — the visible user message stays clean.
    const screen = freshScreen();
    const stream = window.osmos.askStream(
      {
        message: text,
        history,
        screenText: screen?.text,
        screenAt: screen?.at,
      },
      (ev: ChatStreamEvent) => {
      if (ev.type === 'meta') {
        setStreamMeta(
          ev.usedWebSearch
            ? `Searching… ${ev.searchHits} hits${screen ? ' · with screen' : ''}`
            : screen
              ? 'Thinking (with screen)…'
              : 'Thinking…',
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
      if ((source === 'system' || source === 'both') && !system.listening) {
        if (!system.error || Date.now() - systemFailRef.current >= 5000) {
          void system.start();
        }
      }
      // Mic ear is owned by the self-healing watchdog (main-process stream).
    }
  }, [busy, input, overlay, settings, system]);

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
      // Whisper emits non-speech markers ([Music], ♪, [Applause]) on songs /
      // room noise. They carry no note value — drop them entirely.
      if (/^\W*(\[(music|applause|laughter|silence|blank_audio|noise)\]|♪+)[\W]*$/i.test(cleaned)) {
        return;
      }
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
      // Auto-answering each transcript chunk is opt-in only (Settings →
      // "Auto-answer on final transcript"). Default: keep listening and let
      // the user press Ctrl/Cmd+Enter to ask.
      const autoAsk = settings?.autoAskOnFinal === true;
      if (!autoAsk) return;
      if (smart && !shouldAutoAssist(cleaned, true)) return;

      const key = cleaned.toLowerCase().slice(0, 80);
      const now = Date.now();
      if (key && key === lastAssistRef.current.key && now - lastAssistRef.current.at < 5000) return;
      lastAssistRef.current = { key, at: now };

      // Screen context is attached by sendMessage (system prompt in main) —
      // do not also paste it into the user message.
      const prompt =
        smart && overlay
          ? fusedAssistPrompt({ transcript: cleaned, activeMode: mode })
          : cleaned;
      void sendRef.current(prompt);
    },
    [overlay, settings?.activeMode, settings?.autoAskOnFinal],
  );

  useEffect(() => {
    mainMic.onFinal(ingestFinal);
  }, [mainMic.onFinal, ingestFinal]);

  useEffect(() => {
    system.onFinal(ingestFinal);
  }, [system.onFinal, ingestFinal]);

  const liveHeard =
    (system.partial && !isSttStatusLine(system.partial) ? system.partial : '') ||
    (mainMic.partial && !isSttStatusLine(mainMic.partial) ? mainMic.partial : '');

  useEffect(() => {
    if (!liveHeard) return;
    setTranscript((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && !last.isFinal) {
        next[next.length - 1] = { ...last, text: liveHeard };
      } else {
        next.push({ id: `p-${Date.now()}`, text: liveHeard, timestamp: Date.now(), isFinal: false });
      }
      return next;
    });
  }, [liveHeard]);

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
  const answerPlaceholder = 'Answers appear here while you interview, meet, or share your screen.';

  /**
   * 📷 one-shot screen read. The text is NOT pasted into the composer any more —
   * it becomes screen context that main injects into the next question's system
   * prompt (fresh for SCREEN_CONTEXT_FRESH_MS). The status line shows the size.
   */
  const captureScreen = async () => {
    setError('');
    setOcrStatus('Capturing screen…');
    try {
      let dataUrl = '';
      let at = Date.now();
      // Silent main-process grab first on every OS (Mutter / GDI / screencapture).
      if (window.osmos.grabScreen) {
        setOcrStatus('Reading screen…');
        const grabbed = await window.osmos.grabScreen();
        if (grabbed.ok && grabbed.text) {
          const n = applyScreenText(grabbed.text, grabbed.at || Date.now(), 'shot');
          if (!n) {
            setError('Screen read, but nothing usable remained after removing overlay / chrome text.');
            return;
          }
          if (settings?.autoAskOnFinal === true && overlay && continuousRef.current && !pausedRef.current) {
            const mode = settings?.activeMode || 'general';
            void sendRef.current(fusedAssistPrompt({ activeMode: mode }));
          }
          return;
        }
      }

      // Reuse the live stream's latest frame — no extra portal prompt / flash.
      const live = liveScreen ? getLatestLiveFrame() : null;
      if (live) {
        dataUrl = live.dataUrl;
        at = live.at;
      } else {
        const result = window.osmos.captureFullScreen
          ? await window.osmos.captureFullScreen()
          : await window.osmos.captureRegion();
        if (result.cancelled || !result.dataUrl) {
          setError(result.error || 'Screen capture cancelled.');
          return;
        }
        dataUrl = result.dataUrl;
      }

      setOcrStatus('Reading screen…');
      const ocr = await extractTextFromBase64(dataUrl);
      if (!ocr.text) {
        setError(ocr.error || 'OCR returned no text');
        return;
      }
      const n = applyScreenText(ocr.text, at, 'shot');
      if (!n) {
        setError('Screen read, but nothing usable remained after removing OSMOS’s own overlay text.');
        return;
      }
      // Auto-answer on attach only when the user opted in.
      if (settings?.autoAskOnFinal === true && overlay && continuousRef.current && !pausedRef.current) {
        const mode = settings?.activeMode || 'general';
        void sendRef.current(fusedAssistPrompt({ activeMode: mode }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcrStatus('');
    }
  };
  const captureScreenRef = useRef(captureScreen);
  captureScreenRef.current = captureScreen;

  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void sendRef.current(input.trim() || OVERLAY_PROMPTS.assist);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [overlay, input]);

  useEffect(() => {
    if (!overlay || !window.osmos.onShortcut) return;
    return window.osmos.onShortcut((action) => {
      if (action === 'ask') void sendRef.current(OVERLAY_PROMPTS.assist);
      if (action === 'capture') void captureScreenRef.current();
    });
  }, [overlay]);

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
        model: settings?.localSttModel,
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
              micDevices={micDevices}
              onRefreshMics={() => void refreshMicDevices()}
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

        <div className="overlay-main">
          <div className="overlay-answer" aria-live="polite">
            {answerText ? (
              <>
                <p className="overlay-answer__text">
                  <MarkdownText text={answerText || '▍'} />
                </p>
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
          <aside className="overlay-listen" aria-label="Live transcript">
            <div className="overlay-listen__head">
              <span>Live</span>
              <span className="meta">
                {mainMic.listening || system.listening ? 'listening' : 'idle'}
              </span>
            </div>
            <div className="overlay-listen__body">
              {transcript.length === 0 && !liveHeard ? (
                <p className="overlay-listen__empty">
                  Heard speech shows up here — the bar below stays for what you type.
                </p>
              ) : (
                transcript.slice(-8).map((entry) => {
                  const t = new Date(entry.timestamp);
                  const stamp = `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
                  return (
                    <div
                      key={entry.id}
                      className={`overlay-listen__line${entry.isFinal ? '' : ' overlay-listen__line--live'}`}
                    >
                      <span className="overlay-listen__time">{stamp}</span>
                      <span className="overlay-listen__text">{entry.text}</span>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
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
            className={`overlay-tool${mainMic.listening ? ' overlay-tool--live' : ''}`}
            onClick={() => void mainMic.toggle()}
            disabled={busy || continuousEnabled}
            title={
              continuousEnabled
                ? 'Managed by ⚡ Smart — turn Smart off for manual control'
                : 'Microphone'
            }
          >
            Mic
          </button>
          <button
            type="button"
            className="overlay-tool"
            onClick={() => void captureScreen()}
            disabled={busy}
            title="Read the screen once (silent — no share dialog, no screenshot flash)"
          >
            Screen
          </button>
          <button
            type="button"
            className={`overlay-tool${liveScreen ? ' overlay-tool--live' : ''}`}
            onClick={toggleLiveScreen}
            disabled={busy}
            title={
              liveScreen
                ? `Stop background screen reading${liveScreenStatus ? ` (${liveScreenStatus})` : ''}`
                : 'Read the screen in the background (no share dialog on GNOME Linux)'
            }
          >
            {liveScreen ? '👁 Live' : '👁'}
          </button>
          <button
            type="button"
            className={`overlay-tool${system.listening ? ' overlay-tool--live' : ''}`}
            onClick={() => void captureAudio()}
            disabled={busy || continuousEnabled}
            title={
              continuousEnabled
                ? 'Managed by ⚡ Smart — turn Smart off for manual control'
                : system.listening
                  ? 'Stop system audio listen'
                  : 'Listen to system / meeting audio'
            }
          >
            Audio
          </button>
          <button
            type="button"
            className="overlay-tool overlay-tool--soft"
            onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
          {busy ? (
            <button type="button" className="overlay-tool overlay-tool--live" onClick={() => cancelRef.current?.()}>
              Stop
            </button>
          ) : null}
          {(mainMic.listening || system.listening) && (
            <span
              className="rec-chip"
              title="Audio capture active — make sure everyone in the call knows they may be transcribed"
            >
              ● REC
            </span>
          )}
          {settings?.stealthEnabled && <StealthBadge />}
          <span
            className="overlay-tools__status meta"
            title={
              screenInfo.chars && Date.now() - screenInfo.at < SCREEN_CONTEXT_FRESH_MS
                ? `Screen context attached to your next question:\n\n${screenInfo.preview}${screenInfo.chars > screenInfo.preview.length ? '…' : ''}`
                : undefined
            }
          >
            {paused
              ? 'Paused — tap ▶ to resume'
              : (() => {
                  const ears = [
                    mainMic.listening ? 'mic' : '',
                    system.listening ? 'spk' : '',
                  ].filter(Boolean);
                  const badge = continuousEnabled
                    ? `⚡ Smart${ears.length ? ` (${ears.join('+')})` : ''} · `
                    : '';
                  const screenAge = screenInfo.at ? Date.now() - screenInfo.at : Infinity;
                  const screenBadge =
                    screenInfo.chars && screenAge < SCREEN_CONTEXT_FRESH_MS
                      ? `📄 screen ${screenInfo.chars}ch · `
                      : '';
                  const listening = mainMic.listening || system.listening;
                  const body =
                    ocrStatus ||
                    (system.error && !mainMic.listening ? system.error : '') ||
                    mainMic.error ||
                    streamMeta ||
                    (liveScreen ? liveScreenStatus : '') ||
                    (listening ? 'Listening…' : '') ||
                    'Ready';
                  return `${badge}${screenBadge}${body}`;
                })()}
          </span>
        </div>

        {(error || mainMic.error || system.error) && (
          <div className="overlay-error">{error || mainMic.error || system.error}</div>
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
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void sendMessage(input.trim() || OVERLAY_PROMPTS.assist);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
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
        {showShortcuts ? <ShortcutsModal onClose={() => setShowShortcuts(false)} /> : null}
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
          className={`mic-btn ${mainMic.listening ? 'mic-btn--live' : ''}`}
          onClick={() => void mainMic.toggle()}
          disabled={busy}
          title="Start/stop microphone"
        >
          {mainMic.listening ? 'Stop mic' : 'Start mic'}
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
              const result = window.osmos.captureFullScreen
                ? await window.osmos.captureFullScreen()
                : await window.osmos.captureRegion();
              if (result.cancelled || !result.dataUrl) {
                setError('Screen capture failed — grant screen-share permission if prompted.');
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
              : mainMic.listening
                ? settings?.sttProvider === 'webspeech'
                  ? 'Listening…'
                  : 'Recording… click Stop when done'
                : 'Mic idle'}
        </span>
        {mainMic.partial ? <span className="partial">{mainMic.partial}</span> : null}
      </div>

      <div className={`chat-split${transcriptOpen ? '' : ' chat-split--collapsed'}`}>
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

        {transcriptOpen ? (
          <aside className="chat-side">
            <div className="chat-side__head">
              <strong>Live transcript</strong>
              <span className="chat-side__actions">
                <button
                  type="button"
                  className="link-btn"
                  title="Copy full transcript for session notes"
                  onClick={async () => {
                    const text = transcript
                      .map(
                        (t) =>
                          `[${new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${t.text}`,
                      )
                      .join('\n');
                    try {
                      await navigator.clipboard.writeText(text);
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  Copy
                </button>
                <button type="button" className="link-btn" onClick={() => setTranscriptOpen(false)}>
                  Hide
                </button>
              </span>
            </div>
            <TranscriptTimeline entries={transcript} />
          </aside>
        ) : null}
      </div>

      {!transcriptOpen && transcript.length > 0 && (
        <button
          type="button"
          className="link-btn chat-side__show"
          onClick={() => setTranscriptOpen(true)}
        >
          Show transcript ({transcript.length})
        </button>
      )}

      {(error || mainMic.error) && <div className="error">{error || mainMic.error}</div>}

      <div className="composer">
        <textarea
          value={input}
          placeholder="Ask anything, or use the mic…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void sendMessage(input.trim() || OVERLAY_PROMPTS.assist);
              return;
            }
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
      {showShortcuts ? <ShortcutsModal onClose={() => setShowShortcuts(false)} /> : null}
    </section>
  );
}

function StealthBadge() {
  const [status, setStatus] = useState<{
    ok: boolean;
    supported: boolean;
    detail: string;
    checkedAt: number;
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const r = await window.osmos.verifyStealth();
        if (mounted) setStatus(r);
      } catch {
        /* ignore */
      }
    };
    void check();
    const t = window.setInterval(check, 10_000);
    return () => {
      mounted = false;
      window.clearInterval(t);
    };
  }, []);

  if (!status) {
    return (
      <span className="stealth-chip stealth-chip--pending" title="Verifying capture-exclusion status…">
        ⌖ checking…
      </span>
    );
  }
  if (!status.supported) {
    return (
      <span
        className="stealth-chip stealth-chip--warn"
        title={status.detail}
      >
        ⌖ Linux · tab-share to stay private
      </span>
    );
  }
  const age = Math.max(0, Math.floor((Date.now() - status.checkedAt) / 1000));
  return (
    <span
      className={`stealth-chip ${status.ok ? 'stealth-chip--ok' : 'stealth-chip--warn'}`}
      title={`${status.detail} · checked ${age}s ago`}
    >
      ⌖ {status.ok ? 'Verified invisible' : 'Off'} · {age}s
    </span>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const rows: { key: string; desc: string }[] = [
    { key: '?', desc: 'Show this shortcuts panel' },
    { key: 'Esc', desc: 'Close dialogs and overlays' },
    { key: 'Ctrl/⌘ + Enter', desc: 'Send the current question' },
    { key: 'Ctrl/⌘ + .', desc: 'Cancel a streaming response' },
    { key: 'Alt+Shift+Space', desc: 'Toggle the overlay' },
    { key: 'Alt+Shift+A', desc: 'Ask the assistant' },
    { key: 'Alt+Shift+C', desc: 'Capture screen (OCR)' },
    { key: 'Alt+Shift+M', desc: 'Toggle microphone' },
  ];
  return (
    <div className="shortcuts-backdrop" role="dialog" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-modal__head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="link-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <table className="shortcuts-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td><kbd>{r.key}</kbd></td>
                <td>{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="meta" style={{ marginTop: 12 }}>
          Press <kbd>?</kbd> again to dismiss this panel.
        </p>
      </div>
    </div>
  );
}
