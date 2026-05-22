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
  id: '13-fees',
  title: '13 · Fees — taker pays, maker is free',
  summary: 'Maker fee = 0 bps; taker fee = 5 bps. The order TYPE does not decide who pays.',

  async run({ alice, bob, resetAll }) {
    header(
      'Fees',
      'In this exchange:\n' +
        '  • MAKER fee = 0 bps (you sit on the book, you pay nothing).\n' +
        '  • TAKER fee = 5 bps (0.05%) of the asset you RECEIVE.\n' +
        'A common misconception: people think LIMIT orders are "cheap" and MARKET/FOK orders\n' +
        'are "expensive". Wrong. The fee depends on whether you TOOK liquidity, not the type.\n' +
        'A LIMIT order can be either side. We\'ll show two cases (LIMIT taker vs FOK taker) and\n' +
        'see that the math is identical.',
    );
    await pause();

    // --- Phase A: LIMIT taker ---
    step('Phase A — alice rests SELL 1 BTC @ $70,000 (maker)', '');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });

    step('Phase A — bob crosses with LIMIT BUY 1 BTC @ $70,000 (taker)', 'Same type as alice, but different role: bob is the aggressor.');
    const r1 = await bob.place({ side: 'buy', type: 'LIMIT', price: '70000', qty: '1' });
    step('Events', renderEvents(r1.events));

    const bA = await snapshotBalances({ alice, bob });
    step('Balances after Phase A', renderBalances(bA));
    teach(
      'Alice (MAKER): received exactly $70,000 USDC for her 1 BTC. NO fee.\n' +
        'Bob (TAKER): paid $70,000 USDC, received 1 BTC × (1 − 5/10000) = 0.99995 BTC.\n' +
        '  → Fee in BTC = 0.00005 BTC (5 bps of 1 BTC).\n' +
        '  → At $70k/BTC, fee value ≈ $3.50.',
    );
    await pause('Press Enter to reset and run Phase B with FOK…');

    await resetAll();

    // --- Phase B: FOK taker ---
    step('Phase B — alice rests SELL 1 BTC @ $70,000 (maker)', 'Same setup as Phase A.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });

    step('Phase B — bob takes with FOK BUY 1 BTC @ $70,000', 'Different order type, but bob is still the taker.');
    const r2 = await bob.place({ side: 'buy', type: 'FOK', price: '70000', qty: '1' });
    step('Events', renderEvents(r2.events));

    const bB = await snapshotBalances({ alice, bob });
    step('Balances after Phase B', renderBalances(bB));
    teach(
      'Compare with Phase A: alice\'s USDC delta is the SAME ($70,000), bob\'s BTC delta is\n' +
        'the SAME (0.99995 BTC). Order type didn\'t change the fee — being a taker did.\n' +
        '\n' +
        'This MAKER–TAKER model is the industry standard. Binance, Coinbase, Kraken, and\n' +
        'most other venues charge TAKERS and charge MAKERS either zero, a much smaller\n' +
        'fee, or even a maker REBATE (you get paid to provide liquidity). The economics\n' +
        'are intentional: makers post and wait, takers consume — so the exchange\n' +
        'subsidizes whoever fills the book.\n' +
        '\n' +
        'Practical takeaway: fee minimization is about ROLE, not order TYPE. To pay\n' +
        'less, rest your orders (post a LIMIT inside the spread and wait) instead of\n' +
        'crossing. A POST_ONLY can enforce this — it refuses to execute if it would\n' +
        'cross, guaranteeing you stay on the maker side.',
    );
  },
};
