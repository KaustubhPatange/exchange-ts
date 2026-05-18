import { baseUnitsToPrice, baseUnitsToQty, formatPrice, formatQty } from '../api';
import type { AppState } from '../store';

export function TradeTape({ state }: { state: AppState }) {
  const recent = [...state.trades].reverse().slice(0, 30);
  return (
    <div className="panel tape-panel">
      <h3>Recent trades</h3>
      <div className="body">
        <table className="tape">
          <tbody>
            {recent.map((t) => {
              const p = baseUnitsToPrice(t.price);
              const q = baseUnitsToQty(t.qty);
              const time = new Date(t.ts).toLocaleTimeString();
              return (
                <tr key={t.tradeId}>
                  <td className={`price ${t.aggressor}`}>{formatPrice(p)}</td>
                  <td className="qty">{formatQty(q, 5)}</td>
                  <td className="time">{time}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
