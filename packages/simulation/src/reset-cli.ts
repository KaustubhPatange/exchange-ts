import pc from 'picocolors';
import { resetAll } from './reset.js';

async function main(): Promise<void> {
  const t0 = Date.now();
  try {
    await resetAll();
    console.log(pc.green(`✓ engine, ledger, marketdata reset (${Date.now() - t0}ms)`));
  } catch (err) {
    console.error(pc.red(`✗ reset failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

void main();
