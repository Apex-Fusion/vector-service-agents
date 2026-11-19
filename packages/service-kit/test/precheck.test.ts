// packages/service-kit/test/precheck.test.ts
// POST /precheck: the question the runtime asks before it claims an escrow. A go reserves the job slot for the escrow of the call; the job call of that escrow
// takes the reservation. The clock of the server is set by hand where the time matters.
import { describe, test, expect } from 'vitest';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { Server } from 'node:http';
import type { JobContext } from '../src/context.ts';
import { BUSY_TEXT, STOPPING_TEXT, operatorsText } from '../src/server.ts';
import type { PrecheckAnswer } from '../src/server.ts';
import { JobSlot, RESERVATION_MS } from '../src/slot.ts';
import { MAX_BODY } from '../src/wire.ts';
import { ESCROW_X, ESCROW_Y, TOKEN, Refused, call, contextHeaders, contextOf, echoOptions, pause, serve, until, wire } from './support.ts';
import type { Echo } from './support.ts';

const T = 1_700_000_000_000;
const GO: PrecheckAnswer = { go: true };

const precheck = (base: string, body: string = wire({ say: 'hi' }), headers: Record<string, string> = contextHeaders(), authorization: string | null = TOKEN) =>
  call(base, '/precheck', body, headers, authorization);
const job = (base: string, say: string, headers: Record<string, string> = contextHeaders()) => call(base, '/', wire({ say }), headers);
/** A promise that the test settles by hand: what an option or a job waits on, so that the test decides when it answers. */
interface Gate { wait: Promise<void>; open: () => void }
const gate = (): Gate => {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open: () => open() };
};
const json = async (res: Response): Promise<unknown> => res.json();
const lines = (logs: string[]): string[] => logs.map((line) => line.replace(/\d+ ms/, 'N ms'));

/** One POST /precheck over a socket of its own, left open: a caller that can hang up by destroying the socket. */
function openPrecheck(port: number, body: string, headers: Record<string, string>): Socket {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  const head = ['POST /precheck HTTP/1.1', 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, `Authorization: ${TOKEN}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', ''];
  socket.write(head.join('\r\n') + body);
  return socket;
}
const connectionCount = (server: Server): Promise<number> => new Promise((resolve, reject) => { server.getConnections((err, n) => { if (err) reject(err); else resolve(n); }); });
/** Resolves once the server has seen `count` connections end since `before`, and its close events have been delivered. */
async function connectionsEnded(server: Server, before: number, count = 1): Promise<void> {
  const end = Date.now() + 3000;
  while ((await connectionCount(server)) > before - count) {
    if (Date.now() > end) throw new Error('gave up waiting until the connection ended');
    await pause(5);
  }
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe('POST /precheck: the answers', () => {
  test('without an option a pre-check that passes the checks of the kit is a go: 200 {go: true, reserved_ms: 120000}, and the slot is reserved for its escrow, not busy, with no job run', async () => {
    const slot = new JobSlot();
    const logs: string[] = [];
    let runs = 0;
    await serve(echoOptions({ slot, clock: () => T, run: async (r) => { runs += 1; return { said: r.say }; } }, logs), async (base) => {
      const res = await precheck(base);
      expect([res.status, res.headers.get('content-type'), await res.json()]).toStrictEqual([200, 'application/json', { go: true, reserved_ms: 120_000 }]);
      expect(slot.reservedFor(T)).toBe(ESCROW_X);
      expect([slot.busy, runs]).toStrictEqual([false, 0]);
    });
    expect(RESERVATION_MS).toBe(120_000);
    expect(lines(logs)).toStrictEqual([`pre-check go for ${ESCROW_X} after N ms: the slot is reserved for 120000 ms`]);
  });

  test('the option is given the request, parsed, and the context of the call; its go is the answer, and the slot is reserved', async () => {
    const slot = new JobSlot();
    const given: Array<[Echo, JobContext]> = [];
    await serve(echoOptions({ slot, clock: () => T, precheck: (request, context) => { given.push([request, context]); return GO; } }), async (base) => {
      const res = await precheck(base, wire({ say: 'check this' }), contextHeaders(ESCROW_Y));
      expect([res.status, await res.json()]).toStrictEqual([200, { go: true, reserved_ms: 120_000 }]);
      expect(slot.reservedFor(T)).toBe(ESCROW_Y);
    });
    expect(given).toStrictEqual([[{ say: 'check this' }, contextOf(ESCROW_Y)]]);
  });

  test('an option may answer in time: a promise gives the same answer as a value', async () => {
    await serve(echoOptions({ precheck: async () => { await pause(10); return GO; } }), async (base) => {
      expect((await precheck(base)).status).toBe(200);
    });
  });

  test('a refusal of the option is its status and {error, message}, logged as a refused request, and reserves nothing; the go of the same option is the twin', async () => {
    const REFUSALS = [
      { status: 400, error: 'bad_input', message: 'The input is not usable.' }, { status: 402, error: 'underpaid', message: 'The payment is below the price.' },
      { status: 409, error: 'unavailable', message: 'The model is not loaded.' }, { status: 422, error: 'unsupported', message: 'The service cannot do this job.' },
      { status: 499, error: 'custom', message: 'A custom refusal.' },
    ];
    for (const refusal of REFUSALS) {
      const slot = new JobSlot();
      const logs: string[] = [];
      let refuse = true;
      await serve(echoOptions({ slot, clock: () => T, precheck: () => (refuse ? { go: false, ...refusal } : GO) }, logs), async (base) => {
        const res = await precheck(base);
        expect([res.status, await json(res)], refusal.error).toStrictEqual([refusal.status, { error: refusal.error, message: refusal.message }]);
        expect(slot.reservedFor(T), `${refusal.error}: nothing is reserved`).toBeUndefined();
        expect((await job(base, 'other', contextHeaders(ESCROW_Y))).status, 'the slot is free for another escrow').toBe(200);
        refuse = false;
        expect((await precheck(base)).status, 'the twin').toBe(200);
      });
      expect(lines(logs)[0], refusal.error).toBe(`request refused after N ms: ${refusal.error} (${refusal.status})`);
    }
  });

  test('a refusal with a status of 500 or more gets the fixed text for the buyer and is logged whole, as a failure of a job is; 400 and 599 are the edges that count as refusals', async () => {
    const logs: string[] = [];
    const refusal = { go: false, status: 503, error: 'provider_down', message: 'the model at /srv/models/base is down' } as const;
    await serve(echoOptions({ precheck: () => refusal }, logs), async (base) => {
      const res = await precheck(base);
      expect([res.status, await json(res)]).toStrictEqual([503, { error: 'provider_down', message: operatorsText('provider_down') }]);
    });
    expect(lines(logs)).toStrictEqual(['job failed after N ms: provider_down (503): the model at /srv/models/base is down']);
    for (const status of [400, 599]) {
      await serve(echoOptions({ precheck: () => ({ go: false, status, error: 'edge', message: 'An edge.' }) }), async (base) => {
        expect((await precheck(base)).status).toBe(status);
      });
    }
  });

  test('an answer that is neither a go nor a refusal is never a go: 500 internal, nothing reserved, the cause in the log', async () => {
    const WRONG: unknown[] = [
      undefined, null, 'go', true, 1, {}, { go: 'yes' }, { go: 1 }, { go: false }, { ok: true },
      { go: false, status: 200, error: 'x', message: 'y' }, { go: false, status: 302, error: 'x', message: 'y' }, { go: false, status: 399, error: 'x', message: 'y' },
      { go: false, status: 600, error: 'x', message: 'y' }, { go: false, status: 422.5, error: 'x', message: 'y' }, { go: false, status: '422', error: 'x', message: 'y' },
      { go: false, status: 422, error: '', message: 'y' }, { go: false, status: 422, error: 'x' }, { go: false, status: 422, error: 7, message: 'y' }, { go: false, status: 422, error: 'x', message: 8 },
    ];
    for (const answer of WRONG) {
      const slot = new JobSlot();
      const logs: string[] = [];
      await serve(echoOptions({ slot, clock: () => T, precheck: () => answer as PrecheckAnswer }, logs), async (base) => {
        const res = await precheck(base);
        expect([res.status, await json(res)], JSON.stringify(answer)).toStrictEqual([500, { error: 'internal' }]);
        expect(slot.reservedFor(T), JSON.stringify(answer)).toBeUndefined();
      });
      expect(lines(logs), JSON.stringify(answer)).toStrictEqual(['job failed after N ms: internal error: the precheck option must answer { go: true } or { go: false, status, error, message } with a status from 400 to 599']);
    }
  });

  test('an error that the option throws is read by refusalOf as any other: a refusal keeps its status and words, anything else is 500 internal; neither reserves the slot', async () => {
    for (const make of [(refusal: Refused) => (): never => { throw refusal; }, (refusal: Refused) => async (): Promise<PrecheckAnswer> => { throw refusal; }]) {
      const slot = new JobSlot();
      await serve(echoOptions({ slot, clock: () => T, precheck: make(new Refused({ code: 'unsupported', status: 422, message: 'The service cannot do this job.', kind: 'request' })) }), async (base) => {
        const res = await precheck(base);
        expect([res.status, await json(res)]).toStrictEqual([422, { error: 'unsupported', message: 'The service cannot do this job.' }]);
        expect(slot.reservedFor(T)).toBeUndefined();
      });
    }
    const logs: string[] = [];
    const slot = new JobSlot();
    await serve(echoOptions({ slot, clock: () => T, precheck: async () => { throw new Error('the provider\nanswered 500'); } }, logs), async (base) => {
      const res = await precheck(base);
      expect([res.status, await json(res)]).toStrictEqual([500, { error: 'internal' }]);
      expect(slot.reservedFor(T)).toBeUndefined();
    });
    expect(lines(logs)).toStrictEqual(['job failed after N ms: internal error: the provider answered 500']);
  });

  test('a refusal that refusalOf reads with a status that is no refusal is not a go either: 500 internal for 200, 302, 399 and 600, the status 400 is the twin', async () => {
    for (const status of [200, 302, 399, 600]) {
      const slot = new JobSlot();
      await serve(echoOptions({ slot, clock: () => T, precheck: () => { throw new Refused({ code: 'odd', status, message: 'An odd status.', kind: 'request' }); } }), async (base) => {
        const res = await precheck(base);
        expect([res.status, await json(res)], String(status)).toStrictEqual([500, { error: 'internal' }]);
        expect(slot.reservedFor(T), String(status)).toBeUndefined();
      });
    }
    await serve(echoOptions({ precheck: () => { throw new Refused({ code: 'odd', status: 400, message: 'An odd status.', kind: 'request' }); } }), async (base) => {
      expect((await precheck(base)).status).toBe(400);
    });
  });

  test('the request is parsed before the option: a request the intake refuses, a body that is not the wire message and one that is too large are refused, and the option is not asked; a good request is the twin', async () => {
    let asked = 0;
    const logs: string[] = [];
    await serve(echoOptions({ precheck: () => { asked += 1; return GO; } }, logs), async (base) => {
      const shape = await precheck(base, wire({ nothing: 1 }));
      expect([shape.status, await json(shape)]).toStrictEqual([400, { error: 'bad_shape', message: 'say must be text' }]);
      const bad = await precheck(base, 'not the wire message');
      expect([bad.status, (await bad.json() as { error: string }).error]).toStrictEqual([400, 'bad_wire']);
      const big = await precheck(base, 'x'.repeat(MAX_BODY + 1));
      expect([big.status, (await big.json() as { error: string }).error]).toStrictEqual([400, 'request_too_large']);
      expect(asked).toBe(0);
      expect((await precheck(base)).status).toBe(200);
      expect(asked).toBe(1);
    });
    expect(lines(logs).slice(0, 3)).toStrictEqual(['request refused after N ms: bad_shape (400)', 'request refused after N ms: bad_wire (400)', 'request refused after N ms: request_too_large (400)']);
  });
});

describe('POST /precheck: the context headers', () => {
  test('a pre-check with no context header is 400 bad_context that lists the six, and the option is not asked; the six are the twin', async () => {
    let asked = 0;
    await serve(echoOptions({ precheck: () => { asked += 1; return GO; } }), async (base) => {
      const res = await precheck(base, wire({ say: 'hi' }), {});
      const body = await res.json() as { error: string; message: string };
      expect([res.status, body.error, res.headers.get('connection')]).toStrictEqual([400, 'bad_context', 'close']);
      for (const name of Object.keys(contextHeaders())) expect(body.message).toContain(name);
      expect(asked).toBe(0);
      expect((await precheck(base)).status).toBe(200);
      expect(asked).toBe(1);
    });
  });

  test('some of the six headers, or one in a bad form, is 400 bad_context that names the header, before the body is read; the six right headers are the twin', async () => {
    let asked = 0;
    const slot = new JobSlot();
    await serve(echoOptions({ slot, clock: () => T, precheck: () => { asked += 1; return GO; } }), async (base) => {
      for (const name of Object.keys(contextHeaders())) {
        const headers = contextHeaders();
        delete headers[name];
        const res = await precheck(base, 'not the wire message', headers);
        expect([res.status, await json(res)], name).toStrictEqual([400, { error: 'bad_context', message: `the context headers come all together, and ${name} is missing` }]);
      }
      for (const [name, value] of [['x-vector-escrow-ref', 'nonsense'], ['x-vector-payment-lovelace', '1.5'], ['x-vector-advert-model', '']] as const) {
        const res = await precheck(base, 'not the wire message', { ...contextHeaders(), [name]: value });
        const body = await res.json() as { error: string; message: string };
        expect([res.status, body.error, body.message.startsWith(`the header ${name} must be`)], name).toStrictEqual([400, 'bad_context', true]);
      }
      expect([asked, slot.reservedFor(T)]).toStrictEqual([0, undefined]);
      // The right headers with the same body: the body is what is refused then.
      expect((await (await precheck(base, 'not the wire message')).json() as { error: string }).error).toBe('bad_wire');
    });
  });
});

describe('POST /precheck: who may ask, and which route it is', () => {
  test('a pre-check without the token, or with another, is 401 {error: unauthorized} with the connection closed; the option is not asked, a busy slot is not given away, and the count of refusals is the job route\'s', async () => {
    let now = T;
    let asked = 0;
    const logs: string[] = [];
    const slot = new JobSlot();
    const held = gate();
    await serve(echoOptions({ slot, clock: () => now, precheck: () => { asked += 1; return GO; }, run: async (r) => { await held.wait; return { said: r.say }; } }, logs), async (base) => {
      const busy = job(base, 'hold');
      await until(() => slot.busy, 'a job holds the slot');
      for (const authorization of [null, 'Bearer wrong', TOKEN.toUpperCase(), `${TOKEN}x`, '']) {
        const res = await precheck(base, wire({ say: 'x' }), contextHeaders(), authorization);
        expect([res.status, await json(res), res.headers.get('connection')], String(authorization)).toStrictEqual([401, { error: 'unauthorized' }, 'close']);
      }
      expect(asked).toBe(0);
      // A bad context with no token is 401 too: the token comes first.
      expect((await precheck(base, wire({ say: 'x' }), {}, null)).status).toBe(401);
      // The job route refuses a call with no token in the same count, and the line is written when a minute has gone.
      expect((await call(base, '/', wire({ say: 'x' }), contextHeaders(), null)).status).toBe(401);
      now += 60_000;
      expect((await precheck(base, wire({ say: 'x' }), contextHeaders(), null)).status).toBe(401);
      held.open();
      expect((await busy).status).toBe(200);
      // The twin: the token, and the slot that is free now.
      expect((await precheck(base)).status).toBe(200);
      expect(asked).toBe(1);
    });
    expect(logs.filter((line) => line.startsWith('request refused: unauthorized'))).toStrictEqual([
      'request refused: unauthorized (1 since the last line of this kind)', 'request refused: unauthorized (7 since the last line of this kind)',
    ]);
    expect(logs.join('\n')).not.toContain(TOKEN.slice('Bearer '.length));
  });

  test('only POST /precheck is the route: other methods, a query, a trailing slash and another case are 404 {error: not_found}; the route itself is the twin', async () => {
    await serve(echoOptions(), async (base) => {
      for (const [method, path] of [['GET', '/precheck'], ['HEAD', '/precheck'], ['PUT', '/precheck'], ['DELETE', '/precheck'], ['POST', '/precheck?x=1'], ['POST', '/precheck/'], ['POST', '/Precheck'], ['POST', '/pre-check']]) {
        const res = await fetch(`${base}${path}`, { method, headers: { authorization: TOKEN, ...contextHeaders() }, body: method === 'POST' || method === 'PUT' ? wire({ say: 'x' }) : undefined });
        expect(res.status, `${method} ${path}`).toBe(404);
        if (method !== 'HEAD') expect(await res.json(), `${method} ${path}`).toStrictEqual({ error: 'not_found' });
      }
      expect((await precheck(base)).status).toBe(200);
    });
  });
});

describe('POST /precheck: the slot', () => {
  test('while a job runs a pre-check is 409 {error: busy, message}; the option is not asked and nothing is reserved; once the job has ended it is the twin', async () => {
    const slot = new JobSlot();
    const logs: string[] = [];
    const held = gate();
    let asked = 0;
    await serve(echoOptions({ slot, clock: () => T, precheck: () => { asked += 1; return GO; }, run: async (r) => { await held.wait; return { said: r.say }; } }, logs), async (base) => {
      const running = job(base, 'hold', contextHeaders(ESCROW_X));
      await until(() => slot.busy, 'the job holds the slot');
      for (const escrow of [ESCROW_X, ESCROW_Y]) {
        const res = await precheck(base, wire({ say: 'next' }), contextHeaders(escrow));
        expect([res.status, await json(res)], escrow).toStrictEqual([409, { error: 'busy', message: BUSY_TEXT }]);
      }
      expect([asked, slot.reservedFor(T)]).toStrictEqual([0, undefined]);
      held.open();
      expect((await running).status).toBe(200);
      await until(() => !slot.busy, 'the slot is free');
      expect((await precheck(base, wire({ say: 'next' }), contextHeaders(ESCROW_Y))).status).toBe(200);
      expect(asked).toBe(1);
    });
    expect(BUSY_TEXT).toBe('The service is working on another job. Try again shortly.');
    expect(lines(logs).filter((line) => line.startsWith('pre-check refused'))).toStrictEqual(Array(2).fill('pre-check refused after N ms: busy (409), a job is running'));
  });

  test('while the slot is reserved for another escrow a pre-check is 409 {error: busy, message}, the option is not asked and the reservation stands; the same escrow again is a go', async () => {
    const slot = new JobSlot();
    const logs: string[] = [];
    const asked: string[] = [];
    await serve(echoOptions({ slot, clock: () => T, precheck: (_request, context) => { asked.push(context.escrowRef); return GO; } }, logs), async (base) => {
      expect((await precheck(base, wire({ say: 'a' }), contextHeaders(ESCROW_X))).status).toBe(200);
      const other = await precheck(base, wire({ say: 'b' }), contextHeaders(ESCROW_Y));
      expect([other.status, await json(other)]).toStrictEqual([409, { error: 'busy', message: BUSY_TEXT }]);
      expect([asked, slot.reservedFor(T)]).toStrictEqual([[ESCROW_X], ESCROW_X]);
      expect((await precheck(base, wire({ say: 'a again' }), contextHeaders(ESCROW_X))).status).toBe(200);
      expect(asked).toStrictEqual([ESCROW_X, ESCROW_X]);
    });
    expect(lines(logs).filter((line) => line.startsWith('pre-check refused'))).toStrictEqual(['pre-check refused after N ms: busy (409), the slot is held for another escrow']);
  });

  test('a repeated pre-check of the escrow that holds the reservation starts the 120 seconds again; the end is where the last go put it, to the millisecond', async () => {
    const slot = new JobSlot();
    let now = T;
    await serve(echoOptions({ slot, clock: () => now }), async (base) => {
      expect((await precheck(base)).status).toBe(200);
      now = T + 100_000;
      expect((await precheck(base)).status).toBe(200);
      now = T + 100_000 + RESERVATION_MS - 1;
      expect((await job(base, 'early', contextHeaders(ESCROW_Y))).status, 'held: the first go would have ended by now').toBe(409);
      now = T + 100_000 + RESERVATION_MS;
      expect((await job(base, 'late', contextHeaders(ESCROW_Y))).status, 'the second go has ended').toBe(200);
    });
  });

  test('a go that no job takes ends after 120 seconds: a pre-check of another escrow is 409 at 119999 ms and a go at 120000 ms', async () => {
    const slot = new JobSlot();
    let now = T;
    await serve(echoOptions({ slot, clock: () => now }), async (base) => {
      expect((await precheck(base, wire({ say: 'a' }), contextHeaders(ESCROW_X))).status).toBe(200);
      now = T + RESERVATION_MS - 1;
      expect((await precheck(base, wire({ say: 'b' }), contextHeaders(ESCROW_Y))).status).toBe(409);
      now = T + RESERVATION_MS;
      expect((await precheck(base, wire({ say: 'b' }), contextHeaders(ESCROW_Y))).status).toBe(200);
      expect(slot.reservedFor(now)).toBe(ESCROW_Y);
    });
  });

  test('a service that is stopping answers 503 shutting_down, asks no option and reserves nothing; a slot that starts draining while the option is asked gives 503 too', async () => {
    const slot = new JobSlot();
    const logs: string[] = [];
    let asked = 0;
    const answering = gate();
    await serve(echoOptions({ slot, clock: () => T, precheck: async () => { asked += 1; if (asked === 1) await answering.wait; return GO; } }, logs), async (base) => {
      // The slot starts draining while the option of the first call is being asked.
      const first = precheck(base);
      await until(() => asked === 1, 'the option is asked');
      slot.drain();
      answering.open();
      const res = await first;
      expect([res.status, await json(res)]).toStrictEqual([503, { error: 'shutting_down', message: STOPPING_TEXT }]);
      expect(slot.reservedFor(T)).toBeUndefined();
      // Now it is draining: the next call is refused before the option is asked.
      const late = await precheck(base);
      expect([late.status, await json(late)]).toStrictEqual([503, { error: 'shutting_down', message: STOPPING_TEXT }]);
      expect(asked).toBe(1);
    });
    expect(lines(logs).filter((line) => line.startsWith('pre-check refused'))).toStrictEqual(['pre-check refused: the service is stopping', 'pre-check refused: the service is stopping']);
    // The twin: a service that is not stopping answers the same call with a go.
    await serve(echoOptions({ slot: new JobSlot() }), async (base) => {
      expect((await precheck(base)).status).toBe(200);
    });
  });

  test('a job that takes the slot while the option is asked makes the answer 409, never a go: the reservation is made at the end, on the slot as it is then', async () => {
    const slot = new JobSlot();
    const asking = gate();
    const held = gate();
    let asked = 0;
    await serve(echoOptions({ slot, clock: () => T, precheck: async () => { asked += 1; await asking.wait; return GO; }, run: async (r) => { await held.wait; return { said: r.say }; } }), async (base) => {
      const pending = precheck(base, wire({ say: 'a' }), contextHeaders(ESCROW_X));
      await until(() => asked === 1, 'the option is asked');
      const running = job(base, 'hold', contextHeaders(ESCROW_Y));
      await until(() => slot.busy, 'a job of another escrow holds the slot');
      asking.open();
      const res = await pending;
      expect([res.status, await json(res)]).toStrictEqual([409, { error: 'busy', message: BUSY_TEXT }]);
      expect(slot.reservedFor(T)).toBeUndefined();
      held.open();
      expect((await running).status).toBe(200);
    });
  });

  test('two pre-checks of two escrows at once: the one whose option answers first is the go, the other is 409; asked one after the other, each is a go once the slot is free', async () => {
    const slot = new JobSlot();
    const answers = new Map<string, Gate>([[ESCROW_X, gate()], [ESCROW_Y, gate()]]);
    const entered: string[] = [];
    await serve(echoOptions({ slot, clock: () => T, precheck: async (_request, context) => { entered.push(context.escrowRef); await answers.get(context.escrowRef)?.wait; return GO; } }), async (base) => {
      const x = precheck(base, wire({ say: 'x' }), contextHeaders(ESCROW_X));
      const y = precheck(base, wire({ say: 'y' }), contextHeaders(ESCROW_Y));
      await until(() => entered.length === 2, 'both options are asked');
      answers.get(ESCROW_Y)?.open();
      const yAnswer = await y;
      expect([yAnswer.status, await json(yAnswer)]).toStrictEqual([200, { go: true, reserved_ms: 120_000 }]);
      answers.get(ESCROW_X)?.open();
      const xAnswer = await x;
      expect([xAnswer.status, await json(xAnswer)]).toStrictEqual([409, { error: 'busy', message: BUSY_TEXT }]);
      expect(slot.reservedFor(T)).toBe(ESCROW_Y);
    });
  });

  test('a caller that hangs up before the answer is written gets no reservation, and the abandoned call is logged once; the caller that stays is the twin', async () => {
    const slot = new JobSlot();
    const logs: string[] = [];
    const answering = gate();
    let asked = 0;
    await serve(echoOptions({ slot, clock: () => T, precheck: async () => { asked += 1; await answering.wait; return GO; } }, logs), async (_base, port, server) => {
      const caller = openPrecheck(port, wire({ say: 'hi' }), contextHeaders(ESCROW_X));
      await until(() => asked === 1, 'the option is asked');
      const before = await connectionCount(server);
      caller.destroy(); // the runtime gave up: its call is gone
      await connectionsEnded(server, before);
      answering.open();
      await until(() => logs.some((line) => /^pre-check abandoned by the caller after \d+ ms$/.test(line)), 'the abandoned call is logged');
      expect(slot.reservedFor(T), 'a go that nobody heard is no promise').toBeUndefined();
      expect((await job(_base, 'other', contextHeaders(ESCROW_Y))).status, 'the slot is free for another escrow').toBe(200);
    });
    expect(logs.filter((line) => line.startsWith('pre-check abandoned'))).toHaveLength(1);
    expect(logs.some((line) => line.startsWith('pre-check go'))).toBe(false);
    // The twin: a caller that waits for its answer gets the reservation.
    const slotTwo = new JobSlot();
    await serve(echoOptions({ slot: slotTwo, clock: () => T }), async (_base, port, server) => {
      const caller = openPrecheck(port, wire({ say: 'hi' }), contextHeaders(ESCROW_X));
      await until(() => slotTwo.reservedFor(T) === ESCROW_X, 'the go is made');
      caller.destroy();
      await connectionsEnded(server, 1);
    });
  });
});

describe('POST /precheck, then the job call', () => {
  test('a go, then the job call of the escrow: the job takes the reservation and runs with the context; another escrow is 409 meanwhile and free at the end', async () => {
    const slot = new JobSlot();
    const held = gate();
    const seen: Array<JobContext | undefined> = [];
    await serve(echoOptions({ slot, clock: () => T, run: async (r, _at, _signal, context) => { seen.push(context); if (r.say === 'hold') await held.wait; return { said: r.say }; } }), async (base) => {
      expect((await precheck(base, wire({ say: 'hold' }), contextHeaders(ESCROW_X))).status).toBe(200);
      const other = await job(base, 'other', contextHeaders(ESCROW_Y));
      expect([other.status, await json(other)], 'another escrow is held off').toStrictEqual([409, { error: 'busy' }]);
      const running = job(base, 'hold', contextHeaders(ESCROW_X));
      await until(() => slot.busy, 'the job of the escrow holds the slot');
      expect(slot.reservedFor(T), 'the job took the reservation').toBeUndefined();
      expect((await precheck(base, wire({ say: 'next' }), contextHeaders(ESCROW_Y))).status, 'a pre-check meets the running job').toBe(409);
      expect((await job(base, 'again', contextHeaders(ESCROW_X))).status, 'a taken reservation is not taken twice').toBe(409);
      held.open();
      expect((await running).status).toBe(200);
      await until(() => !slot.busy, 'the slot is free');
      expect((await precheck(base, wire({ say: 'next' }), contextHeaders(ESCROW_Y))).status, 'nothing is held now').toBe(200);
    });
    expect(seen).toStrictEqual([contextOf(ESCROW_X)]);
  });
});
