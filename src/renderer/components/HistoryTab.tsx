import { useEffect, useState } from 'react';
import { Icon } from './Icon';

type Session = {
  id: string;
  mode: string;
  messages: Array<{ role: string; content: string; createdAt: number }>;
  createdAt: number;
  updatedAt: number;
};

function sessionTitle(s: Session): string {
  const firstUser = s.messages.find((m) => m.role === 'user' && m.content.trim());
  if (firstUser) {
    const text = firstUser.content.replace(/\s+/g, ' ').trim();
    return text.length > 86 ? `${text.slice(0, 83)}…` : text;
  }
  const mode = (s.mode || 'chat').replace(/^\w/, (c) => c.toUpperCase());
  return `${mode} session`;
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function HistoryTab() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const focus = sessionStorage.getItem('osmos-history-focus');
      if (focus) {
        setExpandedId(focus);
        sessionStorage.removeItem('osmos-history-focus');
      }
    } catch {
      /* ignore */
    }
    void (async () => {
      try {
        const res = await window.osmos.listHistory();
        if (res.ok && res.sessions) {
          setSessions(res.sessions);
        } else {
          setError(res.error || 'Failed to load sessions');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const remove = async (id: string) => {
    const res = await window.osmos.deleteHistory(id);
    if (res.ok && res.sessions) setSessions(res.sessions);
    else setNotice(res.error || 'Could not delete that session');
    if (expandedId === id) setExpandedId(null);
  };

  // Phase 5: the report is written locally as markdown — no provider, no network.
  const exportReport = async (id: string) => {
    const res = await window.osmos.exportSessionReport(id);
    if (res.cancelled) return;
    setNotice(res.ok ? `Saved ${res.summary ?? 'report'} → ${res.path}` : res.error || 'Export failed');
  };

  return (
    <section className="history">
      <header className="history__head">
        <div>
          <p className="history__eyebrow">Local library</p>
          <h1>Sessions</h1>
          <p className="history__lede">
            Every conversation, transcript, and answer — stored on this machine and nowhere else.
          </p>
        </div>
        {!loading && !error ? (
          <span className="history__count">
            {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
          </span>
        ) : null}
      </header>

      {loading ? (
        <div className="history-empty">
          <Icon name="history" size={22} />
          <p>Loading your sessions…</p>
        </div>
      ) : error ? (
        <div className="history-empty history-empty--error">
          <Icon name="info" size={22} />
          <p>{error}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="history-empty">
          <span className="history-empty__icon"><Icon name="history" size={24} /></span>
          <p>No sessions yet</p>
          <span className="meta">Start Osmos during a call — the transcript and recap will land here.</span>
        </div>
      ) : (
        <ul className="history-list">
          {sessions.map((s) => {
            const expanded = expandedId === s.id;
            return (
              <li key={s.id} className={`history-card${expanded ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="history-card__head"
                  onClick={() => setExpandedId(expanded ? null : s.id)}
                  aria-expanded={expanded}
                >
                  <span className="history-card__title">
                    <span className="history-card__topline">
                      <span className="history-card__mode">{s.mode || 'chat'}</span>
                      <span className="history-card__when">{formatWhen(s.updatedAt)}</span>
                    </span>
                    <strong>{sessionTitle(s)}</strong>
                    <span className="history-card__meta">
                      {s.messages.length} {s.messages.length === 1 ? 'message' : 'messages'}
                    </span>
                  </span>
                  <span className={`history-card__chevron${expanded ? ' is-open' : ''}`}>
                    <Icon name="chevron-down" size={17} />
                  </span>
                </button>

                {expanded ? (
                  <div className="history-messages">
                    {s.messages.map((m, i) => (
                      <div key={i} className={`bubble ${m.role}`}>
                        {m.content.slice(0, 2000)}
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="history-card__actions">
                  <button type="button" className="history-action" onClick={() => setExpandedId(expanded ? null : s.id)}>
                    <Icon name="message" size={14} /> {expanded ? 'Collapse' : 'Review'}
                  </button>
                  <button type="button" className="history-action" onClick={() => void exportReport(s.id)}>
                    <Icon name="download" size={14} /> Export report
                  </button>
                  <button type="button" className="history-action history-action--danger" onClick={() => void remove(s.id)}>
                    <Icon name="trash" size={14} /> Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {notice ? <div className="history-notice">{notice}</div> : null}
    </section>
  );
}
