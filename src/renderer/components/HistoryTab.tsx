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

  useEffect(() => {
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
  };

  if (loading) return <section className="panel"><h2>Sessions</h2><p>Loading…</p></section>;
  if (error) return <section className="panel"><h2>Sessions</h2><div className="error">{error}</div></section>;

  return (
    <section className="panel">
      <h2>Sessions</h2>
      <p>Past chat sessions stored locally.</p>
      {sessions.length === 0 && <p className="meta">No sessions yet.</p>}
      <ul>
        {sessions.map((s) => (
          <li key={s.id} style={{ marginBottom: 12 }}>
            <strong>{s.mode || 'chat'} · {new Date(s.createdAt).toLocaleString()}</strong>
            <div className="meta">{s.messages.length} messages</div>
            <button onClick={() => remove(s.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
