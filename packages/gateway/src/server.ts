import Fastify, { type FastifyRequest } from 'fastify';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import IORedis from 'ioredis';
import { newOrderId } from '@exchange/common';

import { resolveUser } from './auth.js';
import {
  parsePriceDecimal, parseQtyDecimal,
  reserveForOrder, ledgerReserve, ledgerRelease, ledgerBalances,
  enginePlace, engineCancel,
  mdSnapshot, mdTrades, mdCandles, mdTicker,
} from './clients.js';

const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Channels we relay to WS subscribers. Client → server: "subscribe" with one
// or more names; gateway then forwards messages from the matching Redis
// Pub/Sub channel as JSON envelopes { channel, data }.
const CHANNEL_MAP: Record<string, string> = {
  book: 'marketdata.l2',
  'book:snapshot': 'marketdata.l2.snapshot',
  trades: 'marketdata.trades',
  ticker: 'marketdata.ticker',
  'candles:1m': 'marketdata.candles.1m',
  'candles:5m': 'marketdata.candles.5m',
  events: 'engine.events.live',
};

interface PlaceOrderBody {
  clientOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'LIMIT' | 'IOC' | 'FOK' | 'POST_ONLY';
  price?: string;     // user-facing decimal, e.g. "67234.50"
  qty: string;        // user-facing decimal, e.g. "0.001"
}

function userIdFromReq(req: FastifyRequest): string | null {
  const apiKey = req.headers['x-api-key'];
  return resolveUser(typeof apiKey === 'string' ? apiKey : undefined);
}

async function main(): Promise<void> {
  const sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  // ---------- CORS so the Vite UI can call us during dev ----------
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'content-type, x-api-key');
    reply.header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    return payload;
  });
  app.options('/*', async (_req, reply) => {
    reply.code(204);
    return null;
  });

  // ---------- Public proxies ----------
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/snapshot', async () => mdSnapshot());
  app.get('/api/trades', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return mdTrades(limit);
  });
  app.get('/api/candles', async (req) => {
    const q = req.query as { interval?: string; limit?: string };
    return mdCandles(q.interval ?? '1m', Number(q.limit ?? 300));
  });
  app.get('/api/ticker', async () => mdTicker());

  // ---------- Authenticated endpoints ----------

  app.get('/api/me', async (req, reply) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      reply.code(401);
      return { error: 'missing or invalid X-API-Key' };
    }
    return { userId };
  });

  app.get('/api/balances', async (req, reply) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      reply.code(401);
      return { error: 'missing or invalid X-API-Key' };
    }
    return ledgerBalances(userId);
  });

  // POST /api/orders — reserve → submit → release-on-reject
  app.post('/api/orders', async (req, reply) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      reply.code(401);
      return { error: 'missing or invalid X-API-Key' };
    }
    const body = req.body as PlaceOrderBody;
    if (!body || !body.symbol || !body.side || !body.type || !body.qty) {
      reply.code(400);
      return { error: 'missing required fields (symbol, side, type, qty)' };
    }

    let price: bigint | undefined;
    let qty: bigint;
    try {
      qty = parseQtyDecimal(body.qty);
      if (body.price !== undefined) price = parsePriceDecimal(body.price);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }

    let reservation: { asset: 'BTC' | 'USDC'; amount: bigint };
    try {
      reservation = reserveForOrder(body.side, body.type, price, qty);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }

    const reserveRes = await ledgerReserve(userId, reservation.asset, reservation.amount);
    if (!reserveRes.ok) {
      reply.code(402);
      return { error: 'INSUFFICIENT_FUNDS', detail: reserveRes };
    }

    const engineRes = await enginePlace({
      clientOrderId: body.clientOrderId ?? newOrderId(),
      userId,
      symbol: body.symbol,
      side: body.side,
      type: body.type,
      price: price?.toString(),
      qty: qty.toString(),
    });

    const isReject = engineRes.events.length === 1 && engineRes.events[0]?.kind === 'OrderRejected';
    if (isReject) {
      // Roll back the reservation.
      await ledgerRelease(userId, reservation.asset, reservation.amount);
    }
    return engineRes;
  });

  app.delete('/api/orders/:orderId', async (req, reply) => {
    const userId = userIdFromReq(req);
    if (!userId) {
      reply.code(401);
      return { error: 'missing or invalid X-API-Key' };
    }
    const { orderId } = req.params as { orderId: string };
    return engineCancel(orderId, userId);
  });

  // ---------- WebSocket fan-out ----------
  //
  // Each WS client maintains its own set of subscribed gateway-channel
  // names. The gateway keeps ONE Redis subscription per Pub/Sub channel
  // and a reverse map (channel → set of clients).

  type ClientId = string;
  const clients = new Map<ClientId, { socket: WebSocket; subs: Set<string> }>();
  const subscribers = new Map<string, Set<ClientId>>(); // gw channel name → client ids

  sub.on('message', (redisChannel, payload) => {
    // Find which gateway channel this matches.
    for (const [gwChannel, redisCh] of Object.entries(CHANNEL_MAP)) {
      if (redisCh === redisChannel) {
        const subSet = subscribers.get(gwChannel);
        if (!subSet) return;
        const envelope = JSON.stringify({ channel: gwChannel, data: tryParseJSON(payload) });
        for (const clientId of subSet) {
          const c = clients.get(clientId);
          if (c) {
            try { c.socket.send(envelope); } catch { /* dropped */ }
          }
        }
        return;
      }
    }
  });

  async function ensureRedisSub(gwChannel: string): Promise<void> {
    const redisCh = CHANNEL_MAP[gwChannel];
    if (!redisCh) return;
    const subSet = subscribers.get(gwChannel);
    if (!subSet || subSet.size === 0) await sub.subscribe(redisCh);
  }
  async function maybeUnsub(gwChannel: string): Promise<void> {
    const redisCh = CHANNEL_MAP[gwChannel];
    if (!redisCh) return;
    const subSet = subscribers.get(gwChannel);
    if (!subSet || subSet.size === 0) await sub.unsubscribe(redisCh);
  }

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const id: ClientId = newOrderId(); // reuse ULID generator for a unique id
    clients.set(id, { socket, subs: new Set() });

    socket.on('message', (raw: Buffer) => {
      let msg: { type?: string; channels?: string[] };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
        const c = clients.get(id);
        if (!c) return;
        for (const ch of msg.channels) {
          if (!CHANNEL_MAP[ch]) continue;
          let s = subscribers.get(ch);
          if (!s) { s = new Set(); subscribers.set(ch, s); }
          const fresh = s.size === 0;
          s.add(id);
          c.subs.add(ch);
          if (fresh) void ensureRedisSub(ch);
        }
      } else if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
        const c = clients.get(id);
        if (!c) return;
        for (const ch of msg.channels) {
          c.subs.delete(ch);
          subscribers.get(ch)?.delete(id);
          if ((subscribers.get(ch)?.size ?? 0) === 0) void maybeUnsub(ch);
        }
      }
    });

    socket.on('close', () => {
      const c = clients.get(id);
      if (!c) return;
      for (const ch of c.subs) {
        subscribers.get(ch)?.delete(id);
        if ((subscribers.get(ch)?.size ?? 0) === 0) void maybeUnsub(ch);
      }
      clients.delete(id);
    });
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[gateway] listening on http://localhost:${PORT}`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[gateway] ${sig} — shutting down`);
    await app.close();
    await sub.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function tryParseJSON(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

main().catch((err) => {
  console.error('[gateway] fatal', err);
  process.exit(1);
});
