import pc from 'picocolors';
import {
  header,
  step,
  teach,
  pause,
} from '../narration.js';
import { btcStr, priceStr, type Snapshot } from '../client.js';
import type { Example } from '../registry.js';

export const example: Example = {
  id: '12-depth-visualization',
  title: '12 · Depth visualization',
  summary: 'Stack multiple bids/asks across price levels and render an ASCII depth chart.',

  async run({ alice, bob, gary, josh, system }) {
    header(
      'L2 depth',
      'An exchange\'s order book has DEPTH at every price level. A "thin" book moves a lot on\n' +
        'small orders; a "thick" book absorbs large orders with little price impact.\n' +
        'We\'ll seed several levels on both sides and visualize the cumulative depth.',
    );
    await pause();

    step('Step 1 — stack four asks at increasing prices', '');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70100', qty: '2' });
    await bob.place({ side: 'sell', type: 'LIMIT', price: '70200', qty: '3' });
    await bob.place({ side: 'sell', type: 'LIMIT', price: '70300', qty: '4' });

    step('Step 2 — stack four bids at decreasing prices', '');
    await gary.place({ side: 'buy', type: 'LIMIT', price: '69900', qty: '1' });
    await gary.place({ side: 'buy', type: 'LIMIT', price: '69800', qty: '2' });
    await josh.place({ side: 'buy', type: 'LIMIT', price: '69700', qty: '3' });
    await josh.place({ side: 'buy', type: 'LIMIT', price: '69600', qty: '4' });

    const snap = await system.snapshot();
    step('L2 depth chart (one bar = 0.5 BTC)', renderDepth(snap));
    teach(
      'Reading the chart:\n' +
        '  • Left column = price (USD per BTC).\n' +
        '  • Bars on the BID side (green) grow as you go DOWN — these are buyers.\n' +
        '  • Bars on the ASK side (red) grow as you go UP — these are sellers.\n' +
        '  • The GAP in the middle is the spread. Best bid = $69,900, best ask = $70,000.\n' +
        '\n' +
        'To eat ALL asks (10 BTC), a buyer would pay the volume-weighted average price:\n' +
        '  VWAP_ask = (1·70000 + 2·70100 + 3·70200 + 4·70300) / 10 = $70,200.\n' +
        'That\'s $200 above the touch ($70,000) — the SLIPPAGE cost of size on this book.\n' +
        '\n' +
        'Slippage scales with the size you take. Walking deeper levels costs more per BTC:\n' +
        '  Take BUY    Avg fill price    Slip vs touch\n' +
        '    1 BTC      $70,000.00        $0        (0 bps)\n' +
        '    3 BTC      $70,066.67        $66.67    (~10 bps)\n' +
        '    6 BTC      $70,133.33        $133.33   (~19 bps)\n' +
        '   10 BTC      $70,200.00        $200.00   (~29 bps)\n' +
        '\n' +
        'Why it matters:\n' +
        '  • Slippage is an IMPLICIT cost — paid on top of the explicit taker fee, and\n' +
        '    usually larger than the fee for any trade above a level\'s depth.\n' +
        '  • Symmetric on the bid side: clearing 10 BTC as a market SELL through these\n' +
        '    bids fills at VWAP $69,700 — $200 below the $69,900 touch.\n' +
        '  • Liquidity = depth × tightness. A thick level at the touch absorbs size with\n' +
        '    little impact; a thin one makes the same trade much more expensive.\n' +
        '  • This is why "market" orders here are sent as IOC with a 1% slippage cap —\n' +
        '    you set the WORST price you\'ll accept; the rest cancels rather than walking\n' +
        '    deeper than you intended.',
    );
  },
};

function renderDepth(snap: Snapshot): string {
  // One bar = 0.5 BTC. Round qty to bars.
  const BAR = 0.5;
  const lines: string[] = [];
  const asksTop = [...snap.asks].slice(0, 10).reverse(); // print highest ask first
  for (const a of asksTop) {
    const qty = Number(btcStr(a.qty));
    const bars = '█'.repeat(Math.max(1, Math.round(qty / BAR)));
    lines.push(`  ${pad(`$${priceStr(a.price)}`, 10)}  ${pc.red(bars)}  ${btcStr(a.qty)} BTC`);
  }
  lines.push(`  ${pc.dim('────────────  spread  ────────────')}`);
  const bidsTop = snap.bids.slice(0, 10);
  for (const b of bidsTop) {
    const qty = Number(btcStr(b.qty));
    const bars = '█'.repeat(Math.max(1, Math.round(qty / BAR)));
    lines.push(`  ${pad(`$${priceStr(b.price)}`, 10)}  ${pc.green(bars)}  ${btcStr(b.qty)} BTC`);
  }
  return lines.join('\n');
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
