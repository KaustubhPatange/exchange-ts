package common

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
