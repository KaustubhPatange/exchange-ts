package common

import (
	"encoding/json"
	"fmt"
)

type EngineEvent interface {
	Kind() string
	Serialize() (string, error)
}

type OrderAcceptedEvent struct {
	Seq   int64
	TS    int64
	Order *Order
}

func (e *OrderAcceptedEvent) Kind() string { return "OrderAccepted" }

func (e *OrderAcceptedEvent) Serialize() (string, error) {
	return marshalTagged(struct {
		Kind string
		*OrderAcceptedEvent
	}{e.Kind(), e})
}

type RejectReason string

const (
	RejectReasonInvalidPrice           RejectReason = "INVALID_PRICE"
	RejectReasonInvalidQty             RejectReason = "INVALID_QTY"
	RejectReasonDuplicateClientOrderID RejectReason = "DUPLICATE_CLIENT_ORDER_ID"
	RejectReasonPostOnlyWouldCross     RejectReason = "POST_ONLY_WOULD_CROSS"
	RejectReasonFOKNotFillable         RejectReason = "FOK_NOT_FILLABLE"
	RejectReasonUnknownSymbol          RejectReason = "UNKNOWN_SYMBOL"
)

type OrderRejectedEvent struct {
	Seq           int64
	TS            int64
	ClientOrderID string
	UserID        string
	Reason        RejectReason
}

func (e *OrderRejectedEvent) Kind() string { return "OrderRejected" }

func (e *OrderRejectedEvent) Serialize() (string, error) {
	return marshalTagged(struct {
		Kind string
		*OrderRejectedEvent
	}{e.Kind(), e})
}

type CancelReason string

const (
	CancelReasonUser              CancelReason = "USER"
	CancelReasonIOCRemainder      CancelReason = "IOC_REMAINDER"
	CancelReasonSTP               CancelReason = "STP"
	CancelReasonMarketNoLiquidity CancelReason = "MARKET_NO_LIQUIDITY"
)

type OrderCanceledEvent struct {
	Seq       int64
	TS        int64
	OrderID   string
	UserID    string
	Symbol    Symbol
	Side      Side
	Price     int64
	Remaining int64
	Reason    CancelReason
}

func (e *OrderCanceledEvent) Kind() string { return "OrderCanceled" }

func (e *OrderCanceledEvent) Serialize() (string, error) {
	return marshalTagged(struct {
		Kind string
		*OrderCanceledEvent
	}{e.Kind(), e})
}

type TradeEvent struct {
	Seq            int64
	TS             int64
	TradeID        string
	Symbol         Symbol
	Price          int64
	Qty            int64
	Aggressor      Side
	TakerOrderID   string
	TakerUserID    string
	TakerOrderType OrderType
	MakerOrderID   string
	MakerUserID    string
}

func (e *TradeEvent) Kind() string { return "Trade" }

func (e *TradeEvent) Serialize() (string, error) {
	return marshalTagged(struct {
		Kind string
		*TradeEvent
	}{e.Kind(), e})
}

func marshalTagged(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func DeserializeEvent(data string) (EngineEvent, error) {
	var raw struct {
		Kind string `json:"Kind"`
	}
	if err := json.Unmarshal([]byte(data), &raw); err != nil {
		return nil, err
	}

	switch raw.Kind {
	case "OrderAccepted":
		var ev OrderAcceptedEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return nil, err
		}
		return &ev, nil
	case "OrderRejected":
		var ev OrderRejectedEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return nil, err
		}
		return &ev, nil
	case "OrderCanceled":
		var ev OrderCanceledEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return nil, err
		}
		return &ev, nil
	case "Trade":
		var ev TradeEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return nil, err
		}
		return &ev, nil
	default:
		return nil, fmt.Errorf("unknown event kind: %s", raw.Kind)
	}
}
