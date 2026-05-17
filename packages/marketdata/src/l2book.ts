import type { EngineEvent, Order, Side } from '@exchange/common';

/**
 * L2 (level-2) book aggregator.
 *
 * Unlike the engine's book — which knows per-order — the L2 view stores
 * only the TOTAL QTY at each price level on each side. That's what
 * traders typically see in an exchange's depth chart.
 *
 * Driven entirely by engine events. We use the same submission-boundary
 * trick as the engine replayer: stash a pending order on OrderAccepted,
 * then on the next submission boundary decide whether it ended up
 * resting and should be added to the L2 totals.
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

export class L2Book {
  /** side -> price -> totalQty */
  private readonly bids = new Map<bigint, bigint>();
  private readonly asks = new Map<bigint, bigint>();
  /** orderId -> { side, price, remaining } for orders currently on the book */
  private readonly orders = new Map<string, { side: Side; price: bigint; remaining: bigint }>();

  private pending: Order | null = null;
  private pendingCanceled = false;

  /** Returns deltas the publisher should push out. */
  apply(ev: EngineEvent): L2Delta[] {
    switch (ev.kind) {
      case 'OrderAccepted': {
        const flushDeltas = this.flushPending();
        this.pending = { ...ev.order };
        this.pendingCanceled = false;
        return flushDeltas;
      }
      case 'OrderRejected': {
        return this.flushPending();
      }
      case 'Trade': {
        const deltas: L2Delta[] = [];
        // The maker is on the book — reduce its level.
        const maker = this.orders.get(ev.makerOrderId);
        if (maker) {
          maker.remaining -= ev.qty;
          if (maker.remaining <= 0n) this.orders.delete(ev.makerOrderId);
          deltas.push(this.applyLevelDelta(maker.side, maker.price, -ev.qty));
        }
        // The taker may be the pending order (this submission). Track its remaining.
        if (this.pending && this.pending.orderId === ev.takerOrderId) {
          this.pending.remaining -= ev.qty;
        }
        return deltas;
      }
      case 'OrderCanceled': {
        if (this.pending && this.pending.orderId === ev.orderId) {
          this.pendingCanceled = true;
          return [];
        }
        const existing = this.orders.get(ev.orderId);
        if (!existing) return [];
        this.orders.delete(ev.orderId);
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

  private flushPending(): L2Delta[] {
    if (
      !this.pending ||
      this.pendingCanceled ||
      this.pending.remaining <= 0n ||
      !(this.pending.type === 'LIMIT' || this.pending.type === 'POST_ONLY')
    ) {
      this.pending = null;
      this.pendingCanceled = false;
      return [];
    }
    const o = this.pending;
    this.orders.set(o.orderId, { side: o.side, price: o.price, remaining: o.remaining });
    const delta = this.applyLevelDelta(o.side, o.price, o.remaining);
    this.pending = null;
    this.pendingCanceled = false;
    return [delta];
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
    order === 'asc' ? (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0
  );
  return sorted.slice(0, n).map(([p, q]) => [p.toString(), q.toString()]);
}
