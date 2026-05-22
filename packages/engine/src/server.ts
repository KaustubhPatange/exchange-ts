import Fastify from 'fastify';
import IORedis from 'ioredis';
import {
  serializeEvent,
  type CancelOrderCommand,
  type EngineEvent,
  type NewOrderCommand,
  type OrderType,
  type Side,
} from '@exchange/common';

import { MatchingEngine } from './matcher.js';
import { EventLog, replayInto } from './eventLog.js';

const PORT = Number(process.env.ENGINE_PORT ?? 8082);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const ADMIN_ENABLED = process.env.EXCHANGE_ADMIN_ENABLED === '1';
const STREAM_KEY = 'engine.events';

// ---------- Wire types ----------

interface PlaceOrderBody {
  clientOrderId: string;
  userId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  price?: string;
  qty: string;
}

interface CancelQuery {
  userId: string;
}

interface PlaceOrderResponse {
  events: unknown[]; // bigints serialized to strings by the JSON replacer below
}

// ---------- Translation helpers ----------

function parseBigint(value: string | undefined, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  try {
    return BigInt(value);
  } catch {
    throw new Error(`invalid bigint for ${field}: ${value}`);
  }
}

function toEnginePlaceCommand(body: PlaceOrderBody): NewOrderCommand {
  return {
    clientOrderId: body.clientOrderId,
    userId: body.userId,
    symbol: body.symbol as NewOrderCommand['symbol'],
    side: body.side,
    type: body.type,
    price: parseBigint(body.price, 'price'),
    qty: parseBigint(body.qty, 'qty')!,
  };
}

function eventsToJsonReadyArray(events: EngineEvent[]): unknown[] {
  // Round-trip through serializeEvent so bigints become strings consistently.
  return events.map((e) => JSON.parse(serializeEvent(e)));
}

// ---------- Boot ----------

async function main(): Promise<void> {
  const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const state = {
    engine: new MatchingEngine(),
    log: new EventLog(redis, STREAM_KEY),
  };
  let resetting = false;

  const t0 = Date.now();
  const lastSeq = await replayInto(state.engine, state.log);
  console.log(
    `[engine] replayed ${lastSeq} events in ${Date.now() - t0}ms; ` +
      `bestBid=${state.engine.book.bestBid() ?? '∅'} bestAsk=${state.engine.book.bestAsk() ?? '∅'}`
  );

  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, seq: state.engine.currentSeq() }));

  app.get('/depth', async (req) => {
    const levels = Number((req.query as { levels?: string }).levels ?? 20);
    return {
      bids: state.engine.book.depth('buy', levels).map(([p, q]) => [p.toString(), q.toString()]),
      asks: state.engine.book.depth('sell', levels).map(([p, q]) => [p.toString(), q.toString()]),
    };
  });

  app.get('/orders', async (req, reply) => {
    const userId = (req.query as { userId?: string }).userId;
    if (!userId) {
      reply.code(400);
      return { error: 'missing userId' };
    }
    const orders = state.engine.getUserOrders(userId).map((o) => ({
      orderId: o.orderId,
      clientOrderId: o.clientOrderId,
      userId: o.userId,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: o.price.toString(),
      qty: o.qty.toString(),
      remaining: o.remaining.toString(),
      status: o.status,
      createdAt: o.createdAt,
    }));
    return { orders };
  });

  app.post('/orders', async (req, reply): Promise<PlaceOrderResponse> => {
    if (resetting) {
      reply.code(503);
      return { events: [{ error: 'RESETTING' }] };
    }
    let cmd: NewOrderCommand;
    try {
      cmd = toEnginePlaceCommand(req.body as PlaceOrderBody);
    } catch (err) {
      reply.code(400);
      return { events: [{ error: (err as Error).message }] };
    }
    const events = state.engine.submit(cmd);
    // Persist BEFORE responding. If persistence fails, the client must retry
    // (clientOrderId makes that safe).
    for (const ev of events) await state.log.append(ev);
    return { events: eventsToJsonReadyArray(events) };
  });

  app.delete('/orders/:orderId', async (req, reply): Promise<PlaceOrderResponse> => {
    if (resetting) {
      reply.code(503);
      return { events: [{ error: 'RESETTING' }] };
    }
    const params = req.params as { orderId: string };
    const query = req.query as CancelQuery;
    const cmd: CancelOrderCommand = { orderId: params.orderId, userId: query.userId };
    const events = state.engine.cancel(cmd);
    for (const ev of events) await state.log.append(ev);
    return { events: eventsToJsonReadyArray(events) };
  });

  if (ADMIN_ENABLED) {
    app.post('/admin/reset', async () => {
      resetting = true;
      try {
        await redis.del(STREAM_KEY);
        state.engine = new MatchingEngine();
        state.log = new EventLog(redis, STREAM_KEY);
        // Tell live WS subscribers (e.g. the UI) to drop accumulated state.
        // This is a sentinel — not a real engine event — and downstream stream
        // consumers (ledger/marketdata) don't read it because we DEL'd the
        // stream and they only act on XREAD payloads, not pub/sub fanout.
        await redis.publish(`${STREAM_KEY}.live`, JSON.stringify({ kind: 'Reset', ts: Date.now() }));
        console.log('[engine] /admin/reset — book + stream cleared');
        return { ok: true, seq: 0 };
      } finally {
        resetting = false;
      }
    });
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[engine] listening on http://localhost:${PORT}`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[engine] ${sig} — shutting down`);
    await app.close();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[engine] fatal', err);
  process.exit(1);
});
