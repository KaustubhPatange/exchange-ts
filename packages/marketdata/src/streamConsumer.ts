import type Redis from 'ioredis';
import { deserializeEvent, type EngineEvent } from '@exchange/common';

/**
 * Consume the engine.events stream. Same shape as ledger's consumer:
 * REPLAY phase (XRANGE) then LIVE phase (XREAD BLOCK 0). Yields each event
 * with its mode so the caller can apply different logic if needed.
 */

export interface StreamItem {
  event: EngineEvent;
  mode: 'replay' | 'live';
}

const PAGE = 1000;

export async function* consumeEngineStream(
  redis: Redis,
  streamKey: string = 'engine.events'
): AsyncGenerator<StreamItem> {
  // --- REPLAY ---
  let cursor: string = '-';
  while (true) {
    const result = (await redis.xrange(
      streamKey,
      cursor,
      '+',
      'COUNT',
      PAGE
    )) as [string, string[]][];
    if (!result || result.length === 0) break;
    for (const [id, fields] of result) {
      const ev = decodeFields(fields);
      if (ev) yield { event: ev, mode: 'replay' };
      cursor = `(${id}`;
    }
    if (result.length < PAGE) break;
  }
  let lastId: string = cursor.startsWith('(') ? cursor.slice(1) : '0';

  // --- LIVE ---
  while (true) {
    const reply = (await redis.call(
      'XREAD',
      'BLOCK',
      '0',
      'COUNT',
      String(PAGE),
      'STREAMS',
      streamKey,
      lastId
    )) as [string, [string, string[]][]][] | null;
    if (!reply) continue;
    for (const [, entries] of reply) {
      for (const [id, fields] of entries) {
        const ev = decodeFields(fields);
        if (ev) yield { event: ev, mode: 'live' };
        lastId = id;
      }
    }
  }
}

function decodeFields(fields: string[]): EngineEvent | null {
  const idx = fields.indexOf('data');
  if (idx < 0 || idx + 1 >= fields.length) return null;
  return deserializeEvent(fields[idx + 1]!);
}
