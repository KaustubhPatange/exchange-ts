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
  const log = new EventLog(redis);
  const engine = new MatchingEngine();

  const t0 = Date.now();
  const lastSeq = await replayInto(engine, log);
  console.log(
    `[engine] replayed ${lastSeq} events in ${Date.now() - t0}ms; ` +
      `bestBid=${engine.book.bestBid() ?? '∅'} bestAsk=${engine.book.bestAsk() ?? '∅'}`
  );

  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, seq: engine.currentSeq() }));

  app.get('/depth', async (req) => {
    const levels = Number((req.query as { levels?: string }).levels ?? 20);
    return {
      bids: engine.book.depth('buy', levels).map(([p, q]) => [p.toString(), q.toString()]),
      asks: engine.book.depth('sell', levels).map(([p, q]) => [p.toString(), q.toString()]),
    };
  });

  app.post('/orders', async (req, reply): Promise<PlaceOrderResponse> => {
    let cmd: NewOrderCommand;
    try {
      cmd = toEnginePlaceCommand(req.body as PlaceOrderBody);
    } catch (err) {
      reply.code(400);
      return { events: [{ error: (err as Error).message }] };
    }
    const events = engine.submit(cmd);
    // Persist BEFORE responding. If persistence fails, the client must retry
    // (clientOrderId makes that safe).
    for (const ev of events) await log.append(ev);
    return { events: eventsToJsonReadyArray(events) };
  });

  app.delete('/orders/:orderId', async (req): Promise<PlaceOrderResponse> => {
    const params = req.params as { orderId: string };
    const query = req.query as CancelQuery;
    const cmd: CancelOrderCommand = { orderId: params.orderId, userId: query.userId };
    const events = engine.cancel(cmd);
    for (const ev of events) await log.append(ev);
    return { events: eventsToJsonReadyArray(events) };
  });

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
