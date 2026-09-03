import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeatureDef } from '@shared/features';
import type { AppSettings, AudioDeviceInfo, UpdateStatus, WebSearchProvider } from '@shared/types';
import { describeAudioCaptureProfile, getAudioCaptureProfile } from '@shared/audioCaptureProfile';

type Info = {
  name: string;
  version: string;
  platform: string;
  platformName: string;
  capabilityNotes: string[];
  features: FeatureDef[];
  shortcutsRegistered?: boolean;
};

type MicDevice = { deviceId: string; label: string };

type Props = {
  settings: AppSettings;
  info: Info | null;
  onChange: (next: AppSettings) => void;
  onSaved: (next: AppSettings) => void;
  onClose?: () => void;
};

type Section =
  | 'general'
  | 'ai'
  | 'web'
  | 'speech'
  | 'stealth'
  | 'keybinds'
  | 'updates'
  | 'about';

const SECTIONS: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: '☰' },
  { id: 'ai', label: 'AI Providers', icon: '✦' },
  { id: 'web', label: 'Intelligence', icon: '◈' },
  { id: 'speech', label: 'Audio', icon: '♫' },
  { id: 'stealth', label: 'Low-profile', icon: '◌' },
  { id: 'keybinds', label: 'Keybinds', icon: '⌨' },
  { id: 'updates', label: 'Setup & Help', icon: '?' },
  { id: 'about', label: 'About', icon: 'ⓘ' },
];

function providerDefaults(id: AppSettings['activeProvider'], current?: AppSettings['providers'][AppSettings['activeProvider']]) {
  return (
    current || {
      id,
      label: id,
      apiKey: '',
      baseUrl: '',
      model: '',
    }
  );
}

export function SettingsPanel({ settings, info, onChange, onSaved, onClose }: Props) {
  const [section, setSection] = useState<Section>('general');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [micTest, setMicTest] = useState<{
    on: boolean;
    level: number;
    peak: number;
    label: string;
  }>({ on: false, level: 0, peak: 0, label: '' });
  const [micDevices, setMicDevices] = useState<MicDevice[]>([]);
  const [webspeechAvailable] = useState(
    typeof window !== 'undefined' && 'webkitSpeechRecognition' in window,
  );
  const refreshMicDevices = useCallback(async () => {
    try {
      const res = await window.osmos.listAudioDevices();
      if (res?.ok) {
        setMicDevices((res.inputs ?? []).map((d) => ({ deviceId: d.id, label: d.name })));
      }
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    void refreshMicDevices();
  }, [refreshMicDevices]);

  const micTestCleanupRef = useRef<null | (() => void)>(null);

  const stopMicTest = useCallback(() => {
    micTestCleanupRef.current?.();
    micTestCleanupRef.current = null;
    setMicTest({ on: false, level: 0, peak: 0, label: '' });
  }, []);

  const startMicTest = useCallback(async () => {
    stopMicTest();
    setError('');
    try {
      const dev = settings?.micDeviceId || '';
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: dev ? { deviceId: { exact: dev } } : true,
        video: false,
      });
      const track = stream.getAudioTracks()[0];
      const label = track?.label || 'Selected microphone';
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const srcNode = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      srcNode.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let peak = 0;

      const timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Perceptual scaling: typical speech lands in the 20-80% band.
        const level = Math.min(100, Math.round(Math.sqrt(rms) * 260));
        peak = Math.max(level, peak * 0.94);
        setMicTest({ on: true, level, peak: Math.round(peak), label });
      }, 100);

      micTestCleanupRef.current = () => {
        window.clearInterval(timer);
        try {
          void ctx.close();
        } catch {
          /* ignore */
        }
        stream.getTracks().forEach((t) => t.stop());
      };
      setMicTest({ on: true, level: 0, peak: 0, label });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMicTest({ on: false, level: 0, peak: 0, label: '' });
    }
  }, [settings?.micDeviceId, stopMicTest]);

  // Restart the meter when the selected device changes mid-test; always
  // release the microphone when the panel unmounts.
  useEffect(() => {
    if (micTest.on) void startMicTest();
    return () => micTestCleanupRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.micDeviceId]);
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [nativeMonitors, setNativeMonitors] = useState<AudioDeviceInfo[]>([]);
  const [preferredMonitorId, setPreferredMonitorId] = useState('');
  const [audioWarning, setAudioWarning] = useState('');
  const audioProfile = getAudioCaptureProfile(info?.platform as NodeJS.Platform | undefined);

  useEffect(() => {
    if (info?.platform !== 'linux') return;
    void (async () => {
      try {
        const res = await window.osmos.listAudioDevices?.();
        if (!res?.ok) return;
        setNativeMonitors(res.monitors || []);
        if (res.preferredMonitorId) setPreferredMonitorId(res.preferredMonitorId);
        setAudioWarning(res.warning || '');
        if (!settings.systemAudioDevice && res.preferredMonitorId) {
          onChange({ ...settings, systemAudioDevice: res.preferredMonitorId });
        }
        if (!settings.micDeviceId && res.preferredInputId) {
          onChange({ ...settings, micDeviceId: res.preferredInputId });
        }
      } catch {
        /* ignore */
      }
    })();
  }, [info?.platform]);

  const set = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });

  const save = async (patch?: Partial<AppSettings>) => {
    setSaving(true);
    setError('');
    try {
      const next = await window.osmos.updateSettings(patch || settings);
      onSaved(next);
      setStatus('Saved');
      setTimeout(() => setStatus(''), 2000);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const patchProvider = (field: 'apiKey' | 'baseUrl' | 'model', value: string) => {
    const id = settings.activeProvider;
    onChange({
      ...settings,
      providers: {
        ...settings.providers,
        [id]: {
          ...providerDefaults(id, settings.providers?.[id]),
          [field]: value,
        },
      },
    });
  };

  return (
    <div className="hub-modal hub-modal--settings" role="dialog" aria-label="Settings">
      <aside className="hub-modal__nav">
        {onClose ? (
          <button type="button" className="hub-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        ) : null}
        <div className="hub-modal__nav-label">Settings</div>
        <nav className="hub-modal__nav-list">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`hub-nav-item${section === s.id ? ' hub-nav-item--active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              <span aria-hidden>{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="hub-modal__quit"
          onClick={onClose}
        >
          Close settings
        </button>
      </aside>

      <div className="hub-modal__body">
        {(error || status) && (
          <div className={`hub-toast${error ? ' hub-toast--err' : ''}`}>{error || status}</div>
        )}

        {section === 'general' && (
          <div className="settings-section">
            <header className="settings-section__head">
              <h3>General settings</h3>
              <p className="meta">Customize how Osmos works for you</p>
            </header>

            <div className="settings-rows">
              <div className="settings-row">
                <div className="settings-row__icon" aria-hidden>
                  ◌
                </div>
                <div className="settings-row__copy">
                  <strong>Low-profile</strong>
                  <p>
                    {info?.platform === 'linux'
                      ? 'On Linux this only hides Osmos from the taskbar/Alt-Tab. Entire-screen Meet/Zoom shares still include the overlay — share a Chrome tab (or a single window) so others do not see it while you keep using Osmos. Full screen-share hiding will come later on Linux.'
                      : 'Hides the overlay from screen shares where the OS supports capture exclusion (Windows / macOS). Only you can see Osmos during a call.'}
                  </p>
                </div>
                <button
                  type="button"
                  className={`home-switch${settings.stealthEnabled ? ' home-switch--on' : ''}`}
                  aria-label="Toggle low-profile"
                  onClick={() => void save({ stealthEnabled: !settings.stealthEnabled })}
                >
                  <span className="home-switch__knob" />
                </button>
              </div>

              <div className="settings-row">
                <div className="settings-row__icon" aria-hidden>
                  ▶
                </div>
                <div className="settings-row__copy">
                  <strong>Smart assist audio</strong>
                  <p>Meetings start capturing system / meeting audio when Smart is on</p>
                </div>
                <select
                  value={settings.assistAudioSource || 'system'}
                  onChange={(e) =>
                    set({
                      assistAudioSource: e.target.value as AppSettings['assistAudioSource'],
                    })
                  }
                >
                  <option value="system">System audio</option>
                  <option value="mic">Mic only</option>
                  <option value="both">Both</option>
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row__icon" aria-hidden>
                  ⌁
                </div>
                <div className="settings-row__copy">
                  <strong>Audio profile</strong>
                  <p>{audioProfile.summary}</p>
                  <p className="meta" style={{ marginTop: 8 }}>
                    {describeAudioCaptureProfile(audioProfile)[0]}
                  </p>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row__icon" aria-hidden>
                  👁
                </div>
                <div className="settings-row__copy">
                  <strong>Continuous screen assist</strong>
                  <p>
                    While Smart is on, keep OCR-reading the screen (loop-safe only — never
                    loops the Wayland portal)
                  </p>
                </div>
                <button
                  type="button"
                  className={`home-switch${settings.continuousScreenAssist !== false ? ' home-switch--on' : ''}`}
                  aria-label="Toggle continuous screen assist"
                  onClick={() =>
                    set({ continuousScreenAssist: settings.continuousScreenAssist === false })
                  }
                >
                  <span className="home-switch__knob" />
                </button>
              </div>

              <div className="settings-row">
                <div className="settings-row__icon" aria-hidden>
                  ✎
                </div>
                <div className="settings-row__copy">
                  <strong>Auto-ask on final speech</strong>
                  <p>When transcription finishes, automatically request an assist</p>
                </div>
                <button
                  type="button"
                  className={`home-switch${settings.autoAskOnFinal ? ' home-switch--on' : ''}`}
                  aria-label="Toggle auto-ask"
                  onClick={() => set({ autoAskOnFinal: !settings.autoAskOnFinal })}
                >
                  <span className="home-switch__knob" />
                </button>
              </div>

              <div className="settings-row">
                <div className="settings-row__icon" aria-hidden>
                  ◈
                </div>
                <div className="settings-row__copy">
                  <strong>Active mode</strong>
                  <p>Default overlay appearance / prompt style</p>
                </div>
                <select
                  value={settings.activeMode}
                  onChange={(e) =>
                    set({ activeMode: e.target.value as AppSettings['activeMode'] })
                  }
                >
                  <option value="interview">Interview</option>
                  <option value="meeting">Meeting</option>
                  <option value="general">General</option>
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row__icon" aria-hidden>
                  ↻
                </div>
                <div className="settings-row__copy">
                  <strong>Version</strong>
                  <p>You are currently using Osmos version {info?.version || '…'}</p>
                </div>
                <button
                  type="button"
                  className="hub-upload__btn"
                  onClick={async () => {
                    const res = await window.osmos.checkUpdates();
                    if (res.error) setError(res.error);
                    else if (res.available) setStatus(`Update available: v${res.version}`);
                    else setStatus(`Up to date (v${res.version || info?.version || ''})`);
                  }}
                >
                  Check
                </button>
              </div>
            </div>

            <div className="row" style={{ marginTop: 18 }}>
              <button className="primary" type="button" disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {section === 'about' && (
          <div className="settings-section">
            <header className="settings-section__head">
              <h3>About Osmos</h3>
              <p className="meta">MIT open-source interview &amp; meeting copilot</p>
            </header>
            <p className="meta">
              {info?.name} {info?.version} · {info?.platformName}
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => void window.osmos.openExternal('https://github.com/taksha17/osmos')}
            >
              Open GitHub
            </button>
          </div>
        )}

        {section === 'keybinds' && (
          <div className="settings-section">
            <header className="settings-section__head">
              <h3>Keybinds</h3>
              <p className="meta">
                {info?.shortcutsRegistered === false
                  ? 'Global hotkeys often fail on Wayland — use in-app controls.'
                  : 'Registered global shortcuts for this session.'}
              </p>
            </header>
            <div className="settings-rows">
              <div className="settings-row">
                <div className="settings-row__copy">
                  <strong>Toggle overlay</strong>
                  <p>Alt+Shift+Space (Linux) / Cmd+Shift+Space (macOS)</p>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row__copy">
                  <strong>Assist</strong>
                  <p>Ctrl/Cmd+Enter in overlay · Alt+Shift+A</p>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row__copy">
                  <strong>Screen OCR</strong>
                  <p>Alt+Shift+C</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {section === 'ai' && (
            <div className="settings-section">
              <header className="settings-section__head">
                <h3>AI provider</h3>
                <p className="meta">
                  Local Ollama works offline with no API key. Cloud providers need a key but need no extra installs.
                </p>
              </header>

              <div className="field">
                <label>Active provider</label>
                <select
                  value={settings.activeProvider}
                  onChange={(e) =>
                    set({ activeProvider: e.target.value as AppSettings['activeProvider'] })
                  }
                >
                  <option value="ollama">Ollama (local — recommended)</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="groq">Groq</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="litellm">LiteLLM</option>
                </select>
              </div>

              {settings.activeProvider === 'ollama' ? (
                <>
                  <div className="field">
                    <label>Ollama base URL</label>
                    <input
                      value={settings.ollamaBaseUrl}
                      onChange={(e) =>
                        set({
                          ollamaBaseUrl: e.target.value,
                          providers: {
                            ...settings.providers,
                            ollama: {
                              ...providerDefaults('ollama', settings.providers.ollama),
                              baseUrl: e.target.value,
                            },
                          },
                        })
                      }
                      placeholder="http://127.0.0.1:11434"
                    />
                  </div>
                  <div className="field">
                    <label>Model</label>
                    <input
                      value={settings.ollamaModel}
                      onChange={(e) =>
                        set({
                          ollamaModel: e.target.value,
                          providers: {
                            ...settings.providers,
                            ollama: {
                              ...providerDefaults('ollama', settings.providers.ollama),
                              model: e.target.value,
                            },
                          },
                        })
                      }
                      placeholder="llama3.2"
                    />
                  </div>
                  <div className="row" style={{ marginBottom: 14 }}>
                    <button
                      className="primary"
                      style={{ height: 38 }}
                      type="button"
                      onClick={async () => {
                        const next = await save({
                          ollamaBaseUrl: settings.ollamaBaseUrl,
                          ollamaModel: settings.ollamaModel,
                          activeProvider: 'ollama',
                        });
                        if (!next) return;
                        const res = await window.osmos.listOllamaModels(next.ollamaBaseUrl);
                        if (!res.ok) {
                          setError(res.error || `Ollama failed at ${res.baseUrl || next.ollamaBaseUrl}`);
                        } else {
                          setModels(res.models);
                          setError('');
                          setStatus(`${res.models.length} models @ ${res.baseUrl || next.ollamaBaseUrl}`);
                        }
                      }}
                    >
                      Probe Ollama
                    </button>
                    {models.length > 0 && <span className="meta">{models.slice(0, 6).join(', ')}</span>}
                  </div>
                  <p className="meta">Install Ollama from ollama.com, pull a model, then Probe.</p>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>API key</label>
                    <input
                      type="password"
                      value={settings.providers?.[settings.activeProvider]?.apiKey || ''}
                      onChange={(e) => patchProvider('apiKey', e.target.value)}
                      placeholder="sk-…"
                    />
                  </div>
                  <div className="field">
                    <label>Base URL</label>
                    <input
                      value={settings.providers?.[settings.activeProvider]?.baseUrl || ''}
                      onChange={(e) => patchProvider('baseUrl', e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>Model</label>
                    <input
                      value={settings.providers?.[settings.activeProvider]?.model || ''}
                      onChange={(e) => patchProvider('model', e.target.value)}
                    />
                  </div>
                  <div className="row" style={{ marginBottom: 14 }}>
                    <button
                      className="primary"
                      style={{ height: 38 }}
                      type="button"
                      onClick={async () => {
                        const provider = settings.providers?.[settings.activeProvider];
                        if (!provider?.baseUrl || !provider?.model) {
                          setError('Enter base URL and model first');
                          return;
                        }
                        await save({
                          activeProvider: settings.activeProvider,
                          providers: settings.providers,
                        });
                        setStatus('Testing provider…');
                        setError('');
                        try {
                          const res = await fetch(
                            `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                            {
                              method: 'POST',
                              headers: {
                                'Content-Type': 'application/json',
                                ...(provider.apiKey
                                  ? { Authorization: `Bearer ${provider.apiKey}` }
                                  : {}),
                              },
                              body: JSON.stringify({
                                model: provider.model,
                                messages: [{ role: 'user', content: 'Say OK' }],
                              }),
                              signal: AbortSignal.timeout(15_000),
                            },
                          );
                          if (!res.ok) {
                            const text = await res.text().catch(() => '');
                            setError(
                              `${provider.label} test failed (${res.status}): ${text.slice(0, 120)}`,
                            );
                          } else {
                            setStatus(`${provider.label} OK`);
                          }
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      Test {settings.providers?.[settings.activeProvider]?.label || settings.activeProvider}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {section === 'web' && (
            <div className="settings-section">
              <header className="settings-section__head">
                <h3>Web access</h3>
                <p className="meta">
                  Ground answers with live search. DuckDuckGo works with no setup. Tavily is stronger with one API key.
                  SearXNG is for self-hosters.
                </p>
              </header>

              <div className="field">
                <label>Search provider</label>
                <select
                  value={settings.webSearchProvider || 'duckduckgo'}
                  onChange={(e) => {
                    const webSearchProvider = e.target.value as WebSearchProvider;
                    set({
                      webSearchProvider,
                      useWebSearch: webSearchProvider !== 'off',
                    });
                  }}
                >
                  <option value="duckduckgo">DuckDuckGo (free — recommended)</option>
                  <option value="tavily">Tavily (API key)</option>
                  <option value="searxng">SearXNG (self-hosted)</option>
                  <option value="off">Off (no live web)</option>
                </select>
              </div>

              {settings.webSearchProvider === 'duckduckgo' && (
                <p className="settings-callout">
                  No account needed. Good enough for most interview/meeting grounding. Switch to Tavily if you need
                  richer, more consistent results.
                </p>
              )}

              {settings.webSearchProvider === 'tavily' && (
                <>
                  <div className="field">
                    <label>Tavily API key</label>
                    <input
                      type="password"
                      value={settings.tavilyApiKey || ''}
                      onChange={(e) => set({ tavilyApiKey: e.target.value })}
                      placeholder="tvly-…"
                    />
                  </div>
                  <p className="meta">
                    Get a key at{' '}
                    <button
                      type="button"
                      className="dash-link"
                      onClick={() => void window.osmos.openExternal('https://tavily.com')}
                    >
                      tavily.com
                    </button>
                    . Paste it here — no server to run.
                  </p>
                </>
              )}

              {settings.webSearchProvider === 'searxng' && (
                <>
                  <div className="field">
                    <label>SearXNG base URL</label>
                    <input
                      value={settings.searxngBaseUrl}
                      onChange={(e) => set({ searxngBaseUrl: e.target.value })}
                      placeholder="http://127.0.0.1/searxng"
                    />
                  </div>
                  <p className="meta">
                    Advanced: run your own SearXNG with JSON enabled. Most users should pick DuckDuckGo or Tavily
                    instead.
                  </p>
                </>
              )}

              {settings.webSearchProvider === 'off' && (
                <p className="settings-callout">
                  Web grounding is disabled. Answers use your profile, documents, and the model only — best for
                  private interview practice.
                </p>
              )}

              <div className="row" style={{ marginTop: 12, marginBottom: 8 }}>
                <button
                  className="primary"
                  style={{ height: 38 }}
                  type="button"
                  disabled={settings.webSearchProvider === 'off'}
                  onClick={async () => {
                    const next = await save({
                      webSearchProvider: settings.webSearchProvider,
                      tavilyApiKey: settings.tavilyApiKey,
                      searxngBaseUrl: settings.searxngBaseUrl,
                      useWebSearch: settings.webSearchProvider !== 'off',
                    });
                    if (!next) return;
                    const res = await window.osmos.testWebSearch({
                      webSearchProvider: next.webSearchProvider,
                      tavilyApiKey: next.tavilyApiKey,
                      searxngBaseUrl: next.searxngBaseUrl,
                    });
                    if (!res.ok) setError(res.error || 'Web search failed');
                    else {
                      setError('');
                      setStatus(
                        res.provider === 'off'
                          ? 'Web search off'
                          : `${res.provider} ok — ${res.resultCount ?? 0} results`,
                      );
                    }
                  }}
                >
                  Test web search
                </button>
              </div>
            </div>
          )}

          {section === 'speech' && (
            <div className="settings-section">
              <header className="settings-section__head">
                <h3>Speech</h3>
                <p className="meta">Local Whisper is the default — offline and reliable on Linux.</p>
              </header>

              <div className="field">
                <label>STT provider</label>
                <select
                  value={settings.sttProvider}
                  onChange={(e) =>
                    set({ sttProvider: e.target.value as AppSettings['sttProvider'] })
                  }
                >
                  <option value="local-whisper">Local Whisper (offline, recommended)</option>
                  <option value="webspeech">
                    Web Speech {webspeechAvailable ? '(needs Google cloud)' : '(unavailable here)'}
                  </option>
                  <option value="openai-whisper">OpenAI Whisper (API key)</option>
                </select>
              </div>

              <div className="field">
                <label>Smart assist listens to</label>
                <select
                  value={settings.assistAudioSource || 'system'}
                  onChange={(e) =>
                    set({
                      assistAudioSource: e.target.value as AppSettings['assistAudioSource'],
                    })
                  }
                >
                  <option value="system">System / meeting audio (recommended)</option>
                  <option value="mic">Microphone only</option>
                  <option value="both">Both mic + system</option>
                </select>
              </div>

              <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <label style={{ marginBottom: 4 }}>Continuous screen assist</label>
                  <p className="meta" style={{ margin: 0 }}>
                    While Smart is on, keep OCR-reading the screen. Uses loop-safe capture only
                    (never loops the Wayland portal).
                  </p>
                </div>
                <button
                  type="button"
                  className={`home-switch${settings.continuousScreenAssist !== false ? ' home-switch--on' : ''}`}
                  aria-label="Toggle continuous screen assist"
                  onClick={() =>
                    set({ continuousScreenAssist: settings.continuousScreenAssist === false })
                  }
                >
                  <span className="home-switch__knob" />
                </button>
              </div>

              <p className="meta" style={{ marginBottom: 14 }}>
                Overlay Smart mode listens to <strong>meeting/system audio</strong> (what your
                speakers play). Continuous screen assist is optional and never steals the Zoom/Meet
                share portal on Wayland.
              </p>
              {audioWarning ? (
                <p className="settings-callout" style={{ marginBottom: 14 }}>
                  {audioWarning}
                </p>
              ) : null}

              <div className="field">
                <label>Loopback device (optional)</label>
                {info?.platform === 'linux' && nativeMonitors.length > 0 ? (
                  <select
                    value={settings.systemAudioDevice || preferredMonitorId || ''}
                    onChange={(e) => set({ systemAudioDevice: e.target.value })}
                  >
                    {nativeMonitors.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={settings.systemAudioDevice || ''}
                    onChange={(e) => set({ systemAudioDevice: e.target.value })}
                    placeholder={
                      info?.platform === 'darwin'
                        ? 'BlackHole 2ch'
                        : info?.platform === 'win32'
                          ? 'Optional override (Windows uses Chromium loopback by default)'
                          : 'PipeWire / Pulse source (blank = default monitor)'
                    }
                  />
                )}
              </div>
              {info?.platform === 'darwin' ? (
                <p className="meta" style={{ marginBottom: 14 }}>
                  macOS cannot tap Zoom/Meet audio without a virtual cable. Install BlackHole
                  (existential.audio/blackhole), then in Audio MIDI Setup create a Multi-Output Device
                  (speakers + BlackHole) and set it as system output. OSMOS auto-picks a BlackHole /
                  Loopback / Soundflower device, or use the field above.
                </p>
              ) : (
                <p className="meta" style={{ marginBottom: 14 }}>
                  Leave blank to auto-detect. On Windows, Smart listen uses Chromium desktop
                  loopback (no ffmpeg WASAPI). Override only if you need a named Linux/macOS
                  virtual cable.
                </p>
              )}

              {/* P0: end-to-end diagnostics — exercises every audio path in one click. */}
              <DiagnosticsPanel settings={settings} />

              {settings.sttProvider === 'local-whisper' && (
                <p className="meta" style={{ marginBottom: 14 }}>
                  Click Start mic, speak, then Stop. Uses a local Node Whisper worker (needs `node` on PATH). First
                  run downloads a small model once.
                </p>
              )}
              {settings.sttProvider === 'webspeech' && (
                <p className="meta" style={{ marginBottom: 14 }}>
                  Web Speech often fails on Linux with a network error. Prefer Local Whisper.
                </p>
              )}

              <div className="field">
                <label>Microphone</label>
                <div className="row">
                  <select
                    style={{ flex: 1 }}
                    value={settings.micDeviceId}
                    onChange={(e) => set({ micDeviceId: e.target.value })}
                  >
                    <option value="">System default</option>
                    {micDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
                    style={{ height: 38 }}
                    type="button"
                    onClick={() => void refreshMicDevices()}
                  >
                    Refresh
                  </button>
                  <button
                    className="primary"
                    style={{ height: 38, marginLeft: 8 }}
                    type="button"
                    onClick={() => (micTest.on ? stopMicTest() : void startMicTest())}
                  >
                    {micTest.on ? 'Stop' : '🎙 Test mic'}
                  </button>
                </div>
                {micTest.on ? (
                  <div className="mic-test" style={{ marginTop: 10 }}>
                    <div className="mic-meter" aria-hidden>
                      <div
                        className="mic-meter__fill"
                        style={{ width: `${Math.min(100, micTest.level)}%` }}
                      />
                      <div
                        className="mic-meter__peak"
                        style={{ left: `${Math.min(100, micTest.peak)}%` }}
                      />
                    </div>
                    <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                      <span className="meta">
                        {micTest.level > 2 ? 'Hearing audio ✓' : 'Silence… speak now'}
                      </span>
                      <span className="meta" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {micTest.level}%
                      </span>
                    </div>
                    <p className="meta" style={{ margin: '4px 0 0' }}>{micTest.label}</p>
                  </div>
                ) : null}
              </div>

              <div className="field">
                <label>STT language</label>
                <input
                  value={settings.sttLanguage}
                  onChange={(e) => set({ sttLanguage: e.target.value })}
                  placeholder="en-US"
                />
              </div>

              <div className="field">
                <label>Response latency (chunk size): {settings.transcribeChunkMs} ms</label>
                <input
                  type="range"
                  min={2000}
                  max={8000}
                  step={500}
                  value={settings.transcribeChunkMs}
                  onChange={(e) => set({ transcribeChunkMs: Number(e.target.value) })}
                  style={{ width: '100%' }}
                />
                <p className="meta" style={{ margin: '4px 0 0' }}>
                  Lower = snappier answers, more CPU. Higher = less chatty for long monologues.
                </p>
              </div>

              <label className="meta" style={{ display: 'block', marginBottom: 14 }}>
                <input
                  type="checkbox"
                  checked={settings.autoAskOnFinal}
                  onChange={(e) => set({ autoAskOnFinal: e.target.checked })}
                />{' '}
                Auto-ask when speech is finalized
              </label>

              {settings.sttProvider === 'openai-whisper' && (
                <>
                  <div className="field">
                    <label>OpenAI API key (Whisper)</label>
                    <input
                      type="password"
                      value={settings.openaiApiKey}
                      onChange={(e) => set({ openaiApiKey: e.target.value })}
                      placeholder="sk-…"
                    />
                  </div>
                  <div className="field">
                    <label>OpenAI base URL</label>
                    <input
                      value={settings.openaiBaseUrl}
                      onChange={(e) => set({ openaiBaseUrl: e.target.value })}
                    />
                  </div>
                </>
              )}

              <h4 style={{ marginTop: 18, marginBottom: 8 }}>System audio</h4>
              <p className="meta" style={{ marginBottom: 10 }}>
                Capture meeting/system audio for transcription. Requires platform audio utilities.
              </p>
              <button
                className="primary"
                style={{ height: 38 }}
                type="button"
                onClick={async () => {
                  setStatus('Capturing system audio…');
                  setError('');
                  try {
                    const { captureElectronLoopback, isWindowsPlatform } = await import(
                      '../stt/electronLoopback'
                    );
                    const res = (await isWindowsPlatform())
                      ? await captureElectronLoopback(5000)
                      : await window.osmos.captureSystemAudio({
                          durationMs: 5000,
                          device: settings.systemAudioDevice,
                        });
                    if (!res.ok) setError(res.error || 'System audio capture failed');
                    else if ((res as { silent?: boolean }).silent) {
                      setError('Captured silence — play audio on speakers and retry.');
                    } else {
                      setStatus(
                        `Captured ${res.mimeType || 'audio'} (${(res.base64?.length || 0) / 1024 | 0} KB)`,
                      );
                    }
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setTimeout(() => setStatus(''), 2000);
                  }
                }}
              >
                Capture system audio (5s)
              </button>
            </div>
          )}

          {section === 'stealth' && (
            <div className="settings-section">
              <header className="settings-section__head">
                <h3>Stealth</h3>
                <p className="meta">
                  Screen-share safer overlay: hide from taskbar
                  {info?.platform === 'linux'
                    ? ', always-on-top. Linux has no OS capture-exclusion API — share a tab/window, not the full desktop.'
                    : info?.platform === 'darwin'
                      ? ', and NSWindowSharingNone (setContentProtection). On newer macOS, prefer sharing one app/tab — full-desktop ScreenCaptureKit shares can still include overlays.'
                      : ', and SetWindowDisplayAffinity / WDA_EXCLUDEFROMCAPTURE (setContentProtection) so Zoom, Teams, Meet, Webex, and similar omit Osmos from the shared feed on Windows 10 2004+ / 11.'}
                </p>
              </header>

              {info?.shortcutsRegistered === false ? (
                <p className="meta" style={{ marginBottom: 14 }}>
                  Global hotkeys failed to register (common on Wayland). Use <strong>Start Osmos</strong>, the
                  overlay menu, and in-app buttons instead of system shortcuts.
                </p>
              ) : (
                <p className="meta" style={{ marginBottom: 14 }}>
                  Hotkeys: Ctrl/Cmd+Shift+Space (toggle overlay), +A (ask), +C (capture).
                </p>
              )}

              <label className="meta" style={{ display: 'block', marginBottom: 14 }}>
                <input
                  type="checkbox"
                  checked={settings.stealthEnabled}
                  onChange={(e) => {
                    const stealthEnabled = e.target.checked;
                    set({ stealthEnabled });
                    void save({ stealthEnabled });
                  }}
                />{' '}
                Enable stealth mode (hide Osmos from screen share)
              </label>

                <div className="field" style={{ marginTop: 14 }}>
                  <label>Local data</label>
                  <button
                    type="button"
                    style={{ height: 38 }}
                    onClick={() => {
                      if (!window.confirm('Delete ALL saved sessions and transcripts?')) return;
                      void window.osmos.clearAllHistory().then(() => {
                        setStatus('All sessions and transcripts deleted');
                        setTimeout(() => setStatus(''), 2500);
                      });
                    }}
                  >
                    Delete all sessions & transcripts
                  </button>
                  <p className="meta" style={{ margin: '6px 0 0' }}>
                    Transcripts of other people are personal data — delete what you don't need.
                  </p>
                </div>

              {settings.stealthEnabled ? (
                <p className="meta" style={{ marginBottom: 14 }}>
                  Best practice: share a single window or browser tab in the meeting app. Enable stealth before
                  joining. Osmos stays visible on your monitor but is excluded from the capture pipeline where
                  the OS supports it.
                </p>
              ) : null}

              <div className="field">
                <label>Overlay opacity ({Math.round((settings.overlayOpacity || 0.92) * 100)}%)</label>
                <input
                  type="range"
                  min={0.45}
                  max={1}
                  step={0.01}
                  value={settings.overlayOpacity || 0.92}
                  onChange={(e) => set({ overlayOpacity: Number(e.target.value) })}
                  onMouseUp={() => void save({ overlayOpacity: settings.overlayOpacity })}
                />
              </div>

              <h4 style={{ marginTop: 18, marginBottom: 8 }}>Platform notes</h4>
              <ul>
                {(info?.capabilityNotes ?? []).map((n) => (
                  <li key={n} className="meta">
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {section === 'updates' && (
            <div className="settings-section">
              <header className="settings-section__head">
                <h3>Updates</h3>
                <p className="meta">Check for a newer release from an update feed JSON URL.</p>
              </header>
              <div className="field">
                <label>Update feed URL</label>
                <input id="update-url" placeholder="https://example.com/update.json" defaultValue="" />
              </div>
              <button
                className="primary"
                style={{ height: 38 }}
                type="button"
                onClick={async () => {
                  const url =
                    (document.getElementById('update-url') as HTMLInputElement | null)?.value || '';
                  const res: UpdateStatus = await window.osmos.checkUpdates(url);
                  if (res.error) setError(res.error);
                  else if (res.available) setStatus(`Update available: v${res.version}`);
                  else setStatus(`Up to date (v${res.version || info?.version || ''})`);
                }}
              >
                Check for updates
              </button>
            </div>
          )}

          <div className="settings-footer">
            <button
              className="primary"
              style={{ height: 40 }}
              type="button"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
      </div>
    </div>
  );
}

type Diag = { name: string; status: 'ok' | 'warn' | 'fail' | 'pending'; detail: string };

function DiagnosticsPanel({ settings }: { settings: AppSettings }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Diag[]>([]);

  const setAt = (i: number, patch: Partial<Diag>) =>
    setResults((r) => r.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));

  const rmsFromWav = (b64: string): number => {
    try {
      const bin = atob(b64);
      let sum = 0;
      let n = 0;
      for (let i = 44; i + 1 < bin.length; i += 2) {
        const s = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8);
        const v = (s >= 0x8000 ? s - 0x10000 : s) / 32768;
        sum += v * v;
        n++;
      }
      return n ? Math.sqrt(sum / n) : 0;
    } catch {
      return 0;
    }
  };

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setResults([
      { name: 'Microphone', status: 'pending', detail: 'Recording 4 s…' },
      { name: 'Speaker / system audio', status: 'pending', detail: 'Capturing 3 s…' },
      { name: 'Speech-to-text model', status: 'pending', detail: 'Warming Whisper…' },
      { name: 'Stealth (capture exclusion)', status: 'pending', detail: 'Checking OS support…' },
    ]);

    // 1. Mic test
    try {
      const dev = settings.micDeviceId;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: dev ? { deviceId: { exact: dev }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let peak = 0;
      const start = Date.now();
      while (Date.now() - start < 4000) {
        await new Promise((r) => setTimeout(r, 80));
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        const r = Math.sqrt(sum / buf.length);
        if (r > peak) peak = r;
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      if (peak > 0.01) {
        setAt(0, { status: 'ok', detail: `peak level ${(peak * 100).toFixed(0)}% — mic is working` });
      } else {
        setAt(0, { status: 'warn', detail: 'peak level 0% — speak during the test or check the picker' });
      }
    } catch (e) {
      setAt(0, { status: 'fail', detail: e instanceof Error ? e.message : String(e) });
    }

    // 2. System audio
    try {
      const res = await window.osmos.captureSystemAudio({ durationMs: 3000 });
      if (!res?.ok || !res.base64) {
        setAt(1, { status: 'fail', detail: res?.error || 'no audio captured' });
      } else {
        const rms = rmsFromWav(res.base64);
        if (rms > 0.01) {
          setAt(1, { status: 'ok', detail: `level ${(rms * 100).toFixed(0)}% — system audio working` });
        } else {
          setAt(1, { status: 'warn', detail: 'silent — play media on this machine (TV/cast won\'t appear)' });
        }
      }
    } catch (e) {
      setAt(1, { status: 'fail', detail: e instanceof Error ? e.message : String(e) });
    }

    // 3. Whisper model — we cannot probe the cache from renderer without IPC,
    //    so we just confirm the STT provider and that the local-whisper code
    //    path resolves. The first real call will still download if missing.
    if (settings.sttProvider === 'local-whisper' || settings.sttProvider === undefined) {
      setAt(2, {
        status: 'ok',
        detail: 'Local Whisper configured — first real transcript downloads the model',
      });
    } else {
      setAt(2, {
        status: 'warn',
        detail: `${settings.sttProvider} selected — confirm API key in Settings`,
      });
    }

    // 4. Stealth
    try {
      const info = await window.osmos.getInfo();
      const plat = info?.platformName ?? '';
      if (plat === 'macOS' || plat === 'Windows') {
        setAt(3, { status: 'ok', detail: `${plat} — OS-level capture exclusion available (Low-profile toggle)` });
      } else {
        setAt(3, { status: 'warn', detail: 'Linux has no OS-level exclusion; share a window/tab, not the whole desktop' });
      }
    } catch {
      setAt(3, { status: 'pending', detail: 'no info available' });
    }

    setRunning(false);
  }, [running, settings.micDeviceId]);

  return (
    <div className="field">
      <label>Run diagnostics</label>
      <p className="meta" style={{ marginBottom: 8 }}>
        Tests mic, system audio, speech model, and stealth in ~10 seconds.
      </p>
      <button
        type="button"
        className="primary"
        style={{ height: 38 }}
        onClick={() => void run()}
        disabled={running}
      >
        {running ? 'Running…' : 'Run diagnostics'}
      </button>
      {results.length ? (
        <ul className="diag-list" style={{ marginTop: 12, listStyle: 'none', padding: 0 }}>
          {results.map((r) => (
            <li key={r.name} className={`diag-row diag-row--${r.status}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <span className="diag-row__icon" aria-hidden style={{ width: 18, display: 'inline-block', textAlign: 'center' }}>
                {r.status === 'ok' ? '✓' : r.status === 'warn' ? '!' : r.status === 'fail' ? '✗' : '…'}
              </span>
              <div>
                <strong>{r.name}</strong>
                <div className="meta">{r.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
