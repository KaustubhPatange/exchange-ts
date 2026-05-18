import type { EngineEvent, Side } from '@exchange/common';

/**
 * L2 (level-2) book aggregator.
 *
 * Unlike the engine's book — which knows per-order — the L2 view stores
 * only the TOTAL QTY at each price level on each side. That's what
 * traders typically see in an exchange's depth chart.
 *
 * Update rules:
 *   - OrderAccepted: pre-add the full qty at the order's (side, price).
 *     For MARKET orders (price = 0) we skip — they cannot rest.
 *   - Trade: reduce BOTH sides — the maker's level by qty (the maker is
 *     resting on the book) AND the taker's level by qty (we pre-added
 *     it on OrderAccepted, so we need to take back the part that just
 *     matched, leaving only the unfilled remainder visible at the
 *     taker's limit price).
 *   - OrderCanceled: remove the order's REMAINING qty from its level.
 *     Works for both user-cancels (resting orders) and terminal cancels
 *     (IOC remainder, STP, MARKET_NO_LIQUIDITY).
 *
 * This makes the L2 reflect the user's order the instant the engine
 * accepts it — no waiting for a "next submission" boundary.
 */

export interface L2Delta {
  side: Side;
  price: string;   // bigint as string for JSON
  qty: string;     // total qty at this level AFTER the change; '0' means remove
}

export interface L2Snapshot {
  bids: [string, string][];  // [price, qty]
  asks: [string, string][];
}

interface TrackedOrder {
  side: Side;
  price: bigint;          // 0n for MARKET (never adds to a level)
  remaining: bigint;
}

export class L2Book {
  private readonly bids = new Map<bigint, bigint>();
  private readonly asks = new Map<bigint, bigint>();
  private readonly orders = new Map<string, TrackedOrder>();

  apply(ev: EngineEvent): L2Delta[] {
    switch (ev.kind) {
      case 'OrderAccepted': {
        const o = ev.order;
        this.orders.set(o.orderId, {
          side: o.side,
          price: o.price,
          remaining: o.qty,
        });
        // MARKET orders never rest. Don't put them in the depth view.
        if (o.type === 'MARKET' || o.price === 0n) return [];
        return [this.applyLevelDelta(o.side, o.price, o.qty)];
      }
      case 'OrderRejected':
        return [];
      case 'Trade': {
        const deltas: L2Delta[] = [];
        const maker = this.orders.get(ev.makerOrderId);
        if (maker) {
          maker.remaining -= ev.qty;
          if (maker.remaining <= 0n) this.orders.delete(ev.makerOrderId);
          deltas.push(this.applyLevelDelta(maker.side, maker.price, -ev.qty));
        }
        const taker = this.orders.get(ev.takerOrderId);
        if (taker) {
          taker.remaining -= ev.qty;
          if (taker.remaining <= 0n) this.orders.delete(ev.takerOrderId);
          // taker.price is 0 for MARKET — those were never added to a level.
          if (taker.price > 0n) {
            deltas.push(this.applyLevelDelta(taker.side, taker.price, -ev.qty));
          }
        }
        return deltas;
      }
      case 'OrderCanceled': {
        const existing = this.orders.get(ev.orderId);
        if (!existing) return [];
        this.orders.delete(ev.orderId);
        if (existing.price === 0n) return []; // MARKET, never added
        return [this.applyLevelDelta(existing.side, existing.price, -existing.remaining)];
      }
    }
  }

  snapshot(levels: number = 50): L2Snapshot {
    return {
      bids: topN(this.bids, 'desc', levels),
      asks: topN(this.asks, 'asc', levels),
    };
  }

  private applyLevelDelta(side: Side, price: bigint, deltaQty: bigint): L2Delta {
    const tree = side === 'buy' ? this.bids : this.asks;
    const current = tree.get(price) ?? 0n;
    const next = current + deltaQty;
    if (next <= 0n) tree.delete(price);
    else tree.set(price, next);
    return { side, price: price.toString(), qty: (next > 0n ? next : 0n).toString() };
  }
}

function topN(
  m: Map<bigint, bigint>,
  order: 'asc' | 'desc',
  n: number
): [string, string][] {
  const sorted = [...m.entries()].sort((a, b) =>
    order === 'asc'
      ? a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
      : a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0
  );
  return sorted.slice(0, n).map(([p, q]) => [p.toString(), q.toString()]);
}
