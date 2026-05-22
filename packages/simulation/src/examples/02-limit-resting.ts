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
  id: '02-limit-resting',
  title: '2 · LIMIT — resting on the book',
  summary: 'A LIMIT order with no immediate match patiently waits for someone to cross it.',

  async run({ alice, bob, system }) {
    header(
      'LIMIT resting orders',
      'Unlike IOC and FOK, a plain LIMIT is happy to wait. If it can\'t fill now, it sits on\n' +
        'the book at your price until somebody else crosses it — or until you cancel it.\n' +
        'While it waits, the exchange LOCKS the funds you committed.',
    );
    await pause();

    step('Step 1 — alice places LIMIT BUY 1 BTC @ $65,000', 'No ask exists yet, so there is nothing to match. The bid rests.');
    const r1 = await alice.place({ side: 'buy', type: 'LIMIT', price: '65000', qty: '1' });
    step('Events emitted', renderEvents(r1.events));

    const balsResting = await snapshotBalances({ alice });
    step('Alice\'s balance with the bid resting', renderBalances(balsResting));
    teach(
      'Notice the USDC locked: 65,000 USDC has moved from `free` to `locked`. That\'s the\n' +
        'exchange holding alice\'s commitment. She still owns it — but she can\'t spend it on\n' +
        'something else while this order is open.',
    );

    const snap1 = await system.snapshot();
    step('Order book — alice\'s bid is the only liquidity', renderBook(snap1));
    await pause();

    step('Step 2 — time passes, nothing happens', 'Without a counterparty the order just sits. This is the defining trait of LIMIT.');
    await pause();

    step('Step 3 — bob shows up and crosses with LIMIT SELL 1 BTC @ $65,000', 'Bob is the taker; alice is the maker.');
    const r2 = await bob.place({ side: 'sell', type: 'LIMIT', price: '65000', qty: '1' });
    step('Events emitted', renderEvents(r2.events));

    const balsAfter = await snapshotBalances({ alice, bob });
    step('Balances after the trade', renderBalances(balsAfter));
    teach(
      'Alice\'s LOCKED USDC dropped (it paid for the BTC she received). She gets +1 BTC.\n' +
        'Bob got +65,000 USDC for his 1 BTC, minus a 5-bps taker fee (0.05 BTC × $65,000 ≈\n' +
        'see balances). Locked balances clear when the order fully fills.',
    );
  },
};
