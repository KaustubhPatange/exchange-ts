import Fastify from 'fastify';
import IORedis from 'ioredis';
import type { Asset } from '@exchange/common';

import { Accounts, InsufficientFundsError } from './accounts.js';
import { Settler } from './settler.js';
import { consumeEngineStream } from './streamConsumer.js';

const PORT = Number(process.env.LEDGER_PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

interface ReserveBody {
  userId: string;
  asset: Asset;
  amount: string;
}

interface ReleaseBody {
  userId: string;
  asset: Asset;
  amount: string;
}

function snapshotToJson(snapshot: ReturnType<Accounts['snapshot']>): unknown {
  return {
    BTC: { free: snapshot.BTC.free.toString(), locked: snapshot.BTC.locked.toString() },
    USDC: { free: snapshot.USDC.free.toString(), locked: snapshot.USDC.locked.toString() },
  };
}

async function main(): Promise<void> {
  const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const accounts = new Accounts();
  const settler = new Settler(accounts);

  // Kick off the stream consumer in the background. It runs forever and
  // re-applies engine events to balances.
  void (async (): Promise<void> => {
    let replayed = 0;
    let liveStarted = false;
    for await (const item of consumeEngineStream(redis)) {
      if (item.mode === 'live' && !liveStarted) {
        liveStarted = true;
        console.log(
          `[ledger] replay done after ${replayed} events; switching to LIVE`
        );
      }
      try {
        settler.apply(item.event, item.mode);
      } catch (err) {
        console.error(
          `[ledger] settle error on seq ${item.event.seq}:`,
          (err as Error).message
        );
      }
      if (item.mode === 'replay') replayed += 1;
    }
  })().catch((err) => {
    console.error('[ledger] stream consumer crashed:', err);
    process.exit(1);
  });

  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/balances/:userId', async (req) => {
    const { userId } = req.params as { userId: string };
    return snapshotToJson(accounts.snapshot(userId));
  });

  app.post('/reserve', async (req, reply) => {
    const body = req.body as ReserveBody;
    try {
      accounts.reserve(body.userId, body.asset, BigInt(body.amount));
      return { ok: true };
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        reply.code(409);
        return {
          ok: false,
          error: 'INSUFFICIENT_FUNDS',
          requested: err.requested.toString(),
          available: err.available.toString(),
        };
      }
      reply.code(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post('/release', async (req, reply) => {
    const body = req.body as ReleaseBody;
    try {
      accounts.release(body.userId, body.asset, BigInt(body.amount));
      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[ledger] listening on http://localhost:${PORT}`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[ledger] ${sig} — shutting down`);
    await app.close();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[ledger] fatal', err);
  process.exit(1);
});
