export const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? 'http://localhost:8080';
export const WS_URL = (import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/ws') as string;

// Decimals — matches packages/common/src/decimal.ts.
const PRICE_DECIMALS = 6;
const QTY_DECIMALS = 8;
const PRICE_ONE = 10 ** PRICE_DECIMALS;
const QTY_ONE = 10 ** QTY_DECIMALS;

export const baseUnitsToPrice = (s: string): number => Number(BigInt(s)) / PRICE_ONE;
export const baseUnitsToQty = (s: string): number => Number(BigInt(s)) / QTY_ONE;
export const formatPrice = (n: number, decimals = 2): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const formatQty = (n: number, decimals = 4): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export interface Snapshot {
  bids: [string, string][];
  asks: [string, string][];
}

export interface Trade {
  tradeId: string;
  ts: number;
  price: string;       // base units
  qty: string;
  aggressor: 'buy' | 'sell';
}

export interface Candle {
  bucketStart: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

export interface Ticker {
  lastPrice: string | null;
  open24h: string | null;
  high24h: string | null;
  low24h: string | null;
  volume24h: string;
  changePct24h: string;
}

export interface Balances {
  BTC: { free: string; locked: string };
  USDC: { free: string; locked: string };
}

export async function getSnapshot(): Promise<Snapshot> {
  const r = await fetch(`${GATEWAY}/api/snapshot`);
  return r.json();
}
export async function getTrades(limit = 50): Promise<Trade[]> {
  const r = await fetch(`${GATEWAY}/api/trades?limit=${limit}`);
  return r.json();
}
export async function getCandles(interval: '1m' | '5m', limit = 300): Promise<{ candles: Candle[] }> {
  const r = await fetch(`${GATEWAY}/api/candles?interval=${interval}&limit=${limit}`);
  return r.json();
}
export async function getTicker(): Promise<Ticker> {
  const r = await fetch(`${GATEWAY}/api/ticker`);
  return r.json();
}
export async function getBalances(apiKey: string): Promise<Balances> {
  const r = await fetch(`${GATEWAY}/api/balances`, { headers: { 'x-api-key': apiKey } });
  return r.json();
}

export interface PlaceOrderInput {
  symbol: 'BTC-USDC';
  side: 'buy' | 'sell';
  type: 'LIMIT' | 'POST_ONLY' | 'IOC' | 'FOK';
  price?: string;     // decimal string
  qty: string;
}
export async function placeOrder(apiKey: string, input: PlaceOrderInput): Promise<unknown> {
  const r = await fetch(`${GATEWAY}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(input),
  });
  return r.json();
}
export async function cancelOrder(apiKey: string, orderId: string): Promise<unknown> {
  const r = await fetch(`${GATEWAY}/api/orders/${encodeURIComponent(orderId)}`, {
    method: 'DELETE',
    headers: { 'x-api-key': apiKey },
  });
  return r.json();
}
