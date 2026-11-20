// packages/usecase-kit/src/cosign/http.ts
// The HTTP side of the route: the method, the content type, the size of the body, and the answer. The handler takes the parts of a request (a Node `IncomingMessage` has all three) and gives back the
// status, the headers and the body of the answer. The service writes them. The handler never throws.
//
// The route is public, so the handler is cheap: it refuses a wrong method, a wrong content type and a body over the limit before the agent parses anything, and it stops reading a body that is
// far over the limit.
import { RUNTIME_BODY_LIMIT_BYTES } from '../protocol/index.ts';
import type { ProtocolResult } from '../protocol/index.ts';
import { COSIGN_STATUS, MAX_COSIGN_REQUEST_BYTES } from './codes.ts';
import type { CosignCode, CosignErrorBody } from './codes.ts';

export interface CosignHttpRequest {
  readonly method?: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The body as chunks. A Node `IncomingMessage` is one. */
  readonly body: AsyncIterable<Uint8Array | string>;
}

export interface CosignHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type CosignHandler = (request: CosignHttpRequest) => Promise<CosignHttpResponse>;

/** A body that is over the limit is read and dropped up to this many bytes, so that the answer can reach the caller. A body above it is not read any more. */
const DRAIN_LIMIT_BYTES = RUNTIME_BODY_LIMIT_BYTES;

const JSON_TYPE = /^application\/json\s*(?:;.*)?$/i;

function respond(status: number, payload: unknown, extra: Readonly<Record<string, string>> = {}): CosignHttpResponse {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(payload) };
}

function fail(code: CosignCode, message: string, extra: Readonly<Record<string, string>> = {}): CosignHttpResponse {
  const body: CosignErrorBody = { error: code, message };
  return respond(COSIGN_STATUS[code], body, extra);
}

/** The value of a header, or undefined when it is missing or has more than one value. */
function headerOf(headers: CosignHttpRequest['headers'], name: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue;
    const value = headers[key];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** The body as bytes, or undefined when it has more than `limit` bytes. A body over the limit is dropped as it comes, and it is not read past DRAIN_LIMIT_BYTES. */
async function readLimited(body: AsyncIterable<Uint8Array | string>, limit: number): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += bytes.byteLength;
    if (size > DRAIN_LIMIT_BYTES) return undefined;
    if (size <= limit) chunks.push(bytes);
  }
  return size <= limit ? Buffer.concat(chunks) : undefined;
}

/** The handler of the route. `cosign` is the function behind it, which takes the body of the request and gives a typed result. */
export function makeHandler(cosign: (body: Uint8Array) => Promise<ProtocolResult<{ readonly transaction: string }, CosignCode>>): CosignHandler {
  const tooLarge = () => fail('request_too_large', `the request has more than ${MAX_COSIGN_REQUEST_BYTES} bytes`, { connection: 'close' });
  return async (request) => {
    try {
      if (request.method !== 'POST') return fail('method_not_allowed', 'the route takes POST only', { allow: 'POST' });
      const type = headerOf(request.headers, 'content-type');
      if (type === undefined || !JSON_TYPE.test(type)) return fail('unsupported_media_type', 'the content type must be application/json');
      const declared = headerOf(request.headers, 'content-length');
      if (declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > MAX_COSIGN_REQUEST_BYTES) return tooLarge();
      const body = await readLimited(request.body, MAX_COSIGN_REQUEST_BYTES);
      if (body === undefined) return tooLarge();
      const result = await cosign(body);
      return result.ok ? respond(200, { transaction: result.value.transaction }) : fail(result.code, result.detail);
    } catch {
      return fail('internal', 'the agent could not sign');
    }
  };
}
