import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { EngineEvent, Side } from '@exchange/common';

import {
  btcStr,
  priceStr,
  usdcStr,
  type Balances,
  type ExchangeClient,
  type PlaceResult,
  type Snapshot,
  type UserName,
} from './client.js';

// ---------- Clack wrappers ----------

export function header(title: string, summary: string): void {
  p.note(pc.dim(summary), pc.cyan(title));
}

export function step(title: string, body: string): void {
  p.note(body, pc.green(title));
}

export function teach(body: string): void {
  p.note(pc.dim(body), pc.yellow('learn'));
}

export function warn(body: string): void {
  p.note(pc.red(body), pc.red('!'));
}

export async function pause(message = 'Press Enter to continue…'): Promise<void> {
  await p.text({ message: pc.dim(message), placeholder: '' });
}

// ---------- Formatters ----------

export function fmtPrice(v: bigint | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `$${priceStr(v)}`;
}

export function fmtBtc(v: bigint): string {
  return `${btcStr(v)} BTC`;
}

export function fmtUsdc(v: bigint): string {
  return `${usdcStr(v)} USDC`;
}

// ---------- Renderers ----------

export function renderBook(snap: Snapshot, levels = 5): string {
  const asks = snap.asks.slice(0, levels).reverse();
  const bids = snap.bids.slice(0, levels);
  const lines: string[] = [];
  lines.push(pc.dim('   side    price            qty'));
  for (const a of asks) {
    lines.push(`   ${pc.red('ASK')}    ${pad(priceStr(a.price), 14)}   ${btcStr(a.qty)}`);
  }
  if (asks.length === 0) lines.push(pc.dim('   (no asks)'));
  lines.push(pc.dim('   ──────────────────────────────'));
  if (bids.length === 0) lines.push(pc.dim('   (no bids)'));
  for (const b of bids) {
    lines.push(`   ${pc.green('BID')}    ${pad(priceStr(b.price), 14)}   ${btcStr(b.qty)}`);
  }
  return lines.join('\n');
}

export function renderBalances(table: Record<string, Balances>): string {
  const lines: string[] = [];
  lines.push(pc.dim('   user      BTC free        BTC locked      USDC free            USDC locked'));
  for (const [user, b] of Object.entries(table)) {
    lines.push(
      `   ${pad(user, 8)}  ${pad(btcStr(b.BTC.free), 14)}  ${pad(btcStr(b.BTC.locked), 14)}  ${pad(usdcStr(b.USDC.free), 18)}  ${usdcStr(b.USDC.locked)}`
    );
  }
  return lines.join('\n');
}

export function renderEvents(events: EngineEvent[]): string {
  if (events.length === 0) return pc.dim('   (no events)');
  return events.map((e) => '   ' + describeEvent(e)).join('\n');
}

export function renderResult(r: PlaceResult): string {
  return renderEvents(r.events);
}

export function describeEvent(e: EngineEvent): string {
  switch (e.kind) {
    case 'OrderAccepted': {
      const o = e.order;
      const priceTag = o.price === 0n ? 'MARKET' : fmtPrice(o.price);
      return `${pc.cyan('OrderAccepted')}  seq=${e.seq}  ${o.userId}  ${o.side.toUpperCase()} ${btcStr(o.qty)} ${o.type} @ ${priceTag}  orderId=${shortId(o.orderId)}`;
    }
    case 'OrderRejected':
      return `${pc.red('OrderRejected')}  seq=${e.seq}  ${e.userId}  reason=${pc.red(e.reason)}`;
    case 'Trade':
      return `${pc.green('Trade')}        seq=${e.seq}  ${btcStr(e.qty)} @ ${fmtPrice(e.price)}  taker=${e.takerUserId}(${e.takerOrderType}/${e.aggressor.toUpperCase()})  maker=${e.makerUserId}  tradeId=${shortId(e.tradeId)}`;
    case 'OrderCanceled':
      return `${pc.yellow('OrderCanceled')} seq=${e.seq}  ${e.userId}  remaining=${btcStr(e.remaining)}  reason=${pc.yellow(e.reason)}  orderId=${shortId(e.orderId)}`;
  }
}

// ---------- Helpers ----------

export async function snapshotBalances(
  clients: Partial<Record<UserName, ExchangeClient>>
): Promise<Record<string, Balances>> {
  const entries = await Promise.all(
    (Object.entries(clients) as [UserName, ExchangeClient][]).map(
      async ([user, c]) => [user, await c.balances()] as const
    )
  );
  return Object.fromEntries(entries);
}

export function side(s: Side): string {
  return s === 'buy' ? pc.green(s.toUpperCase()) : pc.red(s.toUpperCase());
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function shortId(id: string): string {
  if (id.length <= 10) return id;
  return id.slice(0, 6) + '…' + id.slice(-3);
}
