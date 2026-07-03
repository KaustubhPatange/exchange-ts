package main

// Candle holds OHLCV in integer base units; the `,string` tags emit them as
// decimal strings on the wire (matching the TS format) while the aggregator
// does plain int64 arithmetic — one struct, no internal/public duplication.
type Candle struct {
	BucketStart int64 `json:"bucketStart"`
	Open        int64 `json:"open,string"`
	High        int64 `json:"high,string"`
	Low         int64 `json:"low,string"`
	Close       int64 `json:"close,string"`
	Volume      int64 `json:"volume,string"`
	Trades      int   `json:"trades"`
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

	current *Candle
	history []*Candle
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
		a.current = &Candle{
			BucketStart: bucketStart, Open: price, High: price, Low: price, Close: price,
			Volume: qty, Trades: 1,
		}
		events = append(events, a.makeEvent(CandleEventUpdate, a.current))
		return events
	}

	switch {
	case bucketStart > a.current.BucketStart:
		events = append(events, a.makeEvent(CandleEventClose, a.current))
		a.archive(a.current)

		// Backfill flat candles for any empty buckets in between.
		nextStart := a.current.BucketStart + a.IntervalMs
		carry := a.current.Close
		for nextStart < bucketStart {
			flat := &Candle{
				BucketStart: nextStart, Open: carry, High: carry, Low: carry, Close: carry,
				Volume: 0, Trades: 0,
			}
			events = append(events, a.makeEvent(CandleEventClose, flat))
			a.archive(flat)
			nextStart += a.IntervalMs
		}

		a.current = &Candle{
			BucketStart: bucketStart, Open: price, High: price, Low: price, Close: price,
			Volume: qty, Trades: 1,
		}
		events = append(events, a.makeEvent(CandleEventUpdate, a.current))

	case bucketStart == a.current.BucketStart:
		if price > a.current.High {
			a.current.High = price
		}
		if price < a.current.Low {
			a.current.Low = price
		}
		a.current.Close = price
		a.current.Volume += qty
		a.current.Trades++
		events = append(events, a.makeEvent(CandleEventUpdate, a.current))
	}

	return events
}

func (a *CandleAggregator) Tick(now int64) []CandleEvent {
	if a.current == nil {
		return []CandleEvent{}
	}
	bucketStart := (now / a.IntervalMs) * a.IntervalMs
	if bucketStart <= a.current.BucketStart {
		return []CandleEvent{}
	}
	return a.OnTrade(a.current.Close, 0, bucketStart)
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
		out = append(out, *a.history[i])
	}
	if a.current != nil {
		out = append(out, *a.current)
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

func (a *CandleAggregator) archive(c *Candle) {
	a.history = append(a.history, c)
	if len(a.history) > a.Capacity {
		a.history = a.history[1:]
	}
}

func (a *CandleAggregator) makeEvent(kind CandleEventKind, c *Candle) CandleEvent {
	return CandleEvent{Kind: kind, Interval: a.Interval, Candle: *c}
}
