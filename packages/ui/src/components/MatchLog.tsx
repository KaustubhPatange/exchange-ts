import type { AppState } from '../store';

export function MatchLog({ state }: { state: AppState }) {
  return (
    <div className="panel log">
      <h3>Engine event stream</h3>
      <div className="body">
        {state.log.length === 0 && <div style={{ color: 'var(--muted)' }}>waiting for events…</div>}
        {state.log.map((e, i) => (
          <div key={i} className={`entry ${e.kind}`}>
            <span style={{ color: 'var(--muted)' }}>{new Date(e.ts).toLocaleTimeString()} </span>
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}
