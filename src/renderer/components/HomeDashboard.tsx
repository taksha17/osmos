import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { activeSavedProfile, profileSummary } from '@shared/profiles';
import { DEFAULT_SAVED_PROFILE } from '@shared/types';

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
  const summary = profileSummary(activeProfile);
  const undetectable = Boolean(settings?.stealthEnabled);
  const version = info?.version || '0.5.1';

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
    void window.osmos.openExternal('https://github.com/sponsors/taksha17').catch(() => {
      void window.osmos.openExternal('https://github.com/taksha17/osmos');
    });
  };

  return (
    <div className="home-dashboard">
      <header className="home-topbar">
        <div className="home-topbar__spacer" />
        <label className="home-search">
          <span className="home-search__icon" aria-hidden>
            ⌕
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or ask anything..."
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
            ⌾
          </button>
          <div className="home-apps">
            <button
              type="button"
              className="home-icon-btn"
              title="Apps"
              aria-label="Apps"
              onClick={() => setAppsOpen((v) => !v)}
            >
              ▦
            </button>
            {appsOpen ? (
              <div className="home-apps__menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setAppsOpen(false); onSwitchTab('chat'); }}>
                  Chat
                </button>
                <button type="button" role="menuitem" onClick={() => { setAppsOpen(false); onSwitchTab('history'); }}>
                  Sessions
                </button>
                <button type="button" role="menuitem" onClick={() => { setAppsOpen(false); onSwitchTab('roadmap'); }}>
                  Roadmap
                </button>
                <button type="button" role="menuitem" onClick={() => { setAppsOpen(false); onOpenProfile(); }}>
                  Profile
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
            ⚙
          </button>
        </div>
      </header>

      <div className="home-head">
        <div className="home-head__left">
          <div className="home-head__title-row">
            <h1 className="home-title">My Osmos</h1>
            <button
              type="button"
              className="home-icon-btn home-icon-btn--soft"
              title="Refresh"
              aria-label="Refresh"
              disabled={refreshing}
              onClick={() => void loadSessions()}
            >
              ↻
            </button>
            <button
              type="button"
              className={`home-detect${undetectable ? ' home-detect--on' : ''}`}
              onClick={() => void toggleUndetectable()}
              title="Stealth / undetectable overlay"
            >
              <span className="home-detect__ghost" aria-hidden>
                ◌
              </span>
              <span>Undetectable</span>
              <span className={`home-switch${undetectable ? ' home-switch--on' : ''}`} aria-hidden>
                <span className="home-switch__knob" />
              </span>
            </button>
            <button
              type="button"
              className="home-whatsnew"
              onClick={() => onSwitchTab('roadmap')}
            >
              What&apos;s New in {version.split('.').slice(0, 2).join('.')} ↗
            </button>
          </div>
        </div>
        <button type="button" className="home-start" onClick={onStartOsmos}>
          <span className="home-start__mark" aria-hidden>
            ⌀
          </span>
          Start Osmos
        </button>
      </div>

      <div className="home-bento">
        <article className="home-promo home-promo--fund">
          <div className="home-promo__copy">
            <h2>Support development</h2>
            <p>Built openly and sustained by users</p>
            <ul>
              <li>Development driven by real users</li>
              <li>Faster iteration without subscription lock-in</li>
              <li>MIT-licensed desktop copilot you control</li>
            </ul>
          </div>
          <button type="button" className="home-promo__cta home-promo__cta--gold" onClick={openGithub}>
            <span aria-hidden>🚀</span> Fund development
          </button>
        </article>

        <article className="home-promo home-promo--prep">
          <div className="home-promo__copy">
            <h2>Link your calendar to see upcoming events</h2>
          </div>
          <button
            type="button"
            className="home-promo__cta home-promo__cta--ghost"
            onClick={onOpenProfile}
          >
            <span className="home-promo__g" aria-hidden>
              G
            </span>
            Connect calendar →
          </button>
          <div className="home-promo__event" aria-hidden>
            <div className="home-promo__event-card">
              <strong>
                {activeProfile.companyName || summary.hasJd
                  ? activeProfile.companyName || 'Interview prep'
                  : 'Q2 Product Roadmap Review'}
              </strong>
              <div className="home-promo__event-meta">
                <span>4:30 PM</span>
                <span className="home-promo__avatars">
                  <i /><i />
                </span>
              </div>
            </div>
          </div>
        </article>
      </div>

      <section className="home-sessions">
        {grouped.length === 0 ? (
          <div className="home-sessions__empty">
            <p>No sessions yet</p>
            <span className="meta">Start Osmos during a call — history shows up here.</span>
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
                      onClick={() => onSwitchTab('history')}
                    >
                      <span className="home-session-row__title">{sessionTitle(s)}</span>
                      <span className="home-session-row__meta">
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
