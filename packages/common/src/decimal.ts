/**
 * Money never touches JS `number`. Everything is bigint base units.
 *
 * For BTC-USDC:
 *   BTC qty: 8 decimals (1 BTC = 1e8 base units, "satoshi")
 *   USDC qty: 6 decimals (1 USDC = 1e6 base units, "micro-USDC")
 *
 * Price is encoded as: how many quote (USDC) base units per ONE WHOLE base
 * (BTC). So a price of "$67,234.50 per BTC" is 67234_500_000n (because
 * 67234.50 * 1e6 = 67234500000).
 *
 * Notional in quote base units:
 *   notional_quote = (price * qty_base) / BASE_ONE
 * where BASE_ONE = 10n ** 8n (1 BTC in base units).
 *
 * That way: price (1e6 per BTC) * qty (1e8 per BTC) / 1e8 = quote (1e6).
 */

export const BTC_DECIMALS = 8;
export const USDC_DECIMALS = 6;
export const PRICE_DECIMALS = USDC_DECIMALS;       // price quoted in USDC

export const BTC_ONE: bigint = 10n ** BigInt(BTC_DECIMALS);
export const USDC_ONE: bigint = 10n ** BigInt(USDC_DECIMALS);
export const PRICE_ONE: bigint = 10n ** BigInt(PRICE_DECIMALS);

export function toBaseUnits(value: string | number, decimals: number): bigint {
  const s = typeof value === 'number' ? value.toString() : value;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPartRaw, fracPartRaw = ''] = body.split('.');
  const intPart = intPartRaw ?? '0';
  if (fracPartRaw.length > decimals) {
    throw new Error(`too many decimals for value ${value} (max ${decimals})`);
  }
  const frac = fracPartRaw.padEnd(decimals, '0');
  const result = BigInt(intPart + frac);
  return neg ? -result : result;
}

export function fromBaseUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, '0');
  const cut = s.length - decimals;
  const intPart = s.slice(0, cut);
  const fracPart = s.slice(cut).replace(/0+$/, '');
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

/**
 * Compute the quote notional for a (price, qty) pair, in quote base units.
 * Rounds DOWN — the matching engine never invents value.
 */
export function notionalQuote(price: bigint, qtyBase: bigint): bigint {
  return (price * qtyBase) / BTC_ONE;
}
