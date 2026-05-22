import { describe, it, expect, beforeEach } from 'vitest';
import {
  BTC_ONE,
  PRICE_ONE,
  USDC_ONE,
  notionalQuote,
  type EngineEvent,
  type Order,
} from '@exchange/common';
import { Accounts, INITIAL_BALANCES } from './accounts.js';
import { Settler, TAKER_FEE_BPS } from './settler.js';

const PRICE = (usdc: number): bigint =>
  BigInt(Math.round(usdc * Number(PRICE_ONE)));
const QTY = (btc: number): bigint =>
  BigInt(Math.round(btc * Number(BTC_ONE)));

let acc: Accounts;
let settler: Settler;

beforeEach(() => {
  acc = new Accounts();
  settler = new Settler(acc);
});

function order(over: Partial<Order>): Order {
  return {
    orderId: 'O_1',
    clientOrderId: 'c_1',
    userId: 'u',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'LIMIT',
    price: PRICE(100),
    qty: QTY(1),
    remaining: QTY(1),
    status: 'NEW',
    createdAt: 0,
    ...over,
  };
}

describe('Accounts', () => {
  it('seeds a user with initial balances on first touch', () => {
    const s = acc.snapshot('alice');
    expect(s.BTC.free).toBe(INITIAL_BALANCES.BTC);
    expect(s.USDC.free).toBe(INITIAL_BALANCES.USDC);
    expect(s.BTC.locked).toBe(0n);
    expect(s.USDC.locked).toBe(0n);
  });

  it('reserves and releases atomically', () => {
    acc.reserve('alice', 'USDC', 1_000n * USDC_ONE);
    const s1 = acc.snapshot('alice');
    expect(s1.USDC.free).toBe(INITIAL_BALANCES.USDC - 1_000n * USDC_ONE);
    expect(s1.USDC.locked).toBe(1_000n * USDC_ONE);

    acc.release('alice', 'USDC', 1_000n * USDC_ONE);
    const s2 = acc.snapshot('alice');
    expect(s2.USDC.free).toBe(INITIAL_BALANCES.USDC);
    expect(s2.USDC.locked).toBe(0n);
  });

  it('rejects reserving more than free', () => {
    expect(() =>
      acc.reserve('alice', 'BTC', INITIAL_BALANCES.BTC + 1n)
    ).toThrow(/insufficient/);
  });
});

describe('Settler.settle on Trade (buyer is taker)', () => {
  it('moves USDC out of buyer locked, BTC into buyer free (minus fee)', () => {
    // Setup: buyer pre-reserved 100 USDC (1 BTC * $100)
    const reserveUsdc = 100n * USDC_ONE;
    acc.reserve('buyer', 'USDC', reserveUsdc);
    acc.reserve('seller', 'BTC', QTY(1));

    const ev: EngineEvent = {
      kind: 'Trade', seq: 1, ts: 0, tradeId: 'T1', symbol: 'BTC-USDC',
      price: PRICE(100), qty: QTY(1), aggressor: 'buy',
      takerOrderId: 'TO', takerUserId: 'buyer', takerOrderType: 'LIMIT',
      makerOrderId: 'MO', makerUserId: 'seller',
    };
    settler.apply(ev, 'live');

    const b = acc.snapshot('buyer');
    expect(b.USDC.locked).toBe(0n);
    const expectedFee = (QTY(1) * TAKER_FEE_BPS) / 10_000n;
    expect(b.BTC.free).toBe(INITIAL_BALANCES.BTC + QTY(1) - expectedFee);

    const s = acc.snapshot('seller');
    expect(s.BTC.locked).toBe(0n);
    expect(s.USDC.free).toBe(INITIAL_BALANCES.USDC + 100n * USDC_ONE);
  });
});

describe('Settler.settle on Trade (seller is taker)', () => {
  it('charges taker fee from seller (USDC), no fee to buyer', () => {
    acc.reserve('buyer', 'USDC', 100n * USDC_ONE);
    acc.reserve('seller', 'BTC', QTY(1));

    const ev: EngineEvent = {
      kind: 'Trade', seq: 1, ts: 0, tradeId: 'T1', symbol: 'BTC-USDC',
      price: PRICE(100), qty: QTY(1), aggressor: 'sell',
      takerOrderId: 'TO', takerUserId: 'seller', takerOrderType: 'MARKET',
      makerOrderId: 'MO', makerUserId: 'buyer',
    };
    settler.apply(ev, 'live');

    const seller = acc.snapshot('seller');
    const notional = notionalQuote(PRICE(100), QTY(1));
    const expectedFee = (notional * TAKER_FEE_BPS) / 10_000n;
    expect(seller.USDC.free).toBe(INITIAL_BALANCES.USDC + notional - expectedFee);

    const buyer = acc.snapshot('buyer');
    expect(buyer.BTC.free).toBe(INITIAL_BALANCES.BTC + QTY(1)); // no fee
  });
});

describe('Settler.releaseRemainder on cancel', () => {
  it('releases price * remaining USDC for a buy', () => {
    const reserveUsdc = notionalQuote(PRICE(100), QTY(1));
    acc.reserve('alice', 'USDC', reserveUsdc);

    settler.apply(
      {
        kind: 'OrderCanceled', seq: 1, ts: 0,
        orderId: 'O', userId: 'alice', symbol: 'BTC-USDC',
        side: 'buy', price: PRICE(100), remaining: QTY(1), reason: 'USER',
      },
      'live'
    );
    const a = acc.snapshot('alice');
    expect(a.USDC.locked).toBe(0n);
    expect(a.USDC.free).toBe(INITIAL_BALANCES.USDC);
  });

  it('releases remaining BTC for a sell', () => {
    acc.reserve('alice', 'BTC', QTY(1));
    settler.apply(
      {
        kind: 'OrderCanceled', seq: 1, ts: 0,
        orderId: 'O', userId: 'alice', symbol: 'BTC-USDC',
        side: 'sell', price: PRICE(100), remaining: QTY(0.4), reason: 'IOC_REMAINDER',
      },
      'live'
    );
    const a = acc.snapshot('alice');
    expect(a.BTC.locked).toBe(QTY(0.6));
    expect(a.BTC.free).toBe(INITIAL_BALANCES.BTC - QTY(0.6));
  });
});

describe('Settler price improvement', () => {
  it('releases over-reservation when a buy taker fills below its limit', () => {
    // Gateway-style: gary reserves at his $70k limit for 1 BTC = 70k USDC.
    const limit = PRICE(70_000);
    const fill = PRICE(69_000);
    const reserved = notionalQuote(limit, QTY(1));
    acc.reserve('gary', 'USDC', reserved);
    acc.reserve('alice', 'BTC', QTY(1));

    // Settler must see OrderAccepted FIRST to learn gary's limit price.
    settler.apply(
      {
        kind: 'OrderAccepted', seq: 1, ts: 0,
        order: order({
          orderId: 'OG', clientOrderId: 'cG', userId: 'gary',
          side: 'buy', type: 'LIMIT', price: limit, qty: QTY(1), remaining: QTY(1),
        }),
      },
      'live'
    );

    settler.apply(
      {
        kind: 'Trade', seq: 2, ts: 0, tradeId: 'T1', symbol: 'BTC-USDC',
        price: fill, qty: QTY(1), aggressor: 'buy',
        takerOrderId: 'OG', takerUserId: 'gary', takerOrderType: 'LIMIT',
        makerOrderId: 'OA', makerUserId: 'alice',
      },
      'live'
    );

    const g = acc.snapshot('gary');
    expect(g.USDC.locked).toBe(0n);
    // Gary spent the actual fill notional, not the over-reserved limit notional.
    expect(g.USDC.free).toBe(INITIAL_BALANCES.USDC - notionalQuote(fill, QTY(1)));
  });

  it('does not release surplus for a maker buy filled at its own price', () => {
    // Alice is a resting BUY @ $69k; bob aggresses SELL.
    const price = PRICE(69_000);
    const reserved = notionalQuote(price, QTY(1));
    acc.reserve('alice', 'USDC', reserved);
    acc.reserve('bob', 'BTC', QTY(1));

    settler.apply(
      {
        kind: 'OrderAccepted', seq: 1, ts: 0,
        order: order({
          orderId: 'OA', clientOrderId: 'cA', userId: 'alice',
          side: 'buy', type: 'LIMIT', price, qty: QTY(1), remaining: QTY(1),
        }),
      },
      'live'
    );

    settler.apply(
      {
        kind: 'Trade', seq: 2, ts: 0, tradeId: 'T1', symbol: 'BTC-USDC',
        price, qty: QTY(1), aggressor: 'sell',
        takerOrderId: 'OB', takerUserId: 'bob', takerOrderType: 'LIMIT',
        makerOrderId: 'OA', makerUserId: 'alice',
      },
      'live'
    );

    const a = acc.snapshot('alice');
    expect(a.USDC.locked).toBe(0n);
    expect(a.USDC.free).toBe(INITIAL_BALANCES.USDC - reserved);
  });

  it('replay reconstructs balances correctly when buy fills below limit', () => {
    const limit = PRICE(70_000);
    const fill = PRICE(69_000);
    const events: EngineEvent[] = [
      {
        kind: 'OrderAccepted', seq: 1, ts: 0,
        order: order({
          orderId: 'OA', clientOrderId: 'cA', userId: 'alice',
          side: 'sell', type: 'LIMIT', price: fill, qty: QTY(1), remaining: QTY(1),
        }),
      },
      {
        kind: 'OrderAccepted', seq: 2, ts: 0,
        order: order({
          orderId: 'OG', clientOrderId: 'cG', userId: 'gary',
          side: 'buy', type: 'LIMIT', price: limit, qty: QTY(1), remaining: QTY(1),
        }),
      },
      {
        kind: 'Trade', seq: 3, ts: 0, tradeId: 'T1', symbol: 'BTC-USDC',
        price: fill, qty: QTY(1), aggressor: 'buy',
        takerOrderId: 'OG', takerUserId: 'gary', takerOrderType: 'LIMIT',
        makerOrderId: 'OA', makerUserId: 'alice',
      },
    ];
    for (const ev of events) settler.apply(ev, 'replay');

    const g = acc.snapshot('gary');
    expect(g.USDC.locked).toBe(0n);
    expect(g.USDC.free).toBe(INITIAL_BALANCES.USDC - notionalQuote(fill, QTY(1)));
  });
});

describe('Settler in replay mode (full event sequence)', () => {
  it('reconstructs balances from OrderAccepted + Trade events', () => {
    // Simulate: alice buys 1 BTC @ $100 from bob (alice taker, fully filled)
    const buyOrder = order({
      orderId: 'OA', clientOrderId: 'cA', userId: 'alice',
      side: 'buy', price: PRICE(100), qty: QTY(1), remaining: QTY(1),
    });
    const sellOrder = order({
      orderId: 'OB', clientOrderId: 'cB', userId: 'bob',
      side: 'sell', price: PRICE(100), qty: QTY(1), remaining: QTY(1),
    });
    const events: EngineEvent[] = [
      { kind: 'OrderAccepted', seq: 1, ts: 0, order: sellOrder },
      { kind: 'OrderAccepted', seq: 2, ts: 0, order: buyOrder },
      {
        kind: 'Trade', seq: 3, ts: 0, tradeId: 'T1', symbol: 'BTC-USDC',
        price: PRICE(100), qty: QTY(1), aggressor: 'buy',
        takerOrderId: 'OA', takerUserId: 'alice', takerOrderType: 'LIMIT',
        makerOrderId: 'OB', makerUserId: 'bob',
      },
    ];
    for (const ev of events) settler.apply(ev, 'replay');

    const a = acc.snapshot('alice');
    const b = acc.snapshot('bob');
    const notional = notionalQuote(PRICE(100), QTY(1));
    const buyerFee = (QTY(1) * TAKER_FEE_BPS) / 10_000n;
    expect(a.USDC.free).toBe(INITIAL_BALANCES.USDC - notional);
    expect(a.USDC.locked).toBe(0n);
    expect(a.BTC.free).toBe(INITIAL_BALANCES.BTC + QTY(1) - buyerFee);

    expect(b.BTC.free).toBe(INITIAL_BALANCES.BTC - QTY(1));
    expect(b.USDC.free).toBe(INITIAL_BALANCES.USDC + notional); // bob was maker, no fee
  });

  it('handles partial fill + cancel in replay', () => {
    // Alice IOC buy 1 BTC @ $100, only 0.3 BTC available from bob
    const buyOrder = order({
      orderId: 'OA', clientOrderId: 'cA', userId: 'alice',
      type: 'IOC', side: 'buy', price: PRICE(100), qty: QTY(1), remaining: QTY(1),
    });
    const sellOrder = order({
      orderId: 'OB', clientOrderId: 'cB', userId: 'bob',
      side: 'sell', price: PRICE(100), qty: QTY(0.3), remaining: QTY(0.3),
    });
    const events: EngineEvent[] = [
      { kind: 'OrderAccepted', seq: 1, ts: 0, order: sellOrder },
      { kind: 'OrderAccepted', seq: 2, ts: 0, order: buyOrder },
      {
        kind: 'Trade', seq: 3, ts: 0, tradeId: 'T1', symbol: 'BTC-USDC',
        price: PRICE(100), qty: QTY(0.3), aggressor: 'buy',
        takerOrderId: 'OA', takerUserId: 'alice', takerOrderType: 'IOC',
        makerOrderId: 'OB', makerUserId: 'bob',
      },
      {
        kind: 'OrderCanceled', seq: 4, ts: 0, orderId: 'OA', userId: 'alice',
        symbol: 'BTC-USDC', side: 'buy', price: PRICE(100), remaining: QTY(0.7),
        reason: 'IOC_REMAINDER',
      },
    ];
    for (const ev of events) settler.apply(ev, 'replay');

    const a = acc.snapshot('alice');
    expect(a.USDC.locked).toBe(0n);
    expect(a.BTC.locked).toBe(0n);
    // USDC: -0.3 notional (= -30 USDC) total
    expect(a.USDC.free).toBe(INITIAL_BALANCES.USDC - notionalQuote(PRICE(100), QTY(0.3)));
  });
});
