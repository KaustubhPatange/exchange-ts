import WebSocket from 'ws';
import { newOrderId } from '@exchange/common';

/**
 * Around-mid market maker bot.
 *
 * Behavior:
 *   1. Subscribes to the gateway WS for `book` deltas and `book:snapshot`.
 *      Maintains its OWN top-of-book view.
 *   2. Every REFRESH_MS:
 *      - Cancels its previous bid + ask (if any).
 *      - Places a fresh bid at mid - spread/2 and ask at mid + spread/2.
 *      - If the book is empty (no opposite side), seeds at SEED_PRICE.
 *   3. If the engine rejects (e.g. POST_ONLY would cross because the
 *      market moved in the meantime), backs off one cycle.
 *
 * Notes:
 *   - We use POST_ONLY so the bot is always a maker.
 *   - Quotes are placed at the nearest priceTick.
 *   - This is the simplest possible MM — a real one would also manage
 *     inventory and adjust spread/skew accordingly.
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const WS_URL = process.env.WS_URL ?? 'ws://localhost:8080/ws';
const BOT_NAME = process.env.BOT_NAME ?? 'mm1';
const API_KEY = process.env.API_KEY ?? 'key_mm1';

const SPREAD_USDC = Number(process.env.SPREAD_USDC ?? '20');     // total spread in USDC
const SIZE_BTC = Number(process.env.SIZE_BTC ?? '0.5');
const REFRESH_MS = Number(process.env.REFRESH_MS ?? '2000');
const SEED_PRICE = Number(process.env.SEED_PRICE ?? '67000');
const PRICE_TICK = 0.01;

interface TopOfBook {
  bestBid: number | null;
  bestAsk: number | null;
}

const top: TopOfBook = { bestBid: null, bestAsk: null };

let openBidId: string | null = null;
let openAskId: string | null = null;

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[${BOT_NAME}]`, ...args);
}

function roundTick(p: number): number {
  return Math.round(p / PRICE_TICK) * PRICE_TICK;
}

function midPrice(): number {
  if (top.bestBid !== null && top.bestAsk !== null) {
    return (top.bestBid + top.bestAsk) / 2;
  }
  if (top.bestBid !== null) return top.bestBid + SPREAD_USDC / 2;
  if (top.bestAsk !== null) return top.bestAsk - SPREAD_USDC / 2;
  return SEED_PRICE;
}

// price comes from gateway WS as raw bigint string for base units (1e6 per USDC)
function priceFromBase(s: string): number {
  // careful with precision — for our magnitudes this is fine in IEEE-754.
  return Number(BigInt(s)) / 1_000_000;
}

async function placeOrder(side: 'buy' | 'sell', price: number, qty: number): Promise<string | null> {
  const body = {
    clientOrderId: `${BOT_NAME}_${newOrderId()}`,
    symbol: 'BTC-USDC',
    side,
    type: 'POST_ONLY' as const,
    price: price.toFixed(2),
    qty: qty.toFixed(8),
  };
  try {
    const res = await fetch(`${GATEWAY_URL}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { events?: Array<{ kind: string; order?: { orderId: string } }>; error?: string };
    if (json.error) {
      log('place failed:', json.error);
      return null;
    }
    const accepted = json.events?.find((e) => e.kind === 'OrderAccepted');
    if (accepted?.order?.orderId) return accepted.order.orderId;
    return null;
  } catch (err) {
    log('place exception:', (err as Error).message);
    return null;
  }
}

async function cancelOrder(orderId: string | null): Promise<void> {
  if (!orderId) return;
  try {
    await fetch(`${GATEWAY_URL}/api/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      headers: { 'x-api-key': API_KEY },
    });
  } catch (err) {
    log('cancel exception:', (err as Error).message);
  }
}

async function quoteCycle(): Promise<void> {
  await Promise.all([cancelOrder(openBidId), cancelOrder(openAskId)]);
  openBidId = null;
  openAskId = null;

  const mid = midPrice();
  const bidPrice = roundTick(mid - SPREAD_USDC / 2);
  const askPrice = roundTick(mid + SPREAD_USDC / 2);

  // Make sure we won't cross with our own quotes given current top.
  if (top.bestAsk !== null && bidPrice >= top.bestAsk) {
    // Don't quote the bid this round (would cross). Just quote the ask.
    log(`skipping bid (would cross): bidPrice=${bidPrice} >= bestAsk=${top.bestAsk}`);
    openAskId = await placeOrder('sell', askPrice, SIZE_BTC);
    return;
  }
  if (top.bestBid !== null && askPrice <= top.bestBid) {
    log(`skipping ask (would cross): askPrice=${askPrice} <= bestBid=${top.bestBid}`);
    openBidId = await placeOrder('buy', bidPrice, SIZE_BTC);
    return;
  }
  [openBidId, openAskId] = await Promise.all([
    placeOrder('buy', bidPrice, SIZE_BTC),
    placeOrder('sell', askPrice, SIZE_BTC),
  ]);
  log(`quoted mid=${mid.toFixed(2)} bid=${bidPrice.toFixed(2)} ask=${askPrice.toFixed(2)}`);
}

// We only need top-of-book maintenance; full L2 maps let us know the
// next-best when a level disappears.
const bids = new Map<number, number>();
const asks = new Map<number, number>();

function refreshTopFromMaps(): void {
  let bb: number | null = null;
  for (const p of bids.keys()) if (bb === null || p > bb) bb = p;
  let ba: number | null = null;
  for (const p of asks.keys()) if (ba === null || p < ba) ba = p;
  top.bestBid = bb;
  top.bestAsk = ba;
}

function loadSnapshot(snap: { bids: [string, string][]; asks: [string, string][] }): void {
  bids.clear(); asks.clear();
  for (const [p, q] of snap.bids) bids.set(priceFromBase(p), Number(BigInt(q)) / 1e8);
  for (const [p, q] of snap.asks) asks.set(priceFromBase(p), Number(BigInt(q)) / 1e8);
  refreshTopFromMaps();
}

function applyDelta(d: { side: 'buy' | 'sell'; price: string; qty: string }): void {
  const price = priceFromBase(d.price);
  const qty = Number(BigInt(d.qty)) / 1e8;
  const m = d.side === 'buy' ? bids : asks;
  if (qty === 0) m.delete(price);
  else m.set(price, qty);
  refreshTopFromMaps();
}

async function bootstrap(): Promise<void> {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/snapshot`);
    loadSnapshot(await res.json() as { bids: [string, string][]; asks: [string, string][] });
  } catch (err) {
    log('snapshot fetch failed:', (err as Error).message);
  }
}

function connectWS(): void {
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    log('ws connected');
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['book', 'book:snapshot'] }));
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { channel: string; data: unknown };
      if (msg.channel === 'book') {
        applyDelta(msg.data as { side: 'buy' | 'sell'; price: string; qty: string });
      } else if (msg.channel === 'book:snapshot') {
        loadSnapshot(msg.data as { bids: [string, string][]; asks: [string, string][] });
      }
    } catch { /* ignore parse errors */ }
  });
  ws.on('close', () => {
    log('ws closed, reconnecting in 2s');
    setTimeout(connectWS, 2000);
  });
  ws.on('error', (err) => log('ws error:', err.message));
}

async function main(): Promise<void> {
  log(`starting bot. spread=${SPREAD_USDC} size=${SIZE_BTC} refresh=${REFRESH_MS}ms seed=${SEED_PRICE}`);
  await bootstrap();
  connectWS();
  // Initial quote
  await quoteCycle();
  setInterval(() => {
    void quoteCycle();
  }, REFRESH_MS);
}

main().catch((err) => {
  console.error(`[${BOT_NAME}] fatal`, err);
  process.exit(1);
});
