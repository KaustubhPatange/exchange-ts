import { useState } from 'react';
import { cancelOrder, baseUnitsToPrice, baseUnitsToQty } from '../api';
import type { AppState } from '../store';

export function OpenOrders({
  state,
  onAfterCancel,
}: {
  state: AppState;
  onAfterCancel: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const onCancel = async (orderId: string) => {
    setBusy(orderId);
    try {
      await cancelOrder(state.apiKey, orderId);
    } finally {
      setBusy(null);
      onAfterCancel();
    }
  };

  const rows = [...state.openOrders].sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="panel orders">
      <h3>
        Open orders <span style={{ color: 'var(--muted)' }}>· {state.userId} · {rows.length}</span>
      </h3>
      <div className="body">
        {rows.length === 0 ? (
          <div className="empty">No resting orders.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <td>Side</td>
                <td>Type</td>
                <td className="num">Price</td>
                <td className="num">Remaining</td>
                <td></td>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.orderId}>
                  <td className={o.side}>{o.side.toUpperCase()}</td>
                  <td>{o.type}</td>
                  <td className="num">{baseUnitsToPrice(o.price).toFixed(2)}</td>
                  <td className="num">
                    {baseUnitsToQty(o.remaining).toFixed(5)}
                    {o.remaining !== o.qty && (
                      <span style={{ color: 'var(--muted)' }}> / {baseUnitsToQty(o.qty).toFixed(5)}</span>
                    )}
                  </td>
                  <td className="num">
                    <button
                      disabled={busy === o.orderId}
                      onClick={() => void onCancel(o.orderId)}
                    >
                      {busy === o.orderId ? '…' : 'Cancel'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
