// packages/service-kit/test/open-routes.test.ts
// The open routes of the job server: paths of the service's own that it answers with no token and with no job slot (the section "Open routes" of the README).
// Each refusal has an accepted twin, so that a guard that refuses everything fails here too.
import { describe, test, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import * as kit from '../src/index.ts';
import type { OpenReply, OpenRequest, OpenRoute } from '../src/index.ts';
import { lifecycle } from '../src/lifecycle.ts';
import { MAX_OPEN_PATH, OPEN_ROUTE_TIMEOUT_MS } from '../src/routes.ts';
import { createJobServer } from '../src/server.ts';
import type { JobServerOptions } from '../src/server.ts';
import { JobSlot } from '../src/slot.ts';
import { ESCROW_X, ESCROW_Y, Refused, TOKEN, call, contextHeaders, echoOptions, listening, pause, serve, until, wire } from './support.ts';
import type { Echo, Said } from './support.ts';

const LOTS_TEXT = '{"name":"caf\u00e9"}'; // 15 characters and 16 bytes: the length of the answer is the byte count
const text = (body: string, over: Partial<OpenReply> = {}): OpenReply => ({ status: 200, headers: { 'content-type': 'text/plain' }, body, ...over });
const fine: OpenRoute['handle'] = () => text('fine');
const getRoute: OpenRoute = { path: '/lots.json', methods: ['GET'], handle: () => text(LOTS_TEXT, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) };
/** The whole body that a handler is given, as bytes. */
async function bytesOf(body: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
const postRoute: OpenRoute = {
  path: '/cosign/delegate', methods: ['POST'],
  handle: async (request) => {
    const bytes = await bytesOf(request.body);
    return text(JSON.stringify({ method: request.method, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }), { headers: { 'content-type': 'application/json' } });
  },
};
/** A server with the routes `routes`, whose job is the echo job; `over` changes the other options. `fn` gets the base, the port and the log. */
const withRoutes = <T>(routes: readonly OpenRoute[], fn: (base: string, port: number, logs: string[]) => Promise<T>, over: Partial<JobServerOptions<Echo, Said>> = {}): Promise<T> => {
  const logs: string[] = [];
  return serve(echoOptions({ openRoutes: routes, ...over }, logs), (base, port) => fn(base, port, logs));
};
/**
 * Everything the server writes to one request over a socket of its own (Connection: close), as text. A bare "?" at the end of a path goes this way: fetch drops it
 * and the server never sees it.
 */
function raw(port: number, method: string, path: string, body = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
}
const statusOf = (response: string): number => Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]);

// The shapes of the co-sign route of use case 1 (inventory reorder), written out: this package cannot import the kit of that use case.
interface CosignHttpRequest { readonly method?: string | undefined; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly body: AsyncIterable<Uint8Array | string> }
interface CosignHttpResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
const cosignLike = async (request: CosignHttpRequest): Promise<CosignHttpResponse> => {
  if (request.method !== 'POST') return { status: 405, headers: { allow: 'POST', 'content-type': 'application/json' }, body: '{"error":"method_not_allowed"}' };
  const bytes = await bytesOf(request.body);
  return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ transaction: bytes.toString('utf8') }) };
};
// A handler of that type is a handle with no wrapper. This line fails to compile when the two shapes drift apart.
const cosignRoute: OpenRoute = { path: '/cosign/delegate', methods: ['GET', 'POST'], handle: cosignLike };
// A handler that needs a member that the request has not is no handle: the line below must not compile.
const needsUrl = async (request: { readonly url: string }): Promise<OpenReply> => text(request.url);
// @ts-expect-error the request of an open route has no member url
const refusedByTypes: OpenRoute = { path: '/x', methods: ['GET'], handle: needsUrl };

describe('what an open route answers', () => {
  test('a GET route answers its body and headers with no token, whatever the query; HEAD gets the headers of the GET and no body', async () => {
    await withRoutes([getRoute], async (base, port) => {
      for (const path of ['/lots.json', '/lots.json?v=2']) {
        const res = await fetch(`${base}${path}`);
        expect([res.status, res.headers.get('content-type'), res.headers.get('cache-control'), await res.text()], path).toStrictEqual([200, 'application/json', 'no-store', LOTS_TEXT]);
      }
      const head = await fetch(`${base}/lots.json?v=2`, { method: 'HEAD' });
      expect([head.status, head.headers.get('content-type'), head.headers.get('content-length'), await head.text()]).toStrictEqual([200, 'application/json', String(Buffer.byteLength(LOTS_TEXT)), '']);
      // The twin: a wrong token changes nothing, because the route looks at none.
      expect((await fetch(`${base}/lots.json`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(200);
      const bare = await raw(port, 'GET', '/lots.json?');
      expect([statusOf(bare), bare.endsWith(LOTS_TEXT)], 'a bare ? is a query too').toStrictEqual([200, true]);
    });
  });

  test('a POST route answers a body that its handler reads, as the bytes that were posted, in as many chunks as came', async () => {
    await withRoutes([postRoute], async (base) => {
      const posted = Buffer.concat([Buffer.from([0, 255, 128, 10, 13]), Buffer.from('caf\u00e9'), Buffer.alloc(300_000, 7)]);
      const res = await fetch(`${base}/cosign/delegate`, { method: 'POST', body: new Uint8Array(posted), headers: { 'content-type': 'application/octet-stream' } });
      expect([res.status, await res.json()]).toStrictEqual([200, { method: 'POST', length: posted.length, sha256: createHash('sha256').update(posted).digest('hex') }]);
      const empty = await fetch(`${base}/cosign/delegate`, { method: 'POST' });
      expect(await empty.json()).toStrictEqual({ method: 'POST', length: 0, sha256: createHash('sha256').digest('hex') });
    });
  });

  test('the handler gets a new plain object with the three members method, headers and body and no other, and never the request of Node', async () => {
    const seen: OpenRequest[] = [];
    const spy: OpenRoute = { path: '/spy', methods: ['GET', 'POST'], handle: async (request) => { seen.push(request); return text(`read ${(await bytesOf(request.body)).toString('utf8')}`); } };
    await withRoutes([spy], async (base) => {
      const res = await fetch(`${base}/spy`, { method: 'POST', body: 'the bytes', headers: { 'x-probe': 'one', 'content-type': 'application/x-test' } });
      expect([res.status, await res.text()]).toStrictEqual([200, 'read the bytes']);
      await fetch(`${base}/spy`, { method: 'HEAD' });
    });
    expect(seen).toHaveLength(2);
    const [post, head] = seen;
    expect(Object.keys(post)).toStrictEqual(['method', 'headers', 'body']);
    expect(Object.getPrototypeOf(post)).toBe(Object.prototype);
    expect(['url', 'socket', 'httpVersion', 'on'].filter((name) => name in post)).toStrictEqual([]);
    expect([post.method, post.headers['x-probe'], post.headers['content-type'], typeof post.body[Symbol.asyncIterator]]).toStrictEqual(['POST', 'one', 'application/x-test', 'function']);
    expect(post).not.toBe(head);
    expect(head.method).toBe('HEAD'); // a route that lists GET also answers HEAD, and its handler sees the method
  });

  test('a handler typed with the shapes of the co-sign route is a handle with no wrapper, and the status and headers that it chooses are written as they are', async () => {
    expect(refusedByTypes.path).toBe('/x');
    await withRoutes([cosignRoute], async (base) => {
      const ok = await fetch(`${base}/cosign/delegate`, { method: 'POST', body: 'a body' });
      expect([ok.status, ok.headers.get('cache-control'), await ok.json()]).toStrictEqual([200, 'no-store', { transaction: 'a body' }]);
      const wrong = await fetch(`${base}/cosign/delegate`);
      expect([wrong.status, wrong.headers.get('allow'), await wrong.json()]).toStrictEqual([405, 'POST', { error: 'method_not_allowed' }]);
      const head = await fetch(`${base}/cosign/delegate`, { method: 'HEAD' });
      expect([head.status, head.headers.get('allow'), await head.text()]).toStrictEqual([405, 'POST', '']);
    });
  });

  test('a route that lists both methods answers both; a status that the handler chooses is written as it is, 200 to 599 whatever the class', async () => {
    const statuses = [200, 201, 202, 400, 404, 418, 500, 503, 599];
    const routes: OpenRoute[] = statuses.map((status) => ({ path: `/status/${status}`, methods: ['GET', 'POST'], handle: () => text(`status ${status}`, { status }) }));
    await withRoutes(routes, async (base) => {
      for (const status of statuses) {
        for (const method of ['GET', 'POST']) {
          const res = await fetch(`${base}/status/${status}`, { method, ...(method === 'POST' ? { body: 'x' } : {}) });
          expect([res.status, await res.text()], `${method} ${status}`).toStrictEqual([status, `status ${status}`]);
        }
      }
    });
  });
});

describe('what an open route does not answer', () => {
  test('a path that is not listed, and a method that is not listed, are 404 {error: not_found} and run no handler; the listed ones are the twins', async () => {
    let ran = 0;
    const counted = (route: OpenRoute): OpenRoute => ({ ...route, handle: (request) => { ran += 1; return route.handle(request); } });
    await withRoutes([counted(getRoute), counted(postRoute)], async (base) => {
      const misses: Array<[string, string]> = [
        ['GET', '/lots.jsonx'], ['GET', '/lots'], ['GET', '/lots.json/'], ['GET', '/LOTS.JSON'], ['GET', '//lots.json'], ['GET', '/%6cots.json'], ['GET', '/cosign'],
        ['POST', '/lots.json'], ['PUT', '/lots.json'], ['DELETE', '/lots.json'], ['GET', '/cosign/delegate'], ['HEAD', '/cosign/delegate'], ['PUT', '/cosign/delegate'],
      ];
      for (const [method, path] of misses) {
        const res = await fetch(`${base}${path}`, { method, headers: { authorization: TOKEN }, ...(method === 'POST' || method === 'PUT' ? { body: 'x' } : {}) });
        expect(res.status, `${method} ${path}`).toBe(404);
        if (method !== 'HEAD') expect(await res.json(), `${method} ${path}`).toStrictEqual({ error: 'not_found' });
      }
      expect(ran, 'no handler ran for a miss').toBe(0);
      expect((await fetch(`${base}/lots.json`)).status).toBe(200);
      expect((await fetch(`${base}/cosign/delegate`, { method: 'POST', body: 'x' })).status).toBe(200);
      expect(ran).toBe(2);
    });
  });

  test('a query on a POST is 404, as it is for POST /, and on a GET it is ignored', async () => {
    let ran = 0;
    const counted: OpenRoute = { path: '/both', methods: ['GET', 'POST'], handle: () => { ran += 1; return text('both'); } };
    await withRoutes([counted], async (base, port) => {
      for (const query of ['?x=1', '?']) {
        const post = await raw(port, 'POST', `/both${query}`, 'x');
        expect([statusOf(post), post.includes('{"error":"not_found"}')], `POST ${query}`).toStrictEqual([404, true]);
      }
      expect(ran).toBe(0);
      for (const [method, path] of [['POST', '/both'], ['GET', '/both'], ['GET', '/both?x=1'], ['GET', '/both?']] as const) {
        const res = await raw(port, method, path, method === 'POST' ? 'x' : '');
        expect([statusOf(res), res.endsWith('both')], `${method} ${path}`).toStrictEqual([200, true]);
      }
      expect(ran).toBe(4);
    });
  });

  test('a server with no openRoutes, or an empty list, answers every request as it did: the paths of the routes are 404 whatever the method and the token', async () => {
    const probes: Array<[string, string]> = [
      ['GET', '/cosign/delegate'], ['POST', '/cosign/delegate'], ['HEAD', '/cosign/delegate'], ['GET', '/lots.json'], ['PUT', '/lots.json'], ['GET', '/'], ['GET', '/precheck'],
      ['POST', '/agent.json'], ['POST', '/healthz'], ['POST', '/v1'],
    ];
    const answers = (over: Partial<JobServerOptions<Echo, Said>>) => serve(echoOptions(over), async (base) => {
      const out: Array<[string, string, number, string | null, string]> = [];
      for (const [method, path] of probes) {
        const res = await fetch(`${base}${path}`, { method, headers: { authorization: TOKEN }, ...(method === 'POST' || method === 'PUT' ? { body: 'x' } : {}) });
        out.push([method, path, res.status, res.headers.get('content-type'), await res.text()]);
      }
      return out;
    });
    const plain = await answers({});
    expect(await answers({ openRoutes: [] })).toStrictEqual(plain);
    for (const [method, path, status, type, body] of plain) expect([status, type, body], `${method} ${path}`).toStrictEqual([404, 'application/json', method === 'HEAD' ? '' : '{"error":"not_found"}']);
    // The twin: the same paths answer once the routes are given.
    await withRoutes([postRoute, getRoute], async (base) => {
      expect([(await fetch(`${base}/lots.json`)).status, (await fetch(`${base}/cosign/delegate`, { method: 'POST', body: 'x' })).status]).toStrictEqual([200, 200]);
    });
  });

  test('the four paths of the server win and keep their rules: the token for POST / and POST /precheck, and the answers of /healthz and /agent.json', async () => {
    await withRoutes([getRoute, postRoute], async (base) => {
      for (const path of ['/', '/precheck']) {
        for (const authorization of [null, 'Bearer wrong']) {
          const res = await call(base, path, wire({ say: 'x' }), contextHeaders(), authorization);
          expect([res.status, await res.json()], `${path} ${String(authorization)}`).toStrictEqual([401, { error: 'unauthorized' }]);
        }
      }
      // The twin: with the token, the pre-check goes and the job of that escrow runs.
      expect(await (await call(base, '/precheck', wire({ say: 'hi' }), contextHeaders())).json()).toStrictEqual({ go: true, reserved_ms: 120_000 });
      expect(await (await call(base, '/', wire({ say: 'hi' }), contextHeaders())).json()).toStrictEqual({ said: 'hi' });
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
      expect(await (await fetch(`${base}/agent.json`)).text()).toBe('{"name":"Test Agent"}');
    });
  });
});

describe('an open route and the job slot', () => {
  test('a job that holds the slot does not block an open route, and the slot is still held when the route has answered', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slot = new JobSlot();
    await withRoutes([getRoute, postRoute], async (base) => {
      const job = call(base, '/', wire({ say: 'held' }));
      await until(() => slot.busy, 'the job holds the slot');
      expect((await call(base, '/', wire({ say: 'second' }))).status, 'the twin: a second job is busy').toBe(409);
      expect((await fetch(`${base}/lots.json`)).status).toBe(200);
      expect((await fetch(`${base}/cosign/delegate`, { method: 'POST', body: 'x' })).status).toBe(200);
      expect(slot.busy, 'the route did not free the slot').toBe(true);
      release();
      expect(await (await job).json()).toStrictEqual({ said: 'held' });
    }, { slot, run: async (request) => { await gate; return { said: request.say }; } });
  });

  test('an open route takes no slot while it runs: a job takes the slot meanwhile, and a pre-check reserves it', async () => {
    let release = (): void => undefined;
    let entered = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: OpenRoute = { path: '/slow', methods: ['GET'], handle: async () => { entered = true; await gate; return text('slow'); } };
    const slot = new JobSlot();
    await withRoutes([slow], async (base) => {
      const waiting = fetch(`${base}/slow`);
      await until(() => entered, 'the handler has the request');
      expect([slot.busy, slot.canTake(ESCROW_X)]).toStrictEqual([false, 'free']);
      expect(await (await call(base, '/precheck', wire({ say: 'x' }), contextHeaders(ESCROW_X))).json()).toStrictEqual({ go: true, reserved_ms: 120_000 });
      expect(await (await call(base, '/', wire({ say: 'job' }), contextHeaders(ESCROW_X))).json()).toStrictEqual({ said: 'job' });
      release();
      expect(await (await waiting).text()).toBe('slow');
    }, { slot });
  });

  test('an open route runs no job and no pre-check, even for a call that looks like one, and it leaves a reservation as it was', async () => {
    const counts = { parse: 0, run: 0, precheck: 0 };
    const slot = new JobSlot();
    await withRoutes([cosignRoute, getRoute], async (base) => {
      expect(await (await call(base, '/precheck', wire({ say: 'x' }), contextHeaders(ESCROW_X))).json()).toStrictEqual({ go: true, reserved_ms: 120_000 });
      counts.parse = counts.precheck = 0;
      const looksLikeAJob = await call(base, '/cosign/delegate', wire({ say: 'x' }), { ...contextHeaders(ESCROW_Y), 'content-type': 'application/json' });
      expect([looksLikeAJob.status, (await looksLikeAJob.json() as { transaction: string }).transaction]).toStrictEqual([200, wire({ say: 'x' })]);
      expect((await fetch(`${base}/lots.json`, { headers: { authorization: TOKEN, ...contextHeaders(ESCROW_Y) } })).status).toBe(200);
      expect(counts).toStrictEqual({ parse: 0, run: 0, precheck: 0 });
      expect([slot.reservedFor(), slot.canTake(ESCROW_Y), slot.canTake(ESCROW_X)]).toStrictEqual([ESCROW_X, 'held', 'free']);
    }, {
      slot, parse: (json) => { counts.parse += 1; return JSON.parse(json) as Echo; }, run: async (request) => { counts.run += 1; return { said: request.say }; },
      precheck: () => { counts.precheck += 1; return { go: true }; },
    });
  });

  test('a stop refuses no open route and does not take the slot for one: it ends as finished with a route in flight, and logs no abandoned job', async () => {
    const slot = new JobSlot();
    const logs: string[] = [];
    let entered = false;
    const stuck: OpenRoute = { path: '/stuck', methods: ['GET'], handle: () => { entered = true; return new Promise<OpenReply>(() => undefined); } };
    const server = createJobServer(echoOptions({ slot, openRoutes: [getRoute, stuck], openRouteTimeoutMs: 30_000 }, logs));
    const { base } = await listening(server);
    try {
      const waiting = fetch(`${base}/stuck`).then((res) => res.status, () => 'cut');
      await until(() => entered, 'the handler has the request');
      slot.drain(); // the first step of a stop
      expect((await fetch(`${base}/lots.json`)).status, 'an open route is not refused').toBe(200);
      const job = await call(base, '/', wire({ say: 'late' }));
      expect([job.status, (await job.json() as { error: string }).error], 'the twin: a job is refused').toStrictEqual([503, 'shutting_down']);
      const started = Date.now();
      expect(await lifecycle({ server, slot, log: (line) => { logs.push(line); } }).shutdown(200)).toBe('finished');
      expect(Date.now() - started).toBeLessThan(3000);
      expect(logs.filter((line) => line.startsWith('stopping:'))).toStrictEqual([]);
      expect(await waiting, 'the route in flight is cut with the connections').toBe('cut');
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});

describe('the check of the list, at the start of the server', () => {
  const refused = (routes: unknown, path?: string): void => {
    let thrown: unknown;
    try { createJobServer(echoOptions({ openRoutes: routes as readonly OpenRoute[] })).close(); } catch (e) { thrown = e; }
    expect(thrown, 'the server is refused').toBeInstanceOf(RangeError);
    if (path !== undefined) expect((thrown as RangeError).message, 'the message names the path').toContain(path);
  };
  const accepted = (routes: unknown): void => { createJobServer(echoOptions({ openRoutes: routes as readonly OpenRoute[] })).close(); };
  const route = (path: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({ path, methods: ['GET'], handle: fine, ...over });

  test('the four paths of the server are refused, and each path next to them is accepted', () => {
    for (const reserved of ['/', '/precheck', '/healthz', '/agent.json']) refused([route(reserved)], reserved);
    refused([route('/lots.json'), route('/healthz')], '/healthz');
    for (const near of ['/precheck/x', '/healthz2', '/agent', '/agent.json5', '/health', '/Precheck']) accepted([route(near)]);
  });

  test('a path is refused for a missing slash, "..", "//", a query, "#", "%", a character that is not ASCII or not allowed, or more than 128 characters; the twins are accepted', () => {
    expect(MAX_OPEN_PATH).toBe(128);
    const bad = ['lots.json', '', '/a/../b', '/..', '/a//b', '//', '/a?x=1', '/a?', '/a#b', '/a%2e%2e/b', '/a%2F', '/a%2f', '/a b', '/\u00e9', '/a\u0000', '/a\nb', '/a\\b', '/a:b', `/${'a'.repeat(MAX_OPEN_PATH)}`];
    for (const path of bad) refused([route(path)], /^[\x20-\x7e]{0,64}$/.test(path) && !/["\\]/.test(path) ? path : undefined);
    const good = ['/a', '/a.b', '/a_b-c~d/e', '/A-Z0-9', '/a/', '/lots.json', '/cosign/delegate', '/.well-known/x', `/${'a'.repeat(MAX_OPEN_PATH - 1)}`];
    for (const path of good) accepted([route(path)]);
    for (const notText of [undefined, null, 5, ['/a'], {}]) refused([route(notText)]);
  });

  test('a path is given once: two entries of one path are refused even with other methods, and one entry that lists both methods is the twin', () => {
    refused([route('/a'), route('/a')], '/a');
    refused([route('/b'), route('/a'), route('/a', { methods: ['POST'] })], '/a');
    accepted([route('/a', { methods: ['GET', 'POST'] })]);
    accepted([route('/a'), route('/b')]);
  });

  test('the methods are GET, POST or both, each once; any other value, an empty list, and a list that is not an array are refused', () => {
    for (const methods of [[], ['PUT'], ['get'], ['HEAD'], ['DELETE'], ['GET', 'PUT'], ['GET', 'GET'], ['POST', 'POST'], 'GET', [1], [undefined], null, undefined, { 0: 'GET', length: 1 }]) refused([route('/a', { methods })], '/a');
    const holes: unknown[] = [];
    holes[1] = 'GET';
    refused([route('/a', { methods: holes })], '/a');
    for (const methods of [['GET'], ['POST'], ['GET', 'POST'], ['POST', 'GET']]) accepted([route('/a', { methods })]);
  });

  test('handle is a function: nothing else is accepted, and any kind of function is', () => {
    for (const handle of [undefined, null, 'x', 5, {}, [fine]]) refused([route('/a', { handle })], '/a');
    for (const handle of [fine, async () => text('x'), function plain() { return text('x'); }, fine.bind(null)]) accepted([route('/a', { handle })]);
  });

  test('a route is a plain object of its own members: a getter, a Proxy, an inherited member, a class instance and a missing member are refused and nothing of them is read', () => {
    let reads = 0;
    const getter = { path: '/a', methods: ['GET'], get handle() { reads += 1; return fine; } };
    const getterPath = { get path() { reads += 1; return '/a'; }, methods: ['GET'], handle: fine };
    const getterMethods = { path: '/a', get methods() { reads += 1; return ['GET']; }, handle: fine };
    const proxy = new Proxy(route('/a'), { get() { reads += 1; return undefined; }, getOwnPropertyDescriptor() { reads += 1; return undefined; }, getPrototypeOf() { reads += 1; return null; } });
    const proxiedList = new Proxy([route('/a')], { get() { reads += 1; return undefined; }, getOwnPropertyDescriptor() { reads += 1; return undefined; } });
    class Handler { path = '/a'; methods = ['GET']; handle() { return text('x'); } }
    const inherited = Object.create(route('/a')) as object;
    const holeInList: unknown[] = [];
    holeInList[1] = route('/a');
    const getterInList = Object.defineProperty([], '0', { get() { reads += 1; return route('/a'); }, enumerable: true });
    for (const bad of [[getter], [getterPath], [getterMethods], [proxy], proxiedList, [new Handler()], [inherited], holeInList, getterInList, [{ path: '/a', methods: ['GET'] }], [{ methods: ['GET'], handle: fine }], [null], [undefined], ['/a'], [[]]]) refused(bad);
    expect(reads, 'no getter and no trap ran').toBe(0);
    // The twins: a plain object, a frozen one, and one with no prototype, and a route with a member more.
    accepted([route('/a')]);
    accepted([Object.freeze(route('/a'))]);
    accepted([Object.assign(Object.create(null) as object, route('/a'))]);
    accepted([route('/a', { note: 'an extra member is no harm' })]);
  });

  test('openRoutes is an array: an object, a text, null, a number and a Set are refused, and an empty array and no option are accepted', () => {
    for (const notArray of [{}, 'x', null, 5, new Set([route('/a')]), { length: 0 }]) refused(notArray);
    accepted([]);
    accepted(undefined);
  });

  test('the server serves the list as it was at the start: a later change of the objects, of their arrays or of the list changes nothing', async () => {
    const live = { path: '/a', methods: ['GET'] as Array<'GET' | 'POST'>, handle: (): OpenReply => text('first') };
    const list: OpenRoute[] = [live];
    await serve(echoOptions({ openRoutes: list }), async (base) => {
      expect(await (await fetch(`${base}/a`)).text()).toBe('first');
      live.handle = () => text('second');
      live.methods.push('POST');
      live.path = '/healthz';
      list.push({ path: '/b', methods: ['GET'], handle: fine });
      expect(await (await fetch(`${base}/a`)).text()).toBe('first');
      expect((await fetch(`${base}/a`, { method: 'POST', body: 'x' })).status).toBe(404);
      expect((await fetch(`${base}/b`)).status).toBe(404);
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
    });
  });

  test('openRouteTimeoutMs is a whole number from 1 to the most of the kit, and a missing value is the most; null is refused', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, OPEN_ROUTE_TIMEOUT_MS + 1, '5', null, true]) {
      expect(() => createJobServer(echoOptions({ openRouteTimeoutMs: bad as number })), String(bad)).toThrow(RangeError);
    }
    for (const good of [1, 2, 1000, OPEN_ROUTE_TIMEOUT_MS, undefined]) createJobServer(echoOptions({ openRouteTimeoutMs: good })).close();
  });
});

describe('what goes wrong inside a handler', () => {
  const SECRET = 'the key was abc123\nsecond line';
  const failing = (name: string, handle: OpenRoute['handle']): OpenRoute => ({ path: `/${name}`, methods: ['GET', 'POST'], handle });
  const refusal = new Refused({ code: 'bad_shape', status: 400, message: 'say must be text', kind: 'request' });

  test('a handler that throws, rejects, throws something that is no error, or throws a value that cannot be read gives 500 {error: internal} with no detail, and the log holds the message', async () => {
    const routes = [
      failing('throws', () => { throw new Error(SECRET); }), failing('rejects', async () => { throw new Error(SECRET); }), failing('refusal', () => { throw refusal; }),
      failing('string', () => { throw 'a plain text abc123'; }), failing('poisoned', () => { throw Object.create(null); }), failing('fine', fine),
    ];
    await withRoutes(routes, async (base, _port, logs) => {
      for (const name of ['throws', 'rejects', 'refusal', 'string', 'poisoned']) {
        for (const method of ['GET', 'POST']) {
          const res = await fetch(`${base}/${name}`, { method, ...(method === 'POST' ? { body: 'x' } : {}) });
          expect([res.status, res.headers.get('content-type'), res.headers.get('connection'), await res.text()], `${method} ${name}`).toStrictEqual([500, 'application/json', 'close', '{"error":"internal"}']);
        }
      }
      const head = await fetch(`${base}/throws`, { method: 'HEAD' });
      expect([head.status, await head.text()], 'HEAD gets the status and no body').toStrictEqual([500, '']);
      const fineAnswer = await fetch(`${base}/fine`);
      expect([fineAnswer.status, await fineAnswer.text()], 'the twin').toStrictEqual([200, 'fine']);
      expect(logs.filter((line) => line.startsWith('open route /throws failed after '))).toHaveLength(3);
      expect(logs).toContainEqual(expect.stringMatching(/^open route \/throws failed after \d+ ms: the key was abc123 second line$/));
      expect(logs).toContainEqual(expect.stringMatching(/^open route \/rejects failed after \d+ ms: the key was abc123 second line$/));
      expect(logs).toContainEqual(expect.stringMatching(/^open route \/refusal failed after \d+ ms: say must be text$/));
      expect(logs).toContainEqual(expect.stringMatching(/^open route \/string failed after \d+ ms: a plain text abc123$/));
      expect(logs.filter((line) => line.startsWith('open route /poisoned failed after '))).toHaveLength(2);
      expect(logs.filter((line) => !line.startsWith('open route /')), 'no other line').toStrictEqual([]);
      expect(logs.every((line) => !line.includes('\n'))).toBe(true);
    });
  });

  test('the server logs neither the body nor the headers of an open route, of a call that works or of one that fails', async () => {
    const marked: OpenRoute[] = [
      { path: '/works', methods: ['POST'], handle: async (request) => { await bytesOf(request.body); return text('REPLY-BODY-MARK', { headers: { 'x-reply': 'REPLY-HEADER-MARK' } }); } },
      { path: '/fails', methods: ['POST'], handle: async (request) => { await bytesOf(request.body); throw new Error('the handler failed'); } },
      { path: '/malformed', methods: ['POST'], handle: async () => ({ status: 200, headers: { 'x-reply': 'REPLY-HEADER-MARK' }, body: 5 }) as unknown as OpenReply },
      { path: '/stuck', methods: ['POST'], handle: () => new Promise<OpenReply>(() => undefined) },
    ];
    await withRoutes(marked, async (base, _port, logs) => {
      for (const name of ['works', 'fails', 'malformed', 'stuck']) {
        const res = await fetch(`${base}/${name}`, { method: 'POST', body: 'REQUEST-BODY-MARK', headers: { 'x-request': 'REQUEST-HEADER-MARK', authorization: 'Bearer REQUEST-TOKEN-MARK' } });
        await res.text();
      }
      expect(logs.length, 'the three failures are logged').toBe(3);
      for (const mark of ['REQUEST-BODY-MARK', 'REQUEST-HEADER-MARK', 'REQUEST-TOKEN-MARK', 'REPLY-BODY-MARK', 'REPLY-HEADER-MARK', 'x-request', 'x-reply', 'authorization']) {
        expect(logs.join('\n'), mark).not.toContain(mark);
      }
    }, { openRouteTimeoutMs: 300 });
  });

  test('a handler that never answers gives 500 {error: internal} at the bound, and one that answers within it is the twin', async () => {
    const stuck: OpenRoute = { path: '/stuck', methods: ['GET'], handle: () => new Promise<OpenReply>(() => undefined) };
    const quick: OpenRoute = { path: '/quick', methods: ['GET'], handle: async () => { await pause(20); return text('quick'); } };
    await withRoutes([stuck, quick], async (base, _port, logs) => {
      expect([(await fetch(`${base}/quick`)).status, logs]).toStrictEqual([200, []]);
      const started = Date.now();
      const res = await fetch(`${base}/stuck`);
      expect([res.status, await res.text()]).toStrictEqual([500, '{"error":"internal"}']);
      expect(Date.now() - started, 'the answer waits for the bound').toBeGreaterThanOrEqual(450);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^open route \/stuck failed after \d+ ms: no answer within 500 ms$/);
    }, { openRouteTimeoutMs: 500 });
  });

  test('a handler that is late is not stopped, and its late answer or failure is never written, logged or left unhandled: the reply is written once', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finished: string[] = [];
    const late = (name: string, end: () => OpenReply): OpenRoute => ({ path: `/${name}`, methods: ['GET'], handle: async () => { await gate; finished.push(name); return end(); } });
    const routes = [late('answers', () => text('too late')), late('fails', () => { throw new Error('too late'); })];
    await withRoutes(routes, async (base, _port, logs) => {
      const answers = await fetch(`${base}/answers`);
      const fails = await fetch(`${base}/fails`);
      expect([answers.status, await answers.text(), fails.status, await fails.text()]).toStrictEqual([500, '{"error":"internal"}', 500, '{"error":"internal"}']);
      release();
      await until(() => finished.length === 2, 'both handlers have ended');
      await pause(50);
      expect(logs, 'one line for each request, none for the late end').toHaveLength(2);
      expect((await fetch(`${base}/healthz`)).status, 'the server goes on').toBe(200);
    }, { openRouteTimeoutMs: 50 });
  });

  test('the bound is OPEN_ROUTE_TIMEOUT_MS unless the option gives another', async () => {
    expect(OPEN_ROUTE_TIMEOUT_MS).toBe(60_000);
    const delays = vi.spyOn(globalThis, 'setTimeout');
    try {
      await withRoutes([getRoute], async (base) => { await (await fetch(`${base}/lots.json`)).text(); });
      const byDefault = delays.mock.calls.map((callArgs) => callArgs[1]);
      delays.mockClear();
      await withRoutes([getRoute], async (base) => { await (await fetch(`${base}/lots.json`)).text(); }, { openRouteTimeoutMs: 1234 });
      const chosen = delays.mock.calls.map((callArgs) => callArgs[1]);
      expect([byDefault.includes(OPEN_ROUTE_TIMEOUT_MS), chosen.includes(OPEN_ROUTE_TIMEOUT_MS), chosen.includes(1234)]).toStrictEqual([true, false, true]);
    } finally {
      delays.mockRestore();
    }
  });

  test('a reply of another shape is 500 {error: internal}, with a line in the log that names the fault and shows no value; each right shape is the twin', async () => {
    const BAD: Array<[string, unknown]> = [
      ['no reply', undefined], ['null', null], ['a text', 'ok'], ['an array', [200]],
      ['status 99', { status: 99, headers: {}, body: '' }], ['status 100', { status: 100, headers: {}, body: '' }], ['status 101', { status: 101, headers: {}, body: '' }], ['status 199', { status: 199, headers: {}, body: '' }],
      ['status 600', { status: 600, headers: {}, body: '' }], ['status 200.5', { status: 200.5, headers: {}, body: '' }], ['status as a text', { status: '200', headers: {}, body: '' }],
      ['status NaN', { status: Number.NaN, headers: {}, body: '' }], ['no status', { headers: {}, body: '' }],
      ['no body', { status: 200, headers: {} }], ['a body that is a number', { status: 200, headers: {}, body: 5 }], ['a body that is a buffer', { status: 200, headers: {}, body: Buffer.from('x') }],
      ['no headers', { status: 200, body: '' }], ['headers null', { status: 200, headers: null, body: '' }], ['headers as an array', { status: 200, headers: [], body: '' }], ['headers as a text', { status: 200, headers: 'x', body: '' }],
      ['a header value that is a number', { status: 200, headers: { 'x-n': 1 }, body: '' }], ['a header value that is an array', { status: 200, headers: { 'x-a': ['a', 'b'] }, body: '' }],
      ['a header name with a space', { status: 200, headers: { 'bad name': 'x' }, body: '' }], ['an empty header name', { status: 200, headers: { '': 'x' }, body: '' }],
      ['a header value with a line break', { status: 200, headers: { 'x-a': 'a\r\nx-injected: 1' }, body: '' }],
    ];
    const routes: OpenRoute[] = BAD.map(([, reply], index) => ({ path: `/bad/${index}`, methods: ['GET'], handle: () => reply as OpenReply }));
    routes.push({ path: '/good', methods: ['GET'], handle: () => ({ status: 200, headers: { 'x-ok': 'yes' }, body: 'good' }) });
    await withRoutes(routes, async (base, _port, logs) => {
      for (const [index, [name]] of BAD.entries()) {
        const res = await fetch(`${base}/bad/${index}`);
        expect([res.status, await res.text()], name).toStrictEqual([500, '{"error":"internal"}']);
      }
      const good = await fetch(`${base}/good`);
      expect([good.status, good.headers.get('x-ok'), await good.text()]).toStrictEqual([200, 'yes', 'good']);
      expect(logs).toHaveLength(BAD.length);
      logs.forEach((line, index) => expect(line, `line ${index}`).toMatch(new RegExp(`^open route /bad/${index} failed after \\d+ ms: (?:the (?:reply|status|body|headers)|a header) `)));
      expect(logs.join('\n')).not.toMatch(/injected|bad name/);
    });
  });

  test('the server sets content-length and ignores the one of the handler, in any letter case, and the transfer-encoding of the handler: the answer has one length and is the whole body', async () => {
    const framing: OpenRoute = {
      path: '/framing', methods: ['GET'],
      handle: () => text(LOTS_TEXT, { headers: { 'Content-Length': '999', 'content-length': '1', 'CONTENT-LENGTH': '3', 'Transfer-Encoding': 'chunked', 'content-type': 'application/json' } }),
    };
    await withRoutes([framing], async (base, port) => {
      const res = await fetch(`${base}/framing`);
      expect([res.status, res.headers.get('content-length'), await res.text()]).toStrictEqual([200, String(Buffer.byteLength(LOTS_TEXT)), LOTS_TEXT]);
      const head = (await raw(port, 'GET', '/framing')).split('\r\n\r\n')[0].split('\r\n');
      expect(head.filter((line) => /^content-length:/i.test(line)).map((line) => line.toLowerCase())).toStrictEqual([`content-length: ${Buffer.byteLength(LOTS_TEXT)}`]);
      expect(head.filter((line) => /^transfer-encoding:/i.test(line))).toStrictEqual([]);
      expect(head.filter((line) => /^content-type:/i.test(line))).toStrictEqual(['content-type: application/json']);
    });
  });
});

describe('the package exports', () => {
  test('a service imports the bound and the server from the package', () => {
    expect(Object.keys(kit)).toEqual(expect.arrayContaining(['OPEN_ROUTE_TIMEOUT_MS', 'createJobServer']));
    expect(kit.OPEN_ROUTE_TIMEOUT_MS).toBe(OPEN_ROUTE_TIMEOUT_MS);
  });
});
