package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/KaustubhPatange/exchange/common"
	"github.com/KaustubhPatange/exchange/common/api"
	redisExt "github.com/KaustubhPatange/exchange/common/redis"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

type GetDepthQuery struct {
	Levels int `form:"levels,default=20" binding:"gte=0"`
}

type GetOrdersQuery struct {
	UserID string `form:"userId" binding:"required"`
}

type GetCancelQuery struct {
	UserID string `form:"userId" binding:"required"`
}

type PlaceOrderBody struct {
	ClientOrderID string           `json:"clientOrderId" binding:"required"`
	UserID        string           `json:"userId" binding:"required"`
	Symbol        common.Symbol    `json:"symbol" binding:"required"`
	Side          common.Side      `json:"side" binding:"required"`
	Type          common.OrderType `json:"type" binding:"required"`
	Price         int64            `json:"price"`
	Qty           int64            `json:"qty" binding:"required"`
}

func toEngineCommand(body *PlaceOrderBody) (*common.NewOrderCommand, error) {
	return &common.NewOrderCommand{
		ClientOrderID: body.ClientOrderID,
		UserID:        body.UserID,
		Symbol:        body.Symbol,
		Side:          body.Side,
		Type:          body.Type,
		Price:         body.Price,
		Qty:           body.Qty,
	}, nil
}

func serializeEvents(events []common.EngineEvent) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, len(events))
	for i, ev := range events {
		payload, err := ev.Serialize()
		if err != nil {
			return nil, err
		}
		out[i] = json.RawMessage(payload)
	}
	return out, nil
}

func main() {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		panic("Redis cannot be connected")
	}
	client := redis.NewClient(opt)
	defer client.Close()

	port := os.Getenv("ENGINE_PORT")
	if port == "" {
		port = "8082"
	}

	adminEnabled := os.Getenv("EXCHANGE_ADMIN_ENABLED") == "1"

	eng := NewMatchingEngine()
	eventLog := NewEventLog(client)
	resetting := false

	t0 := time.Now()
	lastSeq, err := ReplayInto(context.Background(), eng, eventLog)
	if err != nil {
		log.Fatalf("[engine] replay failed: %v", err)
	}

	log.Printf("[engine] replayed %d events in %s; bestBid=%s bestAsk=%s\n",
		lastSeq, time.Since(t0), bidAskStr(eng.book.BestBid()), bidAskStr(eng.book.BestAsk()))

	r := gin.Default()

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, &gin.H{"ok": true, "seq": eng.seq})
	})

	r.GET("/depth", func(c *gin.Context) {
		var req GetDepthQuery
		if err := c.ShouldBindQuery(&req); err != nil {
			api.WriteError(c, err)
			return
		}
		bids := eng.book.Depth(common.SideBuy, req.Levels)
		asks := eng.book.Depth(common.SideSell, req.Levels)

		c.JSON(200, &gin.H{
			"bids": depthToPairs(bids),
			"asks": depthToPairs(asks),
		})
	})
	r.GET("/orders", func(c *gin.Context) {
		var req GetOrdersQuery
		if err := c.ShouldBindQuery(&req); err != nil {
			api.WriteError(c, err)
			return
		}
		orders := eng.GetUserOrders(req.UserID)
		result := make([]gin.H, len(orders))

		for i, o := range orders {
			result[i] = gin.H{
				"orderId":       o.OrderID,
				"clientOrderId": o.ClientOrderID,
				"userId":        o.UserID,
				"symbol":        o.Symbol,
				"side":          o.Side,
				"type":          o.Type,
				"price":         strconv.FormatInt(o.Price, 10),
				"qty":           strconv.FormatInt(o.Qty, 10),
				"remaining":     strconv.FormatInt(o.Remaining, 10),
				"status":        o.Status,
				"createdAt":     o.CreatedAt,
			}
		}

		c.JSON(200, &gin.H{"orders": result})
	})
	r.POST("/orders", func(c *gin.Context) {
		if resetting {
			c.JSON(503, &gin.H{"events": []gin.H{{"error": "RESETTING"}}})
			return
		}
		var body PlaceOrderBody
		if err := c.ShouldBindJSON(&body); err != nil {
			api.WriteError(c, err)
			return
		}
		cmd, err := toEngineCommand(&body)
		if err != nil {
			c.JSON(400, &gin.H{"events": []gin.H{{"error": err.Error()}}})
			return
		}
		events, err := eng.Submit(cmd)
		if err != nil {
			c.JSON(500, &gin.H{"events": []gin.H{{"error": err.Error()}}})
			return
		}
		for _, ev := range events {
			if err := eventLog.Append(c.Request.Context(), ev); err != nil {
				c.JSON(500, &gin.H{"events": []gin.H{{"error": err.Error()}}})
				return
			}
		}
		out, err := serializeEvents(events)
		if err != nil {
			c.JSON(500, &gin.H{"events": []gin.H{{"error": err.Error()}}})
			return
		}
		c.JSON(200, &gin.H{"events": out})
	})
	r.DELETE("/orders/:orderId", func(c *gin.Context) {
		if resetting {
			c.JSON(503, &gin.H{"events": []gin.H{{"error": "RESETTING"}}})
			return
		}
		var query GetCancelQuery
		if err := c.ShouldBindQuery(&query); err != nil {
			api.WriteError(c, err)
			return
		}
		cmd := &common.CancelOrderCommand{
			OrderID: c.Param("orderId"),
			UserID:  query.UserID,
		}
		events := eng.Cancel(cmd)
		for _, ev := range events {
			if err := eventLog.Append(c.Request.Context(), ev); err != nil {
				c.JSON(500, &gin.H{"events": []gin.H{{"error": err.Error()}}})
				return
			}
		}
		out, err := serializeEvents(events)
		if err != nil {
			c.JSON(500, &gin.H{"events": []gin.H{{"error": err.Error()}}})
			return
		}
		c.JSON(200, &gin.H{"events": out})
	})

	if adminEnabled {
		r.POST("/admin/reset", func(c *gin.Context) {
			resetting = true
			defer func() { resetting = false }()

			ctx := c.Request.Context()
			if err := client.Del(ctx, redisExt.DefaultStreamKey).Err(); err != nil {
				c.JSON(500, &gin.H{"error": err.Error()})
				return
			}
			eng = NewMatchingEngine()
			eventLog = NewEventLog(client)

			sentinel, err := json.Marshal(&gin.H{"kind": "Reset", "ts": time.Now().UnixMilli()})
			if err != nil {
				c.JSON(500, &gin.H{"error": err.Error()})
				return
			}
			if err := client.Publish(ctx, redisExt.DefaultStreamKey+".live", sentinel).Err(); err != nil {
				c.JSON(500, &gin.H{"error": err.Error()})
				return
			}

			log.Println("[engine] /admin/reset — book + stream cleared")
			c.JSON(200, &gin.H{"ok": true, "seq": 0})
		})
	}

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	go func() {
		log.Printf("[engine] listening on http://localhost:%s\n", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[engine] fatal: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	sig := <-stop
	log.Printf("[engine] %s — shutting down\n", sig)
	_ = srv.Shutdown(context.Background())
}

func depthToPairs(levels []DepthLevel) [][2]string {
	out := make([][2]string, len(levels))
	for i, d := range levels {
		out[i] = [2]string{strconv.FormatInt(d.Price, 10), strconv.FormatInt(d.TotalQty, 10)}
	}
	return out
}

func bidAskStr(price int64, ok bool) string {
	if !ok {
		return "∅"
	}
	return strconv.FormatInt(price, 10)
}
