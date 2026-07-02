import { describe, it, expect, beforeEach } from 'vitest';
import {
  BTC_ONE,
  PRICE_ONE,
  notionalQuote,
  type NewOrderCommand,
  type EngineEvent,
  type TradeEvent,
  type OrderAcceptedEvent,
  type OrderCanceledEvent,
  type OrderRejectedEvent,
} from '@exchange/common';
import { MatchingEngine } from './matcher.js';

// ---------- Test helpers ----------

const PRICE = (usdc: number): bigint =>
  BigInt(Math.round(usdc * Number(PRICE_ONE)));
const QTY = (btc: number): bigint =>
  BigInt(Math.round(btc * Number(BTC_ONE)));

let cidCounter = 0;
const cid = (): string => `c_${++cidCounter}`;

function mkCmd(over: Partial<NewOrderCommand> = {}): NewOrderCommand {
  return {
    clientOrderId: cid(),
    userId: 'alice',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'LIMIT',
    price: PRICE(100),
    qty: QTY(1),
    ...over,
  };
}

const trades = (evs: EngineEvent[]): TradeEvent[] =>
  evs.filter((e): e is TradeEvent => e.kind === 'Trade');
const accepted = (evs: EngineEvent[]): OrderAcceptedEvent[] =>
  evs.filter((e): e is OrderAcceptedEvent => e.kind === 'OrderAccepted');
const canceled = (evs: EngineEvent[]): OrderCanceledEvent[] =>
  evs.filter((e): e is OrderCanceledEvent => e.kind === 'OrderCanceled');
const rejected = (evs: EngineEvent[]): OrderRejectedEvent[] =>
  evs.filter((e): e is OrderRejectedEvent => e.kind === 'OrderRejected');

let eng: MatchingEngine;
beforeEach(() => {
  eng = new MatchingEngine();
  cidCounter = 0;
});

// ---------- Validation ----------

describe('validation', () => {
  it('rejects unknown symbol', () => {
    const evs = eng.submit(mkCmd({ symbol: 'ETH-USDC' as never }));
    expect(rejected(evs)[0]?.reason).toBe('UNKNOWN_SYMBOL');
  });

  it('rejects zero qty', () => {
    const evs = eng.submit(mkCmd({ qty: 0n }));
    expect(rejected(evs)[0]?.reason).toBe('INVALID_QTY');
  });

  it('rejects negative qty', () => {
    const evs = eng.submit(mkCmd({ qty: -1n }));
    expect(rejected(evs)[0]?.reason).toBe('INVALID_QTY');
  });

  it('rejects missing price for LIMIT', () => {
    const evs = eng.submit(mkCmd({ price: undefined }));
    expect(rejected(evs)[0]?.reason).toBe('INVALID_PRICE');
  });

  it('rejects zero price for LIMIT', () => {
    const evs = eng.submit(mkCmd({ price: 0n }));
    expect(rejected(evs)[0]?.reason).toBe('INVALID_PRICE');
  });

  it('rejects duplicate clientOrderId for the same user', () => {
    const c = mkCmd();
    eng.submit(c);
    const evs = eng.submit(c);
    expect(rejected(evs)[0]?.reason).toBe('DUPLICATE_CLIENT_ORDER_ID');
  });

  it('allows the SAME clientOrderId from a DIFFERENT user', () => {
    const c1 = mkCmd({ userId: 'alice', clientOrderId: 'x' });
    const c2 = mkCmd({ userId: 'bob', clientOrderId: 'x' });
    expect(rejected(eng.submit(c1))).toHaveLength(0);
    expect(rejected(eng.submit(c2))).toHaveLength(0);
  });
});

// ---------- Resting & top of book ----------

describe('resting', () => {
  it('rests a LIMIT buy that does not cross', () => {
    const evs = eng.submit(mkCmd({ side: 'buy', price: PRICE(100), qty: QTY(1) }));
    expect(accepted(evs)).toHaveLength(1);
    expect(trades(evs)).toHaveLength(0);
    expect(eng.book.bestBid()).toBe(PRICE(100));
  });

  it('rests a LIMIT sell that does not cross', () => {
    const evs = eng.submit(mkCmd({ side: 'sell', price: PRICE(101), qty: QTY(1) }));
    expect(trades(evs)).toHaveLength(0);
    expect(eng.book.bestAsk()).toBe(PRICE(101));
  });

  it('preserves spread (best bid < best ask)', () => {
    eng.submit(mkCmd({ side: 'buy', price: PRICE(100) }));
    eng.submit(mkCmd({ side: 'sell', price: PRICE(101) }));
    expect(eng.book.bestBid()).toBe(PRICE(100));
    expect(eng.book.bestAsk()).toBe(PRICE(101));
  });
});

// ---------- Crossing & matching ----------

describe('matching', () => {
  it('crosses a LIMIT buy against a resting ask', () => {
    eng.submit(mkCmd({ userId: 'maker', side: 'sell', price: PRICE(100), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 'taker', side: 'buy', price: PRICE(101), qty: QTY(1) })
    );
    const ts = trades(evs);
    expect(ts).toHaveLength(1);
    expect(ts[0]?.price).toBe(PRICE(100)); // executes at maker's price (taker improved)
    expect(ts[0]?.qty).toBe(QTY(1));
    expect(ts[0]?.aggressor).toBe('buy');
    expect(eng.book.bestAsk()).toBeUndefined();
    expect(eng.book.bestBid()).toBeUndefined();
  });

  it('crosses a LIMIT sell against a resting bid', () => {
    eng.submit(mkCmd({ userId: 'maker', side: 'buy', price: PRICE(100), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 'taker', side: 'sell', price: PRICE(99), qty: QTY(1) })
    );
    const ts = trades(evs);
    expect(ts).toHaveLength(1);
    expect(ts[0]?.price).toBe(PRICE(100)); // taker improved; executes at maker price
    expect(ts[0]?.aggressor).toBe('sell');
  });

  it('partial fill — incoming larger than top', () => {
    eng.submit(mkCmd({ userId: 'm', side: 'sell', price: PRICE(100), qty: QTY(0.5) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', price: PRICE(100), qty: QTY(1) })
    );
    expect(trades(evs)).toHaveLength(1);
    expect(trades(evs)[0]?.qty).toBe(QTY(0.5));
    // Remainder rests on the bid side at 100
    expect(eng.book.bestBid()).toBe(PRICE(100));
    expect(eng.book.bestAsk()).toBeUndefined();
  });

  it('partial fill — incoming smaller than top', () => {
    eng.submit(mkCmd({ userId: 'm', side: 'sell', price: PRICE(100), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', price: PRICE(100), qty: QTY(0.3) })
    );
    expect(trades(evs)[0]?.qty).toBe(QTY(0.3));
    // Maker still has 0.7 on the ask
    expect(eng.book.bestAsk()).toBe(PRICE(100));
    expect(eng.book.bestBid()).toBeUndefined();
  });

  it('walks multiple levels until filled', () => {
    eng.submit(mkCmd({ userId: 'a', side: 'sell', price: PRICE(100), qty: QTY(0.4) }));
    eng.submit(mkCmd({ userId: 'b', side: 'sell', price: PRICE(101), qty: QTY(0.4) }));
    eng.submit(mkCmd({ userId: 'c', side: 'sell', price: PRICE(102), qty: QTY(0.4) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', price: PRICE(102), qty: QTY(1) })
    );
    const ts = trades(evs);
    expect(ts.map((t) => t.price)).toEqual([PRICE(100), PRICE(101), PRICE(102)]);
    expect(ts.map((t) => t.qty)).toEqual([QTY(0.4), QTY(0.4), QTY(0.2)]);
    // 0.2 remaining at 102 on the ask
    expect(eng.book.bestAsk()).toBe(PRICE(102));
  });

  it('honors price-time priority at the same level', () => {
    eng.submit(mkCmd({ userId: 'first', side: 'sell', price: PRICE(100), qty: QTY(0.5) }));
    eng.submit(mkCmd({ userId: 'second', side: 'sell', price: PRICE(100), qty: QTY(0.5) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', price: PRICE(100), qty: QTY(0.3) })
    );
    // The FIRST resting order should fill (it arrived earlier).
    expect(trades(evs)[0]?.makerUserId).toBe('first');
  });

  it('stops when no longer crosses (does not eat unrelated levels)', () => {
    eng.submit(mkCmd({ userId: 'a', side: 'sell', price: PRICE(100), qty: QTY(0.5) }));
    eng.submit(mkCmd({ userId: 'b', side: 'sell', price: PRICE(105), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', price: PRICE(101), qty: QTY(1) })
    );
    // Should only eat the 100 level, then rest the remainder at 101.
    expect(trades(evs)).toHaveLength(1);
    expect(trades(evs)[0]?.price).toBe(PRICE(100));
    expect(eng.book.bestBid()).toBe(PRICE(101));
    expect(eng.book.bestAsk()).toBe(PRICE(105));
  });
});

// ---------- Order types ----------

describe('MARKET', () => {
  it('eats available liquidity at any price', () => {
    eng.submit(mkCmd({ userId: 'a', side: 'sell', price: PRICE(100), qty: QTY(0.5) }));
    eng.submit(mkCmd({ userId: 'b', side: 'sell', price: PRICE(200), qty: QTY(0.5) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'MARKET', price: undefined, qty: QTY(1) })
    );
    const ts = trades(evs);
    expect(ts.map((t) => t.price)).toEqual([PRICE(100), PRICE(200)]);
    expect(eng.book.bestAsk()).toBeUndefined();
    expect(eng.book.bestBid()).toBeUndefined();
  });

  it('cancels remainder with MARKET_NO_LIQUIDITY when book runs out', () => {
    eng.submit(mkCmd({ userId: 'a', side: 'sell', price: PRICE(100), qty: QTY(0.3) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'MARKET', price: undefined, qty: QTY(1) })
    );
    expect(trades(evs)).toHaveLength(1);
    expect(canceled(evs)[0]?.reason).toBe('MARKET_NO_LIQUIDITY');
    expect(canceled(evs)[0]?.remaining).toBe(QTY(0.7));
  });

  it('never rests, even with no fills', () => {
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'MARKET', price: undefined, qty: QTY(1) })
    );
    expect(trades(evs)).toHaveLength(0);
    expect(canceled(evs)[0]?.reason).toBe('MARKET_NO_LIQUIDITY');
    expect(eng.book.bestBid()).toBeUndefined();
  });
});

describe('IOC', () => {
  it('matches what it can, cancels the rest', () => {
    eng.submit(mkCmd({ userId: 'm', side: 'sell', price: PRICE(100), qty: QTY(0.4) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'IOC', price: PRICE(100), qty: QTY(1) })
    );
    expect(trades(evs)[0]?.qty).toBe(QTY(0.4));
    expect(canceled(evs)[0]?.reason).toBe('IOC_REMAINDER');
    expect(canceled(evs)[0]?.remaining).toBe(QTY(0.6));
    expect(eng.book.bestBid()).toBeUndefined();
  });

  it('respects its limit price (does not eat through)', () => {
    eng.submit(mkCmd({ userId: 'm', side: 'sell', price: PRICE(101), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'IOC', price: PRICE(100), qty: QTY(1) })
    );
    expect(trades(evs)).toHaveLength(0);
    expect(canceled(evs)[0]?.reason).toBe('IOC_REMAINDER');
  });
});

describe('FOK', () => {
  it('fills entirely when liquidity is sufficient', () => {
    eng.submit(mkCmd({ userId: 'a', side: 'sell', price: PRICE(100), qty: QTY(0.5) }));
    eng.submit(mkCmd({ userId: 'b', side: 'sell', price: PRICE(101), qty: QTY(0.5) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'FOK', price: PRICE(101), qty: QTY(1) })
    );
    expect(trades(evs)).toHaveLength(2);
    expect(canceled(evs)).toHaveLength(0);
    expect(rejected(evs)).toHaveLength(0);
  });

  it('rejects when not enough liquidity at price', () => {
    eng.submit(mkCmd({ userId: 'a', side: 'sell', price: PRICE(100), qty: QTY(0.5) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'FOK', price: PRICE(100), qty: QTY(1) })
    );
    expect(rejected(evs)[0]?.reason).toBe('FOK_NOT_FILLABLE');
    expect(trades(evs)).toHaveLength(0);
    // Book unchanged
    expect(eng.book.bestAsk()).toBe(PRICE(100));
  });

  it('rejects when crossable liquidity exists but at worse price than limit', () => {
    eng.submit(mkCmd({ userId: 'a', side: 'sell', price: PRICE(105), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'FOK', price: PRICE(100), qty: QTY(1) })
    );
    expect(rejected(evs)[0]?.reason).toBe('FOK_NOT_FILLABLE');
  });

  it('rejects when a same-user order sits mid-level and STP would stop the fill', () => {
    // Same price level, time order: other(0.3), self(0.5), other(1.0).
    // Match consumes the first other, then hits the self order → STP stops.
    // Only 0.3 fillable < 1.0, so FOK must reject despite the trailing 1.0.
    eng.submit(mkCmd({ userId: 'a', side: 'sell', price: PRICE(100), qty: QTY(0.3) }));
    eng.submit(mkCmd({ userId: 't', side: 'sell', price: PRICE(100), qty: QTY(0.5) }));
    eng.submit(mkCmd({ userId: 'b', side: 'sell', price: PRICE(100), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'FOK', price: PRICE(100), qty: QTY(1) })
    );
    expect(rejected(evs)[0]?.reason).toBe('FOK_NOT_FILLABLE');
    expect(trades(evs)).toHaveLength(0);
    // Book untouched.
    expect(eng.book.bestAsk()).toBe(PRICE(100));
  });
});

describe('POST_ONLY', () => {
  it('rejects when it would cross', () => {
    eng.submit(mkCmd({ userId: 'm', side: 'sell', price: PRICE(100), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'POST_ONLY', price: PRICE(100), qty: QTY(1) })
    );
    expect(rejected(evs)[0]?.reason).toBe('POST_ONLY_WOULD_CROSS');
  });

  it('rests when it would not cross', () => {
    eng.submit(mkCmd({ userId: 'm', side: 'sell', price: PRICE(101), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 't', side: 'buy', type: 'POST_ONLY', price: PRICE(100), qty: QTY(1) })
    );
    expect(accepted(evs)).toHaveLength(1);
    expect(eng.book.bestBid()).toBe(PRICE(100));
  });
});

// ---------- Self-Trade Prevention ----------

describe('STP (cancel-new)', () => {
  it('cancels the new order when it would match own resting', () => {
    eng.submit(mkCmd({ userId: 'alice', side: 'sell', price: PRICE(100), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 'alice', side: 'buy', price: PRICE(100), qty: QTY(1) })
    );
    expect(trades(evs)).toHaveLength(0);
    expect(canceled(evs)[0]?.reason).toBe('STP');
    expect(eng.book.bestAsk()).toBe(PRICE(100)); // own resting untouched
  });

  it('fills against others first, then STP-cancels remainder', () => {
    eng.submit(mkCmd({ userId: 'bob', side: 'sell', price: PRICE(100), qty: QTY(0.4) }));
    eng.submit(mkCmd({ userId: 'alice', side: 'sell', price: PRICE(100), qty: QTY(0.6) }));
    const evs = eng.submit(
      mkCmd({ userId: 'alice', side: 'buy', price: PRICE(100), qty: QTY(1) })
    );
    expect(trades(evs)).toHaveLength(1);
    expect(trades(evs)[0]?.makerUserId).toBe('bob');
    expect(trades(evs)[0]?.qty).toBe(QTY(0.4));
    expect(canceled(evs)[0]?.reason).toBe('STP');
    expect(canceled(evs)[0]?.remaining).toBe(QTY(0.6));
    // Alice's resting sell remains
    expect(eng.book.bestAsk()).toBe(PRICE(100));
  });

  it('FOK with own resting at front is not fillable (STP counted as unavailable)', () => {
    eng.submit(mkCmd({ userId: 'alice', side: 'sell', price: PRICE(100), qty: QTY(1) }));
    const evs = eng.submit(
      mkCmd({ userId: 'alice', side: 'buy', type: 'FOK', price: PRICE(100), qty: QTY(1) })
    );
    expect(rejected(evs)[0]?.reason).toBe('FOK_NOT_FILLABLE');
  });
});

// ---------- Cancel by id ----------

describe('cancel', () => {
  it('cancels a resting order by id', () => {
    const evs = eng.submit(mkCmd({ side: 'buy', price: PRICE(100), qty: QTY(1) }));
    const orderId = accepted(evs)[0]!.order.orderId;
    const cancelEvs = eng.cancel({ orderId, userId: 'alice' });
    expect(cancelEvs[0]?.kind).toBe('OrderCanceled');
    expect((cancelEvs[0] as OrderCanceledEvent).reason).toBe('USER');
    expect(eng.book.bestBid()).toBeUndefined();
  });

  it('is a no-op for unknown order id', () => {
    expect(eng.cancel({ orderId: 'missing', userId: 'alice' })).toEqual([]);
  });

  it('is a no-op when wrong owner attempts to cancel', () => {
    const evs = eng.submit(mkCmd({ side: 'buy', price: PRICE(100), qty: QTY(1) }));
    const orderId = accepted(evs)[0]!.order.orderId;
    expect(eng.cancel({ orderId, userId: 'mallory' })).toEqual([]);
    expect(eng.book.bestBid()).toBe(PRICE(100));
  });

  it('reports the correct remaining at cancel time after a partial fill', () => {
    eng.submit(mkCmd({ userId: 'm', side: 'buy', price: PRICE(100), qty: QTY(1) }));
    // Eat 0.3 of it
    eng.submit(mkCmd({ userId: 't', side: 'sell', price: PRICE(100), qty: QTY(0.3) }));
    // Cancel the rest
    const bestBidOrder = eng.book['refs' as never] as never; // not used; just illustrative
    void bestBidOrder;
    // Find m's order id by scanning the book head
    const top = eng.book.peekTopOrder('buy')!;
    const cancelEvs = eng.cancel({ orderId: top.orderId, userId: 'm' });
    expect((cancelEvs[0] as OrderCanceledEvent).remaining).toBe(QTY(0.7));
  });
});

// ---------- Sequence numbers ----------

describe('sequence numbers', () => {
  it('assigns monotonically increasing seq to every emitted event', () => {
    const seqs: number[] = [];
    seqs.push(...eng.submit(mkCmd({ side: 'sell', price: PRICE(101) })).map((e) => e.seq));
    seqs.push(...eng.submit(mkCmd({ side: 'buy', price: PRICE(101) })).map((e) => e.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBe(seqs[i - 1]! + 1);
    }
  });
});

// ---------- Notional sanity ----------

describe('notional', () => {
  it('computes USDC notional correctly', () => {
    // 1 BTC @ $100 -> 100 USDC (= 100_000_000 base units)
    const n = notionalQuote(PRICE(100), QTY(1));
    expect(n).toBe(100n * 1_000_000n);
  });

  it('handles fractional qty', () => {
    // 0.5 BTC @ $100 -> 50 USDC
    const n = notionalQuote(PRICE(100), QTY(0.5));
    expect(n).toBe(50n * 1_000_000n);
  });
});
