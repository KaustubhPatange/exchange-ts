package engine

import (
	"errors"
	"time"

	"github.com/KaustubhPatange/exchange/common"
)

// MatchingEngine owns the book, assigns sequence numbers, runs the match loop, and emits
// events. Single-threaded by design: every order is processed atomically
// and produces a deterministic event list. This is what allows downstream
// services to rebuild state by replaying events in order.
//
// Order types supported:
//
//	LIMIT      — match while crosses; rest remainder.
//	MARKET     — match while opposite side has liquidity; cancel remainder.
//	IOC        — like LIMIT but cancel remainder instead of resting.
//	FOK        — pre-check; either fully fills or is rejected (no partials).
//	POST_ONLY  — must rest; if it would cross, reject.
//
// Self-Trade Prevention (STP): when an incoming order would match against
// one of the same user's resting orders, we use the CANCEL-NEW policy:
// we stop matching and cancel the rest of the incoming order. Anything
// filled before the self-match still stands.
//
// The match always executes at the MAKER's resting price (the taker
// gets price improvement when their limit is more aggressive than the
// best opposite). This is the standard convention.
type MatchingEngine struct {
	book               OrderBook
	seq                int64
	seenClientOrderids map[string]map[string]struct{}
}

func NewMatchingEngine() *MatchingEngine {
	return &MatchingEngine{
		book:               *NewOrderBook(),
		seenClientOrderids: make(map[string]map[string]struct{}),
	}
}

func (m *MatchingEngine) MarkClientOrderIDSeen(userID, clientOrderID string) {
	s, ok := m.seenClientOrderids[userID]
	if !ok {
		s = make(map[string]struct{})
		m.seenClientOrderids[userID] = s
	}
	s[clientOrderID] = struct{}{}
}

func (m *MatchingEngine) nextSeq() int64 {
	m.seq++
	return m.seq
}

func (m *MatchingEngine) GetUserOrders(userID string) []*common.Order {
	return m.book.OrdersForUser(userID)
}

func (m *MatchingEngine) Submit(cmd *common.NewOrderCommand) ([]common.EngineEvent, error) {
	return m.submitAt(cmd, time.Now().UnixMilli())
}

func (m *MatchingEngine) submitAt(cmd *common.NewOrderCommand, now int64) ([]common.EngineEvent, error) {
	var events []common.EngineEvent

	// validation
	if cmd.Symbol != common.SymbolBTCUSDC {
		events = append(events, m.makeRejected(cmd, now, common.RejectReasonUnknownSymbol))
		return events, nil
	}
	if cmd.Qty <= 0 {
		events = append(events, m.makeRejected(cmd, now, common.RejectReasonInvalidQty))
		return events, nil
	}
	if cmd.Type != common.OrderTypeMarket && cmd.Price <= 0 {
		events = append(events, m.makeRejected(cmd, now, common.RejectReasonInvalidPrice))
		return events, nil
	}

	// idempotency
	user, ok := m.seenClientOrderids[cmd.UserID]
	if !ok {
		user = make(map[string]struct{})
		m.seenClientOrderids[cmd.UserID] = user
	}
	if _, ok := user[cmd.ClientOrderID]; ok {
		events = append(events, m.makeRejected(cmd, now, common.RejectReasonDuplicateClientOrderID))
		return events, nil
	}
	user[cmd.ClientOrderID] = struct{}{}

	// canonical order record

	price := int64(0)
	if cmd.Type != common.OrderTypeMarket {
		price = cmd.Price
	}
	order := &common.Order{
		OrderID:       common.NewOrderID(),
		ClientOrderID: cmd.ClientOrderID,
		UserID:        cmd.UserID,
		Symbol:        cmd.Symbol,
		Side:          cmd.Side,
		Type:          cmd.Type,
		Price:         price,
		Qty:           cmd.Qty,
		Remaining:     cmd.Qty,
		Status:        common.OrderStatusNew,
		CreatedAt:     now,
	}

	if cmd.Type == common.OrderTypePostOnly && m.wouldCross(order) {
		events = append(events, m.makeRejected(cmd, now, common.RejectReasonPostOnlyWouldCross))
		return events, nil
	}

	if cmd.Type == common.OrderTypeFOK && m.fullyFillable(order) {
		events = append(events, m.makeRejected(cmd, now, common.RejectReasonFOKNotFillable))
		return events, nil
	}

	events = append(events, &common.OrderAcceptedEvent{
		Seq:   m.nextSeq(),
		TS:    now,
		Order: order,
	})

	var stoppedBySTP bool
	var oppSide common.Side
	if order.Side == common.SideBuy {
		oppSide = common.SideSell
	} else {
		oppSide = common.SideBuy
	}

	for order.Remaining > 0 {
		top := m.book.PeekTopOrder(oppSide)
		if top == nil {
			break
		}

		if top.UserID == order.UserID {
			stoppedBySTP = true
			break
		}

		fillPrice := top.Price
		fillQty := min(order.Remaining, top.Remaining)

		trade := &common.TradeEvent{
			Seq:            m.nextSeq(),
			TS:             now,
			TradeID:        common.NewTradeID(),
			Symbol:         order.Symbol,
			Price:          fillPrice,
			Qty:            fillQty,
			Aggressor:      order.Side,
			TakerOrderID:   order.OrderID,
			TakerUserID:    order.UserID,
			TakerOrderType: order.Type,
			MakerOrderID:   top.OrderID,
			MakerUserID:    top.UserID,
		}
		events = append(events, trade)

		if err := m.book.ReduceTopOrder(oppSide, fillQty); err != nil {
			return nil, err
		}
		order.Remaining -= fillQty
	}

	if order.Remaining > 0 {
		if stoppedBySTP {
			events = append(events, m.makeCanceled(order, now, common.CancelReasonSTP))
		} else if cmd.Type == common.OrderTypeLimit || cmd.Type == common.OrderTypePostOnly {
			m.book.Rest(order)
		} else if cmd.Type == common.OrderTypeIOC {
			events = append(events, m.makeCanceled(order, now, common.CancelReasonIOCRemainder))
		} else if cmd.Type == common.OrderTypeMarket {
			events = append(events, m.makeCanceled(order, now, common.CancelReasonMarketNoLiquidity))
		} else if cmd.Type == common.OrderTypeFOK {
			// Pre-check should have prevented this; defensive error.
			return nil, errors.New("FOK left remainder after pre-check passed")
		}
	}
	return events, nil
}

func (m *MatchingEngine) Cancel(cmd *common.CancelOrderCommand) []common.EngineEvent {
	return m.cancelAt(cmd, time.Now().UnixMilli())
}

func (m *MatchingEngine) cancelAt(cmd *common.CancelOrderCommand, now int64) []common.EngineEvent {
	existing := m.book.Get(cmd.OrderID)
	if existing == nil || existing.UserID != cmd.UserID {
		return nil
	}
	removed := m.book.Cancel(cmd.OrderID)
	return []common.EngineEvent{m.makeCanceled(removed, now, common.CancelReasonUser)}
}

func (m *MatchingEngine) makeRejected(cmd *common.NewOrderCommand, ts int64, reason common.RejectReason) *common.OrderRejectedEvent {
	return &common.OrderRejectedEvent{
		Seq:           m.nextSeq(),
		TS:            ts,
		ClientOrderID: cmd.ClientOrderID,
		UserID:        cmd.UserID,
		Reason:        reason,
	}
}

func (m *MatchingEngine) makeCanceled(order *common.Order, ts int64, reason common.CancelReason) *common.OrderCanceledEvent {
	return &common.OrderCanceledEvent{
		Seq:       m.nextSeq(),
		TS:        ts,
		OrderID:   order.OrderID,
		UserID:    order.UserID,
		Symbol:    order.Symbol,
		Side:      order.Side,
		Price:     order.Price,
		Remaining: order.Remaining,
		Reason:    reason,
	}
}

func (m *MatchingEngine) wouldCross(order *common.Order) bool {
	if order.Side == common.SideBuy {
		if bestAsk, ok := m.book.BestAsk(); ok {
			return order.Price >= bestAsk
		}
	}
	if bestBid, ok := m.book.BestBid(); ok {
		return order.Price <= bestBid
	}
	return false
}

func (m *MatchingEngine) fullyFillable(order *common.Order) bool {
	oppTree := m.book.treeFor(order.Side)
	var fullyfillable bool
	var available int64
	oppTree.Ascend(func(item priceEntry) bool {
		crosses := order.Type == common.OrderTypeMarket ||
			(order.Side == common.SideBuy && order.Price >= item.price) ||
			(order.Side == common.SideSell && order.Price <= item.price)

		if !crosses {
			return false
		}

		for node := item.level.Head; node != nil; node = node.Next {
			if node.Order.UserID == order.UserID {
				return false
			}
			available += node.Order.Remaining
			if available >= order.Qty {
				fullyfillable = true
				return false
			}
		}

		return true
	})

	if fullyfillable {
		return true
	}

	return available >= order.Qty
}
