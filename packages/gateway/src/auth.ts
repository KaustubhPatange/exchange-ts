/**
 * Hardcoded API-key → userId map. In a real exchange this would be a
 * database lookup; for learning, a Map suffices and lets us run all
 * MM bots and a couple of human user accounts without setup.
 */
export const API_KEYS: Record<string, string> = {
  key_alice: 'alice',
  key_bob: 'bob',
  key_user1: 'user1',
  key_mm1: 'mm1',
  key_mm2: 'mm2',
  key_mm3: 'mm3',
};

export function resolveUser(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  return API_KEYS[apiKey] ?? null;
}
