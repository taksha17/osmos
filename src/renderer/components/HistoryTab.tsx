import { useEffect, useState } from 'react';

type Session = {
  id: string;
  mode: string;
  messages: Array<{ role: string; content: string; createdAt: number }>;
  createdAt: number;
  updatedAt: number;
};

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

  if (loading) return <section className="panel"><h2>Sessions</h2><p>Loading…</p></section>;
  // Only a failed *load* replaces the view; export/delete problems are notices,
  // otherwise one failed export would hide every session until remount.
  if (error) return <section className="panel"><h2>Sessions</h2><div className="error">{error}</div></section>;

  return (
    <section className="panel">
      <h2>Sessions</h2>
      <p>Past chat sessions stored locally. Select a session to review its messages.</p>
      {notice && <p className="meta">{notice}</p>}
      {sessions.length === 0 && <p className="meta">No sessions yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
        {sessions.map((s) => {
          const expanded = expandedId === s.id;
          const firstUser = s.messages.find((m) => m.role === 'user' && m.content.trim());
          const preview = firstUser
            ? firstUser.content.replace(/\s+/g, ' ').slice(0, 90)
            : `${s.messages.length} messages`;
          return (
            <li key={s.id} style={{ marginBottom: 12, border: '1px solid var(--line)', borderRadius: 12, padding: 12 }}>
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : s.id)}
                style={{
                  // Reset without `all:unset`, which also removes the focus ring
                  // keyboard users need to see where they are.
                  display: 'block',
                  width: '100%',
                  background: 'none',
                  border: 0,
                  padding: 0,
                  margin: 0,
                  color: 'inherit',
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
                aria-expanded={expanded}
              >
                <strong>{s.mode || 'chat'} · {new Date(s.createdAt).toLocaleString()}</strong>
                <div className="meta">{s.messages.length} messages · {preview}</div>
              </button>
              {expanded && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflow: 'auto' }}>
                  {s.messages.map((m, i) => (
                    <div key={i} className={`bubble ${m.role}`} style={{ fontSize: '0.84rem' }}>
                      {m.content.slice(0, 2000)}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setExpandedId(expanded ? null : s.id)}>
                  {expanded ? 'Collapse' : 'Review'}
                </button>
                <button type="button" onClick={() => void exportReport(s.id)}>Export report</button>{' '}
                <button type="button" onClick={() => void remove(s.id)}>Delete</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
