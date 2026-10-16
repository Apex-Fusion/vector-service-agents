// packages/service-kit/test/source.test.ts
// The loader of a URL: safeFetch around the fetch it is given, with a tap that keeps the bytes. The URLs are https IP literals of 203.0.113.0/24, public for
// safeFetch and with no host lookup.
import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { fetchUrlBytes, sha256Hex } from '../src/source.ts';
import type { SourceRefusal } from '../src/source.ts';

const URL_A = 'https://203.0.113.7/a.bin';
class Refusal extends Error { constructor(readonly code: SourceRefusal, message: string) { super(message); } }
const refuse = (code: SourceRefusal, message: string) => new Refusal(code, message);
const fetching = (answer: (init: RequestInit) => Response | Promise<Response>) => {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init: RequestInit = {}) => { calls.push(init); return answer(init); }) as typeof fetch;
  return { fetchImpl, calls };
};
const opts = (fetchImpl: typeof fetch, over: { maxBytes?: number; timeoutMs?: number } = {}) => ({ fetchImpl, maxBytes: over.maxBytes ?? 1024, timeoutMs: over.timeoutMs ?? 5000, refuse });
async function refused(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(Refusal); return e as Refusal; }
  throw new Error('the fetch was not refused');
}
/** A body of `sizes` chunks of zeros, made only as fast as the reader asks; `stats` counts the pulls and sees a cancel. */
function streamed(sizes: number[]) {
  const stats = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (stats.pulls >= sizes.length) { controller.close(); return; } controller.enqueue(new Uint8Array(sizes[stats.pulls])); stats.pulls += 1; },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, stats };
}

describe('fetchUrlBytes', () => {
  test('the bytes come back as they were sent, every byte value, with the content type, from one GET that follows no redirect', async () => {
    const all = Uint8Array.from({ length: 256 }, (_v, i) => i);
    const { fetchImpl, calls } = fetching(() => new Response(all, { status: 200, headers: { 'content-type': 'audio/mpeg; charset=x' } }));
    const got = await fetchUrlBytes(URL_A, opts(fetchImpl));
    expect(got.bytes).toStrictEqual(all);
    expect(got.contentType).toBe('audio/mpeg; charset=x');
    expect(calls).toHaveLength(1);
    expect(calls[0].redirect).toBe('manual');
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  test('a redirect, an answer other than 200 and a dropped connection are source_fetch_failed, in our words and with no address', async () => {
    const redirect = await refused(fetchUrlBytes(URL_A, opts(fetching(() => new Response(null, { status: 302, headers: { location: 'https://203.0.113.9/b' } })).fetchImpl)));
    expect([redirect.code, redirect.message]).toStrictEqual(['source_fetch_failed', 'could not fetch the source: redirect to https://203.0.113.9/b refused (redirects are not followed)']);
    const status = await refused(fetchUrlBytes(URL_A, opts(fetching(() => new Response('no', { status: 404 })).fetchImpl)));
    expect([status.code, status.message]).toStrictEqual(['source_fetch_failed', 'could not fetch the source: the server answered 404']);
    const dropped = await refused(fetchUrlBytes(URL_A, opts(fetching(() => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.1:443') }); }).fetchImpl)));
    expect([dropped.code, dropped.message]).toStrictEqual(['source_fetch_failed', 'could not fetch the source: network error']);
  });

  test('a body over maxBytes is source_too_large, cut while it streams; a content-length over it is refused before a byte is read', async () => {
    const { body, stats } = streamed([600, 600, 600, 600]);
    const over = await refused(fetchUrlBytes(URL_A, opts(fetching(() => new Response(body, { status: 200 })).fetchImpl, { maxBytes: 1000 })));
    expect([over.code, over.message]).toStrictEqual(['source_too_large', 'the source is larger than 1000 bytes']);
    expect(stats.pulls).toBeLessThan(4);
    expect(stats.cancelled).toBe(true);
    const declared = await refused(fetchUrlBytes(URL_A, opts(fetching(() => new Response('x', { status: 200, headers: { 'content-length': '5000' } })).fetchImpl, { maxBytes: 1000 })));
    expect(declared.code).toBe('source_too_large');
    expect((await fetchUrlBytes(URL_A, opts(fetching(() => new Response(new Uint8Array(1000), { status: 200 })).fetchImpl, { maxBytes: 1000 }))).bytes.length).toBe(1000);
  });

  test('one time limit covers the whole fetch: a server that never answers is source_fetch_failed', async () => {
    const hang = fetching((init) => new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); }));
    const late = await refused(fetchUrlBytes(URL_A, opts(hang.fetchImpl, { timeoutMs: 50 })));
    expect([late.code, late.message]).toStrictEqual(['source_fetch_failed', 'could not fetch the source: the server did not finish answering within the time limit']);
  });

  test('an address or a scheme that safeFetch refuses is refused before the fetch is called', async () => {
    for (const url of ['http://203.0.113.7/a', 'https://127.0.0.1/a', 'https://10.0.0.1/a', 'https://[::1]/a', 'https://user:pw@203.0.113.7/a']) {
      const { fetchImpl, calls } = fetching(() => new Response('x'));
      const e = await refused(fetchUrlBytes(url, opts(fetchImpl)));
      expect(e.code, url).toBe('source_fetch_failed');
      expect(calls, url).toHaveLength(0);
    }
  });

  test('sha256Hex is the hex digest of the bytes', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
