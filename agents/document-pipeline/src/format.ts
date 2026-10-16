// agents/document-pipeline/src/format.ts
// The small ways the Pipeline writes things down, in one place: an escrow or advert reference in its canonical form (lower-case hex), a moment as
// ISO text, and the message of an error cut short, for messages a person reads.
import { formatOutRef, parseOutRef } from '@vsa/vector-read';
import { clip } from './text.ts';

/** `<txid>#<index>` with the hex in lower case and the index without padding; throws "Invalid out ref" for anything else. */
export function canonicalRef(ref: string): string {
  const { txHash, outputIndex } = parseOutRef(ref);
  return formatOutRef(txHash, outputIndex);
}

/** A POSIX millisecond moment as ISO 8601 text. */
export const iso = (ms: number): string => new Date(ms).toISOString();

/** The message of an error, cut short: errors from the chain and the clients go into messages that a caller reads. */
export function errorText(err: unknown, max = 300): string {
  return clip(err instanceof Error ? err.message : String(err), max);
}
