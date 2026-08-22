import { useEffect, useRef, useState } from 'react';

export type TranscriptEntry = {
  id: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
};

type Props = {
  entries: TranscriptEntry[];
};

export function TranscriptTimeline({ entries }: Props) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, autoScroll]);

  return (
    <div className="transcript-timeline">
      <div className="transcript-header">
        <strong>Transcript</strong>
        <label className="meta">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />{' '}
          Auto-scroll
        </label>
      </div>
      <div className="transcript-list">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={`transcript-entry ${entry.isFinal ? 'final' : 'partial'}`}
          >
            <span className="transcript-time">
              {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span className="transcript-text">{entry.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
