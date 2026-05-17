import type { Symbol } from './types.js';
import { BTC_DECIMALS, USDC_DECIMALS, PRICE_ONE } from './decimal.js';

/**
 * Static config for the single trading pair we support in v1.
 * In a real exchange this lives in a SymbolRegistry.
 */
export interface PairConfig {
  symbol: Symbol;
  base: 'BTC';
  quote: 'USDC';
  baseDecimals: number;
  quoteDecimals: number;
  /** Minimum increment for price, in price base units. */
  priceTick: bigint;
  /** Minimum increment for qty, in base asset base units. */
  qtyStep: bigint;
  /** Minimum order size in base asset base units. */
  minQty: bigint;
}

export const BTC_USDC: PairConfig = {
  symbol: 'BTC-USDC',
  base: 'BTC',
  quote: 'USDC',
  baseDecimals: BTC_DECIMALS,
  quoteDecimals: USDC_DECIMALS,
  // tick = 0.01 USDC => 10_000 base units
  priceTick: PRICE_ONE / 100n,
  // step = 0.00001 BTC => 1_000 base units
  qtyStep: 1_000n,
  // min order = 0.0001 BTC => 10_000 base units
  minQty: 10_000n,
};
