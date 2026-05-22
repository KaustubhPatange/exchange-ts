import {
  header,
  step,
  teach,
  pause,
  renderBook,
  renderEvents,
  fmtPrice,
} from '../narration.js';
import type { Example } from '../registry.js';

export const example: Example = {
  id: '01-price-discovery',
  title: '1 · Price discovery',
  summary: 'Two sellers, two buyers — the first cross sets the last-traded price.',

  async run({ alice, bob, gary, josh, system }) {
    header(
      'Price discovery',
      'Before a trade fires, the exchange has only QUOTES (resting bids and asks).\n' +
        'The first time a buy crosses a sell, the "last-traded price" (LTP) is born — and\n' +
        'it is set by the MAKER\'s resting price, not the taker\'s aggressive price.',
    );
    await pause();

    step('Step 1 — alice posts a sell of 1 BTC @ $70,000', 'No bids yet; nothing matches. This becomes the top ask.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });

    step('Step 2 — bob posts a tighter sell of 1 BTC @ $69,500', 'Better price for buyers. Bob is now the top ask, alice sits behind him.');
    await bob.place({ side: 'sell', type: 'LIMIT', price: '69500', qty: '1' });

    const snap1 = await system.snapshot();
    step('Order book (asks only, no bids yet)', renderBook(snap1));
    const t0 = await system.ticker();
    teach(`Ticker: lastPrice = ${fmtPrice(t0.lastPrice)} — no trades have happened, so it is null.`);
    await pause();

    step('Step 3 — gary bids 1 BTC @ $69,000 (below bob\'s ask)', 'Below the spread — no cross — so this rests as the top bid.');
    await gary.place({ side: 'buy', type: 'LIMIT', price: '69000', qty: '1' });

    const snap2 = await system.snapshot();
    step('Order book now has a spread', renderBook(snap2));
    teach('Best bid = $69,000, best ask = $69,500. Spread = $500. Still no trades — only quotes.');
    await pause();

    step('Step 4 — josh bids 1 BTC @ $69,500 (crosses bob)', 'This bid meets bob\'s ask exactly. CROSS! Trade fires at bob\'s price (the maker price).');
    const r = await josh.place({ side: 'buy', type: 'LIMIT', price: '69500', qty: '1' });

    step('Events emitted', renderEvents(r.events));
    const t1 = await system.ticker();
    teach(
      `Ticker: lastPrice = ${fmtPrice(t1.lastPrice)} — this is the first PRINT.`
    );

    const finalSnap = await system.snapshot();
    step('Order book after trade', renderBook(finalSnap));
    teach('Bob\'s sell consumed. Alice\'s $70,000 ask and gary\'s $69,000 bid still rest.');
  },
};
