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
 *
 * Why this split? In live operation, the gateway must reserve BEFORE
 * sending to the engine to avoid races between concurrent orders. The
 * engine event then arrives a moment later and would double-count if the
 * settler reserved again. On cold boot there is no gateway in the loop
 * for past events, so we must do the reserves ourselves.
 *
 * Either way, by the time we finish processing events up to seq N, the
 * balance state is deterministic and equal across replay and live paths.
 */

export type SettlerMode = 'replay' | 'live';

export const TAKER_FEE_BPS = 5n;  // 0.05%
export const MAKER_FEE_BPS = 0n;  // no rebate in v1

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
  lockForOrder(ev: OrderAcceptedEvent): void {
    const o = ev.order;
    if (o.side === 'buy') {
      const notional = notionalQuote(o.price, o.qty);
      this.accounts.reserve(o.userId, 'USDC', notional);
    } else {
      this.accounts.reserve(o.userId, 'BTC', o.qty);
    }
  }

  settle(ev: TradeEvent): void {
    const notional = notionalQuote(ev.price, ev.qty);

    // Identify buyer/seller from the aggressor flag on the trade.
    const buyer = ev.aggressor === 'buy' ? ev.takerUserId : ev.makerUserId;
    const seller = ev.aggressor === 'buy' ? ev.makerUserId : ev.takerUserId;
    const buyerIsTaker = ev.aggressor === 'buy';
    const sellerIsTaker = !buyerIsTaker;

    // Fees are paid in the asset RECEIVED. Maker pays MAKER_FEE_BPS, taker pays TAKER_FEE_BPS.
    const buyerFeeBps = buyerIsTaker ? TAKER_FEE_BPS : MAKER_FEE_BPS;
    const sellerFeeBps = sellerIsTaker ? TAKER_FEE_BPS : MAKER_FEE_BPS;
    const buyerFeeBtc = (ev.qty * buyerFeeBps) / 10_000n;
    const sellerFeeUsdc = (notional * sellerFeeBps) / 10_000n;

    // Buyer: pays locked USDC, receives free BTC (net of fee)
    this.accounts.debitLockedCreditFree(
      buyer,
      { asset: 'USDC', amount: notional },
      { asset: 'BTC', amount: ev.qty - buyerFeeBtc }
    );

    // Seller: pays locked BTC, receives free USDC (net of fee)
    this.accounts.debitLockedCreditFree(
      seller,
      { asset: 'BTC', amount: ev.qty },
      { asset: 'USDC', amount: notional - sellerFeeUsdc }
    );

    // Fees collected to a special "exchange" account so totals reconcile.
    if (buyerFeeBtc > 0n) {
      this.accounts.get('exchange', 'BTC');
      this.accounts.ensureUser('exchange').get('BTC')!.free += buyerFeeBtc;
    }
    if (sellerFeeUsdc > 0n) {
      this.accounts.ensureUser('exchange').get('USDC')!.free += sellerFeeUsdc;
    }
  }

  releaseRemainder(ev: OrderCanceledEvent): void {
    // The remainder still sitting in `locked` is determined entirely by the
    // order's side/price/remaining — it does not depend on what the gateway
    // originally reserved (because that reserve was exactly price*qty).
    const asset: Asset = ev.side === 'buy' ? 'USDC' : 'BTC';
    const amount =
      ev.side === 'buy' ? notionalQuote(ev.price, ev.remaining) : ev.remaining;
    if (amount > 0n) this.accounts.release(ev.userId, asset, amount);
  }
}
