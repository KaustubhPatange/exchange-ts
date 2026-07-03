package main

import (
	"context"

	"github.com/KaustubhPatange/exchange/common"
	redisExt "github.com/KaustubhPatange/exchange/common/redis"
	"github.com/redis/go-redis/v9"
)

type EventLog struct {
	redis     *redis.Client
	streamKey string
}

func NewEventLog(r *redis.Client) *EventLog {
	return &EventLog{
		redis:     r,
		streamKey: redisExt.DefaultStreamKey,
	}
}

func (e *EventLog) Append(ctx context.Context, event common.EngineEvent) error {
	payload, err := event.Serialize()
	if err != nil {
		return err
	}

	if err := e.redis.XAdd(ctx, &redis.XAddArgs{
		Stream: e.streamKey,
		ID:     "*",
		Values: map[string]any{"data": payload},
	}).Err(); err != nil {
		return err
	}

	return e.redis.Publish(ctx, e.streamKey+".live", payload).Err()
}

func (e *EventLog) ReadAll(ctx context.Context) (<-chan common.EngineEvent, <-chan error) {
	events := make(chan common.EngineEvent)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)

		from := "-"
		page := int64(1000)

		for {
			result, err := e.redis.XRangeN(ctx, redisExt.DefaultStreamKey, from, "+", page).Result()
			if err != nil {
				errs <- err
				return
			}
			if len(result) == 0 {
				return
			}

			for _, entry := range result {
				data, ok := entry.Values["data"]
				if !ok {
					continue
				}

				payload, ok := data.(string)
				if !ok {
					continue
				}

				event, err := common.DeserializeEvent(payload)
				if err != nil {
					errs <- err
					return
				}

				select {
				case events <- event:
				case <-ctx.Done():
					return
				}
				from = "(" + entry.ID
			}

			if int64(len(result)) < page {
				return
			}
		}
	}()

	return events, errs
}

func ReplayInto(ctx context.Context, eng *MatchingEngine, log *EventLog) (int64, error) {
	lastSeq := int64(0)
	var pending *common.Order
	pendingCanceled := false

	flushPending := func() {
		if pending != nil &&
			!pendingCanceled &&
			pending.Remaining > 0 &&
			(pending.Type == common.OrderTypeLimit || pending.Type == common.OrderTypePostOnly) {
			eng.book.Rest(pending)
		}
		pending = nil
		pendingCanceled = false
	}

	events, errs := log.ReadAll(ctx)
	for ev := range events {
		switch e := ev.(type) {
		case *common.OrderAcceptedEvent:
			flushPending()
			orderCopy := *e.Order
			pending = &orderCopy
			eng.MarkClientOrderIDSeen(e.Order.UserID, e.Order.ClientOrderID)
			lastSeq = e.Seq

		case *common.OrderRejectedEvent:
			// we don't usually need this flush since orderaccept will always flush
			// and no order reject event is followed by orderaccept
			flushPending()
			lastSeq = e.Seq

		case *common.TradeEvent:
			maker := eng.book.Get(e.MakerOrderID)
			if maker != nil {
				if err := eng.book.ReduceTopOrder(maker.Side, e.Qty); err != nil {
					return lastSeq, err
				}
			}
			if pending != nil && pending.OrderID == e.TakerOrderID {
				pending.Remaining -= e.Qty
			}
			lastSeq = e.Seq

		case *common.OrderCanceledEvent:
			if pending != nil && pending.OrderID == e.OrderID {
				pendingCanceled = true
			} else {
				eng.book.Cancel(e.OrderID)
			}
			lastSeq = e.Seq
		}
	}

	if err := <-errs; err != nil {
		return lastSeq, err
	}

	flushPending()
	eng.seq = lastSeq
	return lastSeq, nil
}
