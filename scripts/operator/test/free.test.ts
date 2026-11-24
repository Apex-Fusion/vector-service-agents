// The check that no running runtime of an agent works, and the reader of `running-images.json` that the script that starts the container writes before every run.
// No test uses the network or a clock: the fetch is a function of the test, the time is a number that the test gives, and the limit of 10 seconds runs on fake timers.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AdvertSpec } from '../lib/contract.ts';
import { readRunning, readRunningImages, readRuntimeStatus, requireRuntimesFree, runtimesOf } from '../lib/free.ts';
import type { RuntimeRef, RuntimeStatus } from '../lib/free.ts';
import { MemoryOutput } from './support/fakes.ts';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const MINUTE = 60_000;

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

/** An image reference as the compose file pins it: a repository and the digest of the image index. */
const image = (n: number): string => `registry.example/agents/runtime@sha256:${n.toString(16).padStart(2, '0').repeat(32)}`;
const stamp = (ms: number): string => new Date(ms).toISOString();
const body = (generatedAt: unknown, images: unknown): string => JSON.stringify({ generated_at: generatedAt, images });

/** A folder of its own with the file `running-images.json` that holds `text`. It gives the path of the file. */
function fileWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'operator-free-'));
  roots.push(dir);
  const path = join(dir, 'running-images.json');
  writeFileSync(path, text);
  return path;
}

/** The refusal of a call: the test fails when the call does not throw a PreconditionError. */
function refused(run: () => unknown): PreconditionError {
  try { run(); } catch (err) {
    if (err instanceof PreconditionError) return err;
    throw err;
  }
  throw new Error('the call did not refuse');
}
const refusedLater = async (run: Promise<unknown>): Promise<PreconditionError> => run.then(() => { throw new Error('the call did not refuse'); }, (err: unknown) => {
  if (err instanceof PreconditionError) return err;
  throw err;
});

describe('readRunningImages and readRunning', () => {
  it('read a good file: the map from each container to its image, and the set of the containers', () => {
    const path = fileWith(body(stamp(NOW - MINUTE), { 'reorder-runtime': image(1), 'orders-small': image(2) }));
    expect([...readRunningImages(path, NOW)]).toEqual([['reorder-runtime', image(1)], ['orders-small', image(2)]]);
    expect([...readRunning(path, NOW)]).toEqual(['reorder-runtime', 'orders-small']);
  });
  it('take an empty images object as a good file: no container runs', () => {
    const path = fileWith(body(stamp(NOW - MINUTE), {}));
    expect(readRunningImages(path, NOW).size).toBe(0);
    expect(readRunning(path, NOW).size).toBe(0);
  });
  it('take a time with an offset and with the nine decimals of a nanosecond time', () => {
    expect(readRunning(fileWith(body('2026-11-24T13:55:00.123456789+02:00', { runtime: image(1) })), NOW).has('runtime')).toBe(true);
    expect(readRunning(fileWith(body('2026-11-24T11:55:00Z', { runtime: image(1) })), NOW).has('runtime')).toBe(true);
  });

  it('refuse a file that is more than 10 minutes old, and take one that is 9 minutes old or exactly 10 minutes old', () => {
    const aged = (age: number): string => fileWith(body(stamp(NOW - age), { runtime: image(1) }));
    expect(readRunning(aged(9 * MINUTE), NOW).has('runtime')).toBe(true);
    expect(readRunning(aged(10 * MINUTE), NOW).has('runtime')).toBe(true);
    for (const age of [10 * MINUTE + 1, 11 * MINUTE, 3 * 60 * MINUTE]) expect(refused(() => readRunning(aged(age), NOW)).message, `${age} ms`).toMatch(/more than 10 minutes old/);
    // The time of the call decides, so a file that one call takes is old for a later call.
    const path = aged(9 * MINUTE);
    expect(readRunning(path, NOW).has('runtime')).toBe(true);
    expect(refused(() => readRunning(path, NOW + 2 * MINUTE)).message).toMatch(/more than 10 minutes old/);
  });
  it('refuse a file from the future by more than a minute, and take a small step of the clock', () => {
    const ahead = (ms: number): string => fileWith(body(stamp(NOW + ms), {}));
    expect(readRunning(ahead(30_000), NOW).size).toBe(0);
    expect(readRunning(ahead(60_000), NOW).size).toBe(0);
    expect(refused(() => readRunning(ahead(60_001), NOW)).message).toMatch(/in the future/);
    expect(refused(() => readRunning(ahead(5 * MINUTE), NOW)).message).toMatch(/in the future/);
  });
  it('refuse a clock that gives no time', () => {
    expect(refused(() => readRunning(fileWith(body(stamp(NOW), {})), Number.NaN)).message).toMatch(/clock/);
  });

  it('refuse a file that is missing, with a message that says that the start script writes it', () => {
    const missing = join(fileWith('{}'), '..', 'not-there.json');
    expect(refused(() => readRunningImages(missing, NOW)).message).toMatch(/does not exist.*before every run/);
  });
  it('refuse a file that cannot be read, and name the code of the system error and nothing else of it', () => {
    const folder = join(fileWith('{}'), '..');
    const error = refused(() => readRunningImages(folder, NOW));
    expect(error.message).toMatch(/could not be read \(EISDIR\)/);
    expect(error.message).not.toContain(folder);
    const injected = refused(() => readRunning('/state/running-images.json', NOW, { read: () => { throw Object.assign(new Error('EACCES: permission denied, open /state/running-images.json'), { code: 'EACCES' }); } }));
    expect(injected.message).toMatch(/could not be read \(EACCES\)/);
    expect(injected.message).not.toContain('/state');
  });
  it('read through the file system that a test gives', () => {
    const io = { read: (path: string) => (path === '/state/running-images.json' ? body(stamp(NOW), { runtime: image(7) }) : '') };
    expect([...readRunningImages('/state/running-images.json', NOW, io)]).toEqual([['runtime', image(7)]]);
  });

  const GOOD_TIME = stamp(NOW - MINUTE);
  const SHAPES: ReadonlyArray<readonly [string, string]> = [
    ['text that is not JSON', 'this is not json'],
    ['an empty file', ''],
    ['a list', '[]'], ['null', 'null'], ['a text', '"running"'], ['a number', '1'],
    ['an object with no member', '{}'],
    ['no images member', JSON.stringify({ generated_at: GOOD_TIME })],
    ['no generated_at member', JSON.stringify({ images: {} })],
    ['a member that the file does not take', JSON.stringify({ generated_at: GOOD_TIME, images: {}, extra: 1 })],
    ['images as a list', body(GOOD_TIME, [])], ['images as null', body(GOOD_TIME, null)], ['images as a text', body(GOOD_TIME, 'none')],
    ['a generated_at that is a number', body(NOW - MINUTE, {})], ['a generated_at that is null', body(null, {})],
    ['an image that is a tag', body(GOOD_TIME, { runtime: 'registry.example/agents/runtime:latest' })],
    ['an image with a short digest', body(GOOD_TIME, { runtime: 'registry.example/agents/runtime@sha256:abcd' })],
    ['an image with an upper-case digest', body(GOOD_TIME, { runtime: `registry.example/agents/runtime@sha256:${'AB'.repeat(32)}` })],
    ['an image with no repository', body(GOOD_TIME, { runtime: `@sha256:${'ab'.repeat(32)}` })],
    ['an image that is a number', body(GOOD_TIME, { runtime: 5 })], ['an image that is null', body(GOOD_TIME, { runtime: null })], ['an image that is an empty text', body(GOOD_TIME, { runtime: '' })],
    ['an image with a space', body(GOOD_TIME, { runtime: `registry.example/a b@sha256:${'ab'.repeat(32)}` })],
    ['a container name with a space', body(GOOD_TIME, { 'a b': image(1) })], ['an empty container name', body(GOOD_TIME, { '': image(1) })],
    ['a container name with a slash', body(GOOD_TIME, { 'a/b': image(1) })],
  ];
  for (const [what, text] of SHAPES) {
    it(`refuse ${what}`, () => {
      expect(refused(() => readRunningImages(fileWith(text), NOW))).toBeInstanceOf(PreconditionError);
      expect(refused(() => readRunning(fileWith(text), NOW))).toBeInstanceOf(PreconditionError);
    });
  }
  it('take the good file that the shapes are cut from', () => {
    expect(readRunning(fileWith(body(GOOD_TIME, { runtime: image(1), 'a.b-c_d': image(2) })), NOW).size).toBe(2);
  });
  it('refuse a file in which an object holds a member twice, so that a second images cannot hide a running container, and read the same file with each member once', () => {
    const T = GOOD_TIME;
    const IMG = image(1);
    const secret = 'sekret-value-1234'.repeat(4);
    const REPEATS: ReadonlyArray<readonly [string, string, string]> = [
      ['a second empty images after the one that lists a container', `{"generated_at":"${T}","images":{"runtime":"${IMG}"},"images":{}}`, 'images'],
      ['a second images that lists a container after an empty one', `{"generated_at":"${T}","images":{},"images":{"runtime":"${IMG}"}}`, 'images'],
      ['a second generated_at', `{"generated_at":"${T}","generated_at":"${T}","images":{}}`, 'generated_at'],
      ['a container that is listed twice', `{"generated_at":"${T}","images":{"runtime":"${IMG}","runtime":"${image(2)}"}}`, 'runtime'],
      ['a second images that is written with an escape', `{"generated_at":"${T}","images":{},"\\u0069mages":{"runtime":"${IMG}"}}`, 'images'],
      ['a second images in a text with white space and a new line', `{\n  "generated_at": "${T}",\n  "images": { "runtime": "${IMG}" } ,\n  "images" :\n {}\n}`, 'images'],
    ];
    for (const [what, text, name] of REPEATS) {
      const error = refused(() => readRunningImages(fileWith(text), NOW));
      expect(error.message, what).toContain(`member ${name} twice`);
      expect(refused(() => readRunning(fileWith(text), NOW)).message, what).toMatch(/twice/);
    }
    // The twin: the same members once, and a name that two different objects hold is no repeat.
    expect([...readRunning(fileWith(`{"generated_at":"${T}","images":{"runtime":"${IMG}"}}`), NOW)]).toEqual(['runtime']);
    expect([...readRunning(fileWith(`{"generated_at":"${T}","images":{"images":"${IMG}","generated_at":"${image(2)}"}}`), NOW)]).toEqual(['images', 'generated_at']);
    // A name that is no container name is not shown.
    const hidden = refused(() => readRunning(fileWith(`{"generated_at":"${T}","images":{},"${secret}":1,"${secret}":2}`), NOW));
    expect(hidden.message).toMatch(/twice/);
    expect(hidden.message).not.toContain(secret);
  });
  it('refuse a generated_at that is no time, and say which member it is', () => {
    for (const bad of ['yesterday', '', '2026-11-24', '2026-11-24T11:55:00', '2026-02-30T10:00:00Z', '2026-11-24 11:55:00Z', '2026-11-24T24:00:00Z', 'x'.repeat(40)]) {
      expect(refused(() => readRunning(fileWith(body(bad, {})), NOW)).message, bad).toMatch(/generated_at/);
    }
  });
  it('refuse a file that is longer than a state report can be', () => {
    const images = Object.fromEntries(Array.from({ length: 800 }, (_, n) => [`container-${n}`, image(n % 200)]));
    expect(refused(() => readRunning(fileWith(body(GOOD_TIME, images)), NOW)).message).toMatch(/longer than/);
    expect(readRunning(fileWith(body(GOOD_TIME, Object.fromEntries(Object.entries(images).slice(0, 100)))), NOW).size).toBe(100);
  });
  it('show no value of the file in a refusal', () => {
    const secret = 'sekret-value-1234';
    for (const text of [body(GOOD_TIME, { runtime: secret }), body(secret, {}), JSON.stringify({ generated_at: GOOD_TIME, images: {}, [secret]: 1 }), body(GOOD_TIME, { [`${secret} x`]: image(1) })]) {
      expect(refused(() => readRunning(fileWith(text), NOW)).message).not.toContain(secret);
    }
  });
});

const advert = (origin: string, container: string): AdvertSpec => ({
  model: 'lot', priceLovelace: 1n, supplierBondLovelace: 1n, buyerBondLovelace: 1n, windowMs: 1000, maxOutputTokens: 1, depositLovelace: 1n, supplierKey: 'supplier', origin,
  runtimeEnvFile: '.env.runtime', runtimeContainer: container,
});

describe('runtimesOf', () => {
  it('gives one reference for each advert: the container and the status address of its runtime', () => {
    const adverts = [advert('https://small.example', 'orders-small'), advert('https://medium.example', 'orders-medium'), advert('https://large.example', 'orders-large')];
    expect(runtimesOf({ adverts })).toEqual([
      { container: 'orders-small', statusUrl: 'https://small.example/status' }, { container: 'orders-medium', statusUrl: 'https://medium.example/status' },
      { container: 'orders-large', statusUrl: 'https://large.example/status' },
    ]);
  });
  it('gives one reference for an agent with one advert, none for an agent with none, and no double slash for an origin with a slash at its end', () => {
    expect(runtimesOf({ adverts: [advert('https://reorder.example/', 'reorder-runtime')] })).toEqual([{ container: 'reorder-runtime', statusUrl: 'https://reorder.example/status' }]);
    expect(runtimesOf({ adverts: [] })).toEqual([]);
  });
});

const RUNTIMES: readonly RuntimeRef[] = [
  { container: 'orders-small', statusUrl: 'https://small.example/status' },
  { container: 'orders-medium', statusUrl: 'https://medium.example/status' },
  { container: 'orders-large', statusUrl: 'https://large.example/status' },
];
const ALL = new Set(RUNTIMES.map((runtime) => runtime.container));

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const FREE = (): Response => json({ status: 'free', last_seen: '2026-11-24T11:59:00.000Z', active_sessions: 0, max_sessions: 1, version: '1' });

/** A fetch that answers each address with the function of the test, and keeps the addresses that it was asked for. An address with no function is a failed request. */
function fetchOf(answers: Readonly<Record<string, () => Response | Promise<Response>>>): { fetchImpl: typeof fetch; calls: string[]; signals: Array<AbortSignal | null | undefined> } {
  const calls: string[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    signals.push(init?.signal);
    const answer = answers[url];
    if (answer === undefined) throw new TypeError('fetch failed');
    return answer();
  }) as typeof fetch;
  return { fetchImpl, calls, signals };
}
const allFree = (): Record<string, () => Response> => Object.fromEntries(RUNTIMES.map((runtime) => [runtime.statusUrl, FREE]));

describe('requireRuntimesFree', () => {
  it('passes a runtime that is not in running, says so, and asks nobody: whatever the host would answer for it', async () => {
    const out = new MemoryOutput();
    const net = fetchOf(Object.fromEntries(RUNTIMES.map((runtime) => [runtime.statusUrl, () => new Response('Bad Gateway', { status: 502 })])));
    await requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: RUNTIMES, running: new Set(), out });
    expect(net.calls).toEqual([]);
    expect(out.lines).toHaveLength(3);
    for (const runtime of RUNTIMES) expect(out.text).toContain(`the runtime ${runtime.container} is not running`);
    expect(out.text).toContain('running-images.json');
  });
  it('passes a running runtime that says free, with the other members of the body ignored, and asks for its status address', async () => {
    const out = new MemoryOutput();
    const net = fetchOf({ [RUNTIMES[0]!.statusUrl]: FREE });
    await requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out });
    expect(net.calls).toEqual(['https://small.example/status']);
    expect(out.lines).toEqual(['the runtime orders-small is running and says free']);
  });
  it('passes when no runtime is listed, and asks nobody', async () => {
    const net = fetchOf({});
    await requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [], running: ALL, out: new MemoryOutput() });
    expect(net.calls).toEqual([]);
  });
  it('ignores a running container that no listed runtime names', async () => {
    const net = fetchOf({});
    await requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: RUNTIMES, running: new Set(['another-container', 'reorder-service']), out: new MemoryOutput() });
    expect(net.calls).toEqual([]);
  });
  it('asks a runtime that runs once, with a signal, and does not follow a redirect', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => { seen.push(init); return FREE(); }) as typeof fetch;
    await requireRuntimesFree({ fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.redirect).toBe('manual');
    expect(seen[0]?.method).toBe('GET');
  });

  it('refuses a runtime that says working, names it, and says that a job runs', async () => {
    const net = fetchOf({ [RUNTIMES[0]!.statusUrl]: () => json({ status: 'working', active_sessions: 1 }) });
    const error = await refusedLater(requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() }));
    expect(error.message).toMatch(/orders-small/);
    expect(error.message).toMatch(/a job runs/);
  });
  for (const status of [502, 500, 503, 404, 403, 401, 301, 302, 204, 201]) {
    it(`refuses a running runtime that answers the status ${status}, even when the body says free, and says that it cannot tell`, async () => {
      const answer = (): Response => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify({ status: 'free' }), { status }));
      const net = fetchOf({ [RUNTIMES[0]!.statusUrl]: answer });
      const error = await refusedLater(requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() }));
      expect(error.message).toMatch(/cannot tell/);
      expect(error.message).toContain('orders-small');
      expect(error.message).toContain(`status ${status}`);
      expect(error.message).not.toMatch(/a job runs/);
    });
  }
  const BODIES: ReadonlyArray<readonly [string, () => Response, RegExp]> = [
    ['a body that is not JSON', () => new Response('<html>Bad Gateway</html>', { status: 200 }), /not JSON/],
    ['an empty body', () => new Response('', { status: 200 }), /not JSON/],
    ['a JSON list', () => json(['free']), /not a JSON object/],
    ['JSON null', () => json(null), /not a JSON object/],
    ['a JSON text', () => json('free'), /not a JSON object/],
    ['a JSON object with no status', () => json({ last_seen: 'x' }), /no status text/],
    ['a status that is a number', () => json({ status: 1 }), /no status text/],
    ['a status that is a list', () => json({ status: ['free'] }), /no status text/],
    ['a status that is null', () => json({ status: null }), /no status text/],
    ['a status that is an empty text', () => json({ status: '' }), /neither free nor working/],
    ['a status in capital letters', () => json({ status: 'Free' }), /neither free nor working/],
    ['a status with a space', () => json({ status: 'free ' }), /neither free nor working/],
    ['a status that says offline', () => json({ status: 'offline' }), /neither free nor working/],
    ['a status that says anything else', () => json({ status: 'sekret-status-word' }), /neither free nor working/],
  ];
  for (const [what, answer, message] of BODIES) {
    it(`refuses a running runtime that answers with ${what}, and says that it cannot tell`, async () => {
      const net = fetchOf({ [RUNTIMES[0]!.statusUrl]: answer });
      const error = await refusedLater(requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() }));
      expect(error.message).toMatch(/cannot tell/);
      expect(error.message).toMatch(message);
      expect(error.message).not.toContain('sekret-status-word');
    });
  }
  it('refuses a running runtime whose request fails, and shows nothing of the failure', async () => {
    const reject = (): Promise<Response> => Promise.reject(new Error('connect ECONNREFUSED sekret-detail.internal:443'));
    const net = fetchOf({ [RUNTIMES[0]!.statusUrl]: reject });
    const error = await refusedLater(requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() }));
    expect(error.message).toMatch(/cannot tell/);
    expect(error.message).toMatch(/request failed/);
    expect(error.message).not.toContain('sekret-detail');
  });
  it('refuses a running runtime when the fetch throws before it returns a promise', async () => {
    const fetchImpl = ((): Promise<Response> => { throw new Error('the fetch is broken'); }) as typeof fetch;
    const error = await refusedLater(requireRuntimesFree({ fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() }));
    expect(error.message).toMatch(/request failed/);
  });
  it('refuses an answer that is longer than 64 KiB, and takes one with the same status that is short', async () => {
    const long = fetchOf({ [RUNTIMES[0]!.statusUrl]: () => json({ status: 'free', note: 'x'.repeat(70_000) }) });
    const error = await refusedLater(requireRuntimesFree({ fetchImpl: long.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() }));
    expect(error.message).toMatch(/longer than 65536 bytes/);
    const short = fetchOf({ [RUNTIMES[0]!.statusUrl]: () => json({ status: 'free', note: 'x'.repeat(10_000) }) });
    await requireRuntimesFree({ fetchImpl: short.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() });
  });

  it('asks every runtime that runs, refuses when one of three works, and names that one and no other', async () => {
    const out = new MemoryOutput();
    const net = fetchOf({ ...allFree(), [RUNTIMES[1]!.statusUrl]: () => json({ status: 'working' }) });
    const error = await refusedLater(requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: RUNTIMES, running: ALL, out }));
    expect(net.calls.sort()).toEqual(RUNTIMES.map((runtime) => runtime.statusUrl).sort());
    expect(error.message).toContain('orders-medium');
    expect(error.message).not.toContain('orders-small');
    expect(error.message).not.toContain('orders-large');
    expect(error.message).toMatch(/a job runs/);
    expect(out.text).toContain('the runtime orders-small is running and says free');
    expect(out.text).toContain('the runtime orders-large is running and says free');
  });
  it('names each runtime that stops the task, in the order of the list, and not the one that is free or not running', async () => {
    const net = fetchOf({
      [RUNTIMES[0]!.statusUrl]: () => json({ status: 'working' }), [RUNTIMES[1]!.statusUrl]: () => new Response('Bad Gateway', { status: 502 }), [RUNTIMES[2]!.statusUrl]: FREE,
    });
    const error = await refusedLater(requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: RUNTIMES, running: ALL, out: new MemoryOutput() }));
    expect(error.message).toContain('orders-small');
    expect(error.message).toContain('orders-medium');
    expect(error.message).not.toContain('orders-large');
    expect(error.message.indexOf('orders-small')).toBeLessThan(error.message.indexOf('orders-medium'));
    expect(error.message).toMatch(/a job runs/);
    expect(error.message).toMatch(/cannot tell/);
    const notRunning = await refusedLater(requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: RUNTIMES, running: new Set(['orders-small']), out: new MemoryOutput() }));
    expect(notRunning.message).toContain('orders-small');
    expect(notRunning.message).not.toContain('orders-medium');
  });
  it('passes three runtimes of which one is not running and two say free', async () => {
    const out = new MemoryOutput();
    const net = fetchOf(allFree());
    await requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: RUNTIMES, running: new Set(['orders-small', 'orders-large']), out });
    expect(net.calls.sort()).toEqual([RUNTIMES[0]!.statusUrl, RUNTIMES[2]!.statusUrl].sort());
    expect(out.lines).toEqual(['the runtime orders-small is running and says free', expect.stringContaining('the runtime orders-medium is not running'), 'the runtime orders-large is running and says free']);
  });

  describe('with the limit of 10 seconds', () => {
    const never = (): Promise<Response> => new Promise<Response>(() => undefined);
    it('refuses a runtime that gives no answer within 10 seconds, and not before', async () => {
      vi.useFakeTimers();
      const net = fetchOf({ [RUNTIMES[0]!.statusUrl]: never });
      let settled = false;
      const run = requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() });
      const outcome = refusedLater(run);
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await outcome;
      expect(error.message).toMatch(/cannot tell/);
      expect(error.message).toMatch(/within 10 s/);
      expect(net.signals[0]?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
    it('takes an answer that comes after 9 seconds, and leaves no timer', async () => {
      vi.useFakeTimers();
      const slow = (): Promise<Response> => new Promise<Response>((resolve) => { setTimeout(() => resolve(FREE()), 9_000); });
      const net = fetchOf({ [RUNTIMES[0]!.statusUrl]: slow });
      const run = requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() });
      await vi.advanceTimersByTimeAsync(9_000);
      await expect(run).resolves.toBeUndefined();
      expect(net.signals[0]?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
    it('refuses an answer whose body does not end within 10 seconds', async () => {
      vi.useFakeTimers();
      const stalled = (): Response => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')); } }), { status: 200 });
      const net = fetchOf({ [RUNTIMES[0]!.statusUrl]: stalled });
      const outcome = refusedLater(requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: [RUNTIMES[0]!], running: new Set(['orders-small']), out: new MemoryOutput() }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await outcome).message).toMatch(/within 10 s/);
    });
    it('gives each runtime its own 10 seconds: a slow one does not shorten the time of the others', async () => {
      vi.useFakeTimers();
      const later = (): Promise<Response> => new Promise<Response>((resolve) => { setTimeout(() => resolve(FREE()), 9_500); });
      const net = fetchOf({ ...allFree(), [RUNTIMES[0]!.statusUrl]: later, [RUNTIMES[1]!.statusUrl]: later });
      const run = requireRuntimesFree({ fetchImpl: net.fetchImpl, runtimes: RUNTIMES, running: ALL, out: new MemoryOutput() });
      await vi.advanceTimersByTimeAsync(9_500);
      await expect(run).resolves.toBeUndefined();
    });
  });
});

// The one reader of a status address. `requireRuntimesFree` and the task `end-state` both ask a runtime through it, so each answer has one meaning in the pack.
describe('readRuntimeStatus', () => {
  const URL = RUNTIMES[0]!.statusUrl;
  const read = (answer: () => Response | Promise<Response>): Promise<RuntimeStatus> => readRuntimeStatus(fetchOf({ [URL]: answer }).fetchImpl, URL);
  it('gives free for the status word free, and ignores the other members of the body', async () => {
    expect(await read(FREE)).toEqual({ kind: 'free' });
    expect(await read(() => json({ status: 'free' }))).toEqual({ kind: 'free' });
  });
  it('gives working for the status word working', async () => {
    expect(await read(() => json({ status: 'working', active_sessions: 1 }))).toEqual({ kind: 'working' });
  });
  const UNKNOWN: ReadonlyArray<readonly [string, () => Response, RegExp]> = [
    ['the status 502', () => new Response('Bad Gateway', { status: 502 }), /status 502/],
    ['the status 301, whatever the body says', () => new Response(JSON.stringify({ status: 'free' }), { status: 301 }), /status 301/],
    ['a body that is not JSON', () => new Response('<html></html>', { status: 200 }), /not JSON/],
    ['a JSON list', () => json(['free']), /not a JSON object/],
    ['an object with no status text', () => json({ status: 1 }), /no status text/],
    ['another status word', () => json({ status: 'sekret-status-word' }), /neither free nor working/],
    ['a body of more than 64 KiB', () => json({ status: 'free', note: 'x'.repeat(70_000) }), /longer than 65536 bytes/],
  ];
  for (const [what, answer, reason] of UNKNOWN) {
    it(`gives unknown, with the reason, for ${what}`, async () => {
      const status = await read(answer);
      expect(status).toMatchObject({ kind: 'unknown', why: expect.stringMatching(reason) });
      expect(JSON.stringify(status)).not.toContain('sekret-status-word');
    });
  }
  it('gives unknown and shows nothing of the failure when the request fails, and when the fetch throws at once', async () => {
    const failed = await read(() => Promise.reject(new Error('connect ECONNREFUSED sekret-detail.internal:443')));
    expect(failed).toEqual({ kind: 'unknown', why: 'the request failed' });
    const thrown = await readRuntimeStatus((() => { throw new Error('the fetch is broken'); }) as typeof fetch, URL);
    expect(thrown).toEqual({ kind: 'unknown', why: 'the request failed' });
  });
  it('asks with a GET that has a signal and does not follow a redirect', async () => {
    const net = fetchOf({ [URL]: FREE });
    await readRuntimeStatus(net.fetchImpl, URL);
    expect(net.calls).toEqual([URL]);
    expect(net.signals[0]).toBeInstanceOf(AbortSignal);
  });
  it('gives unknown after 10 seconds when no answer comes, aborts the request, and leaves no timer', async () => {
    vi.useFakeTimers();
    const net = fetchOf({ [URL]: () => new Promise<Response>(() => undefined) });
    const outcome = readRuntimeStatus(net.fetchImpl, URL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toEqual({ kind: 'unknown', why: 'no complete answer came within 10 s' });
    expect(net.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
