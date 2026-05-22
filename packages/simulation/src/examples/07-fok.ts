import {
  header,
  step,
  teach,
  warn,
  pause,
  renderBook,
  renderBalances,
  renderEvents,
  snapshotBalances,
} from '../narration.js';
import type { Example } from '../registry.js';

export const example: Example = {
  id: '07-fok',
  title: '7 · FOK (Fill-Or-Kill)',
  summary: 'All-or-nothing: rejected outright if insufficient liquidity; the reservation is released.',

  async run({ alice, bob, gary, josh, system }) {
    header(
      'Fill-Or-Kill',
      'FOK is the strictest order type: the engine PRE-CHECKS whether the full quantity can\n' +
        'be filled at or better than your limit. If not, the order is REJECTED without touching\n' +
        'the book — no partial fill, no resting remainder.',
    );
    await pause();

    step('Step 1 — alice rests a sell of 1 BTC @ $70,000', 'Only liquidity on the ask side so far.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });

    step('Step 2 — bob tries FOK BUY 5 BTC @ $70,000', 'Wants 5, but only 1 BTC is for sale at that price. Expect a rejection.');
    const balsBefore = await snapshotBalances({ bob });
    step('Bob\'s balance BEFORE the FOK attempt', renderBalances(balsBefore));

    const r1 = await bob.place({ side: 'buy', type: 'FOK', price: '70000', qty: '5' });
    step('Events emitted', renderEvents(r1.events));
    if (r1.rejected) {
      warn(`Rejected with reason = ${r1.rejected.reason}. Bob gets nothing, alice\'s ask is untouched.`);
    }

    const balsAfter = await snapshotBalances({ bob });
    step('Bob\'s balance AFTER the rejection', renderBalances(balsAfter));
    teach(
      'Notice locked USDC is back to 0 — the gateway RESERVED bob\'s USDC before sending the\n' +
        'order, then RELEASED it when the engine rejected. This is why \`free\` is exactly\n' +
        'where it started. (No fee either: no trade fired.)',
    );
    await pause();

    step('Step 3 — gary adds an ask of 4 BTC @ $70,000', 'Now there are 5 BTC available at $70,000 across alice (1) and gary (4).');
    await gary.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '4' });

    const snap = await system.snapshot();
    step('Order book before josh\'s FOK', renderBook(snap));
    await pause();

    step('Step 4 — josh tries FOK BUY 5 BTC @ $70,000', 'This time the depth is enough. Expect 2 Trade events (vs alice, vs gary).');
    const r2 = await josh.place({ side: 'buy', type: 'FOK', price: '70000', qty: '5' });
    step('Events emitted', renderEvents(r2.events));
    teach(
      'One incoming FOK produced TWO trades because liquidity was spread across two maker\n' +
        'orders. FOK is atomic on the QUANTITY, not on the number of trades.',
    );
  },
};
