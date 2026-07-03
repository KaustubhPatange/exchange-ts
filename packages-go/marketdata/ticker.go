package main

import (
	"fmt"
	"strconv"

	"github.com/KaustubhPatange/exchange/common"
)

// TickerSnapshot is the last price + 24h volume + 24h % change.
//
// Computed from the 1m candle history maintained by CandleAggregator, so we
// don't need a second data structure.
//
// 24h window covers the most recent 1440 closed candles. If fewer than
// 1440 candles exist (system hasn't been running for 24h yet), we use
// what we have — the change % is still well-defined relative to the
// oldest open we know about.
type TickerSnapshot struct {
	LastPrice    *string `json:"lastPrice"`
	Open24h      *string `json:"open24h"`
	High24h      *string `json:"high24h"`
	Low24h       *string `json:"low24h"`
	Volume24h    string  `json:"volume24h"`
	ChangePct24h string  `json:"changePct24h"`
}

const oneDayMin = 24 * 60

func ComputeTicker(oneMin *CandleAggregator) TickerSnapshot {
	candles := oneMin.Recent(oneDayMin)
	if len(candles) == 0 {
		zero := "0"
		return TickerSnapshot{Volume24h: zero, ChangePct24h: zero}
	}

	last := candles[len(candles)-1]
	first := candles[0]

	high, err := strconv.ParseInt(first.High, 10, 64)
	if err != nil {
		panic(err)
	}
	low, err := strconv.ParseInt(first.Low, 10, 64)
	if err != nil {
		panic(err)
	}
	var vol int64
	for _, c := range candles {
		h, _ := strconv.ParseInt(c.High, 10, 64)
		l, _ := strconv.ParseInt(c.Low, 10, 64)
		if h > high {
			high = h
		}
		if l < low {
			low = l
		}
		v, _ := strconv.ParseInt(c.Volume, 10, 64)
		vol += v
	}

	open, _ := strconv.ParseInt(first.Open, 10, 64)
	close_, _ := strconv.ParseInt(last.Close, 10, 64)

	// changePct as a fixed-point with 4 decimals: e.g. "12.3456" %.
	// (close - open) / open * 100 — done in scaled integers.
	var scaled int64
	if open > 0 {
		scaled = ((close_ - open) * common.UsdcOne) / open // 4-dec * 100
	}
	changePct := formatScaledPercent(scaled)

	lastClose := last.Close
	firstOpen := first.Open
	return TickerSnapshot{
		LastPrice:    &lastClose,
		Open24h:      &firstOpen,
		High24h:      strconvPtr(high),
		Low24h:       strconvPtr(low),
		Volume24h:    strconv.FormatInt(vol, 10),
		ChangePct24h: changePct,
	}
}

func strconvPtr(v int64) *string {
	s := strconv.FormatInt(v, 10)
	return &s
}

func formatScaledPercent(scaled int64) string {
	pctMicros := scaled * 100 // 6 decimal places now, percent units
	neg := pctMicros < 0
	abs := pctMicros
	if neg {
		abs = -abs
	}
	intPart := abs / common.UsdcOne
	fracPart := fmt.Sprintf("%06d", abs%common.UsdcOne)[:4]
	sign := ""
	if neg {
		sign = "-"
	}
	return fmt.Sprintf("%s%d.%s", sign, intPart, fracPart)
}
