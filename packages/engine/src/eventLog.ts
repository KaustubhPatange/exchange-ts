import type Redis from 'ioredis';
import {
  deserializeEvent,
  serializeEvent,
  type EngineEvent,
  type Order,
} from '@exchange/common';

import type { MatchingEngine } from './matcher.js';

/**
 * The append-only event log, backed by a Redis Stream named `engine.events`.
 *
 * This is the source of truth for the entire exchange. Everything else —
 * the order book, ledger balances, the L2 view in market-data — is a
 * derived projection of these events.
 *
 * On engine startup we read the entire stream and rebuild the in-memory
 * book via {@link replayInto}. After replay we begin appending new events
 * (assigned with the resumed seq counter) for every order processed.
 */
export class EventLog {
  constructor(
    private readonly redis: Redis,
    private readonly streamKey: string = 'engine.events'
  ) {}

  /**
   * Append to the durable stream AND publish on a pub/sub channel for
   * services that want low-latency fan-out (gateway → WS clients) without
   * the overhead of XREAD-BLOCK on every connection.
   *
   * The stream is the source of truth; the pub/sub fanout is best-effort
   * (subscribers that miss messages will catch up next time they read
   * the stream from their cursor).
   */
  async append(event: EngineEvent): Promise<void> {
    const payload = serializeEvent(event);
    await this.redis.xadd(this.streamKey, '*', 'data', payload);
    await this.redis.publish(`${this.streamKey}.live`, payload);
  }

  /**
   * Iterate through every event currently in the stream, oldest first.
   * Pages with XRANGE so we don't have to hold the whole log in memory.
   */
  async *readAll(): AsyncGenerator<EngineEvent> {
    let from: string = '-';
    const PAGE = 1000;
    while (true) {
      const result = (await this.redis.xrange(
        this.streamKey,
        from,
        '+',
        'COUNT',
        PAGE
      )) as [string, string[]][];
      if (!result || result.length === 0) return;
      for (const [id, fields] of result) {
        const dataIdx = fields.indexOf('data');
        if (dataIdx < 0 || dataIdx + 1 >= fields.length) continue;
        yield deserializeEvent(fields[dataIdx + 1]!);
        // exclusive next cursor: bump the millisecond-part by one is fragile;
        // simpler to pass the same id with the special "(" prefix.
        from = `(${id}`;
      }
      if (result.length < PAGE) return;
    }
  }
}

/**
 * Replay state from the event log into a fresh MatchingEngine.
 *
 * Strategy: each call to engine.submit() produces a CONTIGUOUS BLOCK of
 * events: one OrderAccepted/OrderRejected, followed by zero or more
 * Trade events for that submission, optionally terminated by an
 * OrderCanceled for the SAME orderId (when the remainder is killed by
 * IOC, STP, or MARKET_NO_LIQUIDITY).
 *
 * So as we walk the log:
 *   - On OrderAccepted: stash it as "pending" (the order from this
 *     submission that might end up resting).
 *   - On Trade: reduce the maker on the book (always at the head of its
 *     side at maker price by invariant) and reduce pending.remaining if
 *     it's the taker.
 *   - On OrderCanceled: if it's the terminal cancel for the pending
 *     submission, mark "do not rest"; otherwise it's a user-cancel of
 *     a previously-resting order — remove it directly.
 *   - On the next OrderAccepted/OrderRejected (or end of stream): if the
 *     pending order should rest (remaining > 0, not terminal-cancelled,
 *     type allows resting), insert it into the book.
 */
export async function replayInto(
  engine: MatchingEngine,
  log: EventLog
): Promise<number> {
  let lastSeq = 0;
  let pending: Order | null = null;
  let pendingCanceled = false;

  const flushPending = (): void => {
    if (
      pending &&
      !pendingCanceled &&
      pending.remaining > 0n &&
      (pending.type === 'LIMIT' || pending.type === 'POST_ONLY')
    ) {
      engine.book.rest(pending);
    }
    pending = null;
    pendingCanceled = false;
  };

  for await (const ev of log.readAll()) {
    lastSeq = ev.seq;

    switch (ev.kind) {
      case 'OrderAccepted': {
        flushPending();
        // Clone so the pending object we may insert into the book is not
        // shared with the event we just consumed.
        pending = { ...ev.order };
        engine.markClientOrderIdSeen(ev.order.userId, ev.order.clientOrderId);
        break;
      }
      case 'OrderRejected': {
        flushPending();
        // Rejected orders don't change book state.
        break;
      }
      case 'Trade': {
        // Reduce the maker on the book. By construction, the maker is the
        // head of its side at its level when the trade fires.
        const maker = engine.book.get(ev.makerOrderId);
        if (maker) engine.book.reduceTopOrder(maker.side, ev.qty);
        // Reduce the taker (the pending order from this submission).
        if (pending && pending.orderId === ev.takerOrderId) {
          pending.remaining -= ev.qty;
        }
        break;
      }
      case 'OrderCanceled': {
        if (pending && pending.orderId === ev.orderId) {
          // Terminal cancel for the current submission (IOC/STP/MARKET).
          pendingCanceled = true;
        } else {
          // User cancel of a previously-resting order.
          engine.book.cancel(ev.orderId);
        }
        break;
      }
    }
  }
  flushPending();
  engine.setSeq(lastSeq);
  return lastSeq;
}
