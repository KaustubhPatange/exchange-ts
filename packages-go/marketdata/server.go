package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/KaustubhPatange/exchange/common"
	redisExt "github.com/KaustubhPatange/exchange/common/redis"
	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
)

func publish(ctx context.Context, pub *goredis.Client, channel string, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		log.Printf("[marketdata] marshal error on %s: %v", channel, err)
		return
	}
	if err := pub.Publish(ctx, channel, payload).Err(); err != nil {
		log.Printf("[marketdata] publish error on %s: %v", channel, err)
	}
}

func main() {
	const oneMinMs = 60_000
	const fiveMinMs = 5 * oneMinMs

	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}
	port := os.Getenv("MARKETDATA_PORT")
	if port == "" {
		port = "8083"
	}
	adminEnabled := os.Getenv("EXCHANGE_ADMIN_ENABLED") == "1"

	opt, err := goredis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("[marketdata] invalid REDIS_URL: %v", err)
	}
	pub := goredis.NewClient(opt)
	defer pub.Close()

	l2 := NewL2Book()
	tape := NewTape(500)
	aggs := map[string]*CandleAggregator{
		"1m": NewCandleAggregator("1m", oneMinMs, 0),
		"5m": NewCandleAggregator("5m", fiveMinMs, 0),
	}

	ctx := context.Background()

	publishL2 := func(deltas []L2Delta) {
		for _, d := range deltas {
			publish(ctx, pub, "marketdata.l2", d)
		}
	}
	publishTrade := func(ev *common.TradeEvent) {
		entry := tape.Push(ev)
		publish(ctx, pub, "marketdata.trades", entry)
	}
	publishCandle := func(events []CandleEvent) {
		for _, e := range events {
			publish(ctx, pub, "marketdata.candles."+e.Interval, e)
		}
	}
	publishTicker := func() {
		publish(ctx, pub, "marketdata.ticker", ComputeTicker(aggs["1m"]))
	}
	publishL2Snapshot := func() {
		publish(ctx, pub, "marketdata.l2.snapshot", l2.Snapshot(50))
	}

	applyEvent := func(item redisExt.StreamItem) {
		ev := *item.Event
		if deltas := l2.Apply(ev); len(deltas) > 0 {
			publishL2(deltas)
		}
		if te, ok := ev.(*common.TradeEvent); ok {
			publishTrade(te)
			c1 := aggs["1m"].OnTrade(te.Price, te.Qty, te.TS)
			c5 := aggs["5m"].OnTrade(te.Price, te.Qty, te.TS)
			publishCandle(append(c1, c5...))
			publishTicker()
		}
	}

	var resetting atomic.Bool
	var consMu sync.Mutex

	cons := redisExt.StartConsumer(redisURL, "marketdata", &resetting, applyEvent, publishL2Snapshot)
	redisExt.WatchConsumer(cons, "marketdata", &resetting)

	candleTicker := time.NewTicker(2 * time.Second)
	defer candleTicker.Stop()
	go func() {
		for range candleTicker.C {
			now := time.Now().UnixMilli()
			c1 := aggs["1m"].Tick(now)
			c5 := aggs["5m"].Tick(now)
			if len(c1) > 0 || len(c5) > 0 {
				publishCandle(append(c1, c5...))
				publishTicker()
			}
		}
	}()

	snapshotTicker := time.NewTicker(5 * time.Second)
	defer snapshotTicker.Stop()
	go func() {
		for range snapshotTicker.C {
			publishL2Snapshot()
		}
	}()

	r := gin.Default()

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, &gin.H{"ok": true})
	})

	r.GET("/snapshot", func(c *gin.Context) {
		levels, _ := strconv.Atoi(c.DefaultQuery("levels", "50"))
		c.JSON(200, l2.Snapshot(levels))
	})

	r.GET("/trades", func(c *gin.Context) {
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
		c.JSON(200, tape.Recent(limit))
	})

	r.GET("/candles", func(c *gin.Context) {
		interval := c.DefaultQuery("interval", "1m")
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "300"))
		agg, ok := aggs[interval]
		if !ok {
			c.JSON(200, &gin.H{"error": "unknown interval " + interval})
			return
		}
		c.JSON(200, &gin.H{"interval": interval, "candles": agg.Recent(limit)})
	})

	r.GET("/ticker", func(c *gin.Context) {
		c.JSON(200, ComputeTicker(aggs["1m"]))
	})

	if adminEnabled {
		r.POST("/admin/reset", func(c *gin.Context) {
			consMu.Lock()
			defer consMu.Unlock()

			resetting.Store(true)
			defer resetting.Store(false)

			cons.Stop()
			l2.Clear()
			tape.Clear()
			aggs["1m"].Clear()
			aggs["5m"].Clear()

			cons = redisExt.StartConsumer(redisURL, "marketdata", &resetting, applyEvent, publishL2Snapshot)
			redisExt.WatchConsumer(cons, "marketdata", &resetting)

			publishL2Snapshot()
			publishTicker()

			log.Println("[marketdata] /admin/reset — projections cleared, consumer restarted")
			c.JSON(200, &gin.H{"ok": true})
		})
	}

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	go func() {
		log.Printf("[marketdata] listening on http://localhost:%s\n", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[marketdata] fatal: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	sig := <-stop
	log.Printf("[marketdata] %s — shutting down\n", sig)

	_ = srv.Shutdown(context.Background())
	consMu.Lock()
	cons.Stop()
	consMu.Unlock()
}
