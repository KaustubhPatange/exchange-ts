import pc from 'picocolors';
import {
  header,
  pause,
  teach,
  step,
  fmtPrice,
  fmtBtc,
} from '../narration.js';
import { btcStr, priceStr, type CandleRow } from '../client.js';
import { GatewayWS } from '../ws.js';
import type { Example } from '../registry.js';

const DURATION_MS = 60_000;
const TICK_MS = 500;

interface LiveTrade {
  price: bigint;
  qty: bigint;
  aggressor: 'buy' | 'sell';
}

export const example: Example = {
  id: '09-continuous-loop',
  title: '9 · Continuous trading (~60 seconds)',
  summary: 'Two MMs quote tightly, two takers cross occasionally — watch the candle and ticker form.',

  async run({ alice, bob, gary, josh }) {
    header(
      'Continuous trading',
      'For ~60 seconds, alice and bob act as MARKET MAKERS — both quote a narrow spread\n' +
        'around a slowly drifting fair value. gary and josh act as TAKERS — every few ticks\n' +
        'they hit the book with an IOC. You will see ticker updates and 1m-candle build live.',
    );
    await pause('Press Enter to start the 60s loop…');

    const ws = new GatewayWS();
    await ws.connect();
    ws.subscribe(['ticker', 'trades', 'candles:1m']);

    let lastPrice: bigint | null = null;
    let liveCandle: CandleRow | null = null;
    const recentTrades: LiveTrade[] = [];

    ws.on<{ lastPrice: string | null }>('ticker', (t) => {
      lastPrice = t.lastPrice === null ? null : BigInt(t.lastPrice);
    });
    ws.on<{ price: string; qty: string; aggressor: 'buy' | 'sell' }>('trades', (t) => {
      recentTrades.unshift({
        price: BigInt(t.price),
        qty: BigInt(t.qty),
        aggressor: t.aggressor,
      });
      if (recentTrades.length > 5) recentTrades.length = 5;
    });
    ws.on<{ kind: string; candle: { bucketStart: number; open: string; high: string; low: string; close: string; volume: string; trades: number } }>(
      'candles:1m',
      (env) => {
        const c = env.candle;
        liveCandle = {
          bucketStart: c.bucketStart,
          open: BigInt(c.open),
          high: BigInt(c.high),
          low: BigInt(c.low),
          close: BigInt(c.close),
          volume: BigInt(c.volume),
          trades: c.trades,
        };
      }
    );

    // Fair-value random walk
    let fair = 70_000;
    const start = Date.now();
    let tickCount = 0;
    let trades = 0;
    const makers = new Map<string, string>(); // user → orderId

    async function cancelIfOpen(client: typeof alice, user: string): Promise<void> {
      const id = makers.get(user);
      if (!id) return;
      try {
        await client.cancel(id);
      } catch {
        // Already filled or canceled — ignore.
      }
      makers.delete(user);
    }

    function render(): void {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = Math.max(0, Math.ceil((DURATION_MS - (Date.now() - start)) / 1000));
      const lines: string[] = [];
      lines.push(
        `${pc.cyan('t=')}${pad(elapsed.toString(), 2)}s  ` +
          `${pc.dim('remaining')}=${remaining}s  ` +
          `${pc.dim('fair')}=$${fair.toFixed(2)}  ` +
          `${pc.dim('last')}=${lastPrice ? `$${priceStr(lastPrice)}` : '—'}  ` +
          `${pc.dim('trades')}=${trades}`
      );
      if (liveCandle) {
        lines.push(
          `${pc.dim('1m candle')}  O=${priceStr(liveCandle.open)}  H=${priceStr(liveCandle.high)}  ` +
            `L=${priceStr(liveCandle.low)}  C=${priceStr(liveCandle.close)}  V=${btcStr(liveCandle.volume)} BTC  n=${liveCandle.trades}`
        );
      }
      if (recentTrades.length > 0) {
        lines.push(pc.dim('last trades:'));
        for (const t of recentTrades) {
          const arrow = t.aggressor === 'buy' ? pc.green('▲') : pc.red('▼');
          lines.push(`  ${arrow} ${btcStr(t.qty)} BTC @ $${priceStr(t.price)}`);
        }
      }
      // Re-print over a fixed area. Use ANSI to clear-and-redraw.
      const text = lines.join('\n');
      process.stdout.write(`\x1b[2J\x1b[H${text}\n`);
    }

    const loop = async (): Promise<void> => {
      while (Date.now() - start < DURATION_MS) {
        tickCount += 1;
        // Random-walk the fair value by up to ±$20.
        fair += (Math.random() - 0.5) * 40;

        const bid = (fair - 10).toFixed(2);
        const ask = (fair + 10).toFixed(2);

        // Refresh maker quotes
        await Promise.all([
          (async () => {
            await cancelIfOpen(bob, 'bob');
            const r = await bob.place({ side: 'buy', type: 'POST_ONLY', price: bid, qty: '0.1' });
            if (r.acceptedOrderId && !r.terminalCancel) makers.set('bob', r.acceptedOrderId);
          })(),
          (async () => {
            await cancelIfOpen(alice, 'alice');
            const r = await alice.place({ side: 'sell', type: 'POST_ONLY', price: ask, qty: '0.1' });
            if (r.acceptedOrderId && !r.terminalCancel) makers.set('alice', r.acceptedOrderId);
          })(),
        ]);

        // Random taker action every ~3 ticks
        if (Math.random() < 0.35) {
          const buyer = Math.random() < 0.5 ? gary : josh;
          const takerSide: 'buy' | 'sell' = Math.random() < 0.5 ? 'buy' : 'sell';
          const aggPrice = takerSide === 'buy' ? (fair + 30).toFixed(2) : (fair - 30).toFixed(2);
          const r = await buyer.place({ side: takerSide, type: 'IOC', price: aggPrice, qty: '0.05' });
          if (r.trades.length > 0) trades += r.trades.length;
        }

        render();
        await new Promise((r) => setTimeout(r, TICK_MS));
      }
    };

    try {
      await loop();
    } finally {
      // Cancel any still-resting MM quotes so the next example starts clean
      // (the resetAll() at the top of the next example would also wipe them).
      await Promise.allSettled([cancelIfOpen(alice, 'alice'), cancelIfOpen(bob, 'bob')]);
      ws.close();
    }

    // Final summary
    const t = await alice.ticker();
    const candles = await alice.candles('1m', 10);
    step(
      'Loop complete',
      `Ticks: ${tickCount}\n` +
        `Trades: ${trades}\n` +
        `Final lastPrice: ${fmtPrice(t.lastPrice)}\n` +
        `24h volume: ${fmtBtc(t.volume24h)}\n` +
        `1m candles built: ${candles.length}`
    );
    if (candles.length > 0) {
      step('Recent 1m candles (oldest → newest)', renderCandles(candles));
    }
    teach(
      'A few things to notice:\n' +
        '  • The ticker `lastPrice` follows the takers — each IOC crossed an MM quote.\n' +
        '  • `volume24h` accumulates BASE asset (BTC) traded over a rolling 24h window.\n' +
        '  • The 1m candles\' Open/High/Low/Close reflect the spread of taker activity.\n' +
        '  • Idle 1m buckets get a FLAT candle (volume=0, OHLC=carry close) — that\'s how the\n' +
        '    chart keeps moving on the time axis even when nobody is trading.',
    );
  },
};

function renderCandles(cs: CandleRow[]): string {
  return cs.map((c) => {
    const ts = new Date(c.bucketStart).toISOString().slice(11, 19);
    return `  ${pc.dim(ts)}  O=${priceStr(c.open)}  H=${priceStr(c.high)}  L=${priceStr(c.low)}  C=${priceStr(c.close)}  V=${btcStr(c.volume)}  n=${c.trades}`;
  }).join('\n');
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}
