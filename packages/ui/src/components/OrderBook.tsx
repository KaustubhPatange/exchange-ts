import { formatPrice, formatQty } from '../api';
import type { AppState } from '../store';

const ROWS = 12;

export function OrderBook({ state }: { state: AppState }) {
  const asks = [...state.book.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, ROWS);
  const bids = [...state.book.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, ROWS);
  const maxQty = Math.max(
    1e-9,
    ...asks.map(([, q]) => q),
    ...bids.map(([, q]) => q)
  );
  const bestAsk = asks[0]?.[0] ?? null;
  const bestBid = bids[0]?.[0] ?? null;
  const spread = bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null;
  return (
    <div className="panel book">
      <h3>Order book</h3>
      <div className="body">
        <table>
          <tbody>
            {asks.slice().reverse().map(([price, qty]) => (
              <tr key={`a${price}`}>
                <td className="price ask">{formatPrice(price)}</td>
                <td className="qty">{formatQty(qty, 5)}</td>
                <td style={{ width: 0, position: 'relative' }}>
                  <div className="depth-bar ask-bar" style={{ width: `${(qty / maxQty) * 80}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="spread">
          {bestAsk !== null && bestBid !== null
            ? `spread ${formatPrice(spread!)} · ${((spread! / ((bestAsk + bestBid) / 2)) * 10000).toFixed(1)} bps`
            : 'spread —'}
        </div>
        <table>
          <tbody>
            {bids.map(([price, qty]) => (
              <tr key={`b${price}`}>
                <td className="price bid">{formatPrice(price)}</td>
                <td className="qty">{formatQty(qty, 5)}</td>
                <td style={{ width: 0, position: 'relative' }}>
                  <div className="depth-bar bid-bar" style={{ width: `${(qty / maxQty) * 80}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
