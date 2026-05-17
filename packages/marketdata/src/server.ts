import Fastify from 'fastify';
import IORedis from 'ioredis';
import {
  type EngineEvent,
  deserializeEvent,
} from '@exchange/common';

import { L2Book, type L2Delta } from './l2book.js';
import { Tape } from './tape.js';
import { CandleAggregator, type CandleEvent } from './candles.js';
import { computeTicker } from './ticker.js';

const PORT = Number(process.env.MARKETDATA_PORT ?? 8083);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const STREAM_KEY = 'engine.events';

const ONE_MIN_MS = 60_000;
const FIVE_MIN_MS = 5 * ONE_MIN_MS;

async function main(): Promise<void> {
  const sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const pub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const cmd = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

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

  // ---- Stream consumer (replay → live) ----

  void (async (): Promise<void> => {
    let cursor: string = '-';
    let replayed = 0;
    const PAGE = 1000;
    // REPLAY
    while (true) {
      const result = (await cmd.xrange(STREAM_KEY, cursor, '+', 'COUNT', PAGE)) as [
        string,
        string[]
      ][];
      if (!result || result.length === 0) break;
      for (const [id, fields] of result) {
        const idx = fields.indexOf('data');
        if (idx >= 0) {
          const ev = deserializeEvent(fields[idx + 1]!);
          await applyEvent(ev);
          replayed += 1;
        }
        cursor = `(${id}`;
      }
      if (result.length < PAGE) break;
    }
    let lastId = cursor.startsWith('(') ? cursor.slice(1) : '0';
    console.log(`[marketdata] replayed ${replayed} events; switching to LIVE`);
    await publishL2Snapshot();

    // LIVE
    while (true) {
      const reply = (await cmd.call(
        'XREAD',
        'BLOCK',
        '0',
        'COUNT',
        '100',
        'STREAMS',
        STREAM_KEY,
        lastId
      )) as [string, [string, string[]][]][] | null;
      if (!reply) continue;
      for (const [, entries] of reply) {
        for (const [id, fields] of entries) {
          const idx = fields.indexOf('data');
          if (idx >= 0) {
            const ev = deserializeEvent(fields[idx + 1]!);
            await applyEvent(ev);
          }
          lastId = id;
        }
      }
    }
  })().catch((err) => {
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

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[marketdata] listening on http://localhost:${PORT}`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[marketdata] ${sig} — shutting down`);
    await app.close();
    await Promise.all([sub.quit(), pub.quit(), cmd.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[marketdata] fatal', err);
  process.exit(1);
});
