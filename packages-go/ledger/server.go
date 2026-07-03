package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/KaustubhPatange/exchange/common"
	"github.com/KaustubhPatange/exchange/common/api"
	redisExt "github.com/KaustubhPatange/exchange/common/redis"
	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
)

type ReserveBody struct {
	UserID string `json:"userId" binding:"required"`
	Asset  string `json:"asset" binding:"required"`
	Amount string `json:"amount" binding:"required"`
}

type ReleaseBody struct {
	UserID string `json:"userId" binding:"required"`
	Asset  string `json:"asset" binding:"required"`
	Amount string `json:"amount" binding:"required"`
}

func snapshotToJSON(snapshot map[common.Asset]Balance) gin.H {
	return gin.H{
		"BTC": gin.H{
			"free":   snapshot[common.AssetBTC].Free,
			"locked": snapshot[common.AssetBTC].Locked,
		},
		"USDC": gin.H{
			"free":   snapshot[common.AssetUSDC].Free,
			"locked": snapshot[common.AssetUSDC].Locked,
		},
	}
}

func main() {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}
	port := os.Getenv("LEDGER_PORT")
	if port == "" {
		port = "8081"
	}
	adminEnabled := os.Getenv("EXCHANGE_ADMIN_ENABLED") == "1"

	opt, err := goredis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("[ledger] invalid REDIS_URL: %v", err)
	}
	redisClient := goredis.NewClient(opt)
	defer redisClient.Close()

	accounts := &Accounts{balances: make(map[string]map[common.Asset]*Balance)}
	settler := &Settler{accounts: *accounts, openBuys: make(map[string]*OpenBuy)}

	var resetting atomic.Bool
	var consMu sync.Mutex

	applyEvent := func(item redisExt.StreamItem) {
		settler.Apply(*item.Event, item.Mode)
	}

	cons := redisExt.StartConsumer(redisURL, "ledger", &resetting, applyEvent, nil)
	redisExt.WatchConsumer(cons, "ledger", &resetting)

	r := gin.Default()

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, &gin.H{
			"ok": true,
		})
	})

	r.GET("/balances/:userId", func(c *gin.Context) {
		userID := c.Param("userId")
		c.JSON(200, snapshotToJSON(accounts.Snapshot(userID)))
	})

	r.POST("/reserve", func(c *gin.Context) {
		if resetting.Load() {
			c.JSON(503, &gin.H{"ok": false, "error": "RESETTING"})
			return
		}
		var body ReserveBody
		if err := c.ShouldBindJSON(&body); err != nil {
			api.WriteError(c, err)
			return
		}
		amount, err := strconv.ParseInt(body.Amount, 10, 64)
		if err != nil {
			api.WriteError(c, err)
			return
		}
		if err := accounts.Reserve(body.UserID, common.Asset(body.Asset), amount); err != nil {
			if insufficient, ok := errors.AsType[*InsufficientFundsError](err); ok {
				c.JSON(409, &gin.H{
					"ok":        false,
					"error":     "INSUFFICIENT_FUNDS",
					"requested": strconv.FormatInt(insufficient.Requested, 10),
					"available": strconv.FormatInt(insufficient.Available, 10),
				})
				return
			}
			api.WriteError(c, err)
			return
		}
		c.JSON(200, &gin.H{"ok": true})
	})

	r.POST("/release", func(c *gin.Context) {
		if resetting.Load() {
			c.JSON(503, &gin.H{"ok": false, "error": "RESETTING"})
			return
		}
		var body ReleaseBody
		if err := c.ShouldBindJSON(&body); err != nil {
			api.WriteError(c, err)
			return
		}
		amount, err := strconv.ParseInt(body.Amount, 10, 64)
		if err != nil {
			api.WriteError(c, err)
			return
		}
		if err := accounts.Release(body.UserID, common.Asset(body.Asset), amount); err != nil {
			api.WriteError(c, err)
			return
		}
		c.JSON(200, &gin.H{"ok": true})
	})

	if adminEnabled {
		r.POST("/admin/reset", func(c *gin.Context) {
			consMu.Lock()
			defer consMu.Unlock()

			resetting.Store(true)
			defer resetting.Store(false)

			cons.Stop()
			accounts.Clear()
			settler.Clear()

			cons = redisExt.StartConsumer(redisURL, "ledger", &resetting, applyEvent, nil)
			redisExt.WatchConsumer(cons, "ledger", &resetting)

			log.Println("[ledger] /admin/reset — balances cleared, consumer restarted")
			c.JSON(200, &gin.H{"ok": true})
		})
	}

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	go func() {
		log.Printf("[ledger] listening on http://localhost:%s\n", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[ledger] fatal: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	sig := <-stop
	log.Printf("[ledger] %s — shutting down\n", sig)

	_ = srv.Shutdown(context.Background())
	consMu.Lock()
	cons.Stop()
	consMu.Unlock()
}
