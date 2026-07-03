package redis

import (
	"context"
	"log"
	"os"
	"sync/atomic"

	goredis "github.com/redis/go-redis/v9"
)

type ConsumerHandle struct {
	client *goredis.Client
	cancel context.CancelFunc
	Done   chan struct{}
}

func StartConsumer(
	redisURL string,
	tag string,
	resetting *atomic.Bool,
	onEvent func(StreamItem),
	onLive func(),
) *ConsumerHandle {
	opt, err := goredis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("[%s] invalid REDIS_URL: %v", tag, err)
	}
	client := goredis.NewClient(opt)
	ctx, cancel := context.WithCancel(context.Background())

	h := &ConsumerHandle{client: client, cancel: cancel, Done: make(chan struct{})}

	events, errs := consumeEngineStream(ctx, client)

	go func() {
		defer close(h.Done)
		defer cancel()

		replayed := 0
		liveStarted := false

		for events != nil || errs != nil {
			select {
			case item, ok := <-events:
				if !ok {
					events = nil
					continue
				}
				if item.Mode == StreamModeLive && !liveStarted {
					liveStarted = true
					log.Printf("[%s] replay done after %d events; switching to LIVE", tag, replayed)
					if onLive != nil {
						onLive()
					}
				}
				onEvent(item)
				if item.Mode == StreamModeReplay {
					replayed++
				}

			case err, ok := <-errs:
				if !ok {
					errs = nil
					continue
				}
				// Disconnect during reset surfaces here; the reset path handles it.
				if resetting.Load() {
					continue
				}
				log.Printf("[%s] stream consumer error: %v", tag, err)
			}
		}
	}()

	return h
}

func (h *ConsumerHandle) Stop() {
	h.cancel()
	<-h.Done
	h.client.Close()
}

func WatchConsumer(h *ConsumerHandle, tag string, resetting *atomic.Bool) {
	go func() {
		<-h.Done
		if !resetting.Load() {
			log.Printf("[%s] stream consumer crashed", tag)
			os.Exit(1)
		}
	}()
}
