import {
  header,
  step,
  teach,
  warn,
  pause,
  renderBook,
  renderEvents,
} from '../narration.js';
import type { Example } from '../registry.js';

export const example: Example = {
  id: '04-post-only',
  title: '4 · POST_ONLY',
  summary: 'Guarantees maker status by rejecting any order that would cross the spread.',

  async run({ alice, bob, system }) {
    header(
      'POST_ONLY',
      'POST_ONLY is a LIMIT order with a hard rule: it MUST rest on the book. If placing it\n' +
        'would immediately match (take liquidity = pay taker fee), the engine REJECTS it.\n' +
        'Market makers use this to guarantee they never accidentally pay taker fees.',
    );
    await pause();

    step('Step 1 — alice rests a sell of 1 BTC @ $70,000', 'Top ask = $70,000.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });

    step('Step 2 — bob tries POST_ONLY BUY 1 BTC @ $70,000', 'A bid AT the ask would cross. POST_ONLY refuses to be a taker.');
    const r1 = await bob.place({ side: 'buy', type: 'POST_ONLY', price: '70000', qty: '1' });
    step('Events emitted', renderEvents(r1.events));
    if (r1.rejected) {
      warn(`Rejected: ${r1.rejected.reason}. Bob did NOT take alice\'s ask; alice\'s order is intact.`);
    }
    await pause();

    step('Step 3 — bob retries POST_ONLY BUY 1 BTC @ $69,500', 'Below the best ask — no cross — so this is safe to rest.');
    const r2 = await bob.place({ side: 'buy', type: 'POST_ONLY', price: '69500', qty: '1' });
    step('Events emitted', renderEvents(r2.events));

    const snap = await system.snapshot();
    step('Order book — bob now sits as the top bid', renderBook(snap));
    teach(
      'Best bid = $69,500 (bob, MAKER). Best ask = $70,000 (alice, MAKER).\n' +
        'POST_ONLY is the "I want to be paid to provide liquidity" toggle. Combined with the\n' +
        '0-bps maker fee in this exchange, bob is now positioned to pay zero fees on any fills.',
    );
  },
};
