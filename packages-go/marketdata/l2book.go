package main

import (
	"sort"
	"strconv"

	"github.com/KaustubhPatange/exchange/common"
)

// L2Book is an L2 (level-2) book aggregator.
//
// Unlike the engine's book — which knows per-order — the L2 view stores
// only the TOTAL QTY at each price level on each side. That's what
// traders typically see in an exchange's depth chart.
//
// Update rules:
//   - OrderAccepted: pre-add the full qty at the order's (side, price).
//     For MARKET orders (price = 0) we skip — they cannot rest.
//   - Trade: reduce BOTH sides — the maker's level by qty (the maker is
//     resting on the book) AND the taker's level by qty (we pre-added
//     it on OrderAccepted, so we need to take back the part that just
//     matched, leaving only the unfilled remainder visible at the
//     taker's limit price).
//   - OrderCanceled: remove the order's REMAINING qty from its level.
//     Works for both user-cancels (resting orders) and terminal cancels
//     (IOC remainder, STP, MARKET_NO_LIQUIDITY).
//
// This makes the L2 reflect the user's order the instant the engine
// accepts it — no waiting for a "next submission" boundary.
type L2Book struct {
	bids   map[int64]int64
	asks   map[int64]int64
	orders map[string]*trackedOrder
}

type trackedOrder struct {
	side      common.Side
	price     int64 // 0 for MARKET (never adds to a level)
	remaining int64
}

type L2Delta struct {
	Side  common.Side `json:"side"`
	Price string      `json:"price"`
	Qty   string      `json:"qty"` // total qty at this level AFTER the change; '0' means remove
}

type L2Snapshot struct {
	Bids [][2]string `json:"bids"` // [price, qty]
	Asks [][2]string `json:"asks"`
}

func NewL2Book() *L2Book {
	return &L2Book{
		bids:   make(map[int64]int64),
		asks:   make(map[int64]int64),
		orders: make(map[string]*trackedOrder),
	}
}

func (b *L2Book) Apply(ev common.EngineEvent) []L2Delta {
	switch e := ev.(type) {
	case *common.OrderAcceptedEvent:
		o := e.Order
		b.orders[o.OrderID] = &trackedOrder{side: o.Side, price: o.Price, remaining: o.Qty}
		if o.Type == common.OrderTypeMarket || o.Price == 0 {
			return nil
		}
		return []L2Delta{b.applyLevelDelta(o.Side, o.Price, o.Qty)}

	case *common.OrderRejectedEvent:
		return nil

	case *common.TradeEvent:
		var deltas []L2Delta
		if maker, ok := b.orders[e.MakerOrderID]; ok {
			maker.remaining -= e.Qty
			if maker.remaining <= 0 {
				delete(b.orders, e.MakerOrderID)
			}
			deltas = append(deltas, b.applyLevelDelta(maker.side, maker.price, -e.Qty))
		}
		if taker, ok := b.orders[e.TakerOrderID]; ok {
			taker.remaining -= e.Qty
			if taker.remaining <= 0 {
				delete(b.orders, e.TakerOrderID)
			}
			// taker.price is 0 for MARKET — those were never added to a level.
			if taker.price > 0 {
				deltas = append(deltas, b.applyLevelDelta(taker.side, taker.price, -e.Qty))
			}
		}
		return deltas

	case *common.OrderCanceledEvent:
		existing, ok := b.orders[e.OrderID]
		if !ok {
			return nil
		}
		delete(b.orders, e.OrderID)
		if existing.price == 0 {
			return nil // MARKET, never added
		}
		return []L2Delta{b.applyLevelDelta(existing.side, existing.price, -existing.remaining)}
	}
	return nil
}

func (b *L2Book) Clear() {
	b.bids = make(map[int64]int64)
	b.asks = make(map[int64]int64)
	b.orders = make(map[string]*trackedOrder)
}

func (b *L2Book) Snapshot(levels int) L2Snapshot {
	if levels == 0 {
		levels = 50
	}
	return L2Snapshot{
		Bids: topN(b.bids, false, levels),
		Asks: topN(b.asks, true, levels),
	}
}

func (b *L2Book) applyLevelDelta(side common.Side, price int64, deltaQty int64) L2Delta {
	tree := b.asks
	if side == common.SideBuy {
		tree = b.bids
	}
	next := tree[price] + deltaQty
	if next <= 0 {
		delete(tree, price)
	} else {
		tree[price] = next
	}
	if next < 0 {
		next = 0
	}
	return L2Delta{Side: side, Price: strconv.FormatInt(price, 10), Qty: strconv.FormatInt(next, 10)}
}

func topN(m map[int64]int64, ascending bool, n int) [][2]string {
	prices := make([]int64, 0, len(m))
	for p := range m {
		prices = append(prices, p)
	}
	if ascending {
		sort.Slice(prices, func(i, j int) bool { return prices[i] < prices[j] })
	} else {
		sort.Slice(prices, func(i, j int) bool { return prices[i] > prices[j] })
	}
	if n < len(prices) {
		prices = prices[:n]
	}
	out := make([][2]string, len(prices))
	for i, p := range prices {
		out[i] = [2]string{strconv.FormatInt(p, 10), strconv.FormatInt(m[p], 10)}
	}
	return out
}
