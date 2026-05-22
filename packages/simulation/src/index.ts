import * as p from '@clack/prompts';
import pc from 'picocolors';

import { clientFor, systemClient } from './client.js';
import { resetAll } from './reset.js';
import { examples, type ExampleDeps } from './registry.js';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const ENGINE = process.env.ENGINE_URL ?? 'http://localhost:8082';
const LEDGER = process.env.LEDGER_URL ?? 'http://localhost:8081';
const MARKETDATA = process.env.MARKETDATA_URL ?? 'http://localhost:8083';

async function probe(url: string, name: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/healthz`);
    if (!res.ok) return `${name} (${url}) returned HTTP ${res.status}`;
    return null;
  } catch (err) {
    return `${name} (${url}) unreachable: ${(err as Error).message}`;
  }
}

async function main(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' Exchange simulation ')));

  const problems = (
    await Promise.all([
      probe(GATEWAY, 'gateway'),
      probe(ENGINE, 'engine'),
      probe(LEDGER, 'ledger'),
      probe(MARKETDATA, 'marketdata'),
    ])
  ).filter((s): s is string => s !== null);

  if (problems.length > 0) {
    p.note(
      problems.join('\n') +
        '\n\n' +
        pc.dim('Run `pnpm dev` in another terminal first.'),
      pc.red('services not reachable')
    );
    p.outro('bye');
    process.exit(1);
  }

  const deps: ExampleDeps = {
    alice: clientFor('alice', GATEWAY),
    bob: clientFor('bob', GATEWAY),
    gary: clientFor('gary', GATEWAY),
    josh: clientFor('josh', GATEWAY),
    system: systemClient(GATEWAY),
    resetAll: () => resetAll({ engine: ENGINE, ledger: LEDGER, marketdata: MARKETDATA }),
  };

  while (true) {
    const choice = await p.select({
      message: 'Pick an example',
      options: [
        ...examples.map((e) => ({
          value: e.id,
          label: e.title,
          hint: e.summary,
        })),
        { value: '__exit', label: 'Exit', hint: '' },
      ],
    });

    if (p.isCancel(choice) || choice === '__exit') {
      return;
    }

    const example = examples.find((e) => e.id === choice);
    if (!example) continue;

    const spin = p.spinner();
    spin.start('Resetting exchange state…');
    try {
      await deps.resetAll();
    } catch (err) {
      spin.stop('reset failed');
      p.note((err as Error).message, pc.red('reset error'));
      continue;
    }
    spin.stop('Clean slate ready.');

    try {
      await example.run(deps);
    } catch (err) {
      p.note((err as Error).message + '\n\n' + ((err as Error).stack ?? ''), pc.red('example crashed'));
    }

    const again = await p.confirm({ message: 'Run another?', initialValue: true });
    if (p.isCancel(again) || !again) {
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
