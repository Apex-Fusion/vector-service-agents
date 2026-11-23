// packages/usecase-kit/test/live/tip.test.ts: the slot of the tip of the node. A stub `fetch` plays the node, so no test uses the network. A good answer gives its slot, and each call makes one request. A node that gives no slot,
// a slot that is not a whole number of at least 1, an error of the node, a status other than 200, an answer that is too long and an answer that comes too late each throw an Error, and no message repeats the answer, the
// error of the network or the URL.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tipSlotOf } from '../../src/live/index.ts';

/** The URL of the node. Its path stands in for a secret that a node URL can hold: no error may show it. */
const OGMIOS = 'https://ogmios.example/path-token-91b7';
/** A text that only the node says: no error may repeat it. */
const MARKER = 'node-text-4f9a';

interface Sent {
  readonly url: unknown;
  readonly init: RequestInit | undefined;
}

/** A stub `fetch` and the requests that it got. `answer` gets the request and its number from 1. */
function node(answer: (sent: Sent, count: number) => Response | Promise<Response>): { readonly fetch: typeof fetch; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const stub = async (url: unknown, init?: RequestInit): Promise<Response> => {
    sent.push({ url, init });
    return answer({ url, init }, sent.length);
  };
  return { fetch: stub as unknown as typeof fetch, sent };
}

/** The answer of a node to the call of the tip. */
const answerOf = (result: unknown, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', method: 'queryNetwork/tip', result, id: null, ...extra }), { status: 200, headers: { 'content-type': 'application/json' } });
/** A good answer, with `slot` as its slot. */
const tip = (slot: unknown): Response => answerOf({ slot, id: 'ab'.repeat(32), height: 1234 });

const read = (stub: typeof fetch, timeoutMs = 2_000): (() => Promise<number>) => tipSlotOf({ fetch: stub, ogmiosUrl: OGMIOS, timeoutMs });

/** The error that a promise rejects with. A promise that resolves is a failure of the test. */
async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call did not throw');
}

/** A promise that the test settles by hand. (Promise.withResolvers is not in the types of this package's target.) */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

/** What no message may show: the text of the node, the URL and the secret in it. */
function expectNoLeak(error: Error, shown: readonly string[] = []): void {
  expect(error).toBeInstanceOf(Error);
  expect(error.message.length).toBeGreaterThan(0);
  for (const text of [MARKER, OGMIOS, 'path-token-91b7', 'ogmios.example', ...shown]) expect(error.message).not.toContain(text);
  expect(error.cause).toBeUndefined();
}

describe('tipSlotOf: a good answer', () => {
  it('gives the slot of the answer, after one POST request to the URL of the node with the JSON-RPC call of the tip', async () => {
    const { fetch: stub, sent } = node(() => tip(98_765));
    expect(await read(stub)()).toBe(98_765);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(OGMIOS);
    const init = sent[0]!.init!;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toStrictEqual({ jsonrpc: '2.0', method: 'queryNetwork/tip', params: {}, id: null });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('manual');
  });

  it.each([[1], [Number.MAX_SAFE_INTEGER]])('takes the slot %i, the least slot and the greatest safe whole number', async (slot) => {
    expect(await read(node(() => tip(slot)).fetch)()).toBe(slot);
  });

  it('takes an answer that holds more members than the slot', async () => {
    expect(await read(node(() => answerOf({ slot: 4_321, id: 'cd'.repeat(32), height: 9, era: 'conway' }, { extra: [1, 2, 3] })).fetch)()).toBe(4_321);
  });

  it('makes no request before it is called, and one request for each call, with the slot of each answer', async () => {
    const slots = [100, 250, 90];
    const { fetch: stub, sent } = node((_sent, count) => tip(slots[count - 1]));
    const slotOfTip = read(stub);
    expect(sent).toHaveLength(0);
    expect(await slotOfTip()).toBe(100);
    expect(sent).toHaveLength(1);
    expect(await slotOfTip()).toBe(250);
    // A node that rolls back and gives a lower slot gives that slot: nothing is kept from an earlier answer.
    expect(await slotOfTip()).toBe(90);
    expect(sent).toHaveLength(3);
  });

  it('makes two requests for two calls at one time', async () => {
    const { fetch: stub, sent } = node((_sent, count) => tip(count * 10));
    const slotOfTip = read(stub);
    expect((await Promise.all([slotOfTip(), slotOfTip()])).sort((a, b) => a - b)).toStrictEqual([10, 20]);
    expect(sent).toHaveLength(2);
  });
});

describe('tipSlotOf: an answer that is not a slot', () => {
  const BAD: ReadonlyArray<readonly [string, () => Response, readonly string[]]> = [
    ['an answer with no result', () => new Response(JSON.stringify({ jsonrpc: '2.0', id: null }), { status: 200 }), []],
    ['the result origin', () => answerOf('origin'), ['origin']],
    ['a result that is null', () => answerOf(null), []],
    ['a result that is a list', () => answerOf([{ slot: 5 }]), []],
    ['a result with no slot', () => answerOf({ id: MARKER, height: 3 }), []],
    ['a slot that is null', () => tip(null), []],
    ['a slot of 0', () => tip(0), []],
    ['a slot below 0', () => tip(-7), ['-7']],
    ['a slot with a fraction', () => tip(12.5), ['12.5']],
    ['a slot that is text', () => tip(`${MARKER}12345`), ['12345']],
    ['a slot that is a number written as text', () => tip('12345'), ['12345']],
    ['a slot that is a list', () => tip([12_345]), ['12345']],
    ['a slot that is true', () => tip(true), ['true']],
    ['a slot above the safe whole numbers', () => new Response('{"jsonrpc":"2.0","result":{"slot":9007199254740993},"id":null}', { status: 200 }), ['9007199254740']],
    ['a slot that is too large for a number', () => new Response('{"jsonrpc":"2.0","result":{"slot":1e999},"id":null}', { status: 200 }), ['1e999']],
    ['an error of the node', () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_602, message: MARKER }, id: null }), { status: 200 }), ['32602']],
    ['an error of the node next to a good result', () => answerOf({ slot: 500 }, { error: { code: -1, message: MARKER } }), []],
    ['an answer that is not JSON', () => new Response(`<html>${MARKER}</html>`, { status: 200 }), []],
    ['an answer that is JSON and no object', () => new Response(JSON.stringify(MARKER), { status: 200 }), []],
    ['an answer that is a list', () => new Response(JSON.stringify([{ result: { slot: 5 } }]), { status: 200 }), []],
    ['an empty answer', () => new Response('', { status: 200 }), []],
    ['an answer that is too long', () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { slot: 5 }, id: null, padding: MARKER.repeat(20_000) }), { status: 200 }), []],
  ];

  it.each(BAD)('throws for %s, and the message does not repeat the answer', async (_name, answer, shown) => {
    const error = await rejection(read(node(answer).fetch)());
    expectNoLeak(error, shown);
  });

  it('takes the next good answer after a bad one: the twin', async () => {
    const { fetch: stub } = node((_sent, count) => (count === 1 ? tip(0) : tip(55)));
    const slotOfTip = read(stub);
    await rejection(slotOfTip());
    expect(await slotOfTip()).toBe(55);
  });

  it('reads an answer that is far below the length limit: the twin of the answer that is too long', async () => {
    const answer = () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { slot: 5 }, id: null, padding: 'x'.repeat(4_000) }), { status: 200 });
    expect(await read(node(answer).fetch)()).toBe(5);
  });
});

describe('tipSlotOf: a status other than 200', () => {
  it.each([201, 204, 301, 302, 400, 401, 404, 429, 500, 502, 503])('throws for the status %i, also when the body is a good answer, and says the status only', async (status) => {
    const answer = () =>
      new Response(status === 204 ? null : JSON.stringify({ jsonrpc: '2.0', result: { slot: 777 }, id: null, note: MARKER }), {
        status,
        headers: status === 301 || status === 302 ? { location: 'https://elsewhere.example/' } : {},
      });
    const error = await rejection(read(node(answer).fetch)());
    expectNoLeak(error, ['777', 'elsewhere']);
    expect(error.message).toContain(String(status));
  });
});

describe('tipSlotOf: a failure of the network and the time of the call', () => {
  it('throws for a fetch that rejects, and the error shows neither the URL nor the text of the failure', async () => {
    const { fetch: stub } = node(() => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${OGMIOS} ${MARKER}`);
    });
    expectNoLeak(await rejection(read(stub)()), ['ECONNREFUSED']);
  });

  it('throws when the node gives no answer in the time, and not before it, aborts the request, and does not wait longer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let signal: AbortSignal | undefined;
    // This stub ignores the signal and never answers: the time limit of the call must end the wait by itself.
    const { fetch: stub } = node(({ init }) => {
      signal = init!.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    let settled = false;
    const work = rejection(read(stub, 30)());
    void work.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await work;
    expectNoLeak(error);
    expect(error.message).toContain('30 ms');
    expect(signal?.aborted).toBe(true);
  });

  it('throws the time limit, and not the error of the abort, for a request that the signal cancels', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetch: stub } = node(({ init }) => {
      const pending = deferred<Response>();
      init!.signal!.addEventListener('abort', () => pending.reject(Object.assign(new Error(`aborted ${OGMIOS} ${MARKER}`), { name: 'AbortError' })), { once: true });
      return pending.promise;
    });
    const work = rejection(read(stub, 30)());
    await vi.advanceTimersByTimeAsync(30);
    const error = await work;
    expectNoLeak(error);
    expect(error.message).toContain('30 ms');
  });

  it('throws when the body of the answer stops after its first bytes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetch: stub } = node(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","result":'));
            },
          }),
          { status: 200 },
        ),
    );
    const work = rejection(read(stub, 30)());
    await vi.advanceTimersByTimeAsync(30);
    const error = await work;
    expectNoLeak(error);
    expect(error.message).toContain('30 ms');
  });

  it('gives the slot of an answer that comes in the time: the twin', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetch: stub } = node(() => {
      const late = deferred<Response>();
      setTimeout(() => late.resolve(tip(42)), 29);
      return late.promise;
    });
    const work = read(stub, 30)();
    await vi.advanceTimersByTimeAsync(29);
    expect(await work).toBe(42);
  });
});

describe('tipSlotOf: what a caller gives', () => {
  const given = (over: Record<string, unknown>): (() => unknown) => () => tipSlotOf({ fetch: node(() => tip(1)).fetch, ogmiosUrl: OGMIOS, timeoutMs: 1_000, ...over } as Parameters<typeof tipSlotOf>[0]);

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], ['5000'], [86_400_001], [undefined], [null]])('refuses the time limit %s when the reader is made, and makes no request', (timeoutMs) => {
    const { fetch: stub, sent } = node(() => tip(1));
    expect(() => tipSlotOf({ fetch: stub, ogmiosUrl: OGMIOS, timeoutMs: timeoutMs as number })).toThrow(TypeError);
    expect(sent).toHaveLength(0);
  });

  it.each([[1], [86_400_000]])('takes the time limit %i', (timeoutMs) => {
    expect(given({ timeoutMs })).not.toThrow();
  });

  it.each([[''], ['ogmios.example'], ['not a url'], ['http://ogmios.example/'], ['ftp://ogmios.example/'], [undefined], [null], [42]])('refuses the URL %s, and the message does not repeat it', (ogmiosUrl) => {
    let error: unknown;
    try {
      given({ ogmiosUrl })();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    if (typeof ogmiosUrl === 'string' && ogmiosUrl.length > 0) expect((error as Error).message).not.toContain(ogmiosUrl);
  });

  it('takes an https URL', () => {
    expect(given({ ogmiosUrl: 'https://ogmios.example/' })).not.toThrow();
  });
});
