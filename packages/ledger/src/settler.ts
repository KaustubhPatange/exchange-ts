import {
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
  constructor(private readonly accounts: Accounts) {}

  apply(ev: EngineEvent, mode: SettlerMode): void {
    switch (ev.kind) {
      case 'OrderAccepted':
        if (mode === 'replay') this.lockForOrder(ev);
        return;
      case 'OrderRejected':
        return;
      case 'Trade':
        this.settle(ev);
        return;
      case 'OrderCanceled':
        this.releaseRemainder(ev);
        return;
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
  }

  private releaseRemainder(ev: OrderCanceledEvent): void {
    const asset: Asset = ev.side === 'buy' ? 'USDC' : 'BTC';
    const amount =
      ev.side === 'buy' ? notionalQuote(ev.price, ev.remaining) : ev.remaining;
    if (amount > 0n) this.accounts.release(ev.userId, asset, amount);
  }
}
