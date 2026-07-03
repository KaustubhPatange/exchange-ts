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

	high := first.High
	low := first.Low
	var vol int64
	for _, c := range candles {
		if c.High > high {
			high = c.High
		}
		if c.Low < low {
			low = c.Low
		}
		vol += c.Volume
	}

	// changePct as a fixed-point with 4 decimals: e.g. "12.3456" %.
	// (close - open) / open * 100 — done in scaled integers.
	var scaled int64
	if first.Open > 0 {
		scaled = ((last.Close - first.Open) * common.UsdcOne) / first.Open // 4-dec * 100
	}
	changePct := formatScaledPercent(scaled)

	return TickerSnapshot{
		LastPrice:    strconvPtr(last.Close),
		Open24h:      strconvPtr(first.Open),
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
