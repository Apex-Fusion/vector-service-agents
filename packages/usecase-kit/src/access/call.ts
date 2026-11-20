// packages/usecase-kit/src/access/call.ts
// One call to a mock system, with the credential of its route. Each function checks that the credential is for this route, before it sends anything. Then it makes the proof or the header, sends
// the call once, and maps the answer with `readAnswer`: the body for a 2xx, `refused_by_system` for a 401 or a 403, and `mock_system_failed` for everything else. There is no retry: a write may
// have taken effect, so a caller that wants another try reads the state first. No function throws.
import type { PresentedToken } from '@vsa/id-kit/client';
import { RUNTIME_BODY_LIMIT_BYTES, type JsonValue } from '../protocol/index.ts';
import { failed, readAnswer, type SystemFailed, type SystemResult } from './answer.ts';
import type { MtlsTransport } from './mtls.ts';
import { MAX_WAIT_MS, within, type Clock } from './ports.ts';
import type { HttpMethod, JwtSvidTarget, RouteTarget, TokenTarget, X509Target } from './routes.ts';
import type { JwtSvidCredential, X509SvidCredential } from './svid.ts';
import type { RouteToken } from './token.ts';
import { errorText, piecesOf, safeText } from './text.ts';

/** The longest time that a call waits for the answer, in milliseconds. A mock system can take about 50 seconds for a check of its own. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** The most bytes of an answer that a call reads. */
export const DEFAULT_MAX_ANSWER_BYTES = RUNTIME_BODY_LIMIT_BYTES;

export interface CallDeps {
  /** The `fetch` of the caller. A test gives a stub. */
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  /** The longest time that a call waits, in milliseconds: a whole number from 1 to 86,400,000. The default is DEFAULT_CALL_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** The most bytes of an answer that a call reads: a whole number of at least 1. The default is DEFAULT_MAX_ANSWER_BYTES. */
  readonly maxAnswerBytes?: number;
}

interface Prepared {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** The values that no detail may show. */
  readonly secrets: readonly string[];
}

const notSent = (detail: string): SystemFailed => failed(null, null, false, detail);

/** The URL is the resource, or a path below it. A URL on another host, or on a path that only starts with the same letters, is not. */
const isUnder = (url: string, resource: string): boolean => url === resource || url.startsWith(`${resource}/`);

/** The limits of a call, or why the call is refused before it is sent: a limit that is not a whole number in its range is an error, and never "no limit". */
function limitsOf(deps: CallDeps): { readonly ok: true; readonly timeoutMs: number; readonly maxBytes: number } | { readonly ok: false; readonly failure: SystemFailed } {
  const timeoutMs = deps.timeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : deps.timeoutMs;
  const maxBytes = deps.maxAnswerBytes === undefined ? DEFAULT_MAX_ANSWER_BYTES : deps.maxAnswerBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) return { ok: false, failure: notSent(`timeoutMs must be a whole number from 1 to ${MAX_WAIT_MS}`) };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return { ok: false, failure: notSent('maxAnswerBytes must be a whole number of at least 1') };
  return { ok: true, timeoutMs, maxBytes };
}

/** The body of a call as text, or why the call is refused before it is sent: a GET has no body, a POST has one, and the body is at most RUNTIME_BODY_LIMIT_BYTES. */
function bodyOf(target: RouteTarget, body: JsonValue | undefined): { readonly ok: true; readonly text: string | null } | { readonly ok: false; readonly failure: SystemFailed } {
  if (target.method === 'GET') return body === undefined ? { ok: true, text: null } : { ok: false, failure: notSent(`the route ${target.route} is a GET and takes no body`) };
  if (body === undefined) return { ok: false, failure: notSent(`the route ${target.route} is a POST and needs a body`) };
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return { ok: false, failure: notSent('the body cannot be written as JSON') };
  }
  return Buffer.byteLength(text, 'utf8') <= RUNTIME_BODY_LIMIT_BYTES
    ? { ok: true, text }
    : { ok: false, failure: notSent(`the body is longer than ${RUNTIME_BODY_LIMIT_BYTES} bytes`) };
}

/** Reads the body of a response up to `max` bytes. Null when the body is longer. */
async function readCapped(response: Response, max: number): Promise<string | null> {
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

/** Sends one call with `fetch`, and maps what came back. A redirect is never followed: it is an answer that is not a 2xx, so it is a failure. */
async function sendWithFetch(deps: CallDeps, call: Prepared): Promise<SystemResult> {
  try {
    const bounded = await within(deps.clock, call.timeoutMs, async (signal) => {
      const response = await deps.fetch(call.url, { method: call.method, headers: call.headers, body: call.body, redirect: 'manual', signal });
      return { status: response.status, text: await readCapped(response, call.maxBytes) };
    });
    if (bounded.timedOut) return failed(null, null, true, `the system did not answer within ${call.timeoutMs} ms`);
    const { status, text } = bounded.value;
    return text === null ? failed(status, null, true, `the answer is longer than ${call.maxBytes} bytes`) : readAnswer(status, text, call.secrets);
  } catch (error) {
    return failed(null, null, true, `no answer: ${errorText(error, call.secrets)}`);
  }
}

const JSON_HEADERS = { accept: 'application/json' } as const;
const withBody = (headers: Record<string, string>, body: string | null): Record<string, string> => (body === null ? headers : { ...headers, 'content-type': 'application/json' });

/**
 * A call with an access token. The token must be the token of this route: the same route, resource and action, a URL below that resource, a holder that the route takes, and a time that has not
 * ended. Otherwise nothing is sent. The call has `Authorization: DPoP <token>` and a new DPoP proof for this method and this URL.
 */
export async function callWithToken(deps: CallDeps, token: RouteToken, target: TokenTarget, body?: JsonValue): Promise<SystemResult> {
  if (token.route !== target.route || token.resource !== target.resource || token.action !== target.action) {
    return notSent(`the token is for the route ${token.route}, and the call is for the route ${target.route}`);
  }
  if (!isUnder(target.url, token.resource)) return notSent('the URL of the call is not below the resource of the token');
  if (target.callers === 'agent' && token.holder === 'subagent') return notSent(`the route ${target.route} takes the agent only, and the token is a subagent token`);
  if (deps.clock.now() >= token.expiresAt) return notSent('the token has ended');
  const limits = limitsOf(deps);
  if (!limits.ok) return limits.failure;
  const prepared = bodyOf(target, body);
  if (!prepared.ok) return prepared.failure;
  let headers: PresentedToken;
  try {
    headers = await token.present(target.method, target.url, () => deps.clock.now());
  } catch (error) {
    return notSent(`the DPoP proof could not be made: ${error instanceof Error ? safeText(error.name) : 'a value that is not an error was thrown'}`);
  }
  const secrets = [headers.authorization, headers.dpop, ...piecesOf(headers.authorization.slice('DPoP '.length)), ...piecesOf(headers.dpop)];
  return sendWithFetch(deps, {
    method: target.method,
    url: target.url,
    headers: withBody({ ...JSON_HEADERS, authorization: headers.authorization, dpop: headers.dpop }, prepared.text),
    body: prepared.text,
    timeoutMs: limits.timeoutMs,
    maxBytes: limits.maxBytes,
    secrets,
  });
}

/** A call with a JWT-SVID, as `Authorization: Bearer <JWT-SVID>`. The JWT-SVID must name the audience of the route, the URL must be below that audience, and the JWT-SVID must not have ended. */
export async function callWithJwtSvid(deps: CallDeps, svid: JwtSvidCredential, target: JwtSvidTarget, body?: JsonValue): Promise<SystemResult> {
  if (!svid.audience.includes(target.audience)) return notSent(`the JWT-SVID does not name the audience of the route ${target.route}`);
  if (!isUnder(target.url, target.audience)) return notSent('the URL of the call is not below the audience of the JWT-SVID');
  if (deps.clock.now() >= svid.expiresAt) return notSent('the JWT-SVID has ended');
  const limits = limitsOf(deps);
  if (!limits.ok) return limits.failure;
  const prepared = bodyOf(target, body);
  if (!prepared.ok) return prepared.failure;
  const bearer = svid.bearer();
  return sendWithFetch(deps, {
    method: target.method,
    url: target.url,
    headers: withBody({ ...JSON_HEADERS, authorization: bearer }, prepared.text),
    body: prepared.text,
    timeoutMs: limits.timeoutMs,
    maxBytes: limits.maxBytes,
    secrets: [bearer, ...piecesOf(bearer.slice('Bearer '.length))],
  });
}

/**
 * A call with an X.509-SVID as the TLS client certificate, to the client-certificate host. The call goes through the transport and not through `fetch`, because `fetch` cannot present a client
 * certificate. The certificate must not have ended. The private key goes to the transport only, and a text that a result shows never holds it.
 */
export async function callWithX509Svid(deps: CallDeps & { readonly transport: MtlsTransport }, credential: X509SvidCredential, target: X509Target, body?: JsonValue): Promise<SystemResult> {
  if (deps.clock.now() >= credential.expiresAt) return notSent('the X.509-SVID has ended');
  const limits = limitsOf(deps);
  if (!limits.ok) return limits.failure;
  const prepared = bodyOf(target, body);
  if (!prepared.ok) return prepared.failure;
  let secrets: readonly string[] = [];
  try {
    const { cert, key } = credential.tls();
    secrets = [key, ...key.split('\n').filter((line) => line.length >= 16 && !line.startsWith('-----'))];
    const bounded = await within(deps.clock, limits.timeoutMs, (signal) =>
      deps.transport({ url: target.url, method: target.method, headers: withBody({ ...JSON_HEADERS }, prepared.text), body: prepared.text, cert, key, maxBodyBytes: limits.maxBytes, signal }),
    );
    if (bounded.timedOut) return failed(null, null, true, `the system did not answer within ${limits.timeoutMs} ms`);
    return readAnswer(bounded.value.status, bounded.value.body, secrets);
  } catch (error) {
    return failed(null, null, true, `no answer: ${errorText(error, secrets)}`);
  }
}
