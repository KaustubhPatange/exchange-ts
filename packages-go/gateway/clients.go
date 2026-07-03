package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/KaustubhPatange/exchange/common"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var (
	engineURL     = envOr("ENGINE_URL", "http://localhost:8082")
	ledgerURL     = envOr("LEDGER_URL", "http://localhost:8081")
	marketdataURL = envOr("MARKETDATA_URL", "http://localhost:8083")
)

type reservation struct {
	Asset  common.Asset
	Amount int64
}

func reserveForOrder(side common.Side, price *int64, qty int64) (reservation, error) {
	if price == nil {
		return reservation{}, fmt.Errorf("price required")
	}
	if side == common.SideBuy {
		return reservation{Asset: common.AssetUSDC, Amount: common.NotionalQuote(*price, qty)}, nil
	}
	return reservation{Asset: common.AssetBTC, Amount: qty}, nil
}

func getJSON(u string) (json.RawMessage, error) {
	res, err := httpClient.Get(u)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(res.Body)
}

func sendJSON(method, u string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, u, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(res.Body)
}

// ---------- Ledger ----------

type ledgerReserveResponse struct {
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	Requested string `json:"requested,omitempty"`
	Available string `json:"available,omitempty"`
}

func ledgerReserve(userID string, asset common.Asset, amount int64) (ledgerReserveResponse, json.RawMessage, error) {
	raw, err := sendJSON(http.MethodPost, ledgerURL+"/reserve", map[string]any{
		"userId": userID,
		"asset":  asset,
		"amount": strconv.FormatInt(amount, 10),
	})
	if err != nil {
		return ledgerReserveResponse{}, nil, err
	}
	var parsed ledgerReserveResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ledgerReserveResponse{}, raw, err
	}
	return parsed, raw, nil
}

// ---------- Engine ----------

type enginePlaceResponse struct {
	Events []struct {
		Kind string `json:"kind"`
	} `json:"events"`
}

func enginePlace(body map[string]any) (enginePlaceResponse, json.RawMessage, error) {
	raw, err := sendJSON(http.MethodPost, engineURL+"/orders", body)
	if err != nil {
		return enginePlaceResponse{}, nil, err
	}
	var parsed enginePlaceResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return enginePlaceResponse{}, raw, err
	}
	return parsed, raw, nil
}
