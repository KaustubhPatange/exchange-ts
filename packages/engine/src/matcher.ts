import {
  newOrderId,
  newTradeId,
  type CancelOrderCommand,
  type EngineEvent,
  type NewOrderCommand,
  type Order,
  type OrderCanceledEvent,
  type OrderRejectedEvent,
  type Side,
  type TradeEvent,
} from '@exchange/common';

import { OrderBook } from './book.js';

/**
 * The matching engine.
 *
 * Owns the book, assigns sequence numbers, runs the match loop, and emits
 * events. Single-threaded by design: every order is processed atomically
 * and produces a deterministic event list. This is what allows downstream
 * services to rebuild state by replaying events in order.
 *
 * Order types supported:
 *   LIMIT      — match while crosses; rest remainder.
 *   MARKET     — match while opposite side has liquidity; cancel remainder.
 *   IOC        — like LIMIT but cancel remainder instead of resting.
 *   FOK        — pre-check; either fully fills or is rejected (no partials).
 *   POST_ONLY  — must rest; if it would cross, reject.
 *
 * Self-Trade Prevention (STP): when an incoming order would match against
 * one of the same user's resting orders, we use the CANCEL-NEW policy:
 * we stop matching and cancel the rest of the incoming order. Anything
 * filled before the self-match still stands.
 *
 * The match always executes at the MAKER's resting price (the taker
 * gets price improvement when their limit is more aggressive than the
 * best opposite). This is the standard convention.
 */
export class MatchingEngine {
  readonly book = new OrderBook();
  private seq = 0;
  private readonly seenClientOrderIds = new Map<string, Set<string>>();

  /** Externally settable so a replayer can sync the sequence counter. */
  setSeq(seq: number): void {
    this.seq = seq;
  }

  currentSeq(): number {
    return this.seq;
  }

  /** Used by the replayer to restore the dedup set without re-emitting. */
  markClientOrderIdSeen(userId: string, clientOrderId: string): void {
    let s = this.seenClientOrderIds.get(userId);
    if (!s) {
      s = new Set();
      this.seenClientOrderIds.set(userId, s);
    }
    s.add(clientOrderId);
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  submit(cmd: NewOrderCommand, now: number = Date.now()): EngineEvent[] {
    const events: EngineEvent[] = [];

    // ---------- Validation ----------
    if (cmd.symbol !== 'BTC-USDC') {
      events.push(this.makeRejected(cmd, now, 'UNKNOWN_SYMBOL'));
      return events;
    }
    if (cmd.qty <= 0n) {
      events.push(this.makeRejected(cmd, now, 'INVALID_QTY'));
      return events;
    }
    if (cmd.type !== 'MARKET' && (cmd.price === undefined || cmd.price <= 0n)) {
      events.push(this.makeRejected(cmd, now, 'INVALID_PRICE'));
      return events;
    }

    // ---------- Idempotency ----------
    let userSeen = this.seenClientOrderIds.get(cmd.userId);
    if (!userSeen) {
      userSeen = new Set();
      this.seenClientOrderIds.set(cmd.userId, userSeen);
    }
    if (userSeen.has(cmd.clientOrderId)) {
      events.push(this.makeRejected(cmd, now, 'DUPLICATE_CLIENT_ORDER_ID'));
      return events;
    }
    userSeen.add(cmd.clientOrderId);

    // ---------- Canonical order record ----------
    const order: Order = {
      orderId: newOrderId(),
      clientOrderId: cmd.clientOrderId,
      userId: cmd.userId,
      symbol: cmd.symbol,
      side: cmd.side,
      type: cmd.type,
      price: cmd.type === 'MARKET' ? 0n : cmd.price!,
      qty: cmd.qty,
      remaining: cmd.qty,
      status: 'NEW',
      createdAt: now,
    };

    // ---------- POST_ONLY pre-check ----------
    if (cmd.type === 'POST_ONLY' && this.wouldCross(order)) {
      events.push(this.makeRejected(cmd, now, 'POST_ONLY_WOULD_CROSS'));
      return events;
    }

    // ---------- FOK pre-check ----------
    if (cmd.type === 'FOK' && !this.fullyFillable(order)) {
      events.push(this.makeRejected(cmd, now, 'FOK_NOT_FILLABLE'));
      return events;
    }

    // ---------- Emit OrderAccepted (initial state) ----------
    events.push({
      kind: 'OrderAccepted',
      seq: this.nextSeq(),
      ts: now,
      order: { ...order },
    });

    // ---------- Match loop ----------
    const oppSide: Side = order.side === 'buy' ? 'sell' : 'buy';
    let stoppedBySTP = false;

    while (order.remaining > 0n) {
      const top = this.book.peekTopOrder(oppSide);
      if (!top) break;

      // For limit-style orders, stop when price no longer crosses.
      if (order.type !== 'MARKET') {
        const crosses =
          order.side === 'buy' ? order.price >= top.price : order.price <= top.price;
        if (!crosses) break;
      }

      // STP cancel-new: stop matching if our own order is at the front.
      if (top.userId === order.userId) {
        stoppedBySTP = true;
        break;
      }

      const fillQty = order.remaining < top.remaining ? order.remaining : top.remaining;
      const fillPrice = top.price;

      const trade: TradeEvent = {
        kind: 'Trade',
        seq: this.nextSeq(),
        ts: now,
        tradeId: newTradeId(),
        symbol: order.symbol,
        price: fillPrice,
        qty: fillQty,
        aggressor: order.side,
        takerOrderId: order.orderId,
        takerUserId: order.userId,
        takerOrderType: order.type,
        makerOrderId: top.orderId,
        makerUserId: top.userId,
      };
      events.push(trade);

      this.book.reduceTopOrder(oppSide, fillQty);
      order.remaining -= fillQty;
    }

    // ---------- Handle remainder ----------
    if (order.remaining > 0n) {
      if (stoppedBySTP) {
        events.push(this.makeCanceled(order, now, 'STP'));
      } else if (cmd.type === 'LIMIT' || cmd.type === 'POST_ONLY') {
        this.book.rest(order);
      } else if (cmd.type === 'IOC') {
        events.push(this.makeCanceled(order, now, 'IOC_REMAINDER'));
      } else if (cmd.type === 'MARKET') {
        events.push(this.makeCanceled(order, now, 'MARKET_NO_LIQUIDITY'));
      } else if (cmd.type === 'FOK') {
        // Pre-check should have prevented this; defensive throw.
        throw new Error('FOK left remainder after pre-check passed');
      }
    }

    return events;
  }

  cancel(cmd: CancelOrderCommand, now: number = Date.now()): EngineEvent[] {
    const existing = this.book.get(cmd.orderId);
    if (!existing) return [];
    if (existing.userId !== cmd.userId) return []; // wrong owner — silent no-op
    const removed = this.book.cancel(cmd.orderId)!;
    return [this.makeCanceled(removed, now, 'USER')];
  }

  /**
   * Open resting orders for a user. O(N) over the book — fine for a learning
   * project at small scale; would want a per-user index in production.
   */
  getUserOrders(userId: string): Order[] {
    return this.book.ordersForUser(userId);
  }

  // ---------- Helpers ----------

  private wouldCross(order: Order): boolean {
    if (order.side === 'buy') {
      const bestAsk = this.book.bestAsk();
      return bestAsk !== undefined && order.price >= bestAsk;
    }
    const bestBid = this.book.bestBid();
    return bestBid !== undefined && order.price <= bestBid;
  }

  /**
   * Walks the opposite side accumulating qty at crossable prices,
   * SKIPPING resting orders owned by the same user (they'd trip STP
   * and never actually fill the incoming).
   */
  private fullyFillable(order: Order): boolean {
    const oppTree = order.side === 'buy' ? this.book.asks : this.book.bids;
    let available = 0n;
    for (const [price, level] of oppTree.entries()) {
      const crosses =
        order.type === 'MARKET' ||
        (order.side === 'buy' ? order.price >= price : order.price <= price);
      if (!crosses) break;

      let node = level.head;
      while (node) {
        if (node.order.userId !== order.userId) {
          available += node.order.remaining;
          if (available >= order.qty) return true;
        } else {
          // Same-user resting at the FRONT — under cancel-new STP, matching
          // would stop here. So FOK cannot fill past this point.
          if (node === level.head && available < order.qty) return false;
        }
        node = node.next;
      }
    }
    return available >= order.qty;
  }

  private makeRejected(
    cmd: NewOrderCommand,
    ts: number,
    reason: OrderRejectedEvent['reason']
  ): OrderRejectedEvent {
    return {
      kind: 'OrderRejected',
      seq: this.nextSeq(),
      ts,
      clientOrderId: cmd.clientOrderId,
      userId: cmd.userId,
      reason,
    };
  }

  private makeCanceled(
    order: Order,
    ts: number,
    reason: OrderCanceledEvent['reason']
  ): OrderCanceledEvent {
    return {
      kind: 'OrderCanceled',
      seq: this.nextSeq(),
      ts,
      orderId: order.orderId,
      userId: order.userId,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      remaining: order.remaining,
      reason,
    };
  }
}
