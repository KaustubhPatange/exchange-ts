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
  id: '08-partial-ioc',
  title: '8 · IOC — partial fill, remainder canceled',
  summary: 'Same setup as example 7 but with IOC: the unfilled qty is canceled instead of resting.',

  async run({ alice, bob, system }) {
    header(
      'Partial fill — IOC',
      'IOC = Immediate-Or-Cancel. The order takes what it can RIGHT NOW; anything that\n' +
        'doesn\'t fill immediately is canceled with reason=IOC_REMAINDER. Notice how this\n' +
        'differs from example #7: same inputs, different ending book.',
    );
    await pause();

    step('Step 1 — alice posts SELL 2 BTC @ $70,000', 'Identical to example 7.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '2' });

    step('Step 2 — bob sends IOC BUY 5 BTC @ $70,000', 'Wants 5; only 2 are available; the other 3 must be canceled.');
    const r = await bob.place({ side: 'buy', type: 'IOC', price: '70000', qty: '5' });
    step('Events emitted', renderEvents(r.events));
    teach(
      'Expected sequence:\n' +
        '  1. OrderAccepted (bob, qty=5)\n' +
        '  2. Trade qty=2 @ $70,000 (consumes alice).\n' +
        '  3. OrderCanceled reason=IOC_REMAINDER, remaining=3 BTC.\n' +
        'The book ends EMPTY — nothing rests.',
    );

    const snap = await system.snapshot();
    step('Book — completely empty', renderBook(snap));

    const bals = await snapshotBalances({ alice, bob });
    step('Balances', renderBalances(bals));
    teach(
      'Bob got 2 BTC (minus fee) and his USDC reservation for the other 3 BTC was RELEASED\n' +
        'when the IOC remainder was canceled. Compare to example #7: that one had 210,000 USDC\n' +
        'still locked. IOC = "no homework left for me; clean exit."',
    );
  },
};
