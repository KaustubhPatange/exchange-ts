import {
  header,
  step,
  teach,
  pause,
  renderBalances,
  renderEvents,
  snapshotBalances,
} from '../narration.js';
import type { Example } from '../registry.js';

export const example: Example = {
  id: '11-price-improvement',
  title: '11 · Price improvement',
  summary: 'A taker who is willing to pay $70,000 ends up paying only $69,000 — the maker\'s price.',

  async run({ alice, gary }) {
    header(
      'Price improvement',
      'A common surprise for new traders: the trade price is the MAKER\'s resting price, not\n' +
        'the taker\'s aggressive price. If you send a buy at $70,000 and the cheapest seller is\n' +
        'asking $69,000, you pay $69,000 — saving $1,000 per BTC.',
    );
    await pause();

    step('Step 1 — alice posts an aggressive SELL @ $69,000', 'Just $69,000 — undercutting whatever else is in the book.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '69000', qty: '1' });

    step('Step 2 — gary, unaware, sends LIMIT BUY 1 BTC @ $70,000', 'He is willing to pay $70,000. But the engine will give him alice\'s lower ask.');
    const r = await gary.place({ side: 'buy', type: 'LIMIT', price: '70000', qty: '1' });
    step('Events emitted — note the Trade price', renderEvents(r.events));

    const trade = r.trades[0];
    if (trade) {
      teach(
        `Trade fired at ${priceShort(trade.price)} (alice\'s price), NOT $70,000 (gary\'s).\n` +
          `Gary saved ($70,000 − $69,000) × 1 BTC = $1,000 USDC. This is "price improvement".`,
      );
    }

    const bals = await snapshotBalances({ alice, gary });
    step('Balances', renderBalances(bals));
    teach(
      'Practical takeaways:\n' +
        '  • A LIMIT order with a price BETTER than the touch is still safe — you just get a\n' +
        '    fill at the touch (or better).\n' +
        '  • Many traders set their LIMIT slightly aggressive to guarantee execution and let\n' +
        '    the book give them the best available price.\n' +
        '  • A MARKET-IF-TOUCHED / FOK is a more aggressive version of the same idea.',
    );
  },
};

function priceShort(p: bigint): string {
  // p is USDC per BTC at 6 decimals. Print as integer if no fractional cents.
  const n = Number(p) / 1_000_000;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
