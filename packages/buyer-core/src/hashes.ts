// packages/buyer-core/src/hashes.ts
// sha256BytesHex is the one function Apex-Fusion/mcp-server's marketplace-datum.ts gained between 94b8f41 (the copy that
// @vsa/vector-read carries) and 651ae93 (the pin of the files in src/vendored/). The vendored marketplace-transport.ts imports it,
// so it is defined here instead of a second copy of the datum module. The code lines below are the source's, byte for byte:
// line 9 (the import) and lines 193-194 of packages/builder/src/vector/marketplace-datum.ts at 651ae93 (see VENDORED-FROM.md).
import { createHash } from 'node:crypto';

/** The sha256 of bytes as they are, lower-case hex: for what arrives as bytes (a file served by a supplier), where decoding to text first would change them. */
export function sha256BytesHex(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
