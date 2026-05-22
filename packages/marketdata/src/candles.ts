/**
 * OHLCV candle aggregator for ONE interval (e.g. 1m, 5m).
 *
 * For each trade with (price, qty, ts):
 *   bucketStart = floor(ts / intervalMs) * intervalMs
 *
 *   If bucketStart > current.bucketStart:
 *     - "Close" the current candle (emit a `close` event, push to history).
 *     - For any intermediate buckets with no trades, emit FLAT candles
 *       (O=H=L=C = prior close, V=0). This keeps the chart continuous so
 *       the time axis doesn't compress over idle periods.
 *     - Start a fresh current candle: O=H=L=C=price, V=qty.
 *   Else if bucketStart === current.bucketStart:
 *     - Update H, L, C, V on the live candle.
 *   Else (rare, out-of-order):
 *     - Ignore. (We don't try to re-mutate already-closed candles.)
 *
 * We always emit an `update` event for the live candle so consumers
 * (chart) can mutate the rightmost bar in place each tick.
 */

export interface Candle {
  bucketStart: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

export type CandleEventKind = 'update' | 'close';

export interface CandleEvent {
  kind: CandleEventKind;
  interval: string;     // e.g. '1m', '5m'
  candle: Candle;
}

interface InternalCandle {
  bucketStart: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  trades: number;
}

export class CandleAggregator {
  private current: InternalCandle | null = null;
  private readonly history: InternalCandle[] = [];

  constructor(
    public readonly interval: string,
    public readonly intervalMs: number,
    public readonly capacity: number = 500
  ) {}

  /** Returns events to publish (one `update` for the new live candle, plus any `close`s for rolled buckets). */
  onTrade(price: bigint, qty: bigint, ts: number): CandleEvent[] {
    const bucketStart = Math.floor(ts / this.intervalMs) * this.intervalMs;
    const events: CandleEvent[] = [];

    if (this.current === null) {
      this.current = {
        bucketStart, open: price, high: price, low: price, close: price,
        volume: qty, trades: 1,
      };
      events.push(this.makeEvent('update', this.current));
      return events;
    }

    if (bucketStart > this.current.bucketStart) {
      events.push(this.makeEvent('close', this.current));
      this.archive(this.current);

      // Backfill flat candles for any empty buckets in between.
      let nextStart = this.current.bucketStart + this.intervalMs;
      const carry = this.current.close;
      while (nextStart < bucketStart) {
        const flat: InternalCandle = {
          bucketStart: nextStart, open: carry, high: carry, low: carry, close: carry,
          volume: 0n, trades: 0,
        };
        events.push(this.makeEvent('close', flat));
        this.archive(flat);
        nextStart += this.intervalMs;
      }

      this.current = {
        bucketStart, open: price, high: price, low: price, close: price,
        volume: qty, trades: 1,
      };
      events.push(this.makeEvent('update', this.current));
    } else if (bucketStart === this.current.bucketStart) {
      if (price > this.current.high) this.current.high = price;
      if (price < this.current.low) this.current.low = price;
      this.current.close = price;
      this.current.volume += qty;
      this.current.trades += 1;
      events.push(this.makeEvent('update', this.current));
    }
    // out-of-order: drop silently.
    return events;
  }

  /**
   * Close out any buckets that have ended due to wall-clock time having
   * advanced past their boundary, even without a new trade. Call this on
   * a periodic timer so the chart's live bar doesn't appear stale when
   * trading goes quiet.
   */
  tick(now: number): CandleEvent[] {
    if (this.current === null) return [];
    const bucketStart = Math.floor(now / this.intervalMs) * this.intervalMs;
    if (bucketStart <= this.current.bucketStart) return [];
    // Synthesize a flat trade at the carry price to roll the bucket forward.
    return this.onTrade(this.current.close, 0n, bucketStart);
  }

  clear(): void {
    this.current = null;
    this.history.length = 0;
  }

  /** Last N (closed + live) candles, oldest first. */
  recent(limit: number): Candle[] {
    const out: Candle[] = [];
    const start = Math.max(0, this.history.length - limit + (this.current ? 0 : 1));
    for (let i = start; i < this.history.length; i++) out.push(toPublic(this.history[i]!));
    if (this.current) out.push(toPublic(this.current));
    return out.slice(-limit);
  }

  private archive(c: InternalCandle): void {
    this.history.push(c);
    if (this.history.length > this.capacity) this.history.shift();
  }

  private makeEvent(kind: CandleEventKind, c: InternalCandle): CandleEvent {
    return { kind, interval: this.interval, candle: toPublic(c) };
  }
}

function toPublic(c: InternalCandle): Candle {
  return {
    bucketStart: c.bucketStart,
    open: c.open.toString(),
    high: c.high.toString(),
    low: c.low.toString(),
    close: c.close.toString(),
    volume: c.volume.toString(),
    trades: c.trades,
  };
}
