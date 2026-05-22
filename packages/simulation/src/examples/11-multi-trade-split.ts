import {
  header,
  step,
  teach,
  pause,
  renderBook,
  renderEvents,
} from '../narration.js';
import type { Example } from '../registry.js';

export const example: Example = {
  id: '11-multi-trade-split',
  title: '11 · Time priority at a price level',
  summary: 'Two sells at the same price — order of fills follows ARRIVAL TIME, not size.',

  async run({ alice, bob, gary, system }) {
    header(
      'Time priority (FIFO)',
      'When multiple orders sit at the SAME price level, who gets filled first?\n' +
        'Not the biggest. Not the smallest. The OLDEST. This is "price–time priority":\n' +
        '  1. Best price wins.\n' +
        '  2. Ties broken by arrival time (FIFO).\n' +
        'We\'ll prove this by sending a tiny order in first and a giant one second.',
    );
    await pause();

    step('Step 1 — alice posts SELL 1 BTC @ $70,000', 'A small order, but she arrives FIRST. She is now head of the queue at this level.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });

    step('Step 2 — bob posts SELL 5 BTC @ $70,000', 'Five times alice\'s size, but he arrives SECOND. He stands BEHIND her in the FIFO queue.');
    await bob.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '5' });

    const snap = await system.snapshot();
    step('Order book — 6 BTC total at $70,000', renderBook(snap));
    teach(
      'The L2 view just shows 6 BTC at the level — it hides the queue order. But the engine\n' +
        'remembers: alice is at position 1, bob at position 2.\n' +
        'A naive "fill the biggest first" rule would say "go to bob." That is NOT how exchanges\n' +
        'work — and watch what happens next.',
    );
    await pause();

    step('Step 3 — gary takes 3 BTC with LIMIT BUY @ $70,000', 'Just 3 BTC. Question: which maker(s) get filled?');
    const r = await gary.place({ side: 'buy', type: 'LIMIT', price: '70000', qty: '3' });
    step('Events emitted', renderEvents(r.events));
    teach(
      'Expected sequence:\n' +
        '  • Trade 1: 1 BTC, maker=alice (consumes her entirely — she was first).\n' +
        '  • Trade 2: 2 BTC, maker=bob (partial fill — he still has 3 BTC resting).\n' +
        'Notice: even though bob had FIVE TIMES more BTC available than alice, the engine fed\n' +
        'gary alice\'s entire 1 BTC first. Quantity is irrelevant at the same price — only\n' +
        'arrival order matters.',
    );

    const after = await system.snapshot();
    step('Book after the sweep — bob\'s 3 BTC still rests', renderBook(after));
    teach(
      'Practical consequences of FIFO:\n' +
        '  • If you want priority, post EARLY — even a small order beats a fresh giant one.\n' +
        '  • If you cancel and re-post (example 12), you go to the BACK of the queue at that\n' +
        '    price. That\'s the cost of moving an order.\n' +
        '  • A taker walking the book sees a stable, predictable order of fills — they don\'t\n' +
        '    have to guess which maker will go first.',
    );
  },
};
