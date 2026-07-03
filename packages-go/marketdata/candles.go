package main

import "strconv"

type Candle struct {
	BucketStart int64  `json:"bucketStart"`
	Open        string `json:"open"`
	High        string `json:"high"`
	Low         string `json:"low"`
	Close       string `json:"close"`
	Volume      string `json:"volume"`
	Trades      int    `json:"trades"`
}

type CandleEventKind string

const (
	CandleEventUpdate CandleEventKind = "update"
	CandleEventClose  CandleEventKind = "close"
)

type CandleEvent struct {
	Kind     CandleEventKind `json:"kind"`
	Interval string          `json:"interval"`
	Candle   Candle          `json:"candle"`
}

type internalCandle struct {
	bucketStart int64
	open        int64
	high        int64
	low         int64
	close       int64
	volume      int64
	trades      int
}

// CandleAggregator is OHLCV candle aggregator for ONE interval (e.g. 1m, 5m).
//
// For each trade with (price, qty, ts):
//
//	bucketStart = floor(ts / intervalMs) * intervalMs
//
//	If bucketStart > current.bucketStart:
//	  - "Close" the current candle (emit a `close` event, push to history).
//	  - For any intermediate buckets with no trades, emit FLAT candles
//	    (O=H=L=C = prior close, V=0). This keeps the chart continuous so
//	    the time axis doesn't compress over idle periods.
//	  - Start a fresh current candle: O=H=L=C=price, V=qty.
//	Else if bucketStart == current.bucketStart:
//	  - Update H, L, C, V on the live candle.
//	Else (rare, out-of-order):
//	  - Ignore. (We don't try to re-mutate already-closed candles.)
//
// We always emit an `update` event for the live candle so consumers
// (chart) can mutate the rightmost bar in place each tick.
type CandleAggregator struct {
	Interval   string
	IntervalMs int64
	Capacity   int

	current *internalCandle
	history []*internalCandle
}

func NewCandleAggregator(interval string, intervalMs int64, capacity int) *CandleAggregator {
	if capacity == 0 {
		capacity = 500
	}
	return &CandleAggregator{Interval: interval, IntervalMs: intervalMs, Capacity: capacity}
}

func (a *CandleAggregator) OnTrade(price, qty, ts int64) []CandleEvent {
	bucketStart := (ts / a.IntervalMs) * a.IntervalMs
	var events []CandleEvent

	if a.current == nil {
		a.current = &internalCandle{
			bucketStart: bucketStart, open: price, high: price, low: price, close: price,
			volume: qty, trades: 1,
		}
		events = append(events, a.makeEvent(CandleEventUpdate, a.current))
		return events
	}

	switch {
	case bucketStart > a.current.bucketStart:
		events = append(events, a.makeEvent(CandleEventClose, a.current))
		a.archive(a.current)

		// Backfill flat candles for any empty buckets in between.
		nextStart := a.current.bucketStart + a.IntervalMs
		carry := a.current.close
		for nextStart < bucketStart {
			flat := &internalCandle{
				bucketStart: nextStart, open: carry, high: carry, low: carry, close: carry,
				volume: 0, trades: 0,
			}
			events = append(events, a.makeEvent(CandleEventClose, flat))
			a.archive(flat)
			nextStart += a.IntervalMs
		}

		a.current = &internalCandle{
			bucketStart: bucketStart, open: price, high: price, low: price, close: price,
			volume: qty, trades: 1,
		}
		events = append(events, a.makeEvent(CandleEventUpdate, a.current))

	case bucketStart == a.current.bucketStart:
		if price > a.current.high {
			a.current.high = price
		}
		if price < a.current.low {
			a.current.low = price
		}
		a.current.close = price
		a.current.volume += qty
		a.current.trades++
		events = append(events, a.makeEvent(CandleEventUpdate, a.current))
	}

	return events
}

func (a *CandleAggregator) Tick(now int64) []CandleEvent {
	if a.current == nil {
		return []CandleEvent{}
	}
	bucketStart := (now / a.IntervalMs) * a.IntervalMs
	if bucketStart <= a.current.bucketStart {
		return []CandleEvent{}
	}
	return a.OnTrade(a.current.close, 0, bucketStart)
}

func (a *CandleAggregator) Clear() {
	a.current = nil
	a.history = nil
}

func (a *CandleAggregator) Recent(limit int) []Candle {
	extra := 0
	if a.current == nil {
		extra = 1
	}
	start := max(len(a.history)-limit+extra, 0)

	out := make([]Candle, 0, limit)
	for i := start; i < len(a.history); i++ {
		out = append(out, toPublic(a.history[i]))
	}
	if a.current != nil {
		out = append(out, toPublic(a.current))
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

func (a *CandleAggregator) archive(c *internalCandle) {
	a.history = append(a.history, c)
	if len(a.history) > a.Capacity {
		a.history = a.history[1:]
	}
}

func (a *CandleAggregator) makeEvent(kind CandleEventKind, c *internalCandle) CandleEvent {
	return CandleEvent{Kind: kind, Interval: a.Interval, Candle: toPublic(c)}
}

func toPublic(c *internalCandle) Candle {
	return Candle{
		BucketStart: c.bucketStart,
		Open:        strconv.FormatInt(c.open, 10),
		High:        strconv.FormatInt(c.high, 10),
		Low:         strconv.FormatInt(c.low, 10),
		Close:       strconv.FormatInt(c.close, 10),
		Volume:      strconv.FormatInt(c.volume, 10),
		Trades:      c.trades,
	}
}
