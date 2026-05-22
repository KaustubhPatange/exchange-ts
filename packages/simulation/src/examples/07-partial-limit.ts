import {
  header,
  step,
  teach,
  pause,
  renderBook,
  renderBalances,
  renderEvents,
  snapshotBalances,
} from '../narration.js';
import type { Example } from '../registry.js';

export const example: Example = {
  id: '07-partial-limit',
  title: '7 · LIMIT — partial fill, remainder rests',
  summary: 'When a LIMIT eats some but not all available liquidity, the unfilled qty rests at your price.',

  async run({ alice, bob, system }) {
    header(
      'Partial fill — LIMIT',
      'You ask for more than the book can give RIGHT NOW. A LIMIT takes what it can at your\n' +
        'price-or-better, and the unfilled remainder REST at your limit price as a new top-of-book\n' +
        'order. Contrast this with example #8 (IOC) where the remainder is canceled.',
    );
    await pause();

    step('Step 1 — alice posts SELL 2 BTC @ $70,000', 'There are 2 BTC available at that price.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '2' });

    step('Step 2 — bob asks for 5 BTC with LIMIT BUY @ $70,000', 'Wants 5. Only 2 are on offer at $70,000 — the rest must wait.');
    const r = await bob.place({ side: 'buy', type: 'LIMIT', price: '70000', qty: '5' });
    step('Events emitted', renderEvents(r.events));
    teach(
      'Expected sequence:\n' +
        '  1. OrderAccepted (bob, qty=5)\n' +
        '  2. Trade qty=2 @ $70,000 (consumes alice).\n' +
        '  3. No cancel event — the remaining 3 BTC of bob\'s order RESTS at $70,000 as a new bid.',
    );

    const snap = await system.snapshot();
    step('Book — bob\'s 3 BTC bid now sits where alice\'s ask used to', renderBook(snap));

    const bals = await snapshotBalances({ alice, bob });
    step('Balances', renderBalances(bals));
    teach(
      'Bob spent USDC for 2 BTC (minus fee), and 3 BTC × $70,000 = 210,000 USDC is STILL\n' +
        'LOCKED because his remaining 3 BTC bid is open. The exchange must keep that USDC\n' +
        'on hand to honor the bid if a seller crosses it later.',
    );
  },
};
