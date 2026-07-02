package common

import (
	"github.com/oklog/ulid/v2"
)

func NewOrderID() string {
	return "O_" + ulid.Make().String()
}

func NewTradeID() string {
	return "T_" + ulid.Make().String()
}
