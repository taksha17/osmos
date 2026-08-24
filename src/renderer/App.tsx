import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureDef } from '@shared/features';
import type { AppSettings, ChatStreamEvent, UpdateStatus } from '@shared/types';
import { ChatPanel } from './components/ChatPanel';
import { ProfilePanel } from './components/ProfilePanel';
import { HistoryTab } from './components/HistoryTab';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HomeDashboard } from './components/HomeDashboard';
import { SettingsPanel } from './components/SettingsPanel';
import { OnboardingWizard } from './components/OnboardingWizard';
import { BrandLogo } from './components/BrandLogo';
import { useMicStt } from './stt/useMicStt';

type Tab = 'home' | 'chat' | 'history' | 'roadmap';
type Modal = null | 'profile' | 'settings';

type Info = {
  name: string;
  version: string;
  platform: string;
  platformName: string;
  capabilityNotes: string[];
  features: FeatureDef[];
  shortcutsRegistered?: boolean;
};

declare global {
  interface Window {
    osmos: {
      getInfo: () => Promise<Info>;
      getSettings: () => Promise<AppSettings>;
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      toggleOverlay: () => Promise<{ visible: boolean }>;
      showLauncher: () => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      listOllamaModels: (baseUrl?: string) =>
        Promise<{ ok: boolean; models: string[]; error?: string; baseUrl?: string }>;
      testSearxng: (baseUrl?: string) => Promise<{ ok: boolean; resultCount?: number; error?: string }>;
      testWebSearch: (override?: {
        webSearchProvider?: 'off' | 'duckduckgo' | 'tavily' | 'searxng';
        tavilyApiKey?: string;
        searxngBaseUrl?: string;
      }) => Promise<{
        ok: boolean;
        provider: 'off' | 'duckduckgo' | 'tavily' | 'searxng';
        resultCount?: number;
        error?: string;
      }>;
      transcribeAudio: (payload: {
        base64: string;
        mimeType: string;
        fileName?: string;
        engine?: 'local' | 'openai';
      }) => Promise<{ ok: boolean; text?: string; error?: string }>;
      captureRegion: () => Promise<{ dataUrl: string; cancelled: boolean }>;
      captureFullScreen: () => Promise<{ dataUrl: string; cancelled: boolean }>;
      captureSystemAudio: (payload?: { durationMs?: number; device?: string }) =>
        Promise<{ ok: boolean; base64?: string; mimeType?: string; error?: string }>;
      startSystemAudioListen: (payload?: { device?: string; chunkMs?: number }) =>
        Promise<{ ok: boolean; error?: string; monitor?: string; mode?: 'stream' | 'fallback' }>;
      stopSystemAudioListen: () => Promise<{ ok: boolean }>;
      onSystemAudioChunk: (
        listener: (chunk: {
          ok: boolean;
          base64?: string;
          mimeType?: string;
          error?: string;
          silent?: boolean;
          rms?: number;
        }) => void,
      ) => () => void;
      onSystemAudioStatus: (listener: (ev: { text: string }) => void) => () => void;
      listAudioDevices: () => Promise<import('@shared/types').AudioDevicesResponse>;
      captureMicAudio: (payload?: { durationMs?: number; device?: string }) =>
        Promise<{ ok: boolean; base64?: string; mimeType?: string; error?: string }>;
      listHistory: () => Promise<{ ok: boolean; sessions?: Array<{ id: string; mode: string; messages: Array<{ role: string; content: string; createdAt: number }>; createdAt: number; updatedAt: number }>; error?: string }>;
      saveHistory: (session: { id: string; mode: string; messages: Array<{ role: string; content: string; createdAt: number }>; createdAt: number; updatedAt: number }) =>
        Promise<{ ok: boolean; sessions?: Array<{ id: string; mode: string; messages: Array<{ role: string; content: string; createdAt: number }>; createdAt: number; updatedAt: number }>; error?: string }>;
      deleteHistory: (id: string) => Promise<{ ok: boolean; sessions?: Array<{ id: string; mode: string; messages: Array<{ role: string; content: string; createdAt: number }>; createdAt: number; updatedAt: number }>; error?: string }>;
      listQuestions: () => Promise<{ ok: boolean; items?: import('@shared/types').QuestionBankItem[]; error?: string }>;
      addQuestion: (item: import('@shared/types').QuestionBankItem) =>
        Promise<{ ok: boolean; items?: import('@shared/types').QuestionBankItem[]; error?: string }>;
      deleteQuestion: (id: string) => Promise<{ ok: boolean; items?: import('@shared/types').QuestionBankItem[]; error?: string }>;
      listStarTemplates: () => Promise<{ ok: boolean; templates?: import('@shared/types').StarTemplate[]; error?: string }>;
      addStarTemplate: (template: import('@shared/types').StarTemplate) =>
        Promise<{ ok: boolean; templates?: import('@shared/types').StarTemplate[]; error?: string }>;
      deleteStarTemplate: (id: string) => Promise<{ ok: boolean; templates?: import('@shared/types').StarTemplate[]; error?: string }>;
      checkUpdates: (updateUrl?: string) => Promise<UpdateStatus>;
      ocrExtract: (payload: { base64: string }) =>
        Promise<{ ok: boolean; text?: string; error?: string }>;
      companyIntel: (payload: { companyName: string; jdText?: string; companyUrl?: string }) =>
        Promise<{ ok: boolean; intel?: string; error?: string }>;
      assembleInterviewPrep: () => Promise<{
        ok: boolean;
        companyIntel?: string;
        questionsAdded?: number;
        error?: string;
        settings?: AppSettings;
      }>;
      extractFileText: (payload: { base64: string; fileName?: string; mimeType?: string }) =>
        Promise<{ ok: boolean; text?: string; error?: string }>;
      ask: (payload: {
        message: string;
        history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      }) => Promise<{
        ok: boolean;
        answer?: string;
        error?: string;
        usedWebSearch?: boolean;
        searchHits?: number;
      }>;
      askStream: (
        payload: {
          message: string;
          history?: Array<{ role: 'user' | 'assistant'; content: string }>;
        },
        onEvent: (event: ChatStreamEvent) => void,
      ) => { requestId: string; done: Promise<unknown>; cancel: () => Promise<unknown> };
      onOverlayEvent: (listener: (event: { type: string }) => void) => () => void;
      onShortcut: (listener: (action: string) => void) => () => void;
      onSettingsChanged: (listener: (settings: AppSettings) => void) => () => void;
      resetOverlayIdle: () => Promise<{ ok: boolean }>;
    };
  }
}

function isOverlayRoute() {
  return window.location.hash.replace(/^#/, '') === '/overlay';
}

function OverlayApp() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [idle, setIdle] = useState(false);
  const [paused, setPaused] = useState(false);
  const controlsRef = useRef<{ paused: boolean; togglePause: () => void } | null>(null);

  useEffect(() => {
    document.body.classList.add('overlay-route');
    return () => document.body.classList.remove('overlay-route');
  }, []);

  useEffect(() => {
    void window.osmos.getSettings().then(setSettings);
    const unsub = window.osmos.onSettingsChanged(setSettings);
    return unsub;
  }, []);
  useEffect(() => {
    const unsub = window.osmos.onOverlayEvent((ev) => {
      if (ev.type === 'idle') setIdle(true);
    });
    return unsub;
  }, []);

  const resetIdle = () => {
    if (idle) setIdle(false);
    void window.osmos.resetOverlayIdle();
  };

  return (
    <div
      className={`overlay-root${idle ? ' idle' : ''}${paused ? ' overlay-root--paused' : ''}${settings?.stealthEnabled ? ' overlay-root--stealth' : ''}`}
      onMouseMove={resetIdle}
      onMouseDown={resetIdle}
      onTouchStart={resetIdle}
    >
      <div className="overlay-stack">
        <div className="overlay-pill">
          <BrandLogo variant="mark" />
          <button
            type="button"
            className="overlay-pill__btn"
            onClick={() => void window.osmos.toggleOverlay()}
          >
            Hide <span aria-hidden>▾</span>
          </button>
          <button
            type="button"
            className={`overlay-pill__pause${paused ? ' overlay-pill__pause--paused' : ''}`}
            onClick={() => controlsRef.current?.togglePause()}
            aria-label={paused ? 'Resume session' : 'Pause session'}
            title={paused ? 'Resume listening' : 'Pause listening'}
          >
            <span aria-hidden>{paused ? '▶' : '❚❚'}</span>
          </button>
        </div>

        <div className="overlay-card">
          <ChatPanel
            settings={settings}
            overlay
            paused={paused}
            onPausedChange={setPaused}
            onSettingsChange={setSettings}
            onPreferSttProvider={(provider) => {
              void window.osmos.updateSettings({ sttProvider: provider }).then(setSettings);
            }}
            onRegisterControls={(controls) => {
              controlsRef.current = controls;
            }}
          />
        </div>
      </div>
    </div>
  );
}

function LauncherApp() {
  const [tab, setTab] = useState<Tab>('home');
  const [modal, setModal] = useState<Modal>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState('');
  const mic = useMicStt(settings);

  useEffect(() => {
    void (async () => {
      const [i, s] = await Promise.all([window.osmos.getInfo(), window.osmos.getSettings()]);
      setInfo(i);
      setSettings(s);
    })();
    const unsub = window.osmos.onSettingsChanged(setSettings);
    return unsub;
  }, []);

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  const liveCount = useMemo(
    () => info?.features.filter((f) => f.status === 'live').length ?? 0,
    [info],
  );

  const saveSettings = async (patch: Partial<AppSettings>) => {
    const next = await window.osmos.updateSettings(patch);
    setSettings(next);
    setStatus('Saved');
  };

  if (settings && !settings.onboardingCompleted) {
    return (
      <OnboardingWizard
        settings={settings}
        onComplete={(next) => {
          setSettings(next);
          void window.osmos.toggleOverlay();
        }}
        onSkip={(next) => setSettings(next)}
      />
    );
  }

  return (
    <div className="launcher-shell">
      <main className="launcher-main">
        {tab === 'home' && (
          <HomeDashboard
            settings={settings}
            info={info}
            liveCount={liveCount}
            onStartOsmos={() => void window.osmos.toggleOverlay()}
            onSwitchTab={(t) => {
              if (t === 'profile') setModal('profile');
              else if (t === 'settings') setModal('settings');
              else setTab(t as Tab);
            }}
            onSettingsChange={setSettings}
            onOpenProfile={() => setModal('profile')}
            onOpenSettings={() => setModal('settings')}
          />
        )}

        {tab === 'chat' && (
          <div className="launcher-page">
            <button type="button" className="launcher-back" onClick={() => setTab('home')}>
              ← Home
            </button>
            <ErrorBoundary>
              <ChatPanel
                settings={settings}
                onSettingsChange={setSettings}
                onPreferSttProvider={(provider) => {
                  void window.osmos.updateSettings({ sttProvider: provider }).then(setSettings);
                }}
              />
            </ErrorBoundary>
          </div>
        )}

        {tab === 'history' && (
          <div className="launcher-page">
            <button type="button" className="launcher-back" onClick={() => setTab('home')}>
              ← Home
            </button>
            <HistoryTab />
          </div>
        )}

        {tab === 'roadmap' && (
          <div className="launcher-page">
            <button type="button" className="launcher-back" onClick={() => setTab('home')}>
              ← Home
            </button>
            <section className="panel">
              <h2>Feature roadmap</h2>
              <p>Target capabilities on Linux, macOS, and Windows — original MIT code.</p>
              <div className="grid">
                {(info?.features ?? []).map((f) => (
                  <div className="card" key={f.id}>
                    <span className={`badge ${f.status}`}>{f.status}</span>
                    <strong>{f.name}</strong>
                    <div className="meta">{f.description}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      {modal && settings ? (
        <div
          className="hub-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          {modal === 'profile' ? (
            <ProfilePanel
              settings={settings}
              onClose={() => setModal(null)}
              onChange={(patch) =>
                setSettings({
                  ...settings,
                  ...patch,
                  profile: patch.profile ? { ...settings.profile, ...patch.profile } : settings.profile,
                  profiles: patch.profiles ?? settings.profiles,
                })
              }
              onSave={() =>
                void saveSettings({
                  activeMode: settings.activeMode,
                  activeProfileId: settings.activeProfileId,
                  profiles: settings.profiles,
                  profile: settings.profile,
                })
              }
              status={status}
            />
          ) : null}
          {modal === 'settings' ? (
            <SettingsPanel
              settings={settings}
              info={info}
              mic={mic}
              onChange={setSettings}
              onSaved={setSettings}
              onClose={() => setModal(null)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  if (isOverlayRoute()) return <OverlayApp />;
  return <LauncherApp />;
}
