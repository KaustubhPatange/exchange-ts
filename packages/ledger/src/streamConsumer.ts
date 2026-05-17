import type Redis from 'ioredis';
import { deserializeEvent, type EngineEvent } from '@exchange/common';

/**
 * Consume the engine.events stream. Yields events in two phases:
 *
 *   1. REPLAY: every event currently in the stream, oldest first.
 *      We do this with XRANGE so it's a clean drain, not a blocking read.
 *   2. LIVE:   subsequent events as they are appended.
 *      We do this with XREAD BLOCK 0.
 *
 * The consumer maintains a cursor (the last stream id processed) so the
 * transition between phases is seamless and we never miss an event nor
 * see one twice in the same run.
 *
 * Each yielded value carries the mode so the caller can apply different
 * settlement logic during replay vs live (see Settler).
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
  // --- REPLAY phase ---
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

  // After replay, `cursor` is the exclusive next id ("(<id>"). For XREAD
  // we need the inclusive last id we saw. Strip the leading `(`. If no
  // events were drained, start from '0' so XREAD streams everything new
  // from the start of the next push.
  let lastId: string = cursor.startsWith('(') ? cursor.slice(1) : '0';

  // --- LIVE phase ---
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
