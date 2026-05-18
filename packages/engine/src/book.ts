import BTreeImport from 'sorted-btree';
import type { Order, Side } from '@exchange/common';

// sorted-btree is CJS; under Node's native ESM loader the default import
// sometimes resolves to the module namespace object rather than the class.
// vitest's transform hides this; Node does not. Normalize once here.
const BTree = (
  (BTreeImport as unknown as { default?: typeof BTreeImport }).default ??
  BTreeImport
) as typeof BTreeImport;

/**
 * Order book data structure.
 *
 * Two sorted maps (B-trees) keyed by price (bigint):
 *   - bids: highest price first (best bid = first)
 *   - asks: lowest price first  (best ask = first)
 *
 * Each price level holds a FIFO doubly-linked list of resting orders.
 * Time priority is preserved by always appending new orders at the TAIL
 * and matching from the HEAD.
 *
 * We also keep an `orderId -> { node, level, side }` map so cancels are
 * O(log n) (price lookup + O(1) unlink) instead of scanning.
 *
 * Why a DLL inside each level? It gives us:
 *   - O(1) head pop during matching
 *   - O(1) unlink on cancel (we have the node ref via the map)
 *   - Time order without resorting on every insert
 */

interface ListNode {
  order: Order;
  prev: ListNode | null;
  next: ListNode | null;
}

export class PriceLevel {
  head: ListNode | null = null;
  tail: ListNode | null = null;
  totalQty: bigint = 0n;
  count: number = 0;

  append(order: Order): ListNode {
    const node: ListNode = { order, prev: this.tail, next: null };
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    this.totalQty += order.remaining;
    this.count += 1;
    return node;
  }

  unlink(node: ListNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    this.totalQty -= node.order.remaining;
    this.count -= 1;
  }

  isEmpty(): boolean {
    return this.head === null;
  }
}

interface OrderRef {
  node: ListNode;
  level: PriceLevel;
  side: Side;
  price: bigint;
}

export class OrderBook {
  // Bids: highest price first. Comparator returns negative when a > b.
  readonly bids = new BTree<bigint, PriceLevel>(
    undefined,
    (a, b) => (a > b ? -1 : a < b ? 1 : 0)
  );
  // Asks: lowest price first. Default ascending comparator on bigint.
  readonly asks = new BTree<bigint, PriceLevel>(
    undefined,
    (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  );
  private readonly refs = new Map<string, OrderRef>();

  bestBid(): bigint | undefined {
    const r = this.bids.minKey();
    return r === undefined ? undefined : r;
  }

  bestAsk(): bigint | undefined {
    const r = this.asks.minKey();
    return r === undefined ? undefined : r;
  }

  /** Add a resting order. Caller must have decided this order should rest. */
  rest(order: Order): void {
    const tree = order.side === 'buy' ? this.bids : this.asks;
    let level = tree.get(order.price);
    if (!level) {
      level = new PriceLevel();
      tree.set(order.price, level);
    }
    const node = level.append(order);
    this.refs.set(order.orderId, {
      node,
      level,
      side: order.side,
      price: order.price,
    });
  }

  /**
   * Pop the head (best, oldest) order on the given side. Returns undefined
   * if that side is empty. Used by the matcher.
   */
  peekTopOrder(side: Side): Order | undefined {
    const tree = side === 'buy' ? this.bids : this.asks;
    const topPrice = tree.minKey();
    if (topPrice === undefined) return undefined;
    const level = tree.get(topPrice)!;
    return level.head?.order;
  }

  /**
   * Reduce or remove the head order on `side`. If qty == head.remaining,
   * the order is unlinked and removed from refs. Otherwise its `remaining`
   * is decreased and `totalQty` on the level is decreased.
   */
  reduceTopOrder(side: Side, fillQty: bigint): void {
    const tree = side === 'buy' ? this.bids : this.asks;
    const topPrice = tree.minKey();
    if (topPrice === undefined) throw new Error('reduceTopOrder on empty side');
    const level = tree.get(topPrice)!;
    const node = level.head;
    if (!node) throw new Error('reduceTopOrder on empty level');
    if (fillQty > node.order.remaining) {
      throw new Error('reduceTopOrder fillQty > remaining');
    }
    if (fillQty === node.order.remaining) {
      this.refs.delete(node.order.orderId);
      level.unlink(node);
      if (level.isEmpty()) tree.delete(topPrice);
    } else {
      node.order.remaining -= fillQty;
      level.totalQty -= fillQty;
    }
  }

  /** Cancel a resting order by id. Returns the canceled order or undefined. */
  cancel(orderId: string): Order | undefined {
    const ref = this.refs.get(orderId);
    if (!ref) return undefined;
    this.refs.delete(orderId);
    ref.level.unlink(ref.node);
    const tree = ref.side === 'buy' ? this.bids : this.asks;
    if (ref.level.isEmpty()) tree.delete(ref.price);
    return ref.node.order;
  }

  /** Look up a resting order (does not mutate). */
  get(orderId: string): Order | undefined {
    return this.refs.get(orderId)?.node.order;
  }

  /** Snapshot of top-N depth for a side: [price, totalQty][]. */
  depth(side: Side, levels: number): [bigint, bigint][] {
    const tree = side === 'buy' ? this.bids : this.asks;
    const out: [bigint, bigint][] = [];
    let count = 0;
    for (const [price, level] of tree.entries()) {
      out.push([price, level.totalQty]);
      if (++count >= levels) break;
    }
    return out;
  }
}
