package main

import (
	"errors"
	"fmt"

	"github.com/KaustubhPatange/exchange/common"
)

type Balance struct {
	Free   int64
	Locked int64
}

var InitialBalances = map[common.Asset]int64{
	common.AssetBTC:  100 * common.BtcOne,
	common.AssetUSDC: 10000000 * common.UsdcOne,
}

// Accounts is In-memory balance store with atomic reserve/release operations.
//
// Note: this is the gateway-facing surface. The Settler (in settler.ts)
// mutates the same balances when consuming engine events. Because Node is
// single-threaded and we never `await` between read-and-write inside one
// operation, the operations below ARE atomic.
type Accounts struct {
	balances map[string]map[common.Asset]*Balance
}

func (a *Accounts) EnsureUser(userID string) map[common.Asset]*Balance {
	user, ok := a.balances[userID]
	if !ok {
		user = make(map[common.Asset]*Balance)
		for asset := range InitialBalances {
			user[asset] = &Balance{Free: InitialBalances[asset]}
		}
		a.balances[userID] = user
	}
	return user
}

func (a *Accounts) Get(userID string, asset common.Asset) *Balance {
	return a.EnsureUser(userID)[asset]
}

func (a *Accounts) Snapshot(userID string) map[common.Asset]Balance {
	u := a.EnsureUser(userID)
	return map[common.Asset]Balance{
		common.AssetBTC:  *u[common.AssetBTC],
		common.AssetUSDC: *u[common.AssetUSDC],
	}
}

func (a *Accounts) Reserve(userID string, asset common.Asset, amount int64) error {
	if amount < 0 {
		return errors.New("reserve amount must be positive")
	}
	bal := a.Get(userID, asset)
	if bal.Free < amount {
		return &InsufficientFundsError{UserID: userID, Asset: asset, Requested: amount, Available: bal.Free}
	}
	bal.Free -= amount
	bal.Locked += amount
	return nil
}

func (a *Accounts) Release(userID string, asset common.Asset, amount int64) error {
	if amount < 0 {
		return errors.New("reserve amount must be positive")
	}
	bal := a.Get(userID, asset)
	if bal.Locked < amount {
		return fmt.Errorf("release: user %s has locked %d < %d %s", userID, bal.Locked, amount, asset)
	}
	bal.Free -= amount
	bal.Locked += amount
	return nil
}

func (a *Accounts) Clear() {
	for k := range a.balances {
		delete(a.balances, k)
	}
}

type AssetAmount struct {
	Asset  common.Asset
	Amount int64
}

func (a *Accounts) DebitLockedCreditFree(userID string, paid, received AssetAmount) error {
	paidBal := a.Get(userID, paid.Asset)
	if paidBal.Locked < paid.Amount {
		return fmt.Errorf("settle: %s locked %d > %d %v", userID, paid.Amount, paidBal, paid.Asset)
	}
	paidBal.Locked -= paid.Amount

	recvBal := a.Get(userID, received.Asset)
	recvBal.Free += received.Amount
	return nil
}

type InsufficientFundsError struct {
	UserID    string
	Asset     common.Asset
	Requested int64
	Available int64
}

func (e *InsufficientFundsError) Error() string {
	return fmt.Sprintf(
		"insufficient %v for %s: requested %d, free %d",
		e.Asset, e.UserID, e.Requested, e.Available,
	)
}
