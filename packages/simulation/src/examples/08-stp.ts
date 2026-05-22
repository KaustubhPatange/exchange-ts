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
  id: '08-stp',
  title: '8 · STP (Self-Trade Prevention)',
  summary: 'A user cannot match against their own resting orders — the new side is canceled.',

  async run({ alice, system }) {
    header(
      'Self-Trade Prevention',
      'Most exchanges forbid a single user from being both taker and maker on the same trade.\n' +
        '"Wash trading" doesn\'t transfer value, can create fake volume, and is regulated.\n' +
        'This exchange uses the CANCEL-NEW policy: the INCOMING order is the one canceled.',
    );
    await pause();

    step('Step 1 — alice rests SELL 1 BTC @ $70,000', 'Standard ask.');
    await alice.place({ side: 'sell', type: 'LIMIT', price: '70000', qty: '1' });
    const snap1 = await system.snapshot();
    step('Book after alice\'s sell', renderBook(snap1));
    await pause();

    step('Step 2 — alice sends BUY 1 BTC @ $70,000 (against her own ask)', 'A normal exchange would call this a trade. STP intervenes.');
    const r = await alice.place({ side: 'buy', type: 'LIMIT', price: '70000', qty: '1' });
    step('Events emitted', renderEvents(r.events));
    teach(
      'Expected sequence:\n' +
        '  1. OrderAccepted  — the buy is registered.\n' +
        '  2. OrderCanceled reason=STP — the remainder is canceled because the only thing it\n' +
        '     would have matched was alice\'s own ask.\n' +
        'No Trade event fired. Alice\'s original sell still rests, untouched.',
    );

    const snap2 = await system.snapshot();
    step('Book after STP — alice\'s sell still rests', renderBook(snap2));
    teach(
      'Important nuance: CANCEL-NEW only kills the part of the incoming order that would have\n' +
        'self-traded. If the order had matched OTHER users first and only then run into\n' +
        'alice\'s own ask, those earlier trades would stand and only the rest is canceled.',
    );
  },
};
