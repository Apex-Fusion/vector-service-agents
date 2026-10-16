// packages/service-kit/src/wire.ts
// The message the runtime posts: `[{"content": "<request JSON as a string>", "role": "user"}]`, at most MAX_BODY bytes. The request JSON inside it is the
// service's to read. Moved from agents/document-pipeline/src/server.ts as it stood.
import type { IncomingMessage } from 'node:http';

/** The most bytes of body the service reads: 1 MB. A buyer posts at most 900000 bytes of wire payload; the rest is the room the runtime's own framing needs. */
export const MAX_BODY = 1_000_000;

/** A body that is not the wire message, or is too large. Carries a stable `code` and the `status` the service answers with. */
export class WireError extends Error {
  readonly code: 'bad_wire' | 'request_too_large';
  readonly status = 400;
  constructor(code: 'bad_wire' | 'request_too_large', message: string) {
    super(message);
    this.name = 'WireError';
    this.code = code;
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const WIRE_SHAPE = 'the body must be the one-element message array [{"content": "<request JSON as a string>", "role": "user"}]';

/** The request JSON out of the wire message the runtime posts: `[{"content": "<request JSON as a string>", "role": "user"}]`. The request JSON is the service's to read. */
export function parseWire(body: string): string {
  // Bytes on the wire, not UTF-16 code units: the HTTP layer counts the same unit.
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY) throw new WireError('request_too_large', `the request is too large (${bytes} bytes, the service reads at most ${MAX_BODY})`);
  let list: unknown;
  try { list = JSON.parse(body); } catch { throw new WireError('bad_wire', `the body is not JSON: ${WIRE_SHAPE}`); }
  if (!Array.isArray(list) || list.length !== 1 || !isObject(list[0]) || typeof list[0].content !== 'string') throw new WireError('bad_wire', WIRE_SHAPE);
  if (list[0].role !== 'user') throw new WireError('bad_wire', "the message role must be 'user'");
  return list[0].content;
}

/**
 * Reads the request body as bytes, the unit parseWire counts in. Past MAX_BODY it stops keeping data and fails at once (the caller answers 400 and closes the
 * connection); the rest of the upload is read and dropped, never held.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes <= MAX_BODY) chunks.push(c);
      else if (!failed) { failed = true; reject(new WireError('request_too_large', `the request is too large (more than ${MAX_BODY} bytes, the most the service reads)`)); }
    });
    req.on('end', () => resolve(Buffer.concat(chunks, bytes).toString('utf8')));
    req.on('error', reject);
  });
}
