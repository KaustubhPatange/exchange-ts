import {
  deserializeEvent,
  fromBaseUnits,
  toBaseUnits,
  BTC_DECIMALS,
  USDC_DECIMALS,
  PRICE_DECIMALS,
  type EngineEvent,
  type OrderType,
  type Side,
} from '@exchange/common';

const DEFAULT_GATEWAY = 'http://localhost:8080';

export const USER_KEYS = {
  alice: 'key_alice',
  bob: 'key_bob',
  gary: 'key_gary',
  josh: 'key_josh',
} as const;

export type UserName = keyof typeof USER_KEYS;

export interface Balance {
  free: bigint;
  locked: bigint;
}

export interface Balances {
  BTC: Balance;
  USDC: Balance;
}

export interface PlaceParams {
  clientOrderId?: string;
  side: Side;
  type: OrderType;
  /** Human-decimal price, e.g. "70000" or "69500.5". Required for non-MARKET. */
  price?: string;
  /** Human-decimal qty in BTC, e.g. "1" or "0.5". */
  qty: string;
}

export interface PlaceResult {
  events: EngineEvent[];
  acceptedOrderId?: string;
  trades: Extract<EngineEvent, { kind: 'Trade' }>[];
  rejected?: { reason: string };
  /** Terminal cancel attached to THIS submission (IOC remainder / STP / MARKET_NO_LIQUIDITY). */
  terminalCancel?: { reason: string; remaining: bigint };
}

export interface SnapshotLevel {
  price: bigint;
  qty: bigint;
}

export interface Snapshot {
  bids: SnapshotLevel[];
  asks: SnapshotLevel[];
}

export interface TradeRow {
  tradeId: string;
  ts: number;
  price: bigint;
  qty: bigint;
  aggressor: Side;
}

export interface CandleRow {
  bucketStart: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  trades: number;
}

export interface Ticker {
  lastPrice: bigint | null;
  high24h: bigint | null;
  low24h: bigint | null;
  open24h: bigint | null;
  volume24h: bigint;
  changePct24h: number | null;
}

interface RawBalanceLeg {
  free: string;
  locked: string;
}
interface RawBalances {
  BTC: RawBalanceLeg;
  USDC: RawBalanceLeg;
}
interface RawSnapshot {
  bids: [string, string][];
  asks: [string, string][];
}
interface RawTrade {
  tradeId: string;
  ts: number;
  price: string;
  qty: string;
  aggressor: Side;
}
interface RawCandle {
  bucketStart: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}
interface RawCandlesResp {
  interval: string;
  candles: RawCandle[];
}
interface RawTicker {
  lastPrice: string | null;
  high24h: string | null;
  low24h: string | null;
  open24h: string | null;
  volume24h: string;
  changePct24h: number | null;
}

function reviveBalances(r: RawBalances): Balances {
  return {
    BTC: { free: BigInt(r.BTC.free), locked: BigInt(r.BTC.locked) },
    USDC: { free: BigInt(r.USDC.free), locked: BigInt(r.USDC.locked) },
  };
}

function reviveSnapshot(r: RawSnapshot): Snapshot {
  return {
    bids: r.bids.map(([p, q]) => ({ price: BigInt(p), qty: BigInt(q) })),
    asks: r.asks.map(([p, q]) => ({ price: BigInt(p), qty: BigInt(q) })),
  };
}

function reviveTrade(r: RawTrade): TradeRow {
  return { tradeId: r.tradeId, ts: r.ts, price: BigInt(r.price), qty: BigInt(r.qty), aggressor: r.aggressor };
}

function reviveCandle(r: RawCandle): CandleRow {
  return {
    bucketStart: r.bucketStart,
    open: BigInt(r.open),
    high: BigInt(r.high),
    low: BigInt(r.low),
    close: BigInt(r.close),
    volume: BigInt(r.volume),
    trades: r.trades,
  };
}

function reviveTicker(r: RawTicker): Ticker {
  return {
    lastPrice: r.lastPrice === null ? null : BigInt(r.lastPrice),
    high24h: r.high24h === null ? null : BigInt(r.high24h),
    low24h: r.low24h === null ? null : BigInt(r.low24h),
    open24h: r.open24h === null ? null : BigInt(r.open24h),
    volume24h: BigInt(r.volume24h),
    changePct24h: r.changePct24h,
  };
}

/**
 * Decode the gateway's `{ events: [...] }` into typed EngineEvents (bigints
 * restored), plus summary helpers for the common shapes simulations care
 * about.
 */
function summarizeEvents(raw: unknown): PlaceResult {
  const wrapped = raw as { events: unknown[] };
  const events: EngineEvent[] = [];
  for (const e of wrapped.events ?? []) {
    // Engine returns serialized-form events (bigints as strings). Re-encode
    // through the common deserializer so bigint fields are restored.
    try {
      events.push(deserializeEvent(JSON.stringify(e)));
    } catch {
      // Ignore malformed entries (e.g. an admin error envelope).
    }
  }
  const result: PlaceResult = { events, trades: [] };
  for (const ev of events) {
    if (ev.kind === 'OrderAccepted') result.acceptedOrderId = ev.order.orderId;
    else if (ev.kind === 'Trade') result.trades.push(ev);
    else if (ev.kind === 'OrderRejected') result.rejected = { reason: ev.reason };
    else if (ev.kind === 'OrderCanceled' && result.acceptedOrderId === ev.orderId) {
      result.terminalCancel = { reason: ev.reason, remaining: ev.remaining };
    }
  }
  return result;
}

export class ExchangeClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_GATEWAY
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && res.status !== 400 && res.status !== 402) {
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async place(p: PlaceParams): Promise<PlaceResult> {
    const body: Record<string, unknown> = {
      symbol: 'BTC-USDC',
      side: p.side,
      type: p.type,
      qty: p.qty,
    };
    if (p.price !== undefined) body.price = p.price;
    if (p.clientOrderId) body.clientOrderId = p.clientOrderId;
    const raw = await this.req<unknown>('POST', '/api/orders', body);
    return summarizeEvents(raw);
  }

  async cancel(orderId: string): Promise<PlaceResult> {
    const raw = await this.req<unknown>('DELETE', `/api/orders/${encodeURIComponent(orderId)}`);
    return summarizeEvents(raw);
  }

  async balances(): Promise<Balances> {
    return reviveBalances(await this.req<RawBalances>('GET', '/api/balances'));
  }

  async snapshot(): Promise<Snapshot> {
    return reviveSnapshot(await this.req<RawSnapshot>('GET', '/api/snapshot'));
  }

  async trades(limit = 20): Promise<TradeRow[]> {
    const raw = await this.req<RawTrade[]>('GET', `/api/trades?limit=${limit}`);
    return raw.map(reviveTrade);
  }

  async candles(interval: '1m' | '5m', limit = 20): Promise<CandleRow[]> {
    const raw = await this.req<RawCandlesResp>(
      'GET',
      `/api/candles?interval=${interval}&limit=${limit}`
    );
    return raw.candles.map(reviveCandle);
  }

  async ticker(): Promise<Ticker> {
    return reviveTicker(await this.req<RawTicker>('GET', '/api/ticker'));
  }
}

export function clientFor(user: UserName, baseUrl?: string): ExchangeClient {
  return new ExchangeClient(USER_KEYS[user], baseUrl);
}

/** Anonymous client for snapshot/trades/candles/ticker reads. */
export function systemClient(baseUrl?: string): ExchangeClient {
  return new ExchangeClient('', baseUrl);
}

// ---------- Decimal helpers re-exported so examples have one place to import ----------

export function btcStr(v: bigint): string {
  return fromBaseUnits(v, BTC_DECIMALS);
}
export function usdcStr(v: bigint): string {
  return fromBaseUnits(v, USDC_DECIMALS);
}
export function priceStr(v: bigint): string {
  return fromBaseUnits(v, PRICE_DECIMALS);
}
export function priceFrom(human: string | number): bigint {
  return toBaseUnits(human, PRICE_DECIMALS);
}
export function btcFrom(human: string | number): bigint {
  return toBaseUnits(human, BTC_DECIMALS);
}
export function usdcFrom(human: string | number): bigint {
  return toBaseUnits(human, USDC_DECIMALS);
}
