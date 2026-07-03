package common

import (
	"fmt"
	"strconv"
	"strings"
)

const (
	BtcDecimals   int64 = 8
	UsdcDecimals  int64 = 6
	PriceDecimals int64 = UsdcDecimals // price quoted in USDC
)

const (
	BtcOne   int64 = 1e8 // 10^BtcDecimals
	UsdcOne  int64 = 1e6 // 10^UsdcDecimals
	PriceOne int64 = 1e6 // 10^PriceDecimals
)

func NotionalQuote(price int64, qtyBase int64) int64 {
	return (price * qtyBase) / BtcOne
}

func ToBaseUnits(value string, decimals int64) (int64, error) {
	neg := strings.HasPrefix(value, "-")
	body := value
	if neg {
		body = value[1:]
	}
	intPart, fracPart, _ := strings.Cut(body, ".")
	if int64(len(fracPart)) > decimals {
		return 0, fmt.Errorf("too many decimals for value %s (max %d)", value, decimals)
	}
	padded := fracPart + strings.Repeat("0", int(decimals)-len(fracPart))
	n, err := strconv.ParseInt(intPart+padded, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid decimal value %s", value)
	}
	if neg {
		return -n, nil
	}
	return n, nil
}
