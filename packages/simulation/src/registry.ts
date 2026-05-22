import type { ExchangeClient } from './client.js';

export interface ExampleDeps {
  alice: ExchangeClient;
  bob: ExchangeClient;
  gary: ExchangeClient;
  josh: ExchangeClient;
  system: ExchangeClient;
  resetAll: () => Promise<void>;
}

export interface Example {
  id: string;
  title: string;
  summary: string;
  run(deps: ExampleDeps): Promise<void>;
}

import { example as ex01 } from './examples/01-price-discovery.js';
import { example as ex02 } from './examples/02-fok.js';
import { example as ex03 } from './examples/03-ioc.js';
import { example as ex04 } from './examples/04-post-only.js';
import { example as ex05 } from './examples/05-limit-resting.js';
import { example as ex06 } from './examples/06-stp.js';
import { example as ex07 } from './examples/07-partial-limit.js';
import { example as ex08 } from './examples/08-partial-ioc.js';
import { example as ex09 } from './examples/09-continuous-loop.js';
import { example as ex10 } from './examples/10-fees.js';
import { example as ex11 } from './examples/11-multi-trade-split.js';
import { example as ex12 } from './examples/12-cancel-replace.js';
import { example as ex13 } from './examples/13-depth-visualization.js';
import { example as ex14 } from './examples/14-price-improvement.js';

export const examples: Example[] = [
  ex01, ex02, ex03, ex04, ex05, ex06, ex07,
  ex08, ex09, ex10, ex11, ex12, ex13, ex14,
];
