import Fastify from 'fastify';
import IORedis from 'ioredis';
import type { EngineEvent } from '@exchange/common';

import { L2Book, type L2Delta } from './l2book.js';
import { Tape } from './tape.js';
import { CandleAggregator, type CandleEvent } from './candles.js';
import { computeTicker } from './ticker.js';
import { consumeEngineStream } from './streamConsumer.js';

const PORT = Number(process.env.MARKETDATA_PORT ?? 8083);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const ADMIN_ENABLED = process.env.EXCHANGE_ADMIN_ENABLED === '1';

const ONE_MIN_MS = 60_000;
const FIVE_MIN_MS = 5 * ONE_MIN_MS;

async function main(): Promise<void> {
  const pub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  let consumerRedis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  let resetting = false;

  const l2 = new L2Book();
  const tape = new Tape(500);
  const aggs = {
    '1m': new CandleAggregator('1m', ONE_MIN_MS),
    '5m': new CandleAggregator('5m', FIVE_MIN_MS),
  } as const;

  // ---- Publishers ----

  async function publishL2(deltas: L2Delta[]): Promise<void> {
    for (const d of deltas) {
      await pub.publish('marketdata.l2', JSON.stringify(d));
    }
  }
  async function publishTrade(ev: Extract<EngineEvent, { kind: 'Trade' }>): Promise<void> {
    const entry = tape.push(ev);
    await pub.publish('marketdata.trades', JSON.stringify(entry));
  }
  async function publishCandle(events: CandleEvent[]): Promise<void> {
    for (const e of events) {
      await pub.publish(`marketdata.candles.${e.interval}`, JSON.stringify(e));
    }
  }
  async function publishTicker(): Promise<void> {
    const t = computeTicker(aggs['1m']);
    await pub.publish('marketdata.ticker', JSON.stringify(t));
  }
  async function publishL2Snapshot(): Promise<void> {
    await pub.publish('marketdata.l2.snapshot', JSON.stringify(l2.snapshot(50)));
  }

  // ---- Event processing ----

  async function applyEvent(ev: EngineEvent): Promise<void> {
    const l2Deltas = l2.apply(ev);
    if (l2Deltas.length > 0) await publishL2(l2Deltas);

    if (ev.kind === 'Trade') {
      await publishTrade(ev);
      const c1 = aggs['1m'].onTrade(ev.price, ev.qty, ev.ts);
      const c5 = aggs['5m'].onTrade(ev.price, ev.qty, ev.ts);
      await publishCandle([...c1, ...c5]);
      await publishTicker();
    }
  }

  // ---- Stream consumer ----

  function startConsumer(): Promise<void> {
    return (async (): Promise<void> => {
      let replayed = 0;
      let liveStarted = false;
      try {
        for await (const item of consumeEngineStream(consumerRedis)) {
          if (item.mode === 'live' && !liveStarted) {
            liveStarted = true;
            console.log(
              `[marketdata] replay done after ${replayed} events; switching to LIVE`
            );
            await publishL2Snapshot();
          }
          await applyEvent(item.event);
          if (item.mode === 'replay') replayed += 1;
        }
      } catch (err) {
        if (!resetting) throw err;
      }
    })();
  }

  let consumerPromise = startConsumer();
  consumerPromise.catch((err) => {
    console.error('[marketdata] stream consumer crashed:', err);
    process.exit(1);
  });

  // ---- Periodic ticks: roll idle candle buckets, publish snapshots ----

  setInterval(() => {
    const now = Date.now();
    const c1 = aggs['1m'].tick(now);
    const c5 = aggs['5m'].tick(now);
    if (c1.length || c5.length) {
      void publishCandle([...c1, ...c5]).then(() => publishTicker());
    }
  }, 2_000);

  setInterval(() => {
    void publishL2Snapshot();
  }, 5_000);

  // ---- HTTP ----

  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/snapshot', async (req) => {
    const levels = Number((req.query as { levels?: string }).levels ?? 50);
    return l2.snapshot(levels);
  });

  app.get('/trades', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return tape.recent(limit);
  });

  app.get('/candles', async (req) => {
    const q = req.query as { interval?: '1m' | '5m'; limit?: string };
    const interval = q.interval ?? '1m';
    const limit = Number(q.limit ?? 300);
    const agg = aggs[interval];
    if (!agg) return { error: `unknown interval ${interval}` };
    return { interval, candles: agg.recent(limit) };
  });

  app.get('/ticker', async () => computeTicker(aggs['1m']));

  if (ADMIN_ENABLED) {
    app.post('/admin/reset', async () => {
      resetting = true;
      try {
        consumerRedis.disconnect();
        await consumerPromise.catch(() => {});
        l2.clear();
        tape.clear();
        aggs['1m'].clear();
        aggs['5m'].clear();
        consumerRedis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
        consumerPromise = startConsumer();
        consumerPromise.catch((err) => {
          console.error('[marketdata] stream consumer crashed after reset:', err);
          process.exit(1);
        });
        await publishL2Snapshot();
        await publishTicker();
        console.log('[marketdata] /admin/reset — projections cleared, consumer restarted');
        return { ok: true };
      } finally {
        resetting = false;
      }
    });
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[marketdata] listening on http://localhost:${PORT}`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[marketdata] ${sig} — shutting down`);
    await app.close();
    await Promise.all([pub.quit(), consumerRedis.quit().catch(() => {})]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[marketdata] fatal', err);
  process.exit(1);
});
