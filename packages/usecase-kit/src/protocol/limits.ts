// packages/usecase-kit/src/protocol/limits.ts
// The limit on the size of a request.
import { accepted, refused, type ProtocolResult } from './result.ts';

/**
 * The most bytes of wire payload that an agent takes: 900,000.
 *
 * The wire payload is the request text written as a string inside a one-message JSON array. Writing the text as a string makes it longer: each quote mark and each backslash gets one more
 * character. The limit counts the payload after this step. The runtime in front of an agent refuses a body above 1 MiB (1,048,576 bytes), and the shared service code reads at most 1,000,000
 * bytes. This limit is below both. A limit on the request text before this step is not safe, because the text can grow past the limit of the runtime.
 */
export const MAX_REQUEST_BYTES = 900_000;

/** The size of a wire payload in bytes, or `request_too_large` when it is over MAX_REQUEST_BYTES. The size is counted in bytes of UTF-8, as the HTTP layer counts it, and not in characters. */
export function checkRequestSize(wirePayload: string | Uint8Array): ProtocolResult<number, 'request_too_large' | 'bad_shape'> {
  let bytes: number;
  if (typeof wirePayload === 'string') bytes = Buffer.byteLength(wirePayload, 'utf8');
  else if (wirePayload instanceof Uint8Array) bytes = wirePayload.byteLength;
  else return refused('bad_shape', 'the request must be text or bytes');
  return bytes <= MAX_REQUEST_BYTES
    ? accepted(bytes)
    : refused('request_too_large', `the request has ${bytes} bytes, and a service takes at most ${MAX_REQUEST_BYTES} bytes`);
}
