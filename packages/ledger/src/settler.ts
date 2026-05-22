import {
  BTC_ONE,
  notionalQuote,
  type Asset,
  type EngineEvent,
  type OrderCanceledEvent,
  type OrderAcceptedEvent,
  type TradeEvent,
} from '@exchange/common';

import { Accounts } from './accounts.js';

/**
 * Settler — turns engine events into balance mutations.
 *
 * Two modes:
 *   - REPLAY:  on cold boot, walk every engine event from seq 0 and
 *              rebuild balances from scratch. We process OrderAccepted
 *              by performing the lock that the gateway would have done.
 *   - LIVE:    after replay, we ignore OrderAccepted and OrderRejected
 *              (the gateway is responsible for reserve/release of those
 *              in the request/response path). We only react to Trade
 *              (settle) and OrderCanceled (release remainder).
 */

export type SettlerMode = 'replay' | 'live';

export const TAKER_FEE_BPS = 5n;  // 0.05%; maker fee is 0 in v1

export class Settler {
  // Tracks resting/active BUY orders so we can release over-reservation
  // when a buy fills below its limit price (price improvement) and clean
  // up the entry when the order is fully consumed or canceled. We only
  // need to track buys because seller reservations are sized in BTC (qty
  // only — no price involved) so they can't be over-reserved.
  private readonly openBuys = new Map<string, { price: bigint; remaining: bigint }>();

  constructor(private readonly accounts: Accounts) {}

  clear(): void {
    this.openBuys.clear();
  }

  apply(ev: EngineEvent, mode: SettlerMode): void {
    switch (ev.kind) {
      case 'OrderAccepted':
        this.trackOrder(ev);
        if (mode === 'replay') this.lockForOrder(ev);
        return;
      case 'OrderRejected':
        return;
      case 'Trade':
        this.settle(ev);
        return;
      case 'OrderCanceled':
        this.releaseRemainder(ev);
        this.openBuys.delete(ev.orderId);
        return;
    }
  }

  private trackOrder(ev: OrderAcceptedEvent): void {
    const o = ev.order;
    if (o.side === 'buy' && o.type !== 'MARKET') {
      this.openBuys.set(o.orderId, { price: o.price, remaining: o.qty });
    }
  }

  /** Lock the funds that the gateway would have reserved for this order. */
  private lockForOrder(ev: OrderAcceptedEvent): void {
    const o = ev.order;
    if (o.side === 'buy') {
      this.accounts.reserve(o.userId, 'USDC', notionalQuote(o.price, o.qty));
    } else {
      this.accounts.reserve(o.userId, 'BTC', o.qty);
    }
  }

  private settle(ev: TradeEvent): void {
    const notional = notionalQuote(ev.price, ev.qty);
    const buyer = ev.aggressor === 'buy' ? ev.takerUserId : ev.makerUserId;
    const seller = ev.aggressor === 'buy' ? ev.makerUserId : ev.takerUserId;

    // Only the taker pays a fee, in the asset they receive.
    const buyerFeeBtc = ev.aggressor === 'buy' ? (ev.qty * TAKER_FEE_BPS) / 10_000n : 0n;
    const sellerFeeUsdc = ev.aggressor === 'sell' ? (notional * TAKER_FEE_BPS) / 10_000n : 0n;

    this.accounts.debitLockedCreditFree(
      buyer,
      { asset: 'USDC', amount: notional },
      { asset: 'BTC', amount: ev.qty - buyerFeeBtc }
    );
    this.accounts.debitLockedCreditFree(
      seller,
      { asset: 'BTC', amount: ev.qty },
      { asset: 'USDC', amount: notional - sellerFeeUsdc }
    );

    if (buyerFeeBtc > 0n) {
      this.accounts.ensureUser('exchange').get('BTC')!.free += buyerFeeBtc;
    }
    if (sellerFeeUsdc > 0n) {
      this.accounts.ensureUser('exchange').get('USDC')!.free += sellerFeeUsdc;
    }

    // Price improvement: if the buyer is the taker and the fill price is
    // below their limit, release the per-qty surplus that was locked at the
    // higher limit price. Maker buys fill at their own resting price, so
    // they never have surplus.
    if (ev.aggressor === 'buy') {
      const taker = this.openBuys.get(ev.takerOrderId);
      if (taker && taker.price > ev.price) {
        const surplus = ((taker.price - ev.price) * ev.qty) / BTC_ONE;
        if (surplus > 0n) this.accounts.release(ev.takerUserId, 'USDC', surplus);
      }
      this.decrementOpenBuy(ev.takerOrderId, ev.qty);
    } else {
      this.decrementOpenBuy(ev.makerOrderId, ev.qty);
    }
  }

  private decrementOpenBuy(orderId: string, qty: bigint): void {
    const entry = this.openBuys.get(orderId);
    if (!entry) return;
    entry.remaining -= qty;
    if (entry.remaining <= 0n) this.openBuys.delete(orderId);
  }

  private releaseRemainder(ev: OrderCanceledEvent): void {
    const asset: Asset = ev.side === 'buy' ? 'USDC' : 'BTC';
    const amount =
      ev.side === 'buy' ? notionalQuote(ev.price, ev.remaining) : ev.remaining;
    if (amount > 0n) this.accounts.release(ev.userId, asset, amount);
  }
}
