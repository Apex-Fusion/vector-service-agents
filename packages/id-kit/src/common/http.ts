// packages/id-kit/src/common/http.ts
// One way to call the gateway, for the client and for the verifier's reader. The `fetch` function is the caller's (a test gives the stub gateway's). A call has a time
// limit and a size limit on the answer, and it follows no redirect.

import { refuse, type GatewayRefused } from './result.ts';

export interface HttpContext {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

/** The answer of a call: `reached` is false when no answer came (a network failure, the time limit, or an answer over the size limit). */
export type Outcome = { readonly reached: true; readonly reply: Reply } | { readonly reached: false; readonly detail: string };

export const DEFAULT_TIMEOUT_MS = 10_000;
/** The status lists, the key set and the bundle are small. One megabyte is far above the gateway's own limit for a body. */
export const DEFAULT_MAX_BYTES = 1_048_576;

async function readCapped(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (declared > max) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function send(http: HttpContext, url: string, init: RequestInit = {}): Promise<Outcome> {
  try {
    const response = await http.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(http.timeoutMs) });
    const body = await readCapped(response, http.maxBytes);
    if (body === null) return { reached: false, detail: `the answer is longer than ${http.maxBytes} bytes` };
    return { reached: true, reply: { status: response.status, headers: response.headers, body } };
  } catch (e) {
    return { reached: false, detail: `no answer: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` };
  }
}

/** The origin of a gateway from the URL that the caller gives. https only, and http for a loopback host (a local test). No user, path, query or fragment. */
export function gatewayOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('the gateway URL is not a URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new TypeError('the gateway URL must be an https URL (http only for a loopback host)');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') throw new TypeError('the gateway URL is an origin: no user, no path, no query and no fragment');
  return url.origin;
}

/** The JSON object in a body, or null. */
export function jsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function retryAfter(headers: Headers): number | null {
  const text = headers.get('retry-after');
  return text !== null && /^\d{1,6}$/.test(text) ? Number(text) : null;
}

/** The refusal for a call that did not give the answer that the caller waits for: no answer, a 4xx, a 5xx or 429, or another status. */
export function failureOf(outcome: Outcome, expected: string): GatewayRefused {
  if (!outcome.reached) return { ...refuse('gateway.unreachable', outcome.detail), status: 0, error: null, retryAfterSeconds: null };
  const { status, headers, body } = outcome.reply;
  const json = jsonObject(body);
  const error = typeof json?.error === 'string' ? json.error : null;
  const description = typeof json?.error_description === 'string' ? json.error_description : `the gateway answered ${status}`;
  if (status >= 500 || status === 429) return { ...refuse('gateway.unavailable', description), status, error, retryAfterSeconds: retryAfter(headers) };
  if (status >= 400) return { ...refuse('gateway.refused', description), status, error, retryAfterSeconds: null };
  return { ...refuse('gateway.bad_response', `${expected}: the gateway answered ${status}`), status, error: null, retryAfterSeconds: null };
}

/** A refusal for a 200 answer whose body has not the shape that the call needs. */
export function badBody(status: number, detail: string): GatewayRefused {
  return { ...refuse('gateway.bad_response', detail), status, error: null, retryAfterSeconds: null };
}
