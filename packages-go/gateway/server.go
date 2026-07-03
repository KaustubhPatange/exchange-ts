package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/KaustubhPatange/exchange/common"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

type placeOrderBody struct {
	ClientOrderID string      `json:"clientOrderId"`
	Symbol        string      `json:"symbol"`
	Side          common.Side `json:"side"`
	Type          string      `json:"type"`
	Price         *string     `json:"price"` // user-facing decimal, e.g. "67234.50"
	Qty           string      `json:"qty"`   // user-facing decimal, e.g. "0.001"
}

func userIDFromReq(c *gin.Context) string {
	return resolveUser(c.GetHeader("x-api-key"))
}

// writeRaw relays an upstream service's JSON body verbatim.
func writeRaw(c *gin.Context, raw json.RawMessage, err error) {
	if err != nil {
		c.JSON(502, gin.H{"error": err.Error()})
		return
	}
	c.Data(200, "application/json; charset=utf-8", raw)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

func main() {
	port := envOr("GATEWAY_PORT", "8080")
	redisURL := envOr("REDIS_URL", "redis://localhost:6379")

	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("[gateway] invalid REDIS_URL: %v", err)
	}
	sub := redis.NewClient(opt)
	defer sub.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub := NewHub()
	go hub.Run(ctx, sub)

	r := gin.Default()

	// CORS so the Vite UI can call us during dev.
	r.Use(func(c *gin.Context) {
		c.Header("access-control-allow-origin", "*")
		c.Header("access-control-allow-headers", "content-type, x-api-key")
		c.Header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	// ---------- Public proxies ----------
	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	r.GET("/api/snapshot", func(c *gin.Context) {
		raw, err := getJSON(marketdataURL + "/snapshot")
		writeRaw(c, raw, err)
	})
	r.GET("/api/trades", func(c *gin.Context) {
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
		raw, err := getJSON(fmt.Sprintf("%s/trades?limit=%d", marketdataURL, limit))
		writeRaw(c, raw, err)
	})
	r.GET("/api/candles", func(c *gin.Context) {
		interval := c.DefaultQuery("interval", "1m")
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "300"))
		raw, err := getJSON(fmt.Sprintf("%s/candles?interval=%s&limit=%d", marketdataURL, url.QueryEscape(interval), limit))
		writeRaw(c, raw, err)
	})
	r.GET("/api/ticker", func(c *gin.Context) {
		raw, err := getJSON(marketdataURL + "/ticker")
		writeRaw(c, raw, err)
	})

	// ---------- Authenticated endpoints ----------
	r.GET("/api/me", func(c *gin.Context) {
		userID := userIDFromReq(c)
		if userID == "" {
			c.JSON(401, gin.H{"error": "missing or invalid X-API-Key"})
			return
		}
		c.JSON(200, gin.H{"userId": userID})
	})

	r.GET("/api/balances", func(c *gin.Context) {
		userID := userIDFromReq(c)
		if userID == "" {
			c.JSON(401, gin.H{"error": "missing or invalid X-API-Key"})
			return
		}
		raw, err := getJSON(ledgerURL + "/balances/" + url.PathEscape(userID))
		writeRaw(c, raw, err)
	})

	// POST /api/orders — reserve → submit → release-on-reject
	r.POST("/api/orders", func(c *gin.Context) {
		userID := userIDFromReq(c)
		if userID == "" {
			c.JSON(401, gin.H{"error": "missing or invalid X-API-Key"})
			return
		}
		var body placeOrderBody
		if err := c.ShouldBindJSON(&body); err != nil || body.Symbol == "" || body.Side == "" || body.Type == "" || body.Qty == "" {
			c.JSON(400, gin.H{"error": "missing required fields (symbol, side, type, qty)"})
			return
		}

		qty, err := common.ToBaseUnits(body.Qty, common.BtcDecimals)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		var price *int64
		if body.Price != nil {
			p, err := common.ToBaseUnits(*body.Price, common.PriceDecimals)
			if err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			price = &p
		}

		res, err := reserveForOrder(body.Side, price, qty)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}

		reserveRes, reserveRaw, err := ledgerReserve(userID, res.Asset, res.Amount)
		if err != nil {
			c.JSON(502, gin.H{"error": err.Error()})
			return
		}
		if !reserveRes.OK {
			c.JSON(402, gin.H{"error": "INSUFFICIENT_FUNDS", "detail": json.RawMessage(reserveRaw)})
			return
		}

		clientOrderID := body.ClientOrderID
		if clientOrderID == "" {
			clientOrderID = common.NewOrderID()
		}
		engineBody := map[string]any{
			"clientOrderId": clientOrderID,
			"userId":        userID,
			"symbol":        body.Symbol,
			"side":          body.Side,
			"type":          body.Type,
			"qty":           strconv.FormatInt(qty, 10),
		}
		if price != nil {
			engineBody["price"] = strconv.FormatInt(*price, 10)
		}

		engineRes, engineRaw, err := enginePlace(engineBody)
		if err != nil {
			c.JSON(502, gin.H{"error": err.Error()})
			return
		}

		isReject := len(engineRes.Events) == 1 && engineRes.Events[0].Kind == "OrderRejected"
		if isReject {
			_, _ = sendJSON(http.MethodPost, ledgerURL+"/release", map[string]any{
				"userId": userID,
				"asset":  res.Asset,
				"amount": strconv.FormatInt(res.Amount, 10),
			})
		}
		c.Data(200, "application/json; charset=utf-8", engineRaw)
	})

	r.DELETE("/api/orders/:orderId", func(c *gin.Context) {
		userID := userIDFromReq(c)
		if userID == "" {
			c.JSON(401, gin.H{"error": "missing or invalid X-API-Key"})
			return
		}
		u := fmt.Sprintf("%s/orders/%s?userId=%s", engineURL, url.PathEscape(c.Param("orderId")), url.QueryEscape(userID))
		raw, err := sendJSON(http.MethodDelete, u, nil)
		writeRaw(c, raw, err)
	})

	r.GET("/api/orders", func(c *gin.Context) {
		userID := userIDFromReq(c)
		if userID == "" {
			c.JSON(401, gin.H{"error": "missing or invalid X-API-Key"})
			return
		}
		raw, err := getJSON(engineURL + "/orders?userId=" + url.QueryEscape(userID))
		writeRaw(c, raw, err)
	})

	// ---------- WebSocket fan-out ----------
	r.GET("/ws", func(c *gin.Context) {
		socket, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		cl := &client{socket: socket, subs: make(map[string]bool)}
		hub.add(cl)
		defer func() {
			hub.remove(cl)
			socket.Close()
		}()

		for {
			_, raw, err := socket.ReadMessage()
			if err != nil {
				return
			}
			var msg struct {
				Type     string   `json:"type"`
				Channels []string `json:"channels"`
			}
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "subscribe":
				hub.subscribe(cl, msg.Channels)
			case "unsubscribe":
				hub.unsubscribe(cl, msg.Channels)
			}
		}
	})

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	go func() {
		log.Printf("[gateway] listening on http://localhost:%s\n", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[gateway] fatal: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	sig := <-stop
	log.Printf("[gateway] %s — shutting down\n", sig)
	cancel()
	_ = srv.Shutdown(context.Background())
}
