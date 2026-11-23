// packages/service-kit/src/routes.ts
// The open routes of a service: public paths of its own, which createJobServer answers next to its four (src/server.ts). An open route needs no token and takes
// no job slot, so a service gives one only for a path that is public by design, and its handler checks every rule of its own: the size of the body, who may call,
// how many calls run at once. This module holds the types, the check of the list that a service gives when it makes its server, the match of a request to a route,
// and the check of a reply. It reads no request and writes no answer.
import { types } from 'node:util';
import { clip } from './text.ts';

/** What the handler of an open route answers: the status, the headers and the body as text. */
export interface OpenReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
/** What the handler of an open route is given: a new object with these three members, and never the request of Node. */
export interface OpenRequest {
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The body as chunks. The request of the server is one: the server reads no byte of it, and the handler reads it with a size limit of its own. */
  readonly body: AsyncIterable<Uint8Array | string>;
}
export interface OpenRoute {
  readonly path: string;
  readonly methods: readonly ('GET' | 'POST')[];
  readonly handle: (request: OpenRequest) => Promise<OpenReply> | OpenReply;
}

/** The longest that the handler of an open route may run, and the default: 60 s. The server answers 500 {error: "internal"} when the handler has not answered by then. */
export const OPEN_ROUTE_TIMEOUT_MS = 60_000;
/** The most characters of the path of an open route. */
export const MAX_OPEN_PATH = 128;
/** The paths that the server answers itself. It answers them first, and no open route may have one. */
const OWN_PATHS: readonly string[] = ['/', '/precheck', '/healthz', '/agent.json'];
/** The characters of a path: no escape, no query, no fragment, no space and no text that is not ASCII, so that no path can stand for another. */
const PATH_CHARS = /^[A-Za-z0-9._~/-]+$/;
const METHODS_TEXT = 'methods lists GET, POST or both, each one time, and no other value';

/** A route as the check keeps it: a copy of the members, each read one time, with the methods as two flags. */
export interface CheckedOpenRoute {
  readonly path: string;
  readonly get: boolean;
  readonly post: boolean;
  readonly handle: OpenRoute['handle'];
}

/** A plain object: made by a literal or by Object.create(null), and no array, no class instance and no Proxy. A Proxy is looked for first, so that nothing of it runs. */
function isPlain(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || types.isProxy(value) || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The members of a plain object, each read one time. The descriptor says that the member is the object's own and holds a value, so that no getter runs. An object
 * that is not plain (a Proxy, a class instance, an inherited member) and a missing member are refused.
 */
function ownValues(value: unknown, names: readonly string[], what: string): Record<string, unknown> {
  if (!isPlain(value)) throw new RangeError(`${what} must be a plain object: no Proxy, no class instance and no member from a prototype`);
  const out: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const found = Object.getOwnPropertyDescriptor(value, name);
    if (found === undefined) throw new RangeError(`${what} has no member ${name} of its own`);
    if (!('value' in found)) throw new RangeError(`${what}: the member ${name} is a getter or a setter, and the kit reads values only`);
    out[name] = found.value;
  }
  return out;
}

/** The elements of an array, each read one time. A Proxy, a hole and a getter are refused. */
function ownElements(value: unknown, what: string): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value)) throw new RangeError(`${what} must be an array and not a Proxy`);
  const out: unknown[] = [];
  const length = value.length;
  for (let index = 0; index < length; index++) {
    const found = Object.getOwnPropertyDescriptor(value, index);
    if (found === undefined || !('value' in found)) throw new RangeError(`${what}[${index}] must be a value of the array: no hole and no getter`);
    out.push(found.value);
  }
  return out;
}

/** Why a path is refused, or undefined for a path that is fit. */
function pathProblem(path: string): string | undefined {
  if (!path.startsWith('/')) return 'must start with "/"';
  if (path.length > MAX_OPEN_PATH) return `has more than ${MAX_OPEN_PATH} characters`;
  if (!PATH_CHARS.test(path)) return 'has a character other than a letter, a digit, or one of . _ ~ / - (no query, no "#", no "%" escape, no space, no text that is not ASCII)';
  if (path.includes('..')) return 'has ".."';
  if (path.includes('//')) return 'has "//"';
  if (OWN_PATHS.includes(path)) return 'is a path that the server answers itself';
  return undefined;
}

/**
 * The list that a service gives as `openRoutes`, checked and copied, by path. A server that is given a bad list is not made: the check throws a RangeError whose
 * message names the path (or the place in the list, when there is no path to name). Each member of the list, of a route and of its methods is read one time, so that
 * what is checked is what is served, and a later change of the objects changes nothing.
 */
export function checkOpenRoutes(value: unknown): ReadonlyMap<string, CheckedOpenRoute> {
  const checked = new Map<string, CheckedOpenRoute>();
  if (value === undefined) return checked;
  ownElements(value, 'openRoutes').forEach((item, index) => {
    const at = `openRoutes[${index}]`;
    const { path, methods, handle } = ownValues(item, ['path', 'methods', 'handle'], at);
    if (typeof path !== 'string') throw new RangeError(`${at}: the path must be a text`);
    const named = `the open route ${JSON.stringify(clip(path, 64))}`;
    const problem = pathProblem(path);
    if (problem !== undefined) throw new RangeError(`${named} ${problem}`);
    if (checked.has(path)) throw new RangeError(`${named} is given twice: one route lists both methods`);
    let get = false;
    let post = false;
    for (const method of ownElements(methods, `${named}: methods`)) {
      if (method === 'GET' && !get) get = true;
      else if (method === 'POST' && !post) post = true;
      else throw new RangeError(`${named}: ${METHODS_TEXT}`);
    }
    if (!get && !post) throw new RangeError(`${named}: ${METHODS_TEXT}`);
    if (typeof handle !== 'function') throw new RangeError(`${named}: handle must be a function`);
    checked.set(path, Object.freeze({ path, get, post, handle: handle as OpenRoute['handle'] }));
  });
  return checked;
}

/**
 * The route that answers a request, or undefined. A GET, and a HEAD, matches the path whatever the query, as /agent.json does. A POST matches only when the whole url
 * is the path, as POST / does: a query is a miss. A method that the route does not list is a miss.
 */
export function matchOpenRoute(routes: ReadonlyMap<string, CheckedOpenRoute>, method: string | undefined, url: string): CheckedOpenRoute | undefined {
  if (routes.size === 0) return undefined;
  const query = url.indexOf('?');
  const route = routes.get(query === -1 ? url : url.slice(0, query));
  if (route === undefined) return undefined;
  if (method === 'GET' || method === 'HEAD') return route.get ? route : undefined;
  if (method === 'POST') return route.post && query === -1 ? route : undefined;
  return undefined;
}

/** A reply that has been checked: the headers to write, which hold no framing header, and the length of the body in bytes. */
export interface CheckedReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytes: number;
}
// What Node refuses in a header: a name that is not a token, and a value with a control character or a character above U+00FF.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/**
 * The reply of a handler, checked: an object whose status is a whole number from 200 to 599 (an interim status is no answer), whose headers are text for names and
 * values that Node can send, and whose body is a text. Each member is read one time. Anything else throws a TypeError whose message names the fault and shows no value.
 */
export function checkOpenReply(value: unknown): CheckedReply {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('the reply of the handler is not an object with the members status, headers and body');
  const { status, headers, body } = value as { status?: unknown; headers?: unknown; body?: unknown };
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) throw new TypeError('the status of the reply is not a whole number from 200 to 599');
  if (typeof body !== 'string') throw new TypeError('the body of the reply is not a text');
  if (!isPlain(headers)) throw new TypeError('the headers of the reply are not a plain object');
  const kept: Record<string, string> = Object.create(null);
  for (const name of Object.keys(headers)) {
    const given = (headers as Record<string, unknown>)[name];
    if (typeof given !== 'string' || !HEADER_NAME.test(name) || !HEADER_VALUE.test(given)) throw new TypeError('a header of the reply has a name or a value that cannot be sent');
    // The server writes the length of the body, and the way that it is framed, itself: the handler's own headers for them are dropped, in any letter case.
    const lower = name.toLowerCase();
    if (lower !== 'content-length' && lower !== 'transfer-encoding') kept[name] = given;
  }
  return { status, headers: kept, body, bytes: Buffer.byteLength(body, 'utf8') };
}
