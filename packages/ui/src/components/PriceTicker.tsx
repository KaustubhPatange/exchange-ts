import { baseUnitsToPrice, formatPrice, formatQty, baseUnitsToQty } from '../api';
import type { AppState } from '../store';

export function PriceTicker({ state }: { state: AppState }) {
  const t = state.ticker;
  const last = t?.lastPrice ? baseUnitsToPrice(t.lastPrice) : null;
  const change = t?.changePct24h ?? '0';
  const prev = state.prevLastPrice;
  const dir = last !== null && prev !== null
    ? last > prev ? 'up' : last < prev ? 'down' : ''
    : '';
  return (
    <div className={`panel ticker ${dir}`}>
      <div className="row">
        <div>
          <div className="meta">BTC-USDC · spot</div>
          <div className="price">{last !== null ? formatPrice(last) : '—'}</div>
        </div>
        <div className="right">
          <div className="meta">24h change</div>
          <div style={{ color: change.startsWith('-') ? 'var(--sell)' : 'var(--buy)', fontWeight: 600 }}>
            {change}%
          </div>
          <div className="meta" style={{ marginTop: 4 }}>
            24h vol {t ? formatQty(baseUnitsToQty(t.volume24h), 3) : '—'} BTC
          </div>
        </div>
      </div>
    </div>
  );
}
