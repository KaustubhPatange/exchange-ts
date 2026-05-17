export type Side = 'buy' | 'sell';

export type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK' | 'POST_ONLY';

export type OrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED';

export type Asset = 'BTC' | 'USDC';

export type Symbol = 'BTC-USDC';

/**
 * Canonical order shape used inside the engine. All numeric quantities are
 * integer base units (see decimal.ts). Price is in base units of the QUOTE
 * asset per ONE WHOLE unit of the BASE asset (i.e. how many USDC base units
 * per 1 BTC). This keeps multiplication clean: notional = price * qty / BASE_ONE.
 */
export interface Order {
  orderId: string;          // server-assigned ULID
  clientOrderId: string;    // client-supplied for idempotency
  userId: string;
  symbol: Symbol;
  side: Side;
  type: OrderType;
  price: bigint;            // 0n for MARKET
  qty: bigint;              // original quantity (base asset base units)
  remaining: bigint;        // unfilled remaining
  status: OrderStatus;
  createdAt: number;        // ms epoch
}

export interface NewOrderCommand {
  clientOrderId: string;
  userId: string;
  symbol: Symbol;
  side: Side;
  type: OrderType;
  price?: bigint;           // required except for MARKET
  qty: bigint;
}

export interface CancelOrderCommand {
  orderId: string;
  userId: string;           // must match owner
}
