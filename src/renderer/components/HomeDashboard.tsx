import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { activeSavedProfile } from '@shared/profiles';
import { resolveAgent } from '@shared/agents';
import { DEFAULT_SAVED_PROFILE } from '@shared/types';
import startOsmosIcon from '@resources/Start_Osmos_64.png';
import { Icon } from './Icon';

type Session = {
  id: string;
  mode: string;
  messages: Array<{ role: string; content: string; createdAt: number }>;
  createdAt: number;
  updatedAt: number;
};

type Tab = 'home' | 'chat' | 'history' | 'profile' | 'settings';

type Info = {
  name: string;
  version: string;
  platformName: string;
  shortcutsRegistered?: boolean;
};

type Props = {
  settings: AppSettings | null;
  info: Info | null;
  liveCount: number;
  onStartOsmos: () => void;
  onSwitchTab: (tab: Tab) => void;
  onSettingsChange: (next: AppSettings) => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
};

function sessionTitle(s: Session): string {
  const firstUser = s.messages.find((m) => m.role === 'user' && m.content.trim());
  if (firstUser) {
    const t = firstUser.content.replace(/\s+/g, ' ').trim();
    return t.length > 64 ? `${t.slice(0, 61)}…` : t;
  }
  const mode = (s.mode || 'general').replace(/^\w/, (c) => c.toUpperCase());
  return `${mode} session`;
}

function formatClock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

function formatDuration(s: Session) {
  const times = s.messages.map((m) => m.createdAt).filter(Boolean);
  if (times.length >= 2) {
    const ms = Math.max(...times) - Math.min(...times);
    const totalSec = Math.max(1, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  const n = s.messages.length;
  if (n <= 1) return '00:01';
  const est = Math.min(99, Math.max(1, n * 2));
  return `00:${String(est).padStart(2, '0')}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86_400_000;
  if (d.getTime() >= startToday) return 'Today';
  if (d.getTime() >= startYesterday) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function HomeDashboard({
  settings,
  info,
  liveCount: _liveCount,
  onStartOsmos,
  onSwitchTab,
  onSettingsChange,
  onOpenProfile,
  onOpenSettings,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);

  const loadSessions = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await window.osmos.listHistory();
      if (res.ok && res.sessions) {
        setSessions([...res.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40));
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const profiles = settings?.profiles?.length
    ? settings.profiles
    : settings
      ? [{ ...DEFAULT_SAVED_PROFILE, ...settings.profile, id: 'default', label: 'Default' }]
      : [];
  const activeProfile = activeSavedProfile(profiles, settings?.activeProfileId);
  const undetectable = Boolean(settings?.stealthEnabled);
  const version = info?.version || '';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const title = sessionTitle(s).toLowerCase();
      return title.includes(q) || (s.mode || '').toLowerCase().includes(q);
    });
  }, [sessions, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of filtered) {
      const label = dayLabel(s.updatedAt);
      const list = map.get(label) || [];
      list.push(s);
      map.set(label, list);
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }));
  }, [filtered]);

  const toggleUndetectable = async () => {
    if (!settings) return;
    const next = await window.osmos.updateSettings({ stealthEnabled: !undetectable });
    onSettingsChange(next);
  };

  const openGithub = () => {
    void window.osmos.openExternal('https://github.com/taksha17/osmos');
  };

  return (
    <div className="home-dashboard">
      <header className="home-topbar">
        <div className="home-brand" aria-label="OSMOS">
          <span className="home-brand__mark">
            <img src={startOsmosIcon} alt="" width={34} height={34} />
          </span>
          <span className="home-brand__wordmark">OSMOS</span>
          <span className="home-brand__tag">AI copilot</span>
        </div>
        <label className="home-search">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            aria-label="Search sessions"
          />
        </label>
        <div className="home-topbar__actions">
          <button
            type="button"
            className="home-icon-btn"
            title="Profile"
            aria-label="Profile"
            onClick={onOpenProfile}
          >
            <Icon name="user" size={18} />
          </button>
          <div className="home-apps">
            <button
              type="button"
              className="home-icon-btn"
              title="Apps"
              aria-label="Apps"
              onClick={() => setAppsOpen((v) => !v)}
            >
              <Icon name="grid" size={17} />
            </button>
            {appsOpen ? (
              <div className="home-apps__menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setAppsOpen(false); onSwitchTab('chat'); }}>
                  <Icon name="message" size={15} /> Chat
                </button>
                <button type="button" role="menuitem" onClick={() => { setAppsOpen(false); onSwitchTab('history'); }}>
                  <Icon name="history" size={15} /> Sessions
                </button>
                <button type="button" role="menuitem" onClick={() => { setAppsOpen(false); onOpenProfile(); }}>
                  <Icon name="user" size={15} /> Profile
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="home-icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <Icon name="sliders" size={18} />
          </button>
        </div>
      </header>

      <div className="home-head">
        <div className="home-head__left">
          <p className="home-eyebrow">Workspace</p>
          <div className="home-head__title-row">
            <h1 className="home-title">My Osmos</h1>
            {(() => {
              const agent = resolveAgent(activeProfile, settings);
              const agentName = agent.displayName?.trim();
              const profileLabel = activeProfile.label?.trim();
              if (agentName && agentName !== profileLabel) {
                return (
                  <span className="home-agent-badge" title={`Agent: ${agentName}`}>
                    <Icon name="sparkles" size={13} />
                    {agentName}
                  </span>
                );
              }
              return null;
            })()}
          </div>
          <p className="home-subtitle">
            A calmer place to prepare, listen, and answer — all without leaving the conversation.
          </p>
        </div>
        <div className="home-head__actions">
          <button
            type="button"
            className={`home-detect${undetectable ? ' home-detect--on' : ''}`}
            onClick={() => void toggleUndetectable()}
            title="Low-profile mode"
          >
            <Icon name="shield" size={15} />
            <span>Low-profile</span>
            <span className={`home-switch${undetectable ? ' home-switch--on' : ''}`} aria-hidden>
              <span className="home-switch__knob" />
            </span>
          </button>
          <button
            type="button"
            className="home-whatsnew"
            onClick={() => window.osmos.openExternal('https://github.com/taksha17/osmos/releases')}
          >
            {version ? `v${version}` : 'Updates'}
            <Icon name="arrow-up-right" size={14} />
          </button>
          <button type="button" className="home-start" onClick={onStartOsmos}>
            <span className="home-start__mark" aria-hidden>
              <img
                src={startOsmosIcon}
                alt=""
                width={28}
                height={28}
                style={{ display: 'block', margin: 'auto' }}
              />
            </span>
            Start Osmos
          </button>
        </div>
      </div>

      <div className="home-bento">
        <article className="home-promo home-promo--prep">
          <div className="home-promo__top">
            <span className="home-promo__eyebrow">Interview prep</span>
            <span className="home-promo__status">
              <span className="home-promo__dot" />
              {activeProfile.resumeText?.trim() ? 'Profile ready' : 'Add your context'}
            </span>
          </div>
          <div className="home-promo__copy">
            <h2>
              {activeProfile.companyName?.trim()
                ? `Prepared for ${activeProfile.companyName.trim()}`
                : 'Walk in prepared, not scripted.'}
            </h2>
            <p>
              {activeProfile.label?.trim() && activeProfile.label.trim().toLowerCase() !== 'default'
                ? `${activeProfile.label.trim()} — answers grounded in your own experience, not generic advice.`
                : 'Answers grounded in your own experience, not generic advice. Add a résumé, job description, or company intel to sharpen them.'}
            </p>
            <div className="home-promo__tags">
              <span className={activeProfile.resumeText?.trim() ? 'is-ready' : ''}>
                {activeProfile.resumeText?.trim() ? 'Résumé attached' : 'Résumé missing'}
              </span>
              <span className={activeProfile.jdText?.trim() ? 'is-ready' : ''}>
                {activeProfile.jdText?.trim() ? 'Job description' : 'No job description'}
              </span>
              {activeProfile.companyIntel?.trim() ? <span className="is-ready">Company intel</span> : null}
            </div>
          </div>
          <button type="button" className="home-promo__cta home-promo__cta--ink" onClick={onOpenProfile}>
            Open interview prep <Icon name="arrow-right" size={15} />
          </button>
        </article>

        <article className="home-promo home-promo--fund">
          <div className="home-promo__top">
            <span className="home-promo__eyebrow">Open source</span>
            <Icon name="github" size={19} />
          </div>
          <div className="home-promo__copy">
            <h2>Built in the open.<br />Owned by you.</h2>
            <p>MIT licensed, local-first, and built in public. Inspect every line or ship your own build.</p>
            <div className="home-promo__stats">
              <span>MIT</span>
              <span>Local-first</span>
              <span>3 platforms</span>
            </div>
          </div>
          <button type="button" className="home-promo__cta home-promo__cta--paper" onClick={openGithub}>
            <Icon name="star" size={15} /> Star on GitHub <Icon name="arrow-up-right" size={14} />
          </button>
        </article>
      </div>

      <section className="home-sessions">
        <div className="home-sessions__head">
          <div>
            <h2>Recent sessions</h2>
            <span>{sessions.length ? `${sessions.length} saved locally` : 'Your call history, kept private'}</span>
          </div>
          <button
            type="button"
            className="home-icon-btn home-icon-btn--soft"
            title="Refresh"
            aria-label="Refresh"
            disabled={refreshing}
            onClick={() => void loadSessions()}
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
        {grouped.length === 0 ? (
          <div className="home-sessions__empty">
            <span className="home-sessions__empty-icon">
              <Icon name="history" size={21} />
            </span>
            <p>No sessions yet</p>
            <span className="meta">Start Osmos during a call — a clean transcript and recap will appear here.</span>
          </div>
        ) : (
          grouped.map((group) => (
            <div key={group.label} className="home-session-group">
              <h3 className="home-session-group__label">{group.label}</h3>
              <ul className="home-session-list">
                {group.items.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="home-session-row"
                      title={sessionTitle(s)}
                      onClick={() => {
                        try {
                          sessionStorage.setItem('osmos-history-focus', s.id);
                        } catch {
                          /* ignore */
                        }
                        onSwitchTab('history');
                      }}
                    >
                      <span className="home-session-row__title">{sessionTitle(s)}</span>
                      <span className="home-session-row__meta">
                        <span className="home-session-row__mode">{s.mode || 'session'}</span>
                        <span className="home-session-row__dur">{formatDuration(s)}</span>
                        <span className="home-session-row__time">{formatClock(s.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
