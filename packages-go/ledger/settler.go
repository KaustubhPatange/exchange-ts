package ledger

import (
	"github.com/KaustubhPatange/exchange/common"
	"github.com/KaustubhPatange/exchange/common/redis"
)

const TakerFeeBps = 5

type OpenBuy struct {
	Price     int64
	Remaining int64
}

type Settler struct {
	accounts Accounts
	openBuys map[string]*OpenBuy
}

func (s *Settler) Clear() {
	for k := range s.openBuys {
		delete(s.openBuys, k)
	}
}

func (s *Settler) Apply(ev common.EngineEvent, mode redis.StreamMode) {
	switch e := ev.(type) {
	case *common.OrderAcceptedEvent:
		s.trackOrder(e)
		if mode == redis.StreamModeReplay {
			s.lockForOrder(e)
		}
	case *common.OrderRejectedEvent:
	case *common.TradeEvent:
		s.settle(e)
	case *common.OrderCanceledEvent:
		s.releaseRemainder(e)
		delete(s.openBuys, e.OrderID)
	}
}

func (s *Settler) trackOrder(ev *common.OrderAcceptedEvent) {
	o := ev.Order
	if o.Side == common.SideBuy && o.Type != common.OrderTypeMarket {
		s.openBuys[o.OrderID] = &OpenBuy{Price: o.Price, Remaining: o.Qty}
	}
}

func (s *Settler) lockForOrder(ev *common.OrderAcceptedEvent) {
	o := ev.Order
	if o.Side == common.SideBuy {
		s.accounts.Reserve(o.UserID, common.AssetUSDC, common.NotionalQuote(o.Price, o.Qty))
	} else {
		s.accounts.Reserve(o.UserID, common.AssetBTC, o.Qty)
	}
}

func (s *Settler) settle(ev *common.TradeEvent) {
	notional := common.NotionalQuote(ev.Price, ev.Qty)
	var buyer, seller string
	if ev.Aggressor == common.SideBuy {
		buyer, seller = ev.TakerUserID, ev.MakerUserID
	} else {
		buyer, seller = ev.MakerUserID, ev.TakerUserID
	}

	var buyerFeeBtc, sellerFeeUsdc int64
	if ev.Aggressor == common.SideBuy {
		buyerFeeBtc = (ev.Qty * TakerFeeBps) / 10_000
	}
	if ev.Aggressor == common.SideSell {
		sellerFeeUsdc = (notional * TakerFeeBps) / 10_000
	}

	s.accounts.DebitLockedCreditFree(
		buyer,
		AssetAmount{Asset: common.AssetUSDC, Amount: notional},
		AssetAmount{Asset: common.AssetBTC, Amount: ev.Qty - buyerFeeBtc},
	)
	s.accounts.DebitLockedCreditFree(
		seller,
		AssetAmount{Asset: common.AssetBTC, Amount: ev.Qty},
		AssetAmount{Asset: common.AssetUSDC, Amount: notional - sellerFeeUsdc},
	)

	if buyerFeeBtc > 0 {
		s.accounts.Get("exchange", common.AssetBTC).Free += buyerFeeBtc
	}
	if sellerFeeUsdc > 0 {
		s.accounts.Get("exchange", common.AssetUSDC).Free += sellerFeeUsdc
	}

	if ev.Aggressor == common.SideBuy {
		taker := s.openBuys[ev.TakerOrderID]
		if taker != nil && taker.Price > ev.Price {
			surplus := common.NotionalQuote(taker.Price-ev.Price, ev.Qty)
			if surplus > 0 {
				s.accounts.Release(ev.TakerUserID, common.AssetUSDC, surplus)
			}
		}
		s.decrementOpenBuy(ev.TakerOrderID, ev.Qty)
	} else {
		s.decrementOpenBuy(ev.MakerOrderID, ev.Qty)
	}
}

func (s *Settler) decrementOpenBuy(orderID string, qty int64) {
	entry := s.openBuys[orderID]
	if entry == nil {
		return
	}
	entry.Remaining -= qty
	if entry.Remaining <= 0 {
		delete(s.openBuys, orderID)
	}
}

func (s *Settler) releaseRemainder(ev *common.OrderCanceledEvent) {
	asset := common.AssetBTC
	var amount int64
	if ev.Side == common.SideBuy {
		asset = common.AssetUSDC
		amount = common.NotionalQuote(ev.Price, ev.Remaining)
	} else {
		amount = ev.Remaining
	}
	if amount > 0 {
		s.accounts.Release(ev.UserID, asset, amount)
	}
}
