import { describe, it, expect } from 'vitest';
import {
  BTC_ONE,
  PRICE_ONE,
  type EngineEvent,
} from '@exchange/common';
import { MatchingEngine } from './matcher.js';
import { replayInto, EventLog } from './eventLog.js';

const PRICE = (usdc: number): bigint =>
  BigInt(Math.round(usdc * Number(PRICE_ONE)));
const QTY = (btc: number): bigint =>
  BigInt(Math.round(btc * Number(BTC_ONE)));

/**
 * Stub log that holds events in memory but exposes the same `readAll`
 * iterator shape as the Redis-backed log. Lets us round-trip without
 * needing a live Redis instance for replay correctness tests.
 */
function inMemoryLog(events: EngineEvent[]): EventLog {
  return {
    async append() {
      /* no-op for these tests */
    },
    async *readAll() {
      for (const e of events) yield e;
    },
  } as unknown as EventLog;
}

function describeBook(eng: MatchingEngine): {
  bids: [string, string][];
  asks: [string, string][];
} {
  return {
    bids: eng.book.depth('buy', 100).map(([p, q]) => [p.toString(), q.toString()]),
    asks: eng.book.depth('sell', 100).map(([p, q]) => [p.toString(), q.toString()]),
  };
}

describe('replayInto', () => {
  it('rebuilds book from a sequence of OrderAccepted events', () => {
    const a = new MatchingEngine();
    const evs: EngineEvent[] = [
      ...a.submit({
        clientOrderId: '1', userId: 'm1', symbol: 'BTC-USDC',
        side: 'buy', type: 'LIMIT', price: PRICE(100), qty: QTY(1),
      }),
      ...a.submit({
        clientOrderId: '2', userId: 'm2', symbol: 'BTC-USDC',
        side: 'sell', type: 'LIMIT', price: PRICE(101), qty: QTY(0.5),
      }),
    ];
    const b = new MatchingEngine();
    return replayInto(b, inMemoryLog(evs)).then(() => {
      expect(describeBook(b)).toEqual(describeBook(a));
      expect(b.currentSeq()).toBe(a.currentSeq());
    });
  });

  it('replays trades, leaving remainder in the book', async () => {
    const a = new MatchingEngine();
    const evs: EngineEvent[] = [
      ...a.submit({
        clientOrderId: '1', userId: 'm', symbol: 'BTC-USDC',
        side: 'sell', type: 'LIMIT', price: PRICE(100), qty: QTY(1),
      }),
      ...a.submit({
        clientOrderId: '2', userId: 't', symbol: 'BTC-USDC',
        side: 'buy', type: 'LIMIT', price: PRICE(100), qty: QTY(0.3),
      }),
    ];
    const b = new MatchingEngine();
    await replayInto(b, inMemoryLog(evs));
    expect(describeBook(b)).toEqual(describeBook(a));
    expect(b.book.bestAsk()).toBe(PRICE(100));
  });

  it('replays user cancels', async () => {
    const a = new MatchingEngine();
    const submitEvs = a.submit({
      clientOrderId: '1', userId: 'alice', symbol: 'BTC-USDC',
      side: 'buy', type: 'LIMIT', price: PRICE(100), qty: QTY(1),
    });
    const orderId = (submitEvs.find((e) => e.kind === 'OrderAccepted') as Extract<EngineEvent, { kind: 'OrderAccepted' }>).order.orderId;
    const cancelEvs = a.cancel({ orderId, userId: 'alice' });
    const allEvs = [...submitEvs, ...cancelEvs];

    const b = new MatchingEngine();
    await replayInto(b, inMemoryLog(allEvs));
    expect(describeBook(b)).toEqual(describeBook(a));
    expect(b.book.bestBid()).toBeUndefined();
  });

  it('replays IOC remainder cancels without resting', async () => {
    const a = new MatchingEngine();
    const evs = [
      ...a.submit({
        clientOrderId: '1', userId: 'm', symbol: 'BTC-USDC',
        side: 'sell', type: 'LIMIT', price: PRICE(100), qty: QTY(0.3),
      }),
      ...a.submit({
        clientOrderId: '2', userId: 't', symbol: 'BTC-USDC',
        side: 'buy', type: 'IOC', price: PRICE(100), qty: QTY(1),
      }),
    ];
    const b = new MatchingEngine();
    await replayInto(b, inMemoryLog(evs));
    expect(describeBook(b)).toEqual(describeBook(a));
    // The IOC remainder must NOT be in either book.
    expect(b.book.bestBid()).toBeUndefined();
  });

  it('round-trips a multi-level scenario', async () => {
    const a = new MatchingEngine();
    const ops: EngineEvent[] = [];
    ops.push(...a.submit({ clientOrderId: '1', userId: 'mm1', symbol: 'BTC-USDC', side: 'sell', type: 'LIMIT', price: PRICE(101), qty: QTY(1) }));
    ops.push(...a.submit({ clientOrderId: '2', userId: 'mm1', symbol: 'BTC-USDC', side: 'sell', type: 'LIMIT', price: PRICE(102), qty: QTY(1) }));
    ops.push(...a.submit({ clientOrderId: '3', userId: 'mm2', symbol: 'BTC-USDC', side: 'buy', type: 'LIMIT', price: PRICE(99), qty: QTY(1) }));
    ops.push(...a.submit({ clientOrderId: '4', userId: 'mm2', symbol: 'BTC-USDC', side: 'buy', type: 'LIMIT', price: PRICE(98), qty: QTY(1) }));
    // Taker eats one level
    ops.push(...a.submit({ clientOrderId: '5', userId: 't', symbol: 'BTC-USDC', side: 'buy', type: 'LIMIT', price: PRICE(101), qty: QTY(0.6) }));

    const b = new MatchingEngine();
    await replayInto(b, inMemoryLog(ops));
    expect(describeBook(b)).toEqual(describeBook(a));
  });

  it('preserves the seq counter so new orders continue numbering', async () => {
    const a = new MatchingEngine();
    const evs = a.submit({
      clientOrderId: '1', userId: 'alice', symbol: 'BTC-USDC',
      side: 'buy', type: 'LIMIT', price: PRICE(100), qty: QTY(1),
    });
    const lastSeq = evs[evs.length - 1]!.seq;
    const b = new MatchingEngine();
    await replayInto(b, inMemoryLog(evs));
    const nextEvs = b.submit({
      clientOrderId: '2', userId: 'alice', symbol: 'BTC-USDC',
      side: 'sell', type: 'LIMIT', price: PRICE(101), qty: QTY(1),
    });
    expect(nextEvs[0]!.seq).toBe(lastSeq + 1);
  });

  it('preserves clientOrderId dedup across replay', async () => {
    const a = new MatchingEngine();
    const evs = a.submit({
      clientOrderId: 'dup', userId: 'alice', symbol: 'BTC-USDC',
      side: 'buy', type: 'LIMIT', price: PRICE(100), qty: QTY(1),
    });
    const b = new MatchingEngine();
    await replayInto(b, inMemoryLog(evs));
    const retry = b.submit({
      clientOrderId: 'dup', userId: 'alice', symbol: 'BTC-USDC',
      side: 'sell', type: 'LIMIT', price: PRICE(200), qty: QTY(1),
    });
    expect(retry[0]!.kind).toBe('OrderRejected');
    expect((retry[0] as Extract<EngineEvent, { kind: 'OrderRejected' }>).reason).toBe(
      'DUPLICATE_CLIENT_ORDER_ID'
    );
  });
});
