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
  id: '10-cancel-replace',
  title: '10 · Cancel & replace',
  summary: 'How to "move" a resting order — there is no native modify, so cancel + re-post.',

  async run({ alice, system }) {
    header(
      'Cancel & replace',
      'Most exchanges (including this one) have no "modify order" primitive. To MOVE an order\n' +
        'you cancel it and place a new one. This is how market makers re-quote on every tick.',
    );
    await pause();

    step('Step 1 — alice posts BUY 1 BTC @ $69,000', 'Establishes a top bid.');
    const r1 = await alice.place({ side: 'buy', type: 'LIMIT', price: '69000', qty: '1' });
    const orderId = r1.acceptedOrderId!;
    const bals1 = await snapshotBalances({ alice });
    step('Balance — note USDC locked', renderBalances(bals1));
    teach(`Order ID: ${orderId} — needed to cancel.`);
    await pause('Press Enter… imagine the market just moved up.');

    step('Step 2 — alice cancels her old bid', 'Returns USDC from locked → free. Book is empty again.');
    const r2 = await alice.cancel(orderId);
    step('Events', renderEvents(r2.events));

    const bals2 = await snapshotBalances({ alice });
    step('Balance after cancel — locked USDC released', renderBalances(bals2));
    await pause();

    step('Step 3 — alice re-posts at the higher price: BUY 1 BTC @ $69,500', 'A fresh reservation is taken at the new price.');
    await alice.place({ side: 'buy', type: 'LIMIT', price: '69500', qty: '1' });

    const bals3 = await snapshotBalances({ alice });
    step('Balance after the new post — USDC locked again', renderBalances(bals3));

    const snap = await system.snapshot();
    step('Book after the move', renderBook(snap));
    teach(
      'A cancel+replace is TWO operations, not one. Consequences:\n' +
        '  • Brief instant between cancel and place where the level has no liquidity.\n' +
        '  • Your TIME PRIORITY at the new level starts fresh — you go to the back of the queue.\n' +
        '  • Funds momentarily unlock and re-lock, which matters if you have other open orders.\n' +
        'Real MM systems batch these calls and accept the tiny window. Some exchanges offer\n' +
        'amend-down operations that preserve time priority on quantity reductions.\n' +
        '\n' +
        'In the UI: the "Open orders" panel below "Place order" lists your resting orders\n' +
        'and offers a Cancel button per row — reproduce this exact flow there by placing a\n' +
        'LIMIT, clicking Cancel, then placing a new one at a different price.',
    );
  },
};
