// packages/usecase-kit/src/protocol/limits.ts
// The limits on the size of a request.
import { accepted, refused, type ProtocolResult } from './result.ts';

/**
 * The most bytes of wire payload that a service takes: 900,000. The limit bounds the wire payload and nothing else. The wire payload is the request text written as a string inside a one-message
 * JSON array. Writing the text as a string makes it longer: each quote mark and each backslash gets one more character. The limit counts the payload after this step.
 *
 * The limit does not bound the body of the call that a sender makes to the runtime in front of the service. The sender puts the wire payload inside a second JSON object, and each quote mark and each
 * backslash of the wire payload gets one more byte again. So the body is longer than the wire payload, and it can pass RUNTIME_BODY_LIMIT_BYTES while the wire payload is under this limit. The
 * runtime refuses such a body. A sender must also keep the body of its call at or below RUNTIME_BODY_LIMIT_BYTES.
 *
 * The shared service code reads at most 1,000,000 bytes of wire payload. This limit is below that number.
 */
export const MAX_REQUEST_BYTES = 900_000;

/** The most bytes that the runtime in front of a service takes in the body of one call: 1 MiB. A body above this number is refused. */
export const RUNTIME_BODY_LIMIT_BYTES = 1_048_576;

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
