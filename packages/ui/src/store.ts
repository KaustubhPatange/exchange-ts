import { useEffect, useReducer } from 'react';
import {
  WS_URL,
  baseUnitsToPrice, baseUnitsToQty,
  getCandles, getSnapshot, getTicker, getTrades, getBalances,
  type Candle, type Trade, type Ticker, type Balances, type Snapshot,
} from './api';

/**
 * Local app state. We track:
 *   - top-of-book derived from the L2 snapshot + deltas
 *   - the full L2 (bids/asks maps) for rendering depth
 *   - recent trades for the tape
 *   - current ticker + 24h stats
 *   - balances for the selected user
 *   - a debug "match log" — last N raw engine events received over WS
 */

export interface BookState {
  bids: Map<number, number>; // price -> qty
  asks: Map<number, number>;
}

export interface AppState {
  apiKey: string;
  userId: string;
  book: BookState;
  trades: Trade[];
  candles1m: Candle[];
  candles5m: Candle[];
  candleInterval: '1m' | '5m' | 'live';
  ticker: Ticker | null;
  prevLastPrice: number | null;
  balances: Balances | null;
  log: LogEntry[];
}

export interface LogEntry {
  ts: number;
  kind: string;
  text: string;
}

type Action =
  | { type: 'set_user'; apiKey: string; userId: string }
  | { type: 'set_snapshot'; snap: Snapshot }
  | { type: 'l2_delta'; side: 'buy' | 'sell'; price: number; qty: number }
  | { type: 'set_trades'; trades: Trade[] }
  | { type: 'push_trade'; trade: Trade }
  | { type: 'set_candles'; interval: '1m' | '5m'; candles: Candle[] }
  | { type: 'candle_update'; interval: '1m' | '5m'; candle: Candle }
  | { type: 'candle_close'; interval: '1m' | '5m'; candle: Candle }
  | { type: 'set_interval'; interval: '1m' | '5m' | 'live' }
  | { type: 'set_ticker'; ticker: Ticker }
  | { type: 'set_balances'; balances: Balances }
  | { type: 'log'; entry: LogEntry };

const initialState = (apiKey: string, userId: string): AppState => ({
  apiKey, userId,
  book: { bids: new Map(), asks: new Map() },
  trades: [],
  candles1m: [], candles5m: [],
  candleInterval: '1m',
  ticker: null,
  prevLastPrice: null,
  balances: null,
  log: [],
});

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'set_user':
      return { ...state, apiKey: action.apiKey, userId: action.userId };
    case 'set_snapshot': {
      const bids = new Map<number, number>();
      const asks = new Map<number, number>();
      for (const [p, q] of action.snap.bids) bids.set(baseUnitsToPrice(p), baseUnitsToQty(q));
      for (const [p, q] of action.snap.asks) asks.set(baseUnitsToPrice(p), baseUnitsToQty(q));
      return { ...state, book: { bids, asks } };
    }
    case 'l2_delta': {
      const target = action.side === 'buy' ? new Map(state.book.bids) : new Map(state.book.asks);
      if (action.qty === 0) target.delete(action.price);
      else target.set(action.price, action.qty);
      return {
        ...state,
        book: action.side === 'buy'
          ? { ...state.book, bids: target }
          : { ...state.book, asks: target },
      };
    }
    case 'set_trades':
      return { ...state, trades: action.trades };
    case 'push_trade': {
      const next = [...state.trades, action.trade];
      if (next.length > 100) next.shift();
      return { ...state, trades: next };
    }
    case 'set_candles':
      return action.interval === '1m'
        ? { ...state, candles1m: action.candles }
        : { ...state, candles5m: action.candles };
    case 'candle_update':
    case 'candle_close': {
      const key = action.interval === '1m' ? 'candles1m' : 'candles5m';
      const arr = state[key].slice();
      const last = arr[arr.length - 1];
      if (last && last.bucketStart === action.candle.bucketStart) {
        arr[arr.length - 1] = action.candle;
      } else {
        arr.push(action.candle);
        if (arr.length > 500) arr.shift();
      }
      return { ...state, [key]: arr } as AppState;
    }
    case 'set_interval':
      return { ...state, candleInterval: action.interval };
    case 'set_ticker': {
      const newLast = action.ticker.lastPrice ? baseUnitsToPrice(action.ticker.lastPrice) : null;
      return {
        ...state,
        ticker: action.ticker,
        prevLastPrice: state.ticker?.lastPrice ? baseUnitsToPrice(state.ticker.lastPrice) : newLast,
      };
    }
    case 'set_balances':
      return { ...state, balances: action.balances };
    case 'log': {
      const log = [action.entry, ...state.log];
      if (log.length > 200) log.pop();
      return { ...state, log };
    }
  }
}

// Hardcoded user list — matches packages/gateway/src/auth.ts.
export const USERS: { apiKey: string; userId: string }[] = [
  { apiKey: 'key_alice', userId: 'alice' },
  { apiKey: 'key_bob', userId: 'bob' },
  { apiKey: 'key_user1', userId: 'user1' },
];

export function useExchangeStore() {
  const [state, dispatch] = useReducer(reducer, initialState(USERS[0]!.apiKey, USERS[0]!.userId));

  // Initial bootstrap: snapshot, trades, candles, ticker. Balances are
  // fetched by the apiKey effect below.
  useEffect(() => {
    void (async () => {
      try {
        const [snap, trades, c1, c5, ticker] = await Promise.all([
          getSnapshot(),
          getTrades(50),
          getCandles('1m', 300),
          getCandles('5m', 300),
          getTicker(),
        ]);
        dispatch({ type: 'set_snapshot', snap });
        dispatch({ type: 'set_trades', trades });
        dispatch({ type: 'set_candles', interval: '1m', candles: c1.candles });
        dispatch({ type: 'set_candles', interval: '5m', candles: c5.candles });
        dispatch({ type: 'set_ticker', ticker });
      } catch (err) {
        console.error('bootstrap failed', err);
      }
    })();
  }, []);

  // Balances refresh whenever user changes or every 2s.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const balances = await getBalances(state.apiKey);
        if (!cancelled) dispatch({ type: 'set_balances', balances });
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [state.apiKey]);

  // WebSocket subscription.
  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    const connect = (): void => {
      if (!active) return;
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        ws?.send(JSON.stringify({
          type: 'subscribe',
          channels: ['book', 'book:snapshot', 'trades', 'ticker', 'candles:1m', 'candles:5m', 'events'],
        }));
      };
      ws.onmessage = (msg) => {
        try {
          const env = JSON.parse(msg.data as string) as { channel: string; data: unknown };
          switch (env.channel) {
            case 'book': {
              const d = env.data as { side: 'buy' | 'sell'; price: string; qty: string };
              dispatch({
                type: 'l2_delta',
                side: d.side,
                price: baseUnitsToPrice(d.price),
                qty: baseUnitsToQty(d.qty),
              });
              break;
            }
            case 'book:snapshot':
              dispatch({ type: 'set_snapshot', snap: env.data as Snapshot });
              break;
            case 'trades':
              dispatch({ type: 'push_trade', trade: env.data as Trade });
              break;
            case 'ticker':
              dispatch({ type: 'set_ticker', ticker: env.data as Ticker });
              break;
            case 'candles:1m':
            case 'candles:5m': {
              const c = env.data as { kind: 'update' | 'close'; interval: '1m' | '5m'; candle: Candle };
              dispatch({ type: c.kind === 'update' ? 'candle_update' : 'candle_close', interval: c.interval, candle: c.candle });
              break;
            }
            case 'events': {
              const ev = env.data as { kind: string; seq?: number } & Record<string, unknown>;
              dispatch({ type: 'log', entry: { ts: Date.now(), kind: ev.kind, text: formatEvent(ev) } });
              break;
            }
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        if (active) setTimeout(connect, 1500);
      };
      ws.onerror = () => { ws?.close(); };
    };
    connect();
    return () => {
      active = false;
      ws?.close();
    };
  }, []);

  return { state, dispatch };
}

function formatEvent(ev: { kind: string } & Record<string, unknown>): string {
  const any = ev as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (ev.kind) {
    case 'OrderAccepted': {
      const o = any.order as { orderId: string; userId: string; side: string; type: string; price: string; qty: string };
      const p = o.price === '0' ? 'MKT' : baseUnitsToPrice(o.price).toFixed(2);
      return `ACCEPT ${o.side.toUpperCase()} ${o.type} ${baseUnitsToQty(o.qty).toFixed(5)} @ ${p}   [${o.userId} · ${o.orderId.slice(0, 10)}…]`;
    }
    case 'OrderRejected':
      return `REJECT ${any.reason}   [user=${any.userId} cid=${any.clientOrderId}]`;
    case 'OrderCanceled': {
      const p = any.price === '0' ? 'MKT' : baseUnitsToPrice(any.price).toFixed(2);
      return `CANCEL ${String(any.side).toUpperCase()} ${baseUnitsToQty(any.remaining).toFixed(5)} @ ${p}   [${any.reason} · ${any.userId}]`;
    }
    case 'Trade':
      return `TRADE  ${any.aggressor === 'buy' ? '↑' : '↓'} ${baseUnitsToQty(any.qty).toFixed(5)} @ ${baseUnitsToPrice(any.price).toFixed(2)}   [taker=${any.takerUserId} maker=${any.makerUserId}]`;
    default:
      return ev.kind;
  }
}
