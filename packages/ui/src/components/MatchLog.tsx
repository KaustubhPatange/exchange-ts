import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../store';

export function MatchLog({ state }: { state: AppState }) {
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  // store.log is newest-first; display chronologically so "end" is the bottom.
  const entries = [...state.log].reverse();

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [state.log, autoScroll]);

  return (
    <div className="panel log">
      <h3>
        Engine event stream
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, textTransform: 'none', letterSpacing: 0, color: 'var(--text)', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ width: 'auto', margin: 0 }}
          />
          auto-scroll
        </label>
      </h3>
      <div className="body" ref={bodyRef}>
        {entries.length === 0 && <div style={{ color: 'var(--muted)' }}>waiting for events…</div>}
        {entries.map((e, i) => (
          <div key={i} className={`entry ${e.kind}`}>
            <span style={{ color: 'var(--muted)' }}>{new Date(e.ts).toLocaleTimeString()} </span>
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}
