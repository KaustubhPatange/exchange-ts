package main

// Hardcoded API-key → userId map. In a real exchange this would be a
// database lookup; for learning, a map suffices.
var apiKeys = map[string]string{
	"key_alice": "alice",
	"key_bob":   "bob",
	"key_gary":  "gary",
	"key_josh":  "josh",
}

// resolveUser returns the userId for an API key, or "" if unknown/missing.
func resolveUser(apiKey string) string {
	return apiKeys[apiKey]
}
