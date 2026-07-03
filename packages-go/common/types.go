package common

type Side string

const (
	SideBuy  Side = "buy"
	SideSell Side = "sell"
)

type OrderType string

const (
	OrderTypeLimit    OrderType = "LIMIT"
	OrderTypeMarket   OrderType = "MARKET"
	OrderTypeIOC      OrderType = "IOC"
	OrderTypeFOK      OrderType = "FOK"
	OrderTypePostOnly OrderType = "POST_ONLY"
)

type OrderStatus string

const (
	OrderStatusNew             OrderStatus = "NEW"
	OrderStatusPartiallyFilled OrderStatus = "PARTIALLY_FILLED"
	OrderStatusFilled          OrderStatus = "FILLED"
	OrderStatusCanceled        OrderStatus = "CANCELED"
	OrderStatusRejected        OrderStatus = "REJECTED"
)

type Asset string

const (
	AssetBTC  Asset = "BTC"
	AssetUSDC Asset = "USDC"
)

type Symbol string

const (
	SymbolBTCUSDC Symbol = "BTC-USDC"
)

// Order is the canonical order shape used inside the engine. All numeric
// quantities are integer base units (see decimal.go). Price is in base units
// of the QUOTE asset per ONE WHOLE unit of the BASE asset (i.e. how many
// USDC base units per 1 BTC). This keeps multiplication clean:
// notional = price * qty / BASE_ONE.
type Order struct {
	OrderID       string      `json:"orderId"`       // server-assigned ULID
	ClientOrderID string      `json:"clientOrderId"` // client-supplied for idempotency
	UserID        string      `json:"userId"`
	Symbol        Symbol      `json:"symbol"`
	Side          Side        `json:"side"`
	Type          OrderType   `json:"type"`
	Price         int64       `json:"price,string"`     // nil/0 for MARKET
	Qty           int64       `json:"qty,string"`       // original quantity (base asset base units)
	Remaining     int64       `json:"remaining,string"` // unfilled remaining
	Status        OrderStatus `json:"status"`
	CreatedAt     int64       `json:"createdAt"` // ms epoch
}

// NewOrderCommand represents a request to place a new order.
type NewOrderCommand struct {
	ClientOrderID string
	UserID        string
	Symbol        Symbol
	Side          Side
	Type          OrderType
	Price         int64 // required except for MARKET
	Qty           int64
}

// CancelOrderCommand represents a request to cancel an existing order.
type CancelOrderCommand struct {
	OrderID string
	UserID  string // must match owner
}
