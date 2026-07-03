package main

import (
	"errors"

	"github.com/KaustubhPatange/exchange/common"
	"github.com/google/btree"
)

type listNode struct {
	Order *common.Order
	Prev  *listNode
	Next  *listNode
}

type priceLevel struct {
	Head     *listNode
	Tail     *listNode
	TotalQty int64
	Count    int
}

func (p *priceLevel) Append(order *common.Order) *listNode {
	node := &listNode{Order: order, Prev: p.Tail, Next: nil}
	if p.Tail != nil {
		p.Tail.Next = node
	} else {
		p.Head = node
	}
	p.Tail = node
	p.TotalQty += order.Remaining
	p.Count += 1
	return node
}

func (p *priceLevel) Unlink(node *listNode) {
	if node.Prev != nil {
		node.Prev.Next = node.Next
	} else {
		p.Head = node.Next
	}
	if node.Next != nil {
		node.Next.Prev = node.Prev
	} else {
		p.Tail = node.Prev
	}
	p.TotalQty -= node.Order.Remaining
	p.Count -= 1
}

func (p *priceLevel) IsEmpty() bool {
	return p.Head == nil
}

type OrderRef struct {
	Node  *listNode
	Level *priceLevel
	Side  common.Side
	Price int64
}

type priceEntry struct {
	price int64
	level *priceLevel
}

type OrderBook struct {
	Bids *btree.BTreeG[priceEntry]
	Asks *btree.BTreeG[priceEntry]
	refs map[string]*OrderRef
}

func NewOrderBook() *OrderBook {
	return &OrderBook{
		Bids: btree.NewG(32, func(a, b priceEntry) bool {
			return a.price > b.price
		}),
		Asks: btree.NewG(32, func(a, b priceEntry) bool {
			return a.price < b.price
		}),
		refs: make(map[string]*OrderRef),
	}
}

func (o *OrderBook) treeFor(side common.Side) *btree.BTreeG[priceEntry] {
	if side == common.SideBuy {
		return o.Bids
	} else {
		return o.Asks
	}
}

func (o *OrderBook) BestBid() (int64, bool) {
	r, ok := o.Bids.Min()
	if !ok {
		return 0, false
	}
	return r.price, true
}

func (o *OrderBook) BestAsk() (int64, bool) {
	r, ok := o.Asks.Min()
	if !ok {
		return 0, false
	}
	return r.price, true
}

func (o *OrderBook) Rest(order *common.Order) {
	tree := o.treeFor(order.Side)
	entry, ok := tree.Get(priceEntry{price: order.Price})
	var level *priceLevel
	if !ok {
		level = &priceLevel{}
		tree.ReplaceOrInsert(priceEntry{price: order.Price, level: level})
	} else {
		level = entry.level
	}
	node := level.Append(order)
	o.refs[order.OrderID] = &OrderRef{
		Node:  node,
		Level: level,
		Side:  order.Side,
		Price: order.Price,
	}
}

func (o *OrderBook) PeekTopOrder(side common.Side) *common.Order {
	tree := o.treeFor(side)
	top, ok := tree.Min()
	if !ok {
		return nil
	}
	if top.level.Head != nil {
		return nil
	}
	return top.level.Head.Order
}

func (o *OrderBook) ReduceTopOrder(side common.Side, fillQty int64) error {
	tree := o.treeFor(side)
	top, ok := tree.Min()
	if !ok {
		return errors.New("reduceTopOrder on empty side")
	}

	level := top.level
	node := level.Head
	if node == nil {
		return errors.New("reduceTopOrder on empty level")
	}

	if fillQty > node.Order.Remaining {
		return errors.New("reduceTopOrder fillQty > remaining")
	}

	if fillQty == node.Order.Remaining {
		delete(o.refs, node.Order.OrderID)
		level.Unlink(node)
		if level.IsEmpty() {
			tree.Delete(top)
		}
	} else {
		node.Order.Remaining -= fillQty
		level.TotalQty -= fillQty
	}

	return nil
}

func (o *OrderBook) Cancel(orderID string) *common.Order {
	ref, ok := o.refs[orderID]
	if !ok {
		return nil
	}
	delete(o.refs, orderID)
	ref.Level.Unlink(ref.Node)

	tree := o.treeFor(ref.Side)
	if ref.Level.IsEmpty() {
		tree.Delete(priceEntry{price: ref.Price})
	}
	return ref.Node.Order
}

func (o *OrderBook) Get(orderID string) *common.Order {
	ref, ok := o.refs[orderID]
	if !ok {
		return nil
	}
	return ref.Node.Order
}

func (o *OrderBook) OrdersForUser(userID string) []*common.Order {
	var out []*common.Order
	for _, tree := range []*btree.BTreeG[priceEntry]{o.Bids, o.Asks} {
		tree.Ascend(func(p priceEntry) bool {
			for node := p.level.Head; node != nil; node = node.Next {
				if node.Order.UserID == userID {
					out = append(out, node.Order)
				}
			}
			return true
		})
	}
	return out
}

type DepthLevel struct {
	Price    int64
	TotalQty int64
}

func (o *OrderBook) Depth(side common.Side, levels int) []DepthLevel {
	tree := o.treeFor(side)
	out := make([]DepthLevel, 0, levels)
	count := 0
	tree.Ascend(func(item priceEntry) bool {
		out = append(out, DepthLevel{Price: item.price, TotalQty: item.level.TotalQty})
		count++
		return count < levels
	})
	return out
}
