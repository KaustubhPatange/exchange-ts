import {
  notionalQuote,
  toBaseUnits,
  USDC_DECIMALS,
  BTC_DECIMALS,
  type Asset,
  type Side,
} from '@exchange/common';

const ENGINE_URL = process.env.ENGINE_URL ?? 'http://localhost:8082';
const LEDGER_URL = process.env.LEDGER_URL ?? 'http://localhost:8081';
const MARKETDATA_URL = process.env.MARKETDATA_URL ?? 'http://localhost:8083';

// ---------- User-facing decimal parsing ----------

export function parsePriceDecimal(s: string): bigint {
  return toBaseUnits(s, USDC_DECIMALS);
}
export function parseQtyDecimal(s: string): bigint {
  return toBaseUnits(s, BTC_DECIMALS);
}

// ---------- Reservation math (same formula as the settler uses) ----------

export function reserveForOrder(
  side: Side,
  price: bigint | undefined,
  qty: bigint
): { asset: Asset; amount: bigint } {
  if (price === undefined) throw new Error('price required');
  if (side === 'buy') return { asset: 'USDC', amount: notionalQuote(price, qty) };
  return { asset: 'BTC', amount: qty };
}

// ---------- Service clients ----------

export interface LedgerReserveResponse {
  ok: boolean;
  error?: string;
  requested?: string;
  available?: string;
}

export async function ledgerReserve(
  userId: string,
  asset: Asset,
  amount: bigint
): Promise<LedgerReserveResponse> {
  const res = await fetch(`${LEDGER_URL}/reserve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, asset, amount: amount.toString() }),
  });
  return (await res.json()) as LedgerReserveResponse;
}

export async function ledgerRelease(
  userId: string,
  asset: Asset,
  amount: bigint
): Promise<void> {
  await fetch(`${LEDGER_URL}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, asset, amount: amount.toString() }),
  });
}

export async function ledgerBalances(userId: string): Promise<unknown> {
  const res = await fetch(`${LEDGER_URL}/balances/${encodeURIComponent(userId)}`);
  return res.json();
}

export interface EnginePlaceResponse {
  events: Array<{ kind: string; reason?: string; order?: { orderId: string } } & Record<string, unknown>>;
}

export async function enginePlace(
  body: Record<string, unknown>
): Promise<EnginePlaceResponse> {
  const res = await fetch(`${ENGINE_URL}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as EnginePlaceResponse;
}

export async function engineCancel(orderId: string, userId: string): Promise<EnginePlaceResponse> {
  const res = await fetch(
    `${ENGINE_URL}/orders/${encodeURIComponent(orderId)}?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  );
  return (await res.json()) as EnginePlaceResponse;
}

export async function mdSnapshot(): Promise<unknown> {
  const res = await fetch(`${MARKETDATA_URL}/snapshot`);
  return res.json();
}
export async function mdTrades(limit: number): Promise<unknown> {
  const res = await fetch(`${MARKETDATA_URL}/trades?limit=${limit}`);
  return res.json();
}
export async function mdCandles(interval: string, limit: number): Promise<unknown> {
  const res = await fetch(`${MARKETDATA_URL}/candles?interval=${interval}&limit=${limit}`);
  return res.json();
}
export async function mdTicker(): Promise<unknown> {
  const res = await fetch(`${MARKETDATA_URL}/ticker`);
  return res.json();
}
