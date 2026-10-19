// packages/hire-kit/src/format.ts
// The small ways the kit writes things down, in one place: an escrow or advert reference in its canonical form (lower-case hex), a moment as ISO text, and
// the message of an error flat and cut short, for messages a person reads. Moved with the hire from agents/document-pipeline/src/format.ts, which keeps its
// own copy for the rest of the Pipeline. errorText comes from @vsa/service-kit/text, the module of packages/service-kit with no imports, and not from the
// root of that kit, which loads the fetch of a source.
import { formatOutRef, parseOutRef } from '@vsa/vector-read';
export { errorText } from '@vsa/service-kit/text';

/** `<txid>#<index>` with the hex in lower case and the index without padding; throws "Invalid out ref" for anything else. */
export function canonicalRef(ref: string): string {
  const { txHash, outputIndex } = parseOutRef(ref);
  return formatOutRef(txHash, outputIndex);
}

/** A POSIX millisecond moment as ISO 8601 text. */
export const iso = (ms: number): string => new Date(ms).toISOString();
