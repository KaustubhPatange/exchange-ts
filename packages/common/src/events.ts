import type { Order, OrderType, Side, Symbol } from './types.js';

/**
 * Engine events. These are the SOURCE OF TRUTH for the exchange — written
 * to the Redis Stream `engine.events` in order. Every other service builds
 * its state by consuming these.
 *
 * Each event has a monotonic `seq` assigned by the engine when it is
 * appended to the log.
 */
export type EngineEvent =
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | OrderCanceledEvent
  | TradeEvent;

export interface OrderAcceptedEvent {
  kind: 'OrderAccepted';
  seq: number;
  ts: number;
  order: Order;
}

export interface OrderRejectedEvent {
  kind: 'OrderRejected';
  seq: number;
  ts: number;
  clientOrderId: string;
  userId: string;
  reason:
    | 'INVALID_PRICE'
    | 'INVALID_QTY'
    | 'DUPLICATE_CLIENT_ORDER_ID'
    | 'POST_ONLY_WOULD_CROSS'
    | 'FOK_NOT_FILLABLE'
    | 'UNKNOWN_SYMBOL';
}

export interface OrderCanceledEvent {
  kind: 'OrderCanceled';
  seq: number;
  ts: number;
  orderId: string;
  userId: string;
  symbol: Symbol;
  side: Side;
  price: bigint;
  remaining: bigint;        // qty that was on the book at cancel time
  reason: 'USER' | 'IOC_REMAINDER' | 'STP' | 'MARKET_NO_LIQUIDITY';
}

export interface TradeEvent {
  kind: 'Trade';
  seq: number;
  ts: number;
  tradeId: string;
  symbol: Symbol;
  price: bigint;            // execution price (always the maker's resting price)
  qty: bigint;              // filled qty (base asset base units)
  // Aggressor is the side that TOOK liquidity (the incoming order).
  aggressor: Side;
  takerOrderId: string;
  takerUserId: string;
  takerOrderType: OrderType;
  makerOrderId: string;
  makerUserId: string;
}

/**
 * JSON-safe serialization for events: bigints become decimal strings.
 * We use this both for the Redis Stream payload and the WS wire format.
 */
export function serializeEvent(ev: EngineEvent): string {
  return JSON.stringify(ev, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
}

const BIGINT_KEYS = new Set([
  'price',
  'qty',
  'remaining',
]);

export function deserializeEvent(json: string): EngineEvent {
  return JSON.parse(json, (k, v) => {
    if (BIGINT_KEYS.has(k) && typeof v === 'string') return BigInt(v);
    return v;
  });
}
