package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// channelMap maps client-facing channel names to the Redis Pub/Sub channels
// the gateway relays. Client → server: "subscribe" with one or more names;
// gateway forwards matching messages as JSON envelopes { channel, data }.
var channelMap = map[string]string{
	"book":          "marketdata.l2",
	"book:snapshot": "marketdata.l2.snapshot",
	"trades":        "marketdata.trades",
	"ticker":        "marketdata.ticker",
	"candles:1m":    "marketdata.candles.1m",
	"candles:5m":    "marketdata.candles.5m",
	"events":        "engine.events.live",
}

// redisToGW is the reverse lookup, built once from channelMap.
var redisToGW = func() map[string]string {
	m := make(map[string]string, len(channelMap))
	for gw, r := range channelMap {
		m[r] = gw
	}
	return m
}()

type client struct {
	mu     sync.Mutex // serialises socket writes
	socket *websocket.Conn
	subs   map[string]bool // gateway channel names
}

func (c *client) send(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.socket.WriteMessage(websocket.TextMessage, data)
}

// Hub fans out Redis Pub/Sub messages to subscribed WebSocket clients. It keeps
// a single Redis subscription for the whole (small, fixed) channel set and a
// reverse map gwChannel → clients.
type Hub struct {
	mu          sync.RWMutex
	clients     map[*client]bool
	subscribers map[string]map[*client]bool // gw channel → clients
}

func NewHub() *Hub {
	return &Hub{
		clients:     make(map[*client]bool),
		subscribers: make(map[string]map[*client]bool),
	}
}

func (h *Hub) add(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = true
}

func (h *Hub) remove(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range c.subs {
		if set := h.subscribers[ch]; set != nil {
			delete(set, c)
		}
	}
	delete(h.clients, c)
}

func (h *Hub) subscribe(c *client, channels []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range channels {
		if _, ok := channelMap[ch]; !ok {
			continue
		}
		set := h.subscribers[ch]
		if set == nil {
			set = make(map[*client]bool)
			h.subscribers[ch] = set
		}
		set[c] = true
		c.subs[ch] = true
	}
}

func (h *Hub) unsubscribe(c *client, channels []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range channels {
		delete(c.subs, ch)
		if set := h.subscribers[ch]; set != nil {
			delete(set, c)
		}
	}
}

// broadcast delivers a Redis message to every client subscribed to the matching
// gateway channel.
func (h *Hub) broadcast(gwChannel string, envelope []byte) {
	h.mu.RLock()
	targets := make([]*client, 0, len(h.subscribers[gwChannel]))
	for c := range h.subscribers[gwChannel] {
		targets = append(targets, c)
	}
	h.mu.RUnlock()
	for _, c := range targets {
		c.send(envelope)
	}
}

// Run subscribes to all Redis channels and pumps messages into the hub until
// the context is cancelled.
func (h *Hub) Run(ctx context.Context, sub *redis.Client) {
	channels := make([]string, 0, len(channelMap))
	for _, r := range channelMap {
		channels = append(channels, r)
	}
	pubsub := sub.Subscribe(ctx, channels...)
	defer pubsub.Close()
	log.Printf("[gateway] subscribed to %v", channels)

	for msg := range pubsub.Channel() {
		gwChannel, ok := redisToGW[msg.Channel]
		if !ok {
			continue
		}
		envelope, err := json.Marshal(map[string]any{
			"channel": gwChannel,
			"data":    tryParseJSON(msg.Payload),
		})
		if err != nil {
			continue
		}
		h.broadcast(gwChannel, envelope)
	}
}

// tryParseJSON returns the decoded value if payload is valid JSON, else the raw
// string — matching the TS gateway's envelope shaping.
func tryParseJSON(payload string) any {
	var v any
	if err := json.Unmarshal([]byte(payload), &v); err != nil {
		return payload
	}
	return v
}
