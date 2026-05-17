# Build a Local Spot Crypto Exchange (to learn how exchanges work)

## Context

You want to learn how spot crypto exchanges (e.g. Backpack) work end‑to‑end:
how orders enter the system, how the matching engine pairs buyers and
sellers, how market makers keep books liquid, and how balances move when
a trade settles. The directory `/Users/kaustubh/WebProjects/exchange-ts`
is empty, so we're building from scratch.

The goal is **a runnable local exchange**, scoped to spot trading on one
pair (BTC/USDC), structured as small microservices that mirror real
exchanges so each concept has its own home in the codebase. The plan is
deliberately phased — each phase is independently runnable so you can
**see and play with what you just built** before moving to the next.

---

## Concept primer (the vocabulary)

Before the architecture, here is the mental model. Every service below
exists to own one of these concepts.

- **Order book**: two sorted collections — **bids** (buy orders, sorted
  high → low) and **asks** (sell orders, sorted low → high). At each
  price level there is a FIFO queue of orders.
- **Top of book**: best bid (highest buy price) and best ask (lowest sell
  price). The gap between them is the **spread**. The midpoint is the
  **mid price**.
- **Maker vs taker**: a **maker** places an order that rests on the book
  and adds liquidity. A **taker** places an order that crosses the spread
  and removes liquidity by matching against a resting order. Makers
  usually pay lower (or negative) fees because liquidity is valuable.
- **Matching engine**: the single component that owns the book and
  applies **price–time priority** — best price wins; ties broken by who
  arrived first.
- **Order types** (we'll implement all of these):
  - `LIMIT` — buy/sell at a price or better; rests on book if not fully filled.
  - `MARKET` — take whatever's available at any price; no resting.
  - `IOC` (Immediate‑Or‑Cancel) — limit, but cancel any unfilled remainder.
  - `FOK` (Fill‑Or‑Kill) — fill the whole order immediately or reject it entirely.
  - `POST_ONLY` — must rest as a maker; reject if it would cross.
  - **STP** (Self‑Trade Prevention) — if your incoming order would match
    your own resting order, skip it (we'll use the "cancel new" policy).
- **Ledger / wallet**: per‑user balances per asset, split into `free` and
  `locked`. Placing an order locks funds; matches settle by moving locked
  → free (of the other side).
- **Event log**: every state change the engine emits — `OrderAccepted`,
  `OrderRejected`, `OrderCancelled`, `Trade`. This log is **the source
  of truth**. Persisting it lets us rebuild any in‑memory state by
  replay. Real exchanges (CME, Coinbase, Binance) are built this way.
- **Market data**: derived views built by listening to the event log —
  the L2 book snapshot (depth per price level), the trade tape (recent
  trades), the ticker (last price, 24h volume), and **OHLCV candles**.
- **OHLCV candle**: for each time bucket (e.g. 1m, 5m) we record
  **O**pen (first trade price), **H**igh (max), **L**ow (min),
  **C**lose (last), **V**olume (sum of qty). The current ("live")
  candle updates on every new trade; when its bucket boundary passes,
  it closes and a new one opens. Candles are pure derivations of the
  trade event stream — no extra state in the engine.
- **Market maker (MM)**: a bot that continuously quotes both bid and ask
  around the mid price to provide liquidity. Cancels and re‑posts as the
  market moves. This is what keeps a real book full and tight.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       React UI (Vite, port 5173)                      │
│  Order book │ Trade tape │ Order form │ Balances │ Match log         │
│  Candlestick chart (1m / 5m) │ Live price ticker                     │
└────────────┬─────────────────────────────────────────┬───────────────┘
             │ REST: POST /orders, GET /candles         │ WS: book, trades, candles, ticker
             ▼                                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Gateway Service (port 8080)                        │
│  • Auth via API key  • Order validation  • Rate limit                │
│  • Talks to Ledger to reserve funds, then to Engine to submit order   │
│  • Subscribes to Market Data and fans out over WebSocket             │
└────┬────────────────────────────────────────────────────┬────────────┘
     │ HTTP: POST /reserve, /release                       │ HTTP: POST /orders
     ▼                                                     ▼
┌────────────────────────┐                ┌──────────────────────────────┐
│  Ledger (port 8081)    │                │  Matching Engine (port 8082)  │
│  • Balances (free,     │                │  • Order book (bid/ask trees) │
│    locked) per user    │                │  • Matching: price–time       │
│  • Reserve / release   │                │  • All order types + STP      │
│  • Consumes Trade      │                │  • Emits events to Redis      │
│    events to settle    │                │  • Replays event log on boot  │
└──────────┬─────────────┘                └────────────────┬─────────────┘
           │ XREAD engine.events                            │ XADD engine.events
           ▼                                                ▼
                       ┌────────────────────────────────────────┐
                       │   Redis (docker-compose)               │
                       │   Streams: engine.events  (event log)  │
                       │   Pub/Sub: marketdata.book, .trades    │
                       └────────────────┬───────────────────────┘
                                        │ XREAD engine.events
                                        ▼
                       ┌────────────────────────────────────────┐
                       │  Market Data (port 8083)               │
                       │  • Builds L2 book from events          │
                       │  • Maintains trade tape (ring buffer)  │
                       │  • Aggregates OHLCV candles (1m, 5m)   │
                       │  • Computes live ticker (last, 24h vol)│
                       │  • Publishes snapshots + deltas        │
                       │  • REST: GET /candles for history      │
                       └────────────────────────────────────────┘

  Side processes (act as ordinary users via Gateway REST):
  ┌────────────────────────────────────────────────────────────┐
  │  Market Maker bots (N=2–3, each its own process)           │
  │  • Quotes both sides around mid every ~500ms                │
  │  • Cancel/replace when mid moves > threshold                │
  │  • Different inventory targets to make book interesting     │
  └────────────────────────────────────────────────────────────┘
```

### Flow of a trade (read this slowly)

1. UI sends `POST /orders {side: buy, type: LIMIT, price, qty}` to Gateway.
2. Gateway authenticates, validates, then calls Ledger `POST /reserve`
   asking to lock `price * qty` USDC. Ledger returns success or rejects
   with `insufficient_funds`.
3. Gateway forwards the order to Engine `POST /orders`.
4. Engine inserts into the book and runs the match loop. Each fill
   produces a `Trade` event written to Redis Stream `engine.events`.
   Unfilled remainder rests on the book and emits `OrderAccepted`.
5. Market Data consumes the events, updates its L2 book and trade tape,
   publishes the delta on Redis Pub/Sub.
6. Ledger consumes the same `Trade` events and settles: debits locked of
   one asset, credits free of the other, for both counterparties.
7. Gateway, subscribed to Pub/Sub, broadcasts book/trade updates to all
   connected UI WebSockets. UI re‑renders.

---

## Repository layout

```
exchange-ts/
├── pnpm-workspace.yaml
├── package.json                 # root scripts (dev, build, test)
├── docker-compose.yml           # Redis only
├── tsconfig.base.json
└── packages/
    ├── common/                  # shared types, event schemas, decimal helpers
    │   └── src/{types,events,decimal,ids}.ts
    ├── engine/                  # matching engine service
    │   └── src/{book,matcher,orderTypes,server,eventLog}.ts
    ├── ledger/                  # balances + settlement service
    │   └── src/{accounts,reservations,server,settler}.ts
    ├── gateway/                 # REST + WebSocket front door
    │   └── src/{rest,ws,auth,clients}.ts
    ├── marketdata/              # derived L2 book + trade tape + candles
    │   └── src/{l2book,tape,candles,ticker,server,publisher}.ts
    ├── mm-bot/                  # market maker bot (run multiple instances)
    │   └── src/{strategy,client,index}.ts
    └── ui/                      # Vite + React
        └── src/{components,hooks,api}/...
```

Key practical choices:
- **TypeScript everywhere**, `pnpm` workspaces.
- **Decimal math**: use `decimal.js` or store all prices/qtys as
  **integer base units** (e.g. satoshis, 6‑decimal USDC). Never use
  JS `number` for money. We'll use integer base units throughout.
- **Order book data structure**: `sorted-btree` keyed by price; each
  node holds a doubly‑linked list of orders for O(1) head pop and O(1)
  cancel‑by‑id (we keep an `orderId → node` map).
- **Event log**: Redis Stream `engine.events`. Every event has a
  monotonic `seq` plus a typed payload. On engine boot, `XREAD` from
  `0` and replay to rebuild the book.
- **Idempotency**: every command carries a `clientOrderId`; engine
  rejects duplicates.

---

## Service designs

### `common`
Shared between every package.
- `types.ts` — `Side`, `OrderType`, `TimeInForce`, `OrderStatus`.
- `events.ts` — discriminated union of engine events
  (`OrderAccepted | OrderRejected | OrderCancelled | Trade`).
- `decimal.ts` — base‑unit helpers (`toBase`, `fromBase`, fixed
  precision per asset).
- `ids.ts` — ULID/UUID helpers.

### `engine` — the heart of the exchange
- **Book** (`book.ts`): two `sorted-btree` instances (bids desc, asks
  asc). Each price level is a FIFO queue. Maintain `orderId → ref`
  map for O(log n) cancel.
- **Matcher** (`matcher.ts`): the loop that takes an incoming order and
  walks the opposite side. Emits `Trade` per fill. Handles all order
  types in one function with a small policy table.
- **STP** (`orderTypes.ts`): before matching a fill, if `restingOrder.userId === incoming.userId`, skip per policy.
- **Event log** (`eventLog.ts`): `XADD engine.events` for every event.
  On boot, `XREAD` from `0` to rebuild the in‑memory book before
  accepting new orders.
- **Server** (`server.ts`): tiny HTTP server. `POST /orders`,
  `DELETE /orders/:id`, `GET /healthz`. Single‑threaded by design —
  this is the *one* place where order arrival is serialized.

### `ledger`
- **Accounts** (`accounts.ts`): `Map<userId, Map<asset, {free, locked}>>`.
- **Reservations** (`reservations.ts`): `reserve(userId, asset, amount)`
  moves free → locked atomically; `release` is the inverse.
- **Settler** (`settler.ts`): consumes `engine.events` from Redis. On
  `Trade(buyer, seller, price, qty)`: debit buyer's locked USDC by
  `price*qty`, credit buyer's free BTC by `qty`; debit seller's locked
  BTC by `qty`, credit seller's free USDC by `price*qty`. Apply maker
  rebate / taker fee here.
- **Server**: `POST /reserve`, `POST /release`, `GET /balances/:userId`.

### `gateway`
- **Auth** (`auth.ts`): simple API key → userId map for now.
- **REST** (`rest.ts`): `POST /orders` runs reserve → submit; on engine
  reject, calls Ledger `release` to unwind.
- **WS** (`ws.ts`): clients subscribe to `book@BTC-USDC`, `trades@BTC-USDC`,
  `account@<userId>`. Gateway is a Redis Pub/Sub subscriber and
  fan‑outs to its WS clients.

### `marketdata`
- **L2 book** (`l2book.ts`): aggregates per‑order quantities into per
  price‑level depth. Updated incrementally from engine events.
- **Tape** (`tape.ts`): ring buffer of the last N trades.
- **Candles** (`candles.ts`): one rolling aggregator per configured
  interval (`1m`, `5m`). On each `Trade(price, qty, ts)`:
  - Compute `bucketStart = floor(ts / interval) * interval`.
  - If `bucketStart > current.bucketStart`: close the current candle
    (publish `candle.close`), open a new one with `O=H=L=C=price`,
    `V=qty`.
  - Else: update `H = max(H, price)`, `L = min(L, price)`,
    `C = price`, `V += qty`, publish `candle.update`.
  - Keep a ring buffer of the last ~500 closed candles per interval
    so the UI can backfill on connect (`GET /candles?interval=1m&limit=300`).
- **Ticker** (`ticker.ts`): tracks `lastPrice`, rolling 24h volume,
  24h % change (derived from the candle ring buffers). Publishes on
  every trade.
- **Publisher** (`publisher.ts`): every event → publish delta on
  `marketdata.book` / `marketdata.trades` / `marketdata.candles.<interval>`
  / `marketdata.ticker`. Periodic full snapshot on
  `marketdata.book.snapshot` so new subscribers can bootstrap.
- **Server** (`server.ts`): `GET /candles?interval=1m&limit=300` for
  historical backfill, `GET /healthz`.

### `mm-bot`
- **Strategy** (`strategy.ts`): a tiny "around mid" quoter — read top of
  book, compute mid, quote `mid ± spread/2` at configurable size on
  both sides. Cancel & replace on mid drift > N ticks or every M ms.
- **Client** (`client.ts`): wraps Gateway REST/WS.
- We'll run 2–3 with different parameters so the book has personality.

### `ui` (React + Vite)
- **OrderBook**: two stacked half‑books with depth bars; recomputes on
  WS deltas.
- **TradeTape**: scrolling list, color‑coded by aggressor side.
- **OrderForm**: side / type / price / qty; live "you would match X"
  preview computed against the local book.
- **Balances**: free/locked per asset.
- **MatchLog**: a debug panel that prints every event the UI receives —
  this is the **"visible matching"** view. Watching bots quote and
  trades print as you place orders is the core learning moment.
- **CandlestickChart**: real‑time OHLCV chart using
  [`lightweight-charts`](https://github.com/tradingview/lightweight-charts)
  (TradingView's open‑source library — what most crypto exchanges
  actually use). Flow:
  1. On mount: `GET /candles?interval=<sel>&limit=300` → seed series.
  2. Subscribe to `candles@BTC-USDC@<sel>` over WS.
  3. On `candle.update`: mutate the last bar in place
     (`series.update(bar)`).
  4. On `candle.close`: the next `update` for a new bucketStart
     naturally appends a new bar.
  5. Interval toggle (`1m` | `5m`) re‑backfills and re‑subscribes.
- **PriceTicker**: large live price + 24h change %, color flashes green/
  red on tick. Driven by `marketdata.ticker` WS topic.

---

## Implementation phases

Each phase ends at a runnable, demonstrable milestone. Do not skip
ahead — each phase teaches one concept.

**Phase 0 — Scaffold (½ day)**
- pnpm workspace, tsconfig, base scripts.
- `docker-compose.yml` running Redis 7.
- `common` package with types, decimal helpers.
- `pnpm dev` runs everything via `concurrently`.

**Phase 1 — Engine in isolation (1–2 days) ← biggest learning beat**
- Build `book` + `matcher` with **unit tests only**, no network.
- Tests cover: crossing limit orders, partial fills, price‑time priority
  (two orders same price, earlier fills first), all order types
  (LIMIT/MARKET/IOC/FOK/POST_ONLY), STP cancel‑new, cancel by id.
- This phase is where you'll really learn matching. Don't move on until
  the tests feel obvious.

**Phase 2 — Event log + replay (½ day)**
- Engine emits events to `engine.events` Redis Stream.
- Engine boot: `XREAD` from 0 and rebuild book before accepting input.
- Add HTTP server. Smoke test: place orders via curl, kill engine,
  restart, confirm book is identical.

**Phase 3 — Ledger (½ day)**
- Accounts + reserve/release HTTP.
- Settler consumes engine events. Apply fees.
- Test: simulate a buy/sell, verify balances move.

**Phase 4 — Gateway (½ day)**
- REST: reserve → submit → release‑on‑reject.
- WS: subscribe + fan‑out from Redis Pub/Sub.
- Auth: hardcoded API keys (`user1`, `user2`, `mm1`, `mm2`).

**Phase 5 — Market data (1 day)**
- L2 book aggregator + trade tape.
- Candle aggregator: 1m and 5m, with unit tests covering
  bucket‑boundary rollover, mid‑bucket updates, gaps with no trades
  (carry forward the prior close as a flat candle).
- Ticker: last price, 24h volume, 24h % change.
- Publish deltas + periodic snapshots on Pub/Sub.
- `GET /candles` REST for historical backfill.

**Phase 6 — UI (1.5 days)**
- React + Vite. Order book, tape, order form, balances, match log.
- Add `lightweight-charts` candlestick chart with interval toggle
  (1m / 5m) and the live price ticker.
- Connect via Gateway WS for book/trades/candles/ticker; REST for
  candle backfill on mount.

**Phase 7 — Market makers (½ day)**
- One MM bot, then a second with different parameters.
- Watch the book come alive, candles start drawing themselves as
  bots cross each other occasionally. Place a market order from the
  UI and watch it eat liquidity in real time — the candle's high or
  low updates instantly.

---

## Critical files (paths we'll create)

- `packages/common/src/events.ts` — event schema (the contract every
  service speaks).
- `packages/engine/src/book.ts` — order book data structure.
- `packages/engine/src/matcher.ts` — matching algorithm (the single
  most important file in the whole project).
- `packages/engine/src/orderTypes.ts` — per‑order‑type policy.
- `packages/engine/src/eventLog.ts` — Redis Streams write + replay.
- `packages/ledger/src/settler.ts` — how trades become balance moves.
- `packages/gateway/src/rest.ts` — the reserve → submit → release flow.
- `packages/marketdata/src/l2book.ts` — event → depth aggregation.
- `packages/marketdata/src/candles.ts` — trade events → rolling OHLCV
  buckets (the core of the chart feature).
- `packages/marketdata/src/ticker.ts` — live last‑price / 24h stats.
- `packages/mm-bot/src/strategy.ts` — the quoting loop.
- `packages/ui/src/components/OrderBook.tsx` — depth view.
- `packages/ui/src/components/CandlestickChart.tsx` — TradingView
  lightweight‑charts wrapper with WS update + interval toggle.
- `packages/ui/src/components/PriceTicker.tsx` — live price + 24h change.
- `packages/ui/src/components/MatchLog.tsx` — debug stream that makes
  matching visible.

No existing files to reuse — this is greenfield.

---

## Verification

End‑to‑end:
- `docker compose up -d redis`
- `pnpm dev` (starts engine, ledger, gateway, marketdata, 2× mm‑bot, UI).
- Open `http://localhost:5173`.
  - Order book populates within seconds (the MMs are quoting).
  - Candlestick chart backfills with the last 300 minutes of synthetic
    history (initially flat at MM mid), then starts updating live as
    bots cross each other.
  - Price ticker shows the latest trade price, flashing on each tick.
  - Place a small market BUY → see the ask side flash and a green
    trade appear on the tape. Your USDC balance drops, BTC rises. The
    live (rightmost) candle's High and Close update in the same frame.
  - Switch the chart from 1m → 5m. Older bars regroup; the live bar
    is now the current 5m bucket.
  - Place a LIMIT BUY below best bid → see it sit on the book.
    Cancel it → see it disappear.
  - Place a POST_ONLY that would cross → it's rejected; balance
    reservation is released.
- Replay test: stop the engine container/process, restart it. The
  book rebuilds from `engine.events`; market data resyncs from the
  next snapshot; UI keeps working.

Per‑phase tests:
- Engine: `pnpm --filter engine test` — matching unit tests are the
  single best learning artifact. Aim for ~30 small, named tests.
- Ledger: integration test that drives the settler with synthetic
  trade events and asserts balances.
- Gateway: integration test that walks reserve → submit → release.
- Market data candles: feed a scripted sequence of synthetic trades
  across a bucket boundary and assert OHLCV correctness, including
  the "no trade in bucket" carry‑forward case.

---

## What we are explicitly NOT building (v1)

- Margin, perps, derivatives, lending. Spot only.
- Multiple pairs. One pair (BTC/USDC) keeps the focus on mechanics.
- Withdrawals / on‑chain integration. Balances are simulated.
- Production‑grade auth (no JWT, no rate‑limit storage). API keys only.
- HA / failover for the engine. One engine instance, period — this is
  also realistic; real exchanges run a single active matcher per
  symbol with hot standbys.

