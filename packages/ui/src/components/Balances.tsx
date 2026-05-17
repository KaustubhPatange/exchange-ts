import type { AppState } from '../store';

function fmt(s: string | undefined, decimals: number): string {
  if (!s) return '—';
  const n = Number(BigInt(s)) / 10 ** decimals;
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function Balances({ state }: { state: AppState }) {
  const b = state.balances;
  return (
    <div className="panel balances">
      <h3>Balances <span style={{ color: 'var(--muted)' }}>· {state.userId}</span></h3>
      <div className="body">
        <table>
          <thead>
            <tr>
              <td className="asset">Asset</td>
              <td className="num">Free</td>
              <td className="num">Locked</td>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="asset">BTC</td>
              <td className="num">{fmt(b?.BTC.free, 8)}</td>
              <td className="num">{fmt(b?.BTC.locked, 8)}</td>
            </tr>
            <tr>
              <td className="asset">USDC</td>
              <td className="num">{fmt(b?.USDC.free, 6)}</td>
              <td className="num">{fmt(b?.USDC.locked, 6)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
