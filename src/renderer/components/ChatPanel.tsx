import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, ChatStreamEvent, StarTemplate } from '../../shared/types';
import {
  fusedAssistPrompt,
  latestUtterancePrompt,
  SCREEN_CONTEXT_FRESH_MS,
  transcriptAssistPrompt,
} from '@shared/continuousAssist';
import { createOrchestrator } from '@shared/policy/orchestrator';
import {
  asksAboutScreen,
  prepareScreenContext,
  SCREEN_CONTEXT_MAX_CHARS,
} from '@shared/screenContext';
import { isSttStatusLine } from '@shared/sttStatus';
import { reconcileFinalTranscript } from '@shared/transcriptDedupe';
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
import { Icon } from './Icon';

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
  onRegisterControls?: (controls: OverlayControls) => void;
  onSettingsChange?: (next: AppSettings) => void;
};

const OVERLAY_PROMPTS = {
  assist: 'Help me respond to what is being discussed right now. Be concise and speakable.',
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
  /** Synchronous busy flag: a second Ctrl+Enter can land before React re-renders. */
  const busyRef = useRef(false);
  /** Monotonic request id; stale stream callbacks must not touch the UI. */
  const activeRequestRef = useRef(0);
  const sessionIdRef = useRef(typeof crypto !== 'undefined' && crypto.randomUUID?.() || `session-${Date.now()}`);
  const mainMicStopRef = useRef(mainMic.stop);
  const mainMicStartRef = useRef(() => mainMic.start());
  mainMicStopRef.current = mainMic.stop;
  mainMicStartRef.current = () => mainMic.start();
  const systemStopRef = useRef(system.stop);
  const systemStartRef = useRef(system.start);
  systemStopRef.current = system.stop;
  systemStartRef.current = system.start;
  // Phase 3 (§7.3/§7.4): one orchestrator decides whether a final transcript
  // becomes an answer — channel-aware, 10 s dedupe, cancel-on-supersede.
  const orchestratorRef = useRef(createOrchestrator());
  const activeAnswerRef = useRef<string | null>(null);
  const lastScreenRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  transcriptRef.current = transcript;
  /** Last displayed final per channel, for duplicate/prefix reconciliation. */
  const lastFinalRef = useRef<
    Record<'me' | 'them', { id: string; text: string; at: number } | null>
  >({ me: null, them: null });
  const inputRef = useRef('');
  inputRef.current = input;
  const micFailRef = useRef(0);
  const systemFailRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Wake the quality provider (+ fast Ollama model) when the overlay opens.
  useEffect(() => {
    if (!overlay) return;
    void window.osmos.warmupProvider?.().catch(() => {});
  }, [overlay]);

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
   * as soon as Smart is on and revives it after failures.
   *
   * Retries back off (4s → 10s → 30s → 60s) and stop entirely once a listener
   * reports a fatal device problem — otherwise a machine with no audio endpoint
   * re-opens capture every few seconds forever.
   */
  const micBackoffRef = useRef({ fails: 0, nextAt: 0 });
  const sysBackoffRef = useRef({ fails: 0, nextAt: 0 });
  const backoffDelay = (fails: number) => [4000, 10000, 30000, 60000][Math.min(fails, 3)]!;
  /**
   * Turning Smart on is an explicit retry: clear the backoff and, when a device
   * was missing, re-probe it (the user may have just plugged one in).
   */
  const toggleContinuous = useCallback(() => {
    const next = !continuousRef.current;
    // Keep the ref in step synchronously: a fast double-toggle used to read the
    // pre-render value and turn Smart on twice instead of off.
    continuousRef.current = next;
    setContinuousEnabled(next);
    if (!next) return;
    micBackoffRef.current = { fails: 0, nextAt: 0 };
    sysBackoffRef.current = { fails: 0, nextAt: 0 };
    if (mainMic.fatal) void mainMicStartRef.current();
    if (system.fatal) void systemStartRef.current();
    // Both flags are primitives, so this callback stays stable until a status
    // actually changes (start functions are read through refs).
  }, [mainMic.fatal, system.fatal]);
  useEffect(() => {
    if (!wantsMic && !wantsSystem) return;
    let cancelled = false;

    const tick = () => {
      if (cancelled || pausedRef.current) return;
      const now = Date.now();

      // Never fire a start while a previous attempt may still be initializing
      // (start() tears down any existing session first).
      const micB = micBackoffRef.current;
      if (wantsMic && !mainMic.listening && !mainMic.fatal && now >= micB.nextAt) {
        if (mainMic.error) micB.fails += 1;
        else micB.fails = 0;
        micB.nextAt = now + backoffDelay(micB.fails);
        micFailRef.current = now;
        void mainMicStartRef.current();
      }
      const sysB = sysBackoffRef.current;
      if (wantsSystem && !system.listening && !system.fatal && now >= sysB.nextAt) {
        if (system.error) sysB.fails += 1;
        else sysB.fails = 0;
        sysB.nextAt = now + backoffDelay(sysB.fails);
        systemFailRef.current = now;
        void systemStartRef.current();
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
      if (source === 'live') setLiveScreenStatus(`screen read · ${text.length} chars`);
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
    setLiveScreenStatus('starting screen read…');

    const isLinux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

    // Silent main engine first on every OS (Mutter / GDI / screencapture / CLI).
    const main = await window.osmos.startScreenLive({ intervalMs: 2000 });
    if (main.ok) {
      wireMainEngineText();
      setLiveScreenStatus(
        main.backend === 'mutter-screencast'
          ? 'watching (no prompt)'
          : `watching${main.backend ? ` (${main.backend})` : ''}`,
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
              if (!n) setLiveScreenStatus('watching · no readable text');
            } else if (res.error && !/no text/i.test(res.error)) {
              setLiveScreenStatus(`OCR: ${res.error}`);
            } else {
              setLiveScreenStatus('watching · no readable text');
            }
          } finally {
            liveOcrBusyRef.current = false;
          }
        },
        onStatus: (text) => setLiveScreenStatus((prev) => (prev.startsWith('screen read') && /unchanged/.test(text) ? prev : text)),
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
        setError('Screen share was cancelled. Turn background reading on again and pick your screen or meeting window.');
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
    setLiveScreenStatus(`watching${res.backend ? ` (${res.backend})` : ''}`);
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

  /** Recent unique live speech for manual overlay asks (no status lines). */
  const transcriptEntriesForAsk = useCallback((): string[] => {
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const entry of transcriptRef.current) {
      if (isSttStatusLine(entry.text)) continue;
      const text = entry.text.trim();
      if (!text) continue;
      const key = text.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(text);
    }
    return entries.slice(-8);
  }, []);

  /**
   * Quick-action buttons and Ctrl+Enter used to send only "what is being
   * discussed?" with no transcript, so the model could only ask for a topic.
   * The newest utterance is the one to answer; older lines are context only,
   * otherwise an old date/location question gets re-answered forever.
   */
  const promptWithLiveContext = useCallback(
    (text: string): string => {
      if (!overlay) return text;
      const entries = transcriptEntriesForAsk();
      if (!entries.length) return text;
      const activeMode = settings?.activeMode || 'general';
      if (text === OVERLAY_PROMPTS.assist) {
        return latestUtterancePrompt({
          latest: entries[entries.length - 1]!,
          earlier: entries.slice(0, -1).join('\n'),
          activeMode,
        });
      }
      if (text === OVERLAY_PROMPTS.followUp || text === OVERLAY_PROMPTS.recap) {
        return transcriptAssistPrompt({
          instruction: text,
          transcript: entries.join('\n'),
          activeMode,
        });
      }
      return text;
    },
    [overlay, settings?.activeMode, transcriptEntriesForAsk],
  );

  const sendMessage = useCallback(async (textIn?: string) => {
    const text = (textIn ?? input).trim();
    if (!text) return;

    // Ctrl+Enter means "answer this now". If an answer is still streaming,
    // supersede it instead of silently dropping the new question. The token
    // makes every callback from the old stream a no-op.
    const superseding = busyRef.current;
    if (superseding) cancelRef.current?.();
    const requestId = ++activeRequestRef.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStreamMeta(superseding ? 'Replacing previous answer…' : '');
    setInput('');

    let history = messagesRef.current;
    if (superseding && history.length) {
      // Drop the in-flight turn (assistant partial, then its user message).
      if (history[history.length - 1]?.role === 'assistant') history = history.slice(0, -1);
      if (history[history.length - 1]?.role === 'user') history = history.slice(0, -1);
    }
    const next = [...history, { role: 'user' as const, content: text }];
    const pending = [...next, { role: 'assistant' as const, content: '' }];
    messagesRef.current = pending;
    setMessages(pending);

    // Attach fresh screen context (📷 or 👁 Live). Main injects it into the
    // system prompt — the visible user message stays clean.
    let screen = freshScreen();
    // A one-shot 📷 capture can be up to 45s old and the window may have changed
    // since. Re-read it at ask time instead of answering from the previous
    // screen; 👁 Live already refreshes every ~2s. A question that explicitly
    // asks about the screen also triggers a first grab when nothing is attached.
    const screenRequested = asksAboutScreen(text);
    const hadScreen = Boolean(lastScreenRef.current.text);
    const canReuseLive = liveScreen && Boolean(screen);
    if (overlay && (screenRequested || hadScreen) && !canReuseLive) {
      setOcrStatus(screen ? 'Refreshing screen…' : 'Reading screen…');
      try {
        const grabbed = await window.osmos.grabScreen?.();
        if (activeRequestRef.current !== requestId) return;
        if (grabbed?.ok && grabbed.text) {
          const n = applyScreenText(grabbed.text, grabbed.at || Date.now(), 'shot');
          screen = n ? lastScreenRef.current : null;
        } else {
          screen = null;
        }
      } catch {
        screen = null;
      } finally {
        if (activeRequestRef.current === requestId) setOcrStatus('');
      }
      if (!screen) {
        // Never answer about the previous window just because it was captured
        // once. A blank/unreadable screen is better than stale screen text.
        lastScreenRef.current = { text: '', at: 0 };
        setScreenInfo({ chars: 0, at: 0, preview: '' });
        if (screenRequested) {
          setError('Could not read the screen — make sure the content is visible, then retry.');
        }
      }
    }
    const modelText = promptWithLiveContext(text);
    const stream = window.osmos.askStream(
      {
        message: modelText,
        history,
        screenText: screen?.text,
        screenAt: screen?.at,
      },
      (ev: ChatStreamEvent) => {
      if (activeRequestRef.current !== requestId) return;
      if (ev.type === 'meta') {
        const routeBit = ev.route
          ? ev.route.lane === 'draft-upgrade'
            ? ` · draft→${ev.route.tier}`
            : ` · ${ev.route.tier}`
          : '';
        setStreamMeta(
          ev.usedWebSearch
            ? `Searching… ${ev.searchHits} hits${screen ? ' · with screen' : ''}${routeBit}`
            : screen
              ? `Thinking (with screen)…${routeBit}`
              : `Thinking…${routeBit}`,
        );
      } else if (ev.type === 'status') {
        setStreamMeta(ev.text);
      } else if (ev.type === 'phase') {
        if (ev.phase === 'upgrade') {
          setStreamMeta(ev.text || 'Upgrading answer…');
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            copy[copy.length - 1] = { role: 'assistant', content: '' };
            return copy;
          });
        } else {
          setStreamMeta(ev.text || 'Quick draft…');
        }
      } else if (ev.type === 'delta') {
        setStreamMeta((m) =>
          m.startsWith('Searching') ||
          m.startsWith('Model thinking') ||
          m.startsWith('Quick draft') ||
          m.startsWith('Upgrading')
            ? m.startsWith('Quick draft')
              ? 'Drafting…'
              : m.startsWith('Upgrading')
                ? 'Writing…'
                : 'Writing…'
            : m || 'Writing…',
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
      if (activeRequestRef.current === requestId) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      // A newer Ctrl+Enter already owns the UI; this old stream must not clear
      // its busy state or replace its answer.
      if (activeRequestRef.current !== requestId) return;
      cancelRef.current = null;
      busyRef.current = false;
      if (activeAnswerRef.current) {
        orchestratorRef.current.complete(activeAnswerRef.current);
        activeAnswerRef.current = null;
      }
      setBusy(false);
      setStreamMeta('');
      if (!overlay || !continuousRef.current || pausedRef.current || !settings) return;
      const source = settings.assistAudioSource || 'system';
      if ((source === 'system' || source === 'both') && !system.listening && !system.fatal) {
        if (!system.error || Date.now() - systemFailRef.current >= 5000) {
          void system.start();
        }
      }
      // Mic ear is owned by the self-healing watchdog (main-process stream).
    }
  }, [
    applyScreenText,
    freshScreen,
    input,
    liveScreen,
    overlay,
    promptWithLiveContext,
    settings,
    system,
  ]);

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
    (text: string, channel: 'me' | 'them' = 'them') => {
      const cleaned = text.trim();
      if (!cleaned) return;
      if (pausedRef.current) return;
      // Hook status text ("🎙 starting mic…") is not speech — never list it.
      if (isSttStatusLine(cleaned)) return;
      // Whisper emits non-speech markers ([Music], ♪, [Applause]) on songs /
      // room noise. They carry no note value — drop them entirely.
      if (/^\W*(\[(music|applause|laughter|silence|blank_audio|noise)\]|♪+)[\W]*$/i.test(cleaned)) {
        return;
      }

      // VAD and fixed chunks can both finalize one question, and a chunk can
      // end on a growing prefix. Reconcile per channel before display or the
      // orchestrator sees the same speech twice.
      const now = Date.now();
      const previous = lastFinalRef.current[channel];
      const decision = reconcileFinalTranscript(previous, cleaned, now);
      if (decision.action === 'skip') return;

      const entryId = crypto.randomUUID?.() || `t-${now}`;
      setTranscript((prev) => {
        // The live partial is the same speech; the final replaces it instead
        // of leaving a second, stale line above.
        const next = prev.length && !prev[prev.length - 1]!.isFinal ? prev.slice(0, -1) : [...prev];
        if (decision.action === 'replace' && previous) {
          const index = next.findIndex((entry) => entry.id === previous.id);
          if (index >= 0) {
            next[index] = { ...next[index]!, text: decision.text };
            return next;
          }
        }
        next.push({ id: entryId, text: decision.text, timestamp: now, isFinal: true });
        return next;
      });

      if (decision.action === 'replace' && previous) {
        lastFinalRef.current[channel] = { ...previous, text: decision.text, at: now };
        return;
      }
      lastFinalRef.current[channel] = { id: entryId, text: decision.text, at: now };

      const mode = settings?.activeMode || 'general';
      const smart = continuousRef.current && overlay && !pausedRef.current;
      // Auto-answering each transcript chunk is opt-in only (Settings →
      // "Auto-answer on final transcript"). Default: keep listening and let
      // the user press Ctrl/Cmd+Enter to ask.
      const autoAsk = settings?.autoAskOnFinal === true;
      if (!autoAsk) return;

      // §7.3: only a direct question fires. Meeting cues become notes, the
      // user's own mic channel never fires, and a repeat inside 10 s is a
      // duplicate — the ad-hoc 5 s prefix check this replaced could not tell
      // those cases apart.
      const actions = orchestratorRef.current.final({
        text: decision.text,
        channel,
        mode,
        smartMode: smart,
        nowMs: now,
      });
      const start = actions.find(
        (action) => action.type === 'start' || action.type === 'restart',
      );
      if (!start) return;

      // Screen context is attached by sendMessage (system prompt in main) —
      // do not also paste it into the user message.
      const prompt =
        smart && overlay
          ? fusedAssistPrompt({ transcript: decision.text, activeMode: mode })
          : decision.text;

      const send = () => {
        activeAnswerRef.current = start.requestId;
        void sendRef.current(prompt);
      };

      if (actions.some((action) => action.type === 'cancel')) {
        // A newer question supersedes the answer still streaming (§7.4). The
        // cancel resolves asynchronously, so the replacement waits one tick.
        cancelRef.current?.();
        window.setTimeout(send, 300);
      } else {
        send();
      }
    },
    [overlay, settings?.activeMode, settings?.autoAskOnFinal],
  );

  useEffect(() => {
    // The user's own voice is the `me` channel: it updates context and never
    // triggers an answer (§7.3 self-speech).
    mainMic.onFinal((text) => ingestFinal(text, 'me'));
  }, [mainMic.onFinal, ingestFinal]);

  useEffect(() => {
    system.onFinal((text) => ingestFinal(text, 'them'));
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
      } else if ((e.ctrlKey || e.metaKey) && e.key === '.') {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current?.();
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
              liveScreen={liveScreen}
              onToggleLiveScreen={toggleLiveScreen}
            />
          ) : (
            <span className="meta">Loading…</span>
          )}
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
            <Icon name="sparkles" size={14} /> Assist
          </button>
          <span className="overlay-actions__dot" aria-hidden>·</span>
          <button type="button" disabled={busy} onClick={() => void sendMessage(OVERLAY_PROMPTS.followUp)}>
            <Icon name="message" size={14} /> Follow-up
          </button>
          <span className="overlay-actions__dot" aria-hidden>·</span>
          <button type="button" disabled={busy} onClick={() => void sendMessage(OVERLAY_PROMPTS.recap)}>
            <Icon name="refresh" size={14} /> Recap
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
            className={`overlay-tool${continuousEnabled ? ' overlay-tool--live' : ''}`}
            onClick={toggleContinuous}
            disabled={busy}
            title={
              continuousEnabled
                ? 'Stop listening'
                : 'Listen to the conversation (mic/system source is set in Settings)'
            }
          >
            <Icon name="mic" size={13} /> {continuousEnabled ? 'Listening' : 'Listen'}
          </button>
          <button
            type="button"
            className="overlay-tool"
            onClick={() => void captureScreen()}
            disabled={busy}
            title="Read the screen once (silent — no share dialog, no screenshot flash)"
          >
            <Icon name="screen" size={13} /> Screen
          </button>
          {busy ? (
            <button type="button" className="overlay-tool overlay-tool--live" onClick={() => cancelRef.current?.()}>
              <Icon name="stop" size={11} /> Stop
            </button>
          ) : null}
          {((mainMic.listening && !mainMic.error) || (system.listening && !system.error)) && (
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
              ? 'Paused — resume to keep listening'
              : (() => {
                  const ears = [
                    mainMic.listening ? 'mic' : '',
                    system.listening ? 'spk' : '',
                  ].filter(Boolean);
                  const badge = continuousEnabled
                    ? `Listening${ears.length ? ` (${ears.join('+')})` : ''} · `
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
                    (listening ? 'Live' : '') ||
                    'Ready';
                  return `${badge}${screenBadge}${body}`;
                })()}
          </span>
        </div>

        {(error || mainMic.error || system.error) && (
          <div className="overlay-error">{error || mainMic.error || system.error}</div>
        )}

        <div className="overlay-composer">
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
              if ((e.ctrlKey || e.metaKey) && e.key === '.') {
                e.preventDefault();
                cancelRef.current?.();
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
            <Icon name="arrow-up" size={16} />
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
            Speak or type — replies stream from{' '}
            {settings?.providers?.[settings.activeProvider]?.label || settings?.activeProvider || 'your model'}.
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
          <Icon name="mic" size={14} /> {mainMic.listening ? 'Stop mic' : 'Start mic'}
        </button>
        <button
          type="button"
          className={`mic-btn ${continuousEnabled ? 'mic-btn--live' : ''}`}
          onClick={toggleContinuous}
          disabled={busy}
          title="Toggle continuous assistant"
        >
          <Icon name="sparkles" size={14} /> {continuousEnabled ? 'Listening' : 'Listen'}
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
          <Icon name="screen" size={15} />
        </button>
        <button
          type="button"
          className="mic-btn"
          onClick={() => void captureAudioOnce()}
          disabled={busy}
          title="Capture 5s of system audio and transcribe"
        >
          <Icon name="volume" size={15} />
        </button>
        {busy ? (
          <button type="button" className="mic-btn mic-btn--live" onClick={() => cancelRef.current?.()}>
            <Icon name="stop" size={11} /> Stop reply
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
        {messages.length === 0 && !busy && (
          <div className="chat-empty">
            <p className="chat-empty__title">Ask anything with your context loaded</p>
            <ul className="chat-empty__hints">
              <li><Icon name="command" size={13} /> Ctrl/⌘ + Enter — Assist</li>
              <li><Icon name="screen" size={13} /> Screen — read once</li>
              <li><Icon name="mic" size={13} /> Mic — live transcript</li>
            </ul>
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
            if ((e.ctrlKey || e.metaKey) && e.key === '.') {
              e.preventDefault();
              cancelRef.current?.();
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
    mechanism?: 'capture-exclusion' | 'gnome-bridge';
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
  // Ubuntu/GNOME hides the window through the Shell bridge; that is not the
  // same claim as a Windows/macOS capture-exclusion flag, so it never reads
  // "Verified invisible".
  const label =
    status.mechanism === 'gnome-bridge'
      ? 'Bridge · hides during shares'
      : status.ok
        ? 'Verified invisible'
        : 'Off';
  return (
    <span
      className={`stealth-chip ${status.ok ? 'stealth-chip--ok' : 'stealth-chip--warn'}`}
      title={`${status.detail} · checked ${age}s ago`}
    >
      ⌖ {label} · {age}s
    </span>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  // Mirrors `registerShortcuts()` in main — never list a key that is not wired.
  const isMac = /mac/i.test(navigator.userAgent);
  const mod = isMac ? 'Cmd' : 'Alt';
  const rows: { key: string; desc: string }[] = [
    { key: '?', desc: 'Show this shortcuts panel' },
    { key: 'Esc', desc: 'Close dialogs and overlays' },
    { key: `${mod}+Shift+Space`, desc: 'Toggle the overlay' },
    { key: `${mod}+Shift+A`, desc: 'Ask about what is being said' },
    { key: `${mod}+Shift+C`, desc: 'Capture screen (OCR)' },
    { key: `${mod}+Shift+X`, desc: 'Toggle click-through' },
    { key: 'Ctrl/⌘ + Enter', desc: 'Assist on what you typed' },
    { key: 'Ctrl/⌘ + .', desc: 'Stop a streaming answer' },
  ];
  return (
    <div className="shortcuts-backdrop" role="dialog" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-modal__head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="link-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={15} /></button>
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
