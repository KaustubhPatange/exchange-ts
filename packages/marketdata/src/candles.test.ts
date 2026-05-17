import { describe, it, expect } from 'vitest';
import { CandleAggregator } from './candles.js';
import { PRICE_ONE, BTC_ONE } from '@exchange/common';

const P = (n: number): bigint => BigInt(n) * PRICE_ONE;
const Q = (n: number): bigint => BigInt(n) * BTC_ONE;

const MIN = 60_000;

describe('CandleAggregator (1m)', () => {
  it('opens a new candle on the first trade', () => {
    const a = new CandleAggregator('1m', MIN);
    const evs = a.onTrade(P(100), Q(1), 0);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.kind).toBe('update');
    expect(evs[0]!.candle.open).toBe(P(100).toString());
    expect(evs[0]!.candle.high).toBe(P(100).toString());
    expect(evs[0]!.candle.close).toBe(P(100).toString());
    expect(evs[0]!.candle.volume).toBe(Q(1).toString());
  });

  it('updates the live candle on trades inside the same bucket', () => {
    const a = new CandleAggregator('1m', MIN);
    a.onTrade(P(100), Q(1), 0);
    const evs = a.onTrade(P(105), Q(2), 30_000);
    expect(evs).toHaveLength(1);
    const c = evs[0]!.candle;
    expect(c.open).toBe(P(100).toString());
    expect(c.high).toBe(P(105).toString());
    expect(c.low).toBe(P(100).toString());
    expect(c.close).toBe(P(105).toString());
    expect(c.volume).toBe(Q(3).toString());
    expect(c.trades).toBe(2);
  });

  it('tracks low correctly when a later trade dips below open', () => {
    const a = new CandleAggregator('1m', MIN);
    a.onTrade(P(100), Q(1), 0);
    const evs = a.onTrade(P(95), Q(1), 30_000);
    expect(evs[0]!.candle.low).toBe(P(95).toString());
  });

  it('rolls the bucket and emits close + new update at boundary', () => {
    const a = new CandleAggregator('1m', MIN);
    a.onTrade(P(100), Q(1), 0);
    const evs = a.onTrade(P(110), Q(1), MIN);
    expect(evs.map((e) => e.kind)).toEqual(['close', 'update']);
    // Closed candle is bucket 0
    expect(evs[0]!.candle.bucketStart).toBe(0);
    expect(evs[0]!.candle.close).toBe(P(100).toString());
    // New live is bucket 1
    expect(evs[1]!.candle.bucketStart).toBe(MIN);
    expect(evs[1]!.candle.open).toBe(P(110).toString());
  });

  it('backfills flat candles for skipped buckets', () => {
    const a = new CandleAggregator('1m', MIN);
    a.onTrade(P(100), Q(1), 0);
    // Skip directly to the 3rd bucket — buckets 1 and 2 had no trades.
    const evs = a.onTrade(P(110), Q(1), 3 * MIN);
    // Expect: close bucket 0; close flat bucket 1; close flat bucket 2; update bucket 3.
    expect(evs.map((e) => e.kind)).toEqual(['close', 'close', 'close', 'update']);
    expect(evs[1]!.candle.bucketStart).toBe(MIN);
    expect(evs[1]!.candle.open).toBe(P(100).toString());
    expect(evs[1]!.candle.high).toBe(P(100).toString());
    expect(evs[1]!.candle.low).toBe(P(100).toString());
    expect(evs[1]!.candle.close).toBe(P(100).toString());
    expect(evs[1]!.candle.volume).toBe('0');
    expect(evs[1]!.candle.trades).toBe(0);
    expect(evs[2]!.candle.bucketStart).toBe(2 * MIN);
    expect(evs[3]!.candle.bucketStart).toBe(3 * MIN);
  });

  it('tick() advances the live bar across the boundary when idle', () => {
    const a = new CandleAggregator('1m', MIN);
    a.onTrade(P(100), Q(1), 0);
    const evs = a.tick(2 * MIN); // wall clock is 2 minutes later, no trades
    // Should close bucket 0 with C=100, then close flat bucket 1 with C=100,
    // and open bucket 2 with O=100 (synthetic), V=0.
    expect(evs.map((e) => e.kind)).toEqual(['close', 'close', 'update']);
    expect(evs[2]!.candle.bucketStart).toBe(2 * MIN);
    expect(evs[2]!.candle.volume).toBe('0');
  });

  it('recent(n) returns history + current, oldest first', () => {
    const a = new CandleAggregator('1m', MIN);
    a.onTrade(P(100), Q(1), 0);
    a.onTrade(P(110), Q(1), MIN);
    a.onTrade(P(120), Q(1), 2 * MIN);
    const hist = a.recent(10);
    expect(hist).toHaveLength(3);
    expect(hist.map((c) => c.bucketStart)).toEqual([0, MIN, 2 * MIN]);
    expect(hist[2]!.close).toBe(P(120).toString());
  });

  it('ignores out-of-order trades', () => {
    const a = new CandleAggregator('1m', MIN);
    a.onTrade(P(100), Q(1), MIN);
    const evs = a.onTrade(P(90), Q(1), 0); // bucket from BEFORE current
    expect(evs).toHaveLength(0);
    // current candle is still bucket 1, unchanged
    expect(a.recent(1)[0]!.bucketStart).toBe(MIN);
  });
});
