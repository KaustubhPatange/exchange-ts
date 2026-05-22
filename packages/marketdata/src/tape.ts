import type { Side, TradeEvent } from '@exchange/common';

/**
 * Trade tape — bounded ring of recent trades. The UI's "tape" panel
 * shows the most recent ~50 of these.
 */

export interface TapeEntry {
  tradeId: string;
  ts: number;
  price: string;        // bigint as string
  qty: string;
  aggressor: Side;
}

export class Tape {
  private readonly ring: TapeEntry[] = [];
  constructor(private readonly capacity: number = 200) {}

  push(ev: TradeEvent): TapeEntry {
    const entry: TapeEntry = {
      tradeId: ev.tradeId,
      ts: ev.ts,
      price: ev.price.toString(),
      qty: ev.qty.toString(),
      aggressor: ev.aggressor,
    };
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.shift();
    return entry;
  }

  recent(limit: number): TapeEntry[] {
    const n = Math.min(limit, this.ring.length);
    return this.ring.slice(this.ring.length - n);
  }

  clear(): void {
    this.ring.length = 0;
  }
}
