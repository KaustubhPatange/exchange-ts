# Learning the basics

This is the minimum vocabulary you need before running the simulation. The simulation itself teaches everything else (order types, partial fills, slippage, STP, price improvement, fees, and so on) one concept at a time.

All examples use BTC-USDC. BTC is the *base* asset (what is being traded). USDC is the *quote* asset (what BTC is priced in). When you see `$70,000`, it means `70,000 USDC per 1 BTC`.

## Bids and asks

There are only two kinds of order:

- A **bid** is a buy order. "I'll pay up to *X* USDC for this much BTC."
- An **ask** (or *offer*) is a sell order. "I'll sell my BTC for at least *X* USDC."

A trade happens when a bid and an ask meet, that is, when somebody is willing to pay at least as much as somebody else is willing to accept.

## The order book

The **order book** is the list of every unfilled bid and every unfilled ask, organized by price. It is what an exchange shows you when it shows you "the market".

```
        Asks (sell side)
        ─────────────────
        $70,200   2.0 BTC
        $70,100   1.0 BTC
        $70,000   0.5 BTC     ← best ask (lowest sell price)

        $69,950   0.7 BTC     ← best bid (highest buy price)
        $69,900   2.5 BTC
        ─────────────────
        Bids (buy side)
```

The two prices nearest the middle, the **best bid** and the **best ask**, are the two most important numbers on the book.

## The spread

The gap between the best bid and the best ask is the **spread**. In the picture above it is `$70,000 - $69,950 = $50`.

A small spread means a liquid market. A wide spread means the opposite, you'll pay more to trade right now instead of waiting.

## Makers and takers

Every trade has two sides:

- The **maker** is the side that was already resting on the book, making liquidity available.
- The **taker** is the incoming order that crossed the spread and took that liquidity.

This distinction shows up everywhere in the simulation, in the UI, and in how fees are charged. Most exchanges (this one included) charge the taker a small fee and pay the maker nothing or a small rebate.

## Next steps

Now run `pnpm simulation`. The examples are ordered from simplest to most realistic and each one explains itself as it runs. Keep the UI open at `http://localhost:5173` so you can watch the book, the trades, and your balances change in real time.

If you want to know how the services behind the simulation actually work, read [ARCHITECTURE.md](ARCHITECTURE.md).
