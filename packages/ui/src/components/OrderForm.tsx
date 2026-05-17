import { useState } from 'react';
import { placeOrder } from '../api';
import type { AppState } from '../store';
import { USERS } from '../store';

export function OrderForm({ state, onUserChange }: { state: AppState; onUserChange: (apiKey: string, userId: string) => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'LIMIT' | 'POST_ONLY' | 'IOC' | 'FOK'>('LIMIT');
  const [price, setPrice] = useState<string>('');
  const [qty, setQty] = useState<string>('0.01');
  const [feedback, setFeedback] = useState<string>('');

  const bestBid = [...state.book.bids.keys()].sort((a, b) => b - a)[0] ?? null;
  const bestAsk = [...state.book.asks.keys()].sort((a, b) => a - b)[0] ?? null;
  const suggestedPrice = side === 'buy'
    ? bestAsk ?? bestBid ?? null
    : bestBid ?? bestAsk ?? null;

  const submit = async (overrides?: { type?: 'IOC' }) => {
    setFeedback('placing…');
    try {
      const t = overrides?.type ?? type;
      const p = t === 'IOC' && side === 'buy' && bestAsk
        ? (bestAsk * 1.05).toFixed(2)
        : price;
      const result = await placeOrder(state.apiKey, {
        symbol: 'BTC-USDC',
        side,
        type: t,
        price: p || undefined,
        qty,
      }) as { events?: { kind: string; reason?: string }[]; error?: string };
      if (result.error) {
        setFeedback(`error: ${result.error}`);
        return;
      }
      const last = result.events?.[result.events.length - 1];
      setFeedback(`${result.events?.length ?? 0} events — last: ${last?.kind ?? 'n/a'}${last?.reason ? `(${last.reason})` : ''}`);
    } catch (err) {
      setFeedback((err as Error).message);
    }
  };

  return (
    <div className="panel form">
      <h3>
        Place order
        <select value={state.apiKey} onChange={(e) => {
          const u = USERS.find(u => u.apiKey === e.target.value)!;
          onUserChange(u.apiKey, u.userId);
        }} style={{ width: 'auto', padding: '2px 6px' }}>
          {USERS.map(u => <option key={u.apiKey} value={u.apiKey}>{u.userId}</option>)}
        </select>
      </h3>
      <div className="body">
        <div className="side-tabs">
          <button className={side === 'buy' ? 'buy' : ''} onClick={() => setSide('buy')}>BUY</button>
          <button className={side === 'sell' ? 'sell' : ''} onClick={() => setSide('sell')}>SELL</button>
        </div>
        <div className="field">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option>LIMIT</option>
            <option>POST_ONLY</option>
            <option>IOC</option>
            <option>FOK</option>
          </select>
        </div>
        <div className="field">
          <label>Price (USDC)</label>
          <div className="row">
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder={suggestedPrice ? suggestedPrice.toFixed(2) : ''} />
            <button onClick={() => suggestedPrice && setPrice(suggestedPrice.toFixed(2))} style={{ flexShrink: 0 }}>mid</button>
          </div>
        </div>
        <div className="field">
          <label>Quantity (BTC)</label>
          <input value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        <button className={side} onClick={() => void submit()}>
          {side === 'buy' ? 'Place BUY' : 'Place SELL'}
        </button>
        <button onClick={() => void submit({ type: 'IOC' })} style={{ marginTop: -4 }}>
          Market {side === 'buy' ? 'BUY' : 'SELL'} (IOC w/ 5% slip cap)
        </button>
        {feedback && <div className="help">{feedback}</div>}
      </div>
    </div>
  );
}
