// packages/service-kit/test/job-context.test.ts
// The job call with the context headers, and with a reservation of the slot made before it. The reservation is made here on the slot itself; the tests of the
// pre-check route (precheck.test.ts) make it through the route.
import { describe, test, expect } from 'vitest';
import type { JobContext } from '../src/context.ts';
import { JobSlot, RESERVATION_MS } from '../src/slot.ts';
import { STOPPING_TEXT } from '../src/server.ts';
import type { JobServerOptions } from '../src/server.ts';
import { ESCROW_X, ESCROW_Y, TOKEN, call, contextHeaders, contextOf, echoOptions, serve, until, wire } from './support.ts';
import type { Echo, Said } from './support.ts';

type Run = NonNullable<JobServerOptions<Echo, Said>['run']>;
const T = 1_700_000_000_000;

/** A run that notes what it was given, and a gate that holds the jobs whose request asks to wait. */
function noting() {
  const seen: Array<{ request: Echo; signal: boolean; context: JobContext | undefined }> = [];
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run: Run = async (request, _arrivedAt, signal, context) => {
    seen.push({ request, signal: signal !== undefined, context });
    if (request.say.startsWith('hold')) await gate;
    return { said: request.say };
  };
  return { seen, run, release: () => release() };
}

describe('the job call and the context headers', () => {
  test('the six headers of a job call are given to run as one context, its fourth argument, with or without a signal for the run', async () => {
    for (const abortOnClose of [false, true]) {
      const { seen, run } = noting();
      await serve(echoOptions({ run, abortOnClose }), async (base) => {
        const res = await call(base, '/', wire({ say: 'hi' }), contextHeaders(ESCROW_X));
        expect([res.status, await res.json()]).toStrictEqual([200, { said: 'hi' }]);
      });
      expect(seen, `abortOnClose ${abortOnClose}`).toStrictEqual([{ request: { say: 'hi' }, signal: abortOnClose, context: contextOf(ESCROW_X) }]);
    }
  });

  test('a call with no context header runs as it always did: the run is given no context', async () => {
    const { seen, run } = noting();
    await serve(echoOptions({ run }), async (base) => {
      const res = await call(base, '/', wire({ say: 'old runtime' }));
      expect([res.status, await res.json()]).toStrictEqual([200, { said: 'old runtime' }]);
    });
    expect(seen).toStrictEqual([{ request: { say: 'old runtime' }, signal: false, context: undefined }]);
  });

  test('a header in a bad form is 400 bad_context that names it, with the connection closed and nothing run; the six right headers are the twin', async () => {
    const { seen, run } = noting();
    const logs: string[] = [];
    const BAD: Array<[string, string]> = [
      ['x-vector-escrow-ref', 'not a reference'], ['x-vector-advert-ref', `${'d4'.repeat(32)}#01`], ['x-vector-advert-model', 'caf\u00e9'], ['x-vector-buyer-pkh', 'c3'.repeat(27)],
      ['x-vector-payment-lovelace', '-5'], ['x-vector-deliver-by-ms', 'soon'],
    ];
    await serve(echoOptions({ run, log: (line) => { logs.push(line); } }), async (base) => {
      for (const [name, value] of BAD) {
        const res = await call(base, '/', wire({ say: 'x' }), { ...contextHeaders(), [name]: value });
        const body = await res.json() as { error: string; message: string };
        expect([res.status, body.error, res.headers.get('connection')], name).toStrictEqual([400, 'bad_context', 'close']);
        expect(body.message, name).toContain(`the header ${name} must be`);
      }
      expect(seen, 'no job ran').toStrictEqual([]);
      const twin = await call(base, '/', wire({ say: 'x' }), contextHeaders());
      expect(twin.status).toBe(200);
    });
    expect(logs.filter((line) => /^request refused after \d+ ms: bad_context \(400\)$/.test(line))).toHaveLength(BAD.length);
  });

  test('some of the six headers, but not all, is 400 bad_context; the six are the twin', async () => {
    const { seen, run } = noting();
    await serve(echoOptions({ run }), async (base) => {
      for (const name of Object.keys(contextHeaders())) {
        const headers = contextHeaders();
        delete headers[name];
        const res = await call(base, '/', wire({ say: 'x' }), headers);
        expect([res.status, await res.json()], name).toStrictEqual([400, { error: 'bad_context', message: `the context headers come all together, and ${name} is missing` }]);
      }
      expect(seen).toStrictEqual([]);
      expect((await call(base, '/', wire({ say: 'x' }), contextHeaders())).status).toBe(200);
    });
  });

  test('the token is checked first: a call without it is 401 whatever its context, and the same call with it is the twin', async () => {
    const { seen, run } = noting();
    await serve(echoOptions({ run }), async (base) => {
      for (const authorization of [null, 'Bearer wrong']) {
        const res = await call(base, '/', wire({ say: 'x' }), { ...contextHeaders(), 'x-vector-escrow-ref': 'nonsense' }, authorization);
        expect([res.status, await res.json()]).toStrictEqual([401, { error: 'unauthorized' }]);
      }
      const twin = await call(base, '/', wire({ say: 'x' }), { ...contextHeaders(), 'x-vector-escrow-ref': 'nonsense' });
      expect(twin.status).toBe(400);
      expect(seen).toStrictEqual([]);
    });
  });

  test('the context comes before the body and before the slot: a bad header is 400 bad_context for a bad body and for a busy slot; the right headers are the twin', async () => {
    const { seen, run, release } = noting();
    const slot = new JobSlot();
    await serve(echoOptions({ run, slot }), async (base) => {
      const bad = { ...contextHeaders(), 'x-vector-buyer-pkh': 'short' };
      const brokenBody = 'not the wire message';
      expect((await (await call(base, '/', brokenBody, bad)).json() as { error: string }).error).toBe('bad_context');
      expect((await (await call(base, '/', brokenBody, contextHeaders())).json() as { error: string }).error).toBe('bad_wire');
      const first = call(base, '/', wire({ say: 'hold' }), contextHeaders(ESCROW_X));
      await until(() => slot.busy, 'the first job holds the slot');
      expect((await (await call(base, '/', wire({ say: 'x' }), bad)).json() as { error: string }).error).toBe('bad_context');
      expect((await call(base, '/', wire({ say: 'x' }), contextHeaders(ESCROW_Y))).status, 'the right headers meet the busy slot').toBe(409);
      release();
      expect((await first).status).toBe(200);
    });
    expect(seen.map((s) => s.request.say)).toStrictEqual(['hold']);
  });
});

describe('the job call and a reservation of the slot', () => {
  test('during a reservation the job call of another escrow, and one with no context, get 409 {error: busy} and run nothing; the call of the reserved escrow takes it', async () => {
    const { seen, run } = noting();
    const slot = new JobSlot();
    const logs: string[] = [];
    let now = T;
    await serve(echoOptions({ run, slot, clock: () => now, log: (line) => { logs.push(line); } }), async (base) => {
      expect(slot.reserve(ESCROW_X, now)).toBe('reserved');
      for (const headers of [contextHeaders(ESCROW_Y), {}]) {
        const res = await call(base, '/', wire({ say: 'other' }), headers);
        expect([res.status, await res.json()], JSON.stringify(headers)).toStrictEqual([409, { error: 'busy' }]);
      }
      expect(seen, 'neither ran').toStrictEqual([]);
      expect(slot.reservedFor(now), 'the reservation stands').toBe(ESCROW_X);
      // The twin: the call of the escrow that holds the reservation.
      const own = await call(base, '/', wire({ say: 'own' }), contextHeaders(ESCROW_X));
      expect([own.status, await own.json()]).toStrictEqual([200, { said: 'own' }]);
      expect(seen.map((s) => s.request.say)).toStrictEqual(['own']);
      expect(slot.reservedFor(now), 'the job took it').toBeUndefined();
    });
    expect(logs.filter((line) => line === 'job refused: the slot is held for another escrow')).toHaveLength(2);
  });

  test('a taken reservation is not taken twice: while the job runs the same escrow and another get 409, and when it ends the slot is free for any escrow', async () => {
    const { seen, run, release } = noting();
    const slot = new JobSlot();
    await serve(echoOptions({ run, slot, clock: () => T }), async (base) => {
      slot.reserve(ESCROW_X, T);
      const first = call(base, '/', wire({ say: 'hold first' }), contextHeaders(ESCROW_X));
      await until(() => slot.busy, 'the first job holds the slot');
      for (const escrow of [ESCROW_X, ESCROW_Y]) {
        const res = await call(base, '/', wire({ say: 'second' }), contextHeaders(escrow));
        expect([res.status, await res.json()], escrow).toStrictEqual([409, { error: 'busy' }]);
      }
      expect(seen.map((s) => s.request.say), 'the second calls did not run').toStrictEqual(['hold first']);
      release();
      expect((await first).status).toBe(200);
      await until(() => !slot.busy, 'the slot is free');
      // Nothing is held now: another escrow runs at once, and then the first one again.
      expect((await call(base, '/', wire({ say: 'third' }), contextHeaders(ESCROW_Y))).status).toBe(200);
      expect((await call(base, '/', wire({ say: 'fourth' }), contextHeaders(ESCROW_X))).status).toBe(200);
    });
    expect(seen.map((s) => s.request.say)).toStrictEqual(['hold first', 'third', 'fourth']);
  });

  test('a reservation that no job takes ends after 120 seconds: at 119999 ms the slot is still held, at 120000 ms it takes any job', async () => {
    const { seen, run } = noting();
    const slot = new JobSlot();
    let now = T;
    await serve(echoOptions({ run, slot, clock: () => now }), async (base) => {
      slot.reserve(ESCROW_X, T);
      now = T + RESERVATION_MS - 1;
      expect((await call(base, '/', wire({ say: 'early' }), contextHeaders(ESCROW_Y))).status).toBe(409);
      now = T + RESERVATION_MS;
      const late = await call(base, '/', wire({ say: 'late' }), contextHeaders(ESCROW_Y));
      expect([late.status, await late.json()]).toStrictEqual([200, { said: 'late' }]);
    });
    expect(seen.map((s) => s.request.say)).toStrictEqual(['late']);
  });

  test('a job call with no reservation takes the slot as it did, with a context or without one', async () => {
    const { seen, run } = noting();
    await serve(echoOptions({ run }), async (base) => {
      expect((await call(base, '/', wire({ say: 'with' }), contextHeaders(ESCROW_Y))).status).toBe(200);
      expect((await call(base, '/', wire({ say: 'without' }))).status).toBe(200);
    });
    expect(seen.map((s) => s.request.say)).toStrictEqual(['with', 'without']);
  });

  test('a job call that is not a request leaves the reservation as it was: the bad body of the reserved escrow is refused, and its good call is the twin', async () => {
    const { seen, run } = noting();
    const slot = new JobSlot();
    await serve(echoOptions({ run, slot, clock: () => T }), async (base) => {
      slot.reserve(ESCROW_X, T);
      const bad = await call(base, '/', wire({ nothing: 1 }), contextHeaders(ESCROW_X));
      expect([bad.status, (await bad.json() as { error: string }).error]).toStrictEqual([400, 'bad_shape']);
      expect(slot.reservedFor(T)).toBe(ESCROW_X);
      expect((await call(base, '/', wire({ say: 'good' }), contextHeaders(ESCROW_X))).status).toBe(200);
    });
    expect(seen.map((s) => s.request.say)).toStrictEqual(['good']);
  });

  test('a service that is stopping takes no job, the reserved one included: 503 shutting_down, and the call of the reserved escrow is no twin once the slot drains', async () => {
    const { seen, run } = noting();
    const slot = new JobSlot();
    await serve(echoOptions({ run, slot, clock: () => T }), async (base) => {
      slot.reserve(ESCROW_X, T);
      slot.drain();
      const res = await call(base, '/', wire({ say: 'late' }), contextHeaders(ESCROW_X));
      expect([res.status, await res.json()]).toStrictEqual([503, { error: 'shutting_down', message: STOPPING_TEXT }]);
    });
    expect(seen).toStrictEqual([]);
  });
});
