const DEFAULTS = {
  engine: process.env.ENGINE_URL ?? 'http://localhost:8082',
  ledger: process.env.LEDGER_URL ?? 'http://localhost:8081',
  marketdata: process.env.MARKETDATA_URL ?? 'http://localhost:8083',
};

export interface ResetUrls {
  engine?: string;
  ledger?: string;
  marketdata?: string;
}

async function callReset(url: string, name: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${url}/admin/reset`, { method: 'POST' });
  } catch (err) {
    throw new Error(`reset(${name}): ${name} not reachable at ${url} — is \`pnpm dev\` running? (${(err as Error).message})`);
  }
  if (res.status === 404) {
    throw new Error(
      `reset(${name}): /admin/reset returned 404. The dev script must set EXCHANGE_ADMIN_ENABLED=1 (see root package.json).`
    );
  }
  if (!res.ok) {
    throw new Error(`reset(${name}): HTTP ${res.status} — ${await res.text()}`);
  }
}

async function waitHealthy(url: string, name: string, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`reset: ${name} did not respond /healthz within ${timeoutMs}ms`);
}

/**
 * Wipe state across all three stateful services. Engine first (it owns the
 * source-of-truth Redis stream); then ledger and marketdata in parallel
 * because they are independent projections.
 */
export async function resetAll(urls: ResetUrls = {}): Promise<void> {
  const u = { ...DEFAULTS, ...urls };
  await callReset(u.engine, 'engine');
  await Promise.all([
    callReset(u.ledger, 'ledger'),
    callReset(u.marketdata, 'marketdata'),
  ]);
  await Promise.all([
    waitHealthy(u.engine, 'engine'),
    waitHealthy(u.ledger, 'ledger'),
    waitHealthy(u.marketdata, 'marketdata'),
  ]);
  // Give the freshly-restarted XREAD consumers a moment to enter LIVE mode
  // before the next example begins publishing events. Without this, the
  // first one or two events of the next example can race the consumer
  // re-subscribe and get missed on the in-memory projection.
  await new Promise((r) => setTimeout(r, 100));
}
