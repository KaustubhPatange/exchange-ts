package redis

import (
	"context"
	"strings"

	"github.com/KaustubhPatange/exchange/common"
	"github.com/redis/go-redis/v9"
)

const DefaultStreamKey = "engine.events"

type StreamMode string

const (
	StreamModeReplay StreamMode = "replay"
	StreamModeLive   StreamMode = "live"
)

type StreamItem struct {
	Event *common.EngineEvent
	Mode  StreamMode
}

func consumeEngineStream(ctx context.Context, client *redis.Client) (<-chan StreamItem, <-chan error) {
	events := make(chan StreamItem)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)

		from := "-"
		page := int64(1000)

		// replay mode
		for {
			result, err := client.XRangeN(ctx, DefaultStreamKey, from, "+", page).Result()
			if err != nil {
				errs <- err
				break
			}
			if len(result) == 0 {
				break
			}

			for _, entry := range result {
				event, err := decodeFields(entry)
				if err != nil {
					errs <- err
					break
				}

				select {
				case events <- StreamItem{Event: &event, Mode: StreamModeReplay}:
				case <-ctx.Done():
					return
				}
				from = "(" + entry.ID
			}

			if int64(len(result)) < page {
				break
			}
		}

		lastID := "0"
		if strings.HasPrefix(from, "(") {
			lastID = from[1:]
		}

		// live mode
		for {
			result, err := client.XRead(ctx, &redis.XReadArgs{
				Streams: []string{DefaultStreamKey, lastID},
				Block:   0,
				Count:   page,
			}).Result()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				errs <- err
				continue
			}

			for _, stream := range result {
				for _, entry := range stream.Messages {
					event, err := decodeFields(entry)
					if err != nil {
						errs <- err
						continue
					}

					select {
					case events <- StreamItem{Event: &event, Mode: StreamModeLive}:
					case <-ctx.Done():
						return
					}
					lastID = entry.ID
				}
			}
		}
	}()

	return events, errs
}

func decodeFields(entry redis.XMessage) (common.EngineEvent, error) {
	data, ok := entry.Values["data"]
	if !ok {
		return nil, nil
	}

	payload, ok := data.(string)
	if !ok {
		return nil, nil
	}

	return common.DeserializeEvent(payload)
}
