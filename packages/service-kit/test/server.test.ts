// packages/service-kit/test/server.test.ts
// The HTTP surface on a job of its own: an echo that can wait, refuse and fail. The Pipeline's suite (agents/document-pipeline/test/server.test.ts) runs the
// same surface under its own manifest and pipeline; these tests hold the seams it does not use.
import { describe, test, expect } from 'vitest';
import { connect } from 'node:net';
import { HealthMonitor } from '../src/health.ts';
import { HEARTBEAT_MS, STOPPING_TEXT, createJobServer, operatorsText } from '../src/server.ts';
import type { JobServerOptions, Refusal } from '../src/server.ts';
import { JobSlot } from '../src/slot.ts';
import { MAX_BODY } from '../src/wire.ts';
import { TOKEN, close, listening, pause, until, wire } from './support.ts';

const MANIFEST = '{"name":"Test Agent","note":"the bytes the advert hashes"}';
interface Echo { say: string; waitMs?: number; fail?: Refusal; boom?: boolean }
type Said = { said: string };
class Refused extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }

function options(over: Partial<JobServerOptions<Echo, Said>> = {}, logs: string[] = []): JobServerOptions<Echo, Said> {
  return {
    manifestText: MANIFEST, authHeader: TOKEN, clock: Date.now, log: (line) => { logs.push(line); },
    parse: (json) => {
      const value = JSON.parse(json) as Echo;
      if (typeof value.say !== 'string') throw new Refused({ code: 'bad_shape', status: 400, message: 'say must be text', kind: 'request' });
      return value;
    },
    run: async (request) => {
      if (request.waitMs !== undefined) await pause(request.waitMs);
      if (request.fail !== undefined) throw new Refused(request.fail);
      if (request.boom === true) throw new Error('a failure\nwith a second line');
      return { said: request.say };
    },
    refusalOf: (e) => (e instanceof Refused ? e.refusal : null),
    ...over,
  };
}
async function serve<T>(opts: JobServerOptions<Echo, Said>, fn: (base: string, port: number) => Promise<T>): Promise<T> {
  const server = createJobServer(opts);
  const { base, port } = await listening(server);
  try { return await fn(base, port); } finally { close(server); }
}
const post = (base: string, body: string, authorization: string | null = TOKEN) =>
  fetch(`${base}/`, { method: 'POST', body, headers: authorization === null ? {} : { authorization } });
/** One POST over a socket of its own with Connection: close, and everything the server wrote, interim lines included. */
function rawPost(port: number, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.write(['POST / HTTP/1.1', 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, `Authorization: ${TOKEN}`, 'Connection: close', '', ''].join('\r\n') + body);
  });
}

describe('createJobServer', () => {
  test('a job: 200 with the bytes serialize writes, as application/json, and the done hook with the arrival', async () => {
    const seen: Array<[string, string]> = [];
    const opts = options({ serialize: (r) => `{"said":${JSON.stringify(r.said)},"by":"serialize"}`, done: (r, at) => { seen.push([r.said, typeof at]); } });
    await serve(opts, async (base) => {
      const res = await post(base, wire({ say: 'hello' }));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.text()).toBe('{"said":"hello","by":"serialize"}');
    });
    expect(seen).toStrictEqual([['hello', 'number']]);
  });

  test('without serialize the body is JSON.stringify of the result, and without done the line is "job done in <ms> ms"', async () => {
    const logs: string[] = [];
    await serve(options({}, logs), async (base) => {
      expect(await (await post(base, wire({ say: 'hi' }))).text()).toBe('{"said":"hi"}');
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^job done in \d+ ms$/);
  });

  test('GET /healthz is {ok:true} without a check; with a check that fails it is 503 {ok:false, reason} once the check has answered, and HEAD has the headers only', async () => {
    await serve(options(), async (base) => {
      const res = await fetch(`${base}/healthz?x=1`);
      expect([res.status, await res.json()]).toStrictEqual([200, { ok: true }]);
    });
    const health = new HealthMonitor({ check: async () => { throw new Error('the disk is full'); }, reason: 'low_disk', clock: Date.now, ttlMs: 60_000, timeoutMs: 1000 });
    await serve(options({ health }), async (base) => {
      await until(() => !health.healthy, 'the first check, made at start, has answered');
      const res = await fetch(`${base}/healthz`);
      expect([res.status, await res.json()]).toStrictEqual([503, { ok: false, reason: 'low_disk' }]);
      const head = await fetch(`${base}/healthz`, { method: 'HEAD' });
      expect([head.status, await head.text(), head.headers.get('content-length')]).toStrictEqual([503, '', String('{"ok":false,"reason":"low_disk"}'.length)]);
    });
  });

  test('GET /agent.json serves the manifest text as it was given, whatever the query; HEAD gets the same headers and no body', async () => {
    await serve(options(), async (base) => {
      for (const path of ['/agent.json', '/agent.json?v=2']) expect(await (await fetch(`${base}${path}`)).text()).toBe(MANIFEST);
      const head = await fetch(`${base}/agent.json`, { method: 'HEAD' });
      expect([head.status, await head.text(), head.headers.get('content-length')]).toStrictEqual([200, '', String(Buffer.byteLength(MANIFEST))]);
    });
  });

  test('every other route is 404 {error: not_found}, a POST / with a query among them', async () => {
    await serve(options(), async (base) => {
      for (const [method, path] of [['GET', '/'], ['POST', '/v1/job'], ['POST', '/?x=1'], ['PUT', '/'], ['DELETE', '/agent.json']]) {
        const res = await fetch(`${base}${path}`, { method, headers: { authorization: TOKEN }, body: method === 'GET' || method === 'DELETE' ? undefined : wire({ say: 'x' }) });
        expect([res.status, await res.json()], `${method} ${path}`).toStrictEqual([404, { error: 'not_found' }]);
      }
    });
  });

  test('POST / without the token, or with another, is 401 {error: unauthorized} with the connection closed and nothing run; the refusals are counted in one line a minute at most', async () => {
    let now = 1_000_000;
    let runs = 0;
    const logs: string[] = [];
    await serve(options({ clock: () => now, run: async (r) => { runs += 1; return { said: r.say }; } }, logs), async (base) => {
      for (const authorization of [null, 'Bearer wrong', TOKEN.toUpperCase(), `${TOKEN}x`, '']) {
        const res = await post(base, wire({ say: 'x' }), authorization);
        expect([res.status, await res.json(), res.headers.get('connection')]).toStrictEqual([401, { error: 'unauthorized' }, 'close']);
      }
      now += 60_000;
      await post(base, wire({ say: 'x' }), null);
    });
    expect(runs).toBe(0);
    expect(logs).toStrictEqual(['request refused: unauthorized (1 since the last line of this kind)', 'request refused: unauthorized (5 since the last line of this kind)']);
    expect(logs.join('\n')).not.toContain(TOKEN.slice('Bearer '.length));
  });

  test('a body that is not the wire message is 400 bad_wire, one over MAX_BODY bytes is 400 request_too_large, and both are logged as refused requests', async () => {
    const logs: string[] = [];
    await serve(options({}, logs), async (base) => {
      const bad = await post(base, 'not the wire message');
      expect([bad.status, (await bad.json()).error, bad.headers.get('connection')]).toStrictEqual([400, 'bad_wire', 'close']);
      const big = await post(base, 'x'.repeat(MAX_BODY + 1));
      expect([big.status, (await big.json()).error]).toStrictEqual([400, 'request_too_large']);
    });
    expect(logs.map((l) => l.replace(/\d+ ms/, 'N ms'))).toStrictEqual(['request refused after N ms: bad_wire (400)', 'request refused after N ms: request_too_large (400)']);
  });

  test('refusalOf decides: a refused request and a failed job keep their message; a 5xx tells the buyer only the code and where the detail is, and logs the whole message', async () => {
    const logs: string[] = [];
    await serve(options({}, logs), async (base) => {
      const shape = await post(base, wire({}));
      expect([shape.status, await shape.json()]).toStrictEqual([400, { error: 'bad_shape', message: 'say must be text' }]);
      const job = await post(base, wire({ say: 'x', fail: { code: 'deadline', status: 422, message: 'The deadline came.', kind: 'job' } }));
      expect([job.status, await job.json()]).toStrictEqual([422, { error: 'deadline', message: 'The deadline came.' }]);
      const side = await post(base, wire({ say: 'x', fail: { code: 'asr_failed', status: 500, message: 'the model at /app/asr/models/base failed', kind: 'job' } }));
      expect([side.status, await side.json()]).toStrictEqual([500, { error: 'asr_failed', message: operatorsText('asr_failed') }]);
    });
    expect(operatorsText('asr_failed')).toBe("The service could not do this job (asr_failed). The operator's log has the detail.");
    expect(logs.map((l) => l.replace(/\d+ ms/, 'N ms'))).toStrictEqual([
      'request refused after N ms: bad_shape (400)', 'job failed after N ms: deadline (422)', 'job failed after N ms: asr_failed (500): the model at /app/asr/models/base failed',
    ]);
  });

  test('anything else is 500 {error: internal} with no detail, logged by its message on one line; a result that cannot be serialised is the same', async () => {
    const logs: string[] = [];
    await serve(options({}, logs), async (base) => {
      const res = await post(base, wire({ say: 'x', boom: true }));
      expect([res.status, await res.json()]).toStrictEqual([500, { error: 'internal' }]);
    });
    await serve(options({ serialize: () => { throw new TypeError('Do not know how to serialize a BigInt'); } }, logs), async (base) => {
      expect((await post(base, wire({ say: 'x' }))).status).toBe(500);
    });
    expect(logs.map((l) => l.replace(/\d+ ms/, 'N ms'))).toStrictEqual(['job failed after N ms: internal error: a failure with a second line', 'job failed after N ms: internal error: Do not know how to serialize a BigInt']);
  });

  test('one job at a time: a second one is 409 busy and runs nothing; a slot that is draining gives 503 shutting_down with the fixed text', async () => {
    const slot = new JobSlot();
    await serve(options({ slot }), async (base) => {
      const first = post(base, wire({ say: 'first', waitMs: 200 }));
      await until(() => slot.busy, 'the first job holds the slot');
      const second = await post(base, wire({ say: 'second' }));
      expect([second.status, await second.json()]).toStrictEqual([409, { error: 'busy' }]);
      expect(await (await first).json()).toStrictEqual({ said: 'first' });
      slot.drain();
      const late = await post(base, wire({ say: 'late' }));
      expect([late.status, await late.json()]).toStrictEqual([503, { error: 'shutting_down', message: STOPPING_TEXT }]);
    });
    expect(STOPPING_TEXT).toBe('The service is stopping and takes no new job. Try again shortly.');
  });

  test('while a job runs, an HTTP/1.1 client is written "102 Processing" every heartbeatMs, then the same 200', async () => {
    await serve(options({ heartbeatMs: 40 }), async (_base, port) => {
      const text = await rawPost(port, wire({ say: 'slow', waitMs: 200 }));
      const interim = text.split('HTTP/1.1 102 Processing\r\n\r\n');
      expect(interim.length - 1).toBeGreaterThanOrEqual(2);
      expect(interim.at(-1)).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
      expect(interim.at(-1)).toContain('{"said":"slow"}');
    });
  });

  test('heartbeatMs must be more than 0 and at most HEARTBEAT_MS, and a server is never made without a token', () => {
    expect(HEARTBEAT_MS).toBe(60_000);
    for (const bad of [0, -1, Number.NaN, 60_001]) expect(() => createJobServer(options({ heartbeatMs: bad })), String(bad)).toThrow(RangeError);
    for (const bad of ['', undefined as unknown as string]) expect(() => createJobServer(options({ authHeader: bad }))).toThrow(RangeError);
    createJobServer(options({ heartbeatMs: 1 })).close();
  });
});
