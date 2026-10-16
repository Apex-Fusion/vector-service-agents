// agents/document-pipeline/src/format.ts
// The small ways the Pipeline writes things down, in one place: an escrow or advert reference in its canonical form (lower-case hex), a moment as
// ISO text, and the message of an error flat and cut short, for messages a person reads.
import { flatText } from '@vsa/buyer-core';
import { formatOutRef, parseOutRef } from '@vsa/vector-read';
import { clip } from './text.ts';

/** `<txid>#<index>` with the hex in lower case and the index without padding; throws "Invalid out ref" for anything else. */
export function canonicalRef(ref: string): string {
  const { txHash, outputIndex } = parseOutRef(ref);
  return formatOutRef(txHash, outputIndex);
}

/** A POSIX millisecond moment as ISO 8601 text. */
export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The message of an error, flat and cut short: errors from the chain, the clients and the vendored normaliser go into messages that a caller reads and
 * into log lines, and some of them echo a key or a type a supplier chose. Every control character becomes a space (flatText, ruling R64), so that a line
 * break cannot forge a log line nor an escape steer a terminal.
 */
export function errorText(err: unknown, max = 300): string {
  const text = err instanceof Error ? err.message : String(err);
  return clip(flatText(text, text.length), max);
}
