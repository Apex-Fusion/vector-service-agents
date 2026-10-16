// agents/document-pipeline/src/format.ts
// The small ways the Pipeline writes things down, in one place: an escrow or advert reference in its canonical form (lower-case hex), a moment as
// ISO text, and the message of an error flat and cut short, for messages a person reads.
import { formatOutRef, parseOutRef } from '@vsa/vector-read';
export { errorText } from '@vsa/service-kit';

/** `<txid>#<index>` with the hex in lower case and the index without padding; throws "Invalid out ref" for anything else. */
export function canonicalRef(ref: string): string {
  const { txHash, outputIndex } = parseOutRef(ref);
  return formatOutRef(txHash, outputIndex);
}

/** A POSIX millisecond moment as ISO 8601 text. */
export const iso = (ms: number): string => new Date(ms).toISOString();
