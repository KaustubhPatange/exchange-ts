/**
 * Hardcoded API-key → userId map. In a real exchange this would be a
 * database lookup; for learning, a Map suffices.
 */
export const API_KEYS: Record<string, string> = {
  key_alice: 'alice',
  key_bob: 'bob',
  key_gary: 'gary',
  key_josh: 'josh',
};

export function resolveUser(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  return API_KEYS[apiKey] ?? null;
}
