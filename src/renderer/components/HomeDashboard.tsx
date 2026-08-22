import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings, CopilotMode } from '@shared/types';
import { MODE_DEFS } from '@shared/modes';
import { APP_TAGLINE } from '@shared/brand';
import { activeSavedProfile, modeLabel, profileSummary } from '@shared/profiles';
import { DEFAULT_SAVED_PROFILE } from '@shared/types';
import { BrandLogo } from './BrandLogo';

type Session = {
  id: string;
  mode: string;
  messages: Array<{ role: string; content: string; createdAt: number }>;
  createdAt: number;
  updatedAt: number;
};

type Tab = 'home' | 'chat' | 'history' | 'profile' | 'settings' | 'roadmap';

type Info = {
  name: string;
  version: string;
  platformName: string;
  shortcutsRegistered?: boolean;
};

type ProbeStatus = 'checking' | 'ok' | 'fail' | 'off';

type Probes = {
  llm: ProbeStatus;
  llmDetail: string;
  search: ProbeStatus;
  searchDetail: string;
  mic: ProbeStatus;
  micDetail: string;
};

type Props = {
  settings: AppSettings | null;
  info: Info | null;
  liveCount: number;
  onStartOsmos: () => void;
  onSwitchTab: (tab: Tab) => void;
  onSettingsChange: (next: AppSettings) => void;
};

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function providerLabel(settings: AppSettings | null) {
  if (!settings) return '…';
  if (settings.activeProvider === 'ollama') {
    return settings.ollamaModel || 'Ollama';
  }
  const p = settings.providers?.[settings.activeProvider];
  return p?.model || p?.label || settings.activeProvider;
}

function sttLabel(settings: AppSettings | null) {
  if (!settings) return '…';
  if (settings.sttProvider === 'local-whisper') return 'Local Whisper';
  if (settings.sttProvider === 'openai-whisper') return 'Whisper API';
  return 'Web Speech';
}

function relativeTime(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

async function probeServices(settings: AppSettings): Promise<Probes> {
  const probes: Probes = {
    llm: 'checking',
    llmDetail: providerLabel(settings),
    search: settings.webSearchProvider === 'off' || !settings.useWebSearch ? 'off' : 'checking',
    searchDetail:
      settings.webSearchProvider === 'off' || !settings.useWebSearch
        ? 'Disabled'
        : settings.webSearchProvider || 'DuckDuckGo',
    mic: 'checking',
    micDetail: sttLabel(settings),
  };

  if (settings.activeProvider === 'ollama') {
    const res = await window.osmos.listOllamaModels(settings.ollamaBaseUrl);
    probes.llm = res.ok && res.models.length > 0 ? 'ok' : 'fail';
    probes.llmDetail = res.ok
      ? `${res.models.length} models · ${settings.ollamaModel}`
      : res.error?.slice(0, 48) || 'Unreachable';
  } else {
    const p = settings.providers?.[settings.activeProvider];
    probes.llm = p?.model && (p.apiKey || p.baseUrl) ? 'ok' : 'fail';
    probes.llmDetail = p?.model || settings.activeProvider;
  }

  if (settings.webSearchProvider === 'off' || settings.useWebSearch === false) {
    probes.search = 'off';
    probes.searchDetail = 'Disabled';
  } else {
    const res = await window.osmos.testWebSearch({
      webSearchProvider: settings.webSearchProvider,
      tavilyApiKey: settings.tavilyApiKey,
      searxngBaseUrl: settings.searxngBaseUrl,
    });
    probes.search = res.ok ? 'ok' : 'fail';
    probes.searchDetail = res.ok
      ? `${res.provider} · ${res.resultCount ?? 0} hits`
      : res.error?.slice(0, 40) || 'Failed';
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    if (inputs.length === 0) {
      probes.mic = 'fail';
      probes.micDetail = 'No audio input devices found';
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      probes.mic = 'ok';
      probes.micDetail = `${inputs.length} device${inputs.length === 1 ? '' : 's'} · ${sttLabel(settings)}`;
    }
  } catch {
    probes.mic = 'fail';
    probes.micDetail = 'Mic permission needed';
  }

  return probes;
}

export function HomeDashboard({
  settings,
  info,
  liveCount,
  onStartOsmos,
  onSwitchTab,
  onSettingsChange,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [probes, setProbes] = useState<Probes | null>(null);
  const [probing, setProbing] = useState(false);

  const runProbes = useCallback(async () => {
    if (!settings) return;
    setProbing(true);
    setProbes({
      llm: 'checking',
      llmDetail: 'Checking…',
      search: settings.useWebSearch && settings.webSearchProvider !== 'off' ? 'checking' : 'off',
      searchDetail:
        settings.useWebSearch && settings.webSearchProvider !== 'off' ? 'Checking…' : 'Off',
      mic: 'checking',
      micDetail: 'Checking…',
    });
    setProbes(await probeServices(settings));
    setProbing(false);
  }, [settings]);

  useEffect(() => {
    void window.osmos.listHistory().then((res) => {
      if (res.ok && res.sessions) {
        setSessions(
          [...res.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
        );
      }
    });
  }, []);

  useEffect(() => {
    void runProbes();
  }, [runProbes]);

  const name = settings?.profile?.displayName?.trim() || 'there';
  const activeMode = settings?.activeMode || 'interview';
  const mode = MODE_DEFS.find((m) => m.id === activeMode) ?? MODE_DEFS[0]!;
  const profiles = settings?.profiles?.length
    ? settings.profiles
    : settings
      ? [{ ...DEFAULT_SAVED_PROFILE, ...settings.profile, id: 'default', label: 'Default' }]
      : [];
  const activeProfile = activeSavedProfile(profiles, settings?.activeProfileId);
  const summary = profileSummary(activeProfile);

  const openProfile = (section?: 'basics' | 'company' | 'documents' | 'questions') => {
    if (section) {
      try {
        sessionStorage.setItem('osmos-profile-section', section);
      } catch {
        /* ignore */
      }
    }
    onSwitchTab('profile');
  };

  const prep = useMemo(
    () => [
      {
        id: 'resume',
        label: 'Résumé in profile',
        done: Boolean(settings?.profile?.resumeText?.trim()),
        section: 'basics' as const,
      },
      {
        id: 'jd',
        label: 'Job description',
        done: Boolean(settings?.profile?.jdText?.trim()),
        section: 'basics' as const,
      },
      {
        id: 'docs',
        label: 'Reference documents',
        done: (activeProfile.documents?.length || settings?.documents?.length || 0) > 0,
        section: 'documents' as const,
        detail: (activeProfile.documents?.length || settings?.documents?.length)
          ? `${activeProfile.documents?.length || settings?.documents?.length} attached`
          : undefined,
      },
      {
        id: 'company',
        label: 'Company research',
        done: Boolean(activeProfile.companyIntel?.trim() || activeProfile.companyUrl?.trim()),
        section: 'company' as const,
        detail: activeProfile.companyName || undefined,
      },
      {
        id: 'questions',
        label: 'Question bank / STAR',
        done: (activeProfile.questions?.length || 0) + (activeProfile.starTemplates?.length || 0) > 0,
        section: 'questions' as const,
        detail:
          (activeProfile.questions?.length || 0) > 0
            ? `${activeProfile.questions?.length} questions`
            : 'Practice stories',
      },
      {
        id: 'llm',
        label: 'LLM reachable',
        done: probes?.llm === 'ok',
        section: null as null,
        detail: probes?.llmDetail || providerLabel(settings),
        tab: 'settings' as Tab,
      },
    ],
    [settings, probes, activeProfile],
  );

  const prepDone = prep.filter((p) => p.done).length;

  const setMode = async (modeId: CopilotMode) => {
    const next = await window.osmos.updateSettings({ activeMode: modeId });
    onSettingsChange(next);
  };

  const switchProfile = async (id: string) => {
    const next = await window.osmos.updateSettings({ activeProfileId: id });
    onSettingsChange(next);
  };

  const quickActions = [
    { id: 'chat' as Tab, label: 'Ask anything', desc: 'Open chat', icon: '💬' },
    { id: 'profile' as Tab, label: 'Edit profile', desc: 'Résumé, company, docs, questions', icon: '◈' },
    { id: 'history' as Tab, label: 'Sessions', desc: 'Past conversations', icon: '↺' },
    { id: 'settings' as Tab, label: 'Settings', desc: 'AI, speech, stealth', icon: '⚙' },
  ];

  const statusItems = [
    { label: 'LLM', status: probes?.llm ?? 'checking', value: probes?.llmDetail ?? providerLabel(settings) },
    { label: 'Speech', status: probes?.mic ?? 'checking', value: probes?.micDetail ?? sttLabel(settings) },
    { label: 'Mode', status: 'ok' as ProbeStatus, value: mode.name },
    {
      label: 'Web',
      status:
        probes?.search ??
        (settings?.webSearchProvider === 'off' || !settings?.useWebSearch ? 'off' : 'checking'),
      value:
        probes?.searchDetail ??
        (settings?.webSearchProvider === 'off' || !settings?.useWebSearch
          ? 'Off'
          : settings?.webSearchProvider || 'DuckDuckGo'),
    },
  ];

  const systemReady =
    probes &&
    probes.llm === 'ok' &&
    probes.mic === 'ok' &&
    (probes.search === 'ok' || probes.search === 'off');

  return (
    <div className="home-dashboard">
      <section className="dash-hero">
        <div className="dash-hero__copy">
          <BrandLogo variant="hero" />
          <p className="dash-hero__greet">
            {greeting()}, <span>{name}</span>
          </p>
          <p className="dash-hero__tagline">{APP_TAGLINE}</p>
        </div>
        <div className="dash-hero__actions">
          <button type="button" className="dash-start" onClick={onStartOsmos}>
            Start Osmos
          </button>
          <p className="meta dash-hero__hint">
            {systemReady
              ? 'All systems ready — Smart assist listens and suggests answers in the overlay.'
              : 'Check system status below, then start your session. Web search works with no setup (DuckDuckGo); add Tavily for stronger results.'}
          </p>
          <div className="dash-hero__badges">
            <span className={`status-pill${systemReady ? ' status-pill--ok' : ''}`}>
              <span className="status-dot" /> {systemReady ? 'Ready' : 'Setup needed'}
            </span>
            <span className="status-pill">{liveCount} live</span>
            <span className="status-pill">v{info?.version ?? '…'}</span>
          </div>
          {info?.shortcutsRegistered === false ? (
            <p className="meta dash-hero__hint">
              Global hotkeys unavailable (common on Wayland). Use in-app controls or the overlay menu.
            </p>
          ) : null}
        </div>
      </section>

      <section className="dash-card dash-card--profile dash-card--profile-hero">
        <div className="dash-card__head">
          <h2>Profile</h2>
          <button type="button" className="dash-link" onClick={() => openProfile()}>
            Customize
          </button>
        </div>
        <div className="dash-profile">
          <div className="dash-profile__active">
            <strong className="dash-profile__name">{activeProfile.label || 'Default'}</strong>
            <span className="meta">
              {modeLabel(activeProfile.preferredMode || activeMode)}
              {activeProfile.displayName ? ` · ${activeProfile.displayName}` : ''}
            </span>
            <div className="dash-profile__tags">
              <span className={`dash-tag${summary.hasResume ? ' dash-tag--on' : ''}`}>
                {summary.hasResume ? 'Résumé' : 'No résumé'}
              </span>
              <span className={`dash-tag${summary.hasJd ? ' dash-tag--on' : ''}`}>
                {summary.hasJd ? 'JD' : 'No JD'}
              </span>
              <span className={`dash-tag${summary.hasCompany ? ' dash-tag--on' : ''}`}>
                {summary.hasCompany ? 'Company' : 'No company'}
              </span>
              <span className={`dash-tag${summary.docCount ? ' dash-tag--on' : ''}`}>
                {summary.docCount ? `${summary.docCount} docs` : 'Docs'}
              </span>
              <span className={`dash-tag${summary.questionCount ? ' dash-tag--on' : ''}`}>
                {summary.questionCount ? `${summary.questionCount} Qs` : 'Questions'}
              </span>
            </div>
          </div>
          <div className="dash-profile__list">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`dash-profile__item${p.id === activeProfile.id ? ' dash-profile__item--active' : ''}`}
                onClick={() => void switchProfile(p.id)}
              >
                {p.label || p.displayName || 'Untitled'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="dash-status">
        <div className="dash-status__head">
          <h2>System status</h2>
          <button type="button" className="dash-link" disabled={probing} onClick={() => void runProbes()}>
            {probing ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        <div className="dash-status__grid">
          {statusItems.map((item) => (
            <div key={item.label} className={`dash-status__item dash-status__item--${item.status}`}>
              <span className="dash-status__label">
                <span className={`dash-status__dot dash-status__dot--${item.status}`} aria-hidden />
                {item.label}
              </span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </section>

      <div className="dash-grid">
        <section className="dash-card dash-card--modes">
          <div className="dash-card__head">
            <h2>Copilot mode</h2>
            <button type="button" className="dash-link" onClick={() => openProfile('basics')}>
              Edit profile
            </button>
          </div>
          <p className="meta dash-card__sub">{mode.blurb}</p>
          <div className="dash-mode-grid">
            {MODE_DEFS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`dash-mode${activeMode === m.id ? ' dash-mode--active' : ''}`}
                onClick={() => void setMode(m.id)}
              >
                <span className="dash-mode__name">{m.name}</span>
                <span className="dash-mode__blurb">{m.blurb.split('.')[0]}.</span>
              </button>
            ))}
          </div>
        </section>

        <section className="dash-card dash-card--sessions">
          <div className="dash-card__head">
            <h2>Recent sessions</h2>
            <button type="button" className="dash-link" onClick={() => onSwitchTab('history')}>
              View all
            </button>
          </div>
          {sessions.length === 0 ? (
            <p className="meta dash-empty">No sessions yet. Start Osmos to begin your first run.</p>
          ) : (
            <ul className="dash-session-list">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button type="button" className="dash-session" onClick={() => onSwitchTab('history')}>
                    <span className="dash-session__mode">{s.mode || 'general'}</span>
                    <span className="dash-session__meta">
                      {s.messages.length} messages · {relativeTime(s.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="dash-card dash-card--prep">
          <div className="dash-card__head">
            <h2>Interview prep</h2>
            <span className="status-pill">{prepDone}/{prep.length} ready</span>
          </div>
          <ul className="dash-prep-list">
            {prep.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="dash-prep"
                  onClick={() => {
                    if (item.section) openProfile(item.section);
                    else if ('tab' in item && item.tab) onSwitchTab(item.tab);
                  }}
                >
                  <span className={`dash-prep__check${item.done ? ' dash-prep__check--done' : ''}`} aria-hidden>
                    {item.done ? '✓' : '○'}
                  </span>
                  <span className="dash-prep__label">{item.label}</span>
                  {item.detail ? <span className="dash-prep__detail meta">{item.detail}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="dash-card dash-card--actions">
          <div className="dash-card__head">
            <h2>Quick actions</h2>
          </div>
          <div className="dash-action-grid">
            {quickActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="dash-action"
                onClick={() => onSwitchTab(action.id)}
              >
                <span className="dash-action__icon" aria-hidden>{action.icon}</span>
                <strong>{action.label}</strong>
                <span className="meta">{action.desc}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
