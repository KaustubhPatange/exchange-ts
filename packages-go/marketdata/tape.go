package main

import (
	"strconv"

	"github.com/KaustubhPatange/exchange/common"
)

type TapeEntry struct {
	TradeID   string      `json:"tradeId"`
	TS        int64       `json:"ts"`
	Price     string      `json:"price"`
	Qty       string      `json:"qty"`
	Aggressor common.Side `json:"aggressor"`
}

// Tape is a trade tape — bounded ring of recent trades. The UI's "tape"
// panel shows the most recent ~50 of these.
type Tape struct {
	capacity int
	ring     []TapeEntry
}

func NewTape(capacity int) *Tape {
	if capacity == 0 {
		capacity = 200
	}
	return &Tape{capacity: capacity, ring: make([]TapeEntry, 0, capacity)}
}

func (t *Tape) Push(ev *common.TradeEvent) TapeEntry {
	entry := TapeEntry{
		TradeID:   ev.TradeID,
		TS:        ev.TS,
		Price:     strconv.FormatInt(ev.Price, 10),
		Qty:       strconv.FormatInt(ev.Qty, 10),
		Aggressor: ev.Aggressor,
	}
	t.ring = append(t.ring, entry)
	if len(t.ring) > t.capacity {
		t.ring = t.ring[1:]
	}
	return entry
}

func (t *Tape) Recent(limit int) []TapeEntry {
	n := min(limit, len(t.ring))
	return t.ring[len(t.ring)-n:]
}

func (t *Tape) Clear() {
	t.ring = make([]TapeEntry, 0, t.capacity)
}
