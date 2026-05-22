import {
  header,
  step,
  teach,
  pause,
  renderEvents,
  renderBook,
} from '../narration.js';
import type { Example } from '../registry.js';

export const example: Example = {
  id: '05-ioc',
  title: '5 · IOC (Immediate-Or-Cancel)',
  summary: 'Take what is available right now; cancel any unfilled remainder. Never rests.',

  async run({ alice, bob, system }) {
    header(
      'Immediate-Or-Cancel',
      'IOC says: match as much as possible RIGHT NOW at my limit-or-better; whatever\n' +
        'cannot fill immediately, cancel. Unlike LIMIT, an IOC never rests on the book.',
    );
    await pause();

    step('Step 1 — alice rests a sell of 1 BTC @ $70,000', 'Top ask = $70,000.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });

    step('Step 2 — bob sends IOC BUY 1 BTC @ $69,300 (1% BELOW alice)', 'His limit is below the best ask, so nothing can match.');
    const r1 = await bob.place({ side: 'buy', type: 'IOC', price: '69300', qty: '1' });
    step('Events emitted', renderEvents(r1.events));
    teach(
      'The order was ACCEPTED, then immediately CANCELED with reason=IOC_REMAINDER.\n' +
        'Zero trades. The book is unchanged. This is NOT an error — IOC just cancels the\n' +
        'unfillable remainder, even if "remainder" is the entire order.',
    );
    const snap1 = await system.snapshot();
    step('Book after the no-cross IOC', renderBook(snap1));
    await pause();

    step('Step 3 — bob sends IOC BUY 1 BTC @ $70,700 (1% ABOVE alice)', 'Crosses cleanly. Should fully fill at alice\'s $70,000 (maker price).');
    const r2 = await bob.place({ side: 'buy', type: 'IOC', price: '70700', qty: '1' });
    step('Events emitted', renderEvents(r2.events));
    teach(
      'Compare with a LIMIT order: a LIMIT BUY @ $69,300 would have RESTED as the new top bid.\n' +
        'IOC said "no thanks, cancel me" instead. IOC is for taking liquidity opportunistically\n' +
        'when you don\'t want to advertise a quote.\n' +
        '\n' +
        'Real-world: most retail "Market Buy / Market Sell" buttons (including this\n' +
        'exchange\'s UI — see the OrderForm) are implemented as IOC under the hood, with a\n' +
        'slippage cap on the limit price (here it\'s 1%). True MARKET orders — no price\n' +
        'cap at all — are dangerous in thin books because they walk arbitrarily deep (see\n' +
        'example 12 on slippage). IOC + slippage cap gives the same "fill now or skip"\n' +
        'feel with a safety net. Many exchanges no longer expose unbounded MARKET orders\n' +
        'to retail for exactly this reason.',
    );
  },
};
