import { BTC_ONE, USDC_ONE, type Asset } from '@exchange/common';

/**
 * Per-asset balance. `free` is spendable; `locked` is committed to an
 * open order. Total holdings = free + locked.
 */
export interface Balance {
  free: bigint;
  locked: bigint;
}

/**
 * Generous initial endowments — there's no deposit flow in v1, so every
 * user "appears" with these balances the first time they touch the system.
 * Plenty of room for market makers to quote and for you to play.
 */
export const INITIAL_BALANCES: Record<Asset, bigint> = {
  BTC: 100n * BTC_ONE,
  USDC: 10_000_000n * USDC_ONE,
};

/**
 * In-memory balance store with atomic reserve/release operations.
 *
 * Note: this is the gateway-facing surface. The Settler (in settler.ts)
 * mutates the same balances when consuming engine events. Because Node is
 * single-threaded and we never `await` between read-and-write inside one
 * operation, the operations below ARE atomic.
 */
export class Accounts {
  private readonly balances = new Map<string, Map<Asset, Balance>>();

  ensureUser(userId: string): Map<Asset, Balance> {
    let user = this.balances.get(userId);
    if (!user) {
      user = new Map();
      for (const asset of ['BTC', 'USDC'] as const) {
        user.set(asset, { free: INITIAL_BALANCES[asset], locked: 0n });
      }
      this.balances.set(userId, user);
    }
    return user;
  }

  get(userId: string, asset: Asset): Balance {
    return this.ensureUser(userId).get(asset)!;
  }

  snapshot(userId: string): Record<Asset, Balance> {
    const u = this.ensureUser(userId);
    return {
      BTC: { ...u.get('BTC')! },
      USDC: { ...u.get('USDC')! },
    };
  }

  /** Move `amount` from free → locked. Throws if insufficient. */
  reserve(userId: string, asset: Asset, amount: bigint): void {
    if (amount <= 0n) throw new Error('reserve amount must be positive');
    const bal = this.get(userId, asset);
    if (bal.free < amount) {
      throw new InsufficientFundsError(userId, asset, amount, bal.free);
    }
    bal.free -= amount;
    bal.locked += amount;
  }

  /** Move `amount` from locked → free. Throws if insufficient. */
  release(userId: string, asset: Asset, amount: bigint): void {
    if (amount <= 0n) throw new Error('release amount must be positive');
    const bal = this.get(userId, asset);
    if (bal.locked < amount) {
      throw new Error(
        `release: user ${userId} has locked ${bal.locked} < ${amount} ${asset}`
      );
    }
    bal.locked -= amount;
    bal.free += amount;
  }

  /** Settle a fill: decrease locked of paid asset, increase free of received asset. */
  debitLockedCreditFree(
    userId: string,
    paid: { asset: Asset; amount: bigint },
    received: { asset: Asset; amount: bigint }
  ): void {
    const paidBal = this.get(userId, paid.asset);
    if (paidBal.locked < paid.amount) {
      throw new Error(
        `settle: ${userId} locked ${paid.amount} > ${paidBal.locked} ${paid.asset}`
      );
    }
    paidBal.locked -= paid.amount;
    const recvBal = this.get(userId, received.asset);
    recvBal.free += received.amount;
  }
}

export class InsufficientFundsError extends Error {
  constructor(
    public readonly userId: string,
    public readonly asset: Asset,
    public readonly requested: bigint,
    public readonly available: bigint
  ) {
    super(
      `insufficient ${asset} for ${userId}: requested ${requested}, free ${available}`
    );
    this.name = 'InsufficientFundsError';
  }
}
