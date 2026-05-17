import type { CandleAggregator, Candle } from './candles.js';

/**
 * Ticker — last price + 24h volume + 24h % change.
 *
 * Computed from the 1m candle history maintained by CandleAggregator,
 * so we don't need a second data structure.
 *
 * 24h window covers the most recent 1440 closed candles. If fewer than
 * 1440 candles exist (system hasn't been running for 24h yet), we use
 * what we have — the change % is still well-defined relative to the
 * oldest open we know about.
 */

export interface TickerSnapshot {
  lastPrice: string | null;
  open24h: string | null;
  high24h: string | null;
  low24h: string | null;
  volume24h: string;
  changePct24h: string;
}

const ONE_DAY_MIN = 24 * 60;

export function computeTicker(oneMin: CandleAggregator): TickerSnapshot {
  const candles: Candle[] = oneMin.recent(ONE_DAY_MIN);
  if (candles.length === 0) {
    return {
      lastPrice: null, open24h: null, high24h: null, low24h: null,
      volume24h: '0', changePct24h: '0',
    };
  }
  const last = candles[candles.length - 1]!;
  const first = candles[0]!;
  let high = BigInt(first.high);
  let low = BigInt(first.low);
  let vol = 0n;
  for (const c of candles) {
    const h = BigInt(c.high);
    const l = BigInt(c.low);
    if (h > high) high = h;
    if (l < low) low = l;
    vol += BigInt(c.volume);
  }
  const open = BigInt(first.open);
  const close = BigInt(last.close);
  // changePct as a fixed-point with 4 decimals: e.g. "12.3456" %.
  // (close - open) / open * 100 — done in bigint by scaling.
  const scaled = open > 0n ? ((close - open) * 1_000_000n) / open : 0n; // 4-dec * 100
  const changePct = formatScaledPercent(scaled);

  return {
    lastPrice: last.close,
    open24h: first.open,
    high24h: high.toString(),
    low24h: low.toString(),
    volume24h: vol.toString(),
    changePct24h: changePct,
  };
}

function formatScaledPercent(scaled: bigint): string {
  // scaled has 6 implied decimal places, and represents (delta/open) * 1e6.
  // To get a percent we multiply by 100 → divide by 1e4 to get a number with 2 decimals.
  // We'll output with 4 decimal places to keep precision.
  const pctMicros = scaled * 100n; // 6 decimal places now, percent units
  const neg = pctMicros < 0n;
  const abs = neg ? -pctMicros : pctMicros;
  const intPart = abs / 1_000_000n;
  const fracPart = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, 4);
  return `${neg ? '-' : ''}${intPart.toString()}.${fracPart}`;
}
