import { useState } from 'react';
import type { FeatureDef } from '@shared/features';
import type { AppSettings, UpdateStatus, WebSearchProvider } from '@shared/types';

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
  mic: {
    devices: MicDevice[];
    webspeechAvailable: boolean;
    refreshDevices: () => Promise<void>;
  };
  onChange: (next: AppSettings) => void;
  onSaved: (next: AppSettings) => void;
};

type Section = 'ai' | 'web' | 'speech' | 'stealth' | 'updates';

const SECTIONS: Array<{ id: Section; label: string; blurb: string }> = [
  { id: 'ai', label: 'AI', blurb: 'Language model provider' },
  { id: 'web', label: 'Web', blurb: 'Live search grounding' },
  { id: 'speech', label: 'Speech', blurb: 'Microphone & transcription' },
  { id: 'stealth', label: 'Stealth', blurb: 'Screen-share safety' },
  { id: 'updates', label: 'Updates', blurb: 'Release feed' },
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

export function SettingsPanel({ settings, info, mic, onChange, onSaved }: Props) {
  const [section, setSection] = useState<Section>('ai');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

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
    <section className="panel settings-panel">
      <div className="settings-panel__intro">
        <h2>Settings</h2>
        <p>Configure OSMOS like a product — AI, web, speech, and privacy in separate places.</p>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={section === s.id ? 'active' : ''}
              onClick={() => setSection(s.id)}
            >
              <strong>{s.label}</strong>
              <span>{s.blurb}</span>
            </button>
          ))}
        </nav>

        <div className="settings-body">
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
                    Web Speech {mic.webspeechAvailable ? '(needs Google cloud)' : '(unavailable here)'}
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
              <p className="meta" style={{ marginBottom: 14 }}>
                Overlay Smart mode captures the next audio chunk while the previous one is still
                transcribing, then suggests answers. System audio needs PipeWire (Linux), ffmpeg WASAPI
                (Windows), or ffmpeg + BlackHole (macOS).
              </p>

              <div className="field">
                <label>Loopback device (optional)</label>
                <input
                  value={settings.systemAudioDevice || ''}
                  onChange={(e) => set({ systemAudioDevice: e.target.value })}
                  placeholder={
                    info?.platform === 'darwin'
                      ? 'BlackHole 2ch'
                      : info?.platform === 'win32'
                        ? 'WASAPI device name (blank = loopback)'
                        : 'PipeWire / Pulse source (blank = default monitor)'
                  }
                />
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
                  Leave blank to auto-detect the default monitor / WASAPI loopback. Override only if you
                  have a named virtual cable.
                </p>
              )}

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
                    {mic.devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
                    style={{ height: 38 }}
                    type="button"
                    onClick={() => void mic.refreshDevices()}
                  >
                    Refresh
                  </button>
                </div>
              </div>

              <div className="field">
                <label>STT language</label>
                <input
                  value={settings.sttLanguage}
                  onChange={(e) => set({ sttLanguage: e.target.value })}
                  placeholder="en-US"
                />
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
                    const res = await window.osmos.captureSystemAudio({
                      durationMs: 5000,
                      device: settings.systemAudioDevice,
                    });
                    if (!res.ok) setError(res.error || 'System audio capture failed');
                    else {
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
            {status && <span className="meta">{status}</span>}
            {error && <span className="error">{error}</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
