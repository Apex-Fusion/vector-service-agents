// Vitest port of packages/builder/test/safe-fetch.test.ts (Plan A Task 7 Step 1; node:test -> vitest).
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertSafeUrl, isPrivateAddress, safeFetch } from '../src/safe-fetch.ts';

describe('safeFetch policy', () => {
  test('refuses non-https', () => { expect(() => assertSafeUrl('http://example.com/x')).toThrow(/https/); });
  test('refuses credentials in the URL', () => { expect(() => assertSafeUrl('https://user:pw@example.com/')).toThrow(/credentials/); });
  test('classifies private and special ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  test('refuses a host that resolves to a private address', async () => {
    const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
    await expect(safeFetch('https://metadata.example/', {}, { lookup, fetchImpl: (async () => new Response('x')) as any })).rejects.toThrow(/private/);
  });
  test('caps the response size', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const big = 'a'.repeat(5000);
    await expect(safeFetch('https://ok.example/', {}, { lookup, maxResponseBytes: 1000, fetchImpl: (async () => new Response(big)) as any })).rejects.toThrow(/exceeds/);
  });
  test('refuses cross-scheme redirects', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const f = (async () => new Response('', { status: 302, headers: { location: 'http://evil.example/' } })) as any;
    await expect(safeFetch('https://ok.example/', {}, { lookup, fetchImpl: f })).rejects.toThrow(/redirect/);
  });
  // Local additions: the Plan A suite has no success-path test and never checks that redirect: 'manual' reaches fetch.
  test('passes the caller init through with redirect: manual and returns status, headers and text', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    let seen: RequestInit | undefined;
    const f = (async (_u: any, init?: RequestInit) => { seen = init; return new Response('hello', { status: 200, headers: { 'x-k': 'v' } }); }) as any;
    const res = await safeFetch('https://ok.example/p', { method: 'POST', body: 'req' }, { lookup, fetchImpl: f });
    expect(res.status).toBe(200);
    expect(res.text).toBe('hello');
    expect(res.headers.get('x-k')).toBe('v');
    expect(seen?.redirect).toBe('manual');
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('req');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
  test('checks an IP-literal host directly, without a lookup', async () => {
    const lookup = async () => { throw new Error('lookup must not be called'); };
    const f = (async () => new Response('x')) as any;
    await expect(safeFetch('https://169.254.169.254/latest/meta-data', {}, { lookup, fetchImpl: f })).rejects.toThrow(/private/);
  });
});

// Hardening (made here first; PR 3 vendors it): the byte cap must hold while the body streams in, not after
// the whole body has been buffered, because Task 4 points safeFetch at endpoints a registrant controls.
describe('safeFetch body cap and abort handling', () => {
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  const URL_ = 'https://ok.example/';
  // A pull-driven body of the given chunk sizes that counts pulls and notes a cancel.
  const countedBody = (sizes: number[], strategy?: QueuingStrategy<Uint8Array>) => {
    const seen = { pulls: 0, cancelled: false };
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { seen.pulls++; if (next < sizes.length) c.enqueue(new Uint8Array(sizes[next++]).fill(97)); else c.close(); },
      cancel() { seen.cancelled = true; },
    }, strategy);
    return { body, seen };
  };

  test('stops reading and cancels the body once the running total passes the cap', async () => {
    const { body, seen } = countedBody(Array(100).fill(1_000));
    const f = (async () => new Response(body)) as any;
    await expect(safeFetch(URL_, {}, { lookup, maxResponseBytes: 2_500, fetchImpl: f })).rejects.toThrow(/exceeds the 2500 byte cap/);
    expect(seen.pulls).toBeLessThanOrEqual(4);
    expect(seen.cancelled).toBe(true);
  });

  test('refuses a content-length above the cap before pulling any body byte', async () => {
    // highWaterMark 0: no look-ahead, so a pull can only come from a read of the body
    const { body, seen } = countedBody(Array(100).fill(1_000), { highWaterMark: 0 });
    const f = (async () => new Response(body, { headers: { 'content-length': '10000' } })) as any;
    await expect(safeFetch(URL_, {}, { lookup, maxResponseBytes: 1_000, fetchImpl: f })).rejects.toThrow(/response of 10000 bytes exceeds the 1000 byte cap/);
    expect(seen.pulls).toBe(0);
    expect(seen.cancelled).toBe(true);
  });

  test('a refused redirect cancels its unread body instead of leaving the connection open', async () => {
    // highWaterMark 0: no look-ahead, so a pull can only come from a read of the body
    const { body, seen } = countedBody(Array(100).fill(1_000), { highWaterMark: 0 });
    const f = (async () => new Response(body, { status: 302, headers: { location: 'http://evil.example/' } })) as any;
    await expect(safeFetch(URL_, {}, { lookup, fetchImpl: f })).rejects.toThrow(/redirect/);
    expect(seen.pulls).toBe(0);
    expect(seen.cancelled).toBe(true);
  });

  test('a body of exactly the cap resolves, one byte more does not', async () => {
    const plain = await safeFetch(URL_, {}, { lookup, maxResponseBytes: 1_000, fetchImpl: (async () => new Response('a'.repeat(1_000))) as any });
    expect(plain.text).toBe('a'.repeat(1_000));
    // streamed in two chunks with an honest content-length: neither the header check nor the running total may trip
    const exact = countedBody([500, 500]);
    const ok = await safeFetch(URL_, {}, { lookup, maxResponseBytes: 1_000, fetchImpl: (async () => new Response(exact.body, { headers: { 'content-length': '1000' } })) as any });
    expect(ok.text).toBe('a'.repeat(1_000));
    expect(exact.seen.cancelled).toBe(false);
    const over = countedBody([500, 501, 500]); // a third chunk keeps the source open, so there is something left to cancel
    await expect(safeFetch(URL_, {}, { lookup, maxResponseBytes: 1_000, fetchImpl: (async () => new Response(over.body)) as any })).rejects.toThrow(/exceeds/);
    expect(over.seen.cancelled).toBe(true);
  });

  test('a null body (204) yields empty text, and multi-byte text split across chunks survives', async () => {
    const empty = await safeFetch(URL_, {}, { lookup, fetchImpl: (async () => new Response(null, { status: 204 })) as any });
    expect(empty).toMatchObject({ status: 204, text: '' });
    const euro = new TextEncoder().encode('€uro'); // 0xE2 0x82 0xAC then ASCII: split inside the first character
    const split = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(euro.slice(0, 1)); c.enqueue(euro.slice(1, 2)); c.enqueue(euro.slice(2)); c.close(); } }));
    expect((await safeFetch(URL_, {}, { lookup, fetchImpl: (async () => split) as any })).text).toBe('€uro');
  });

  test('an already-aborted caller signal reaches fetch and makes safeFetch reject', async () => {
    const ac = new AbortController();
    ac.abort(new Error('caller gave up'));
    let received: AbortSignal | undefined;
    // behave like fetch: refuse to start on an aborted signal
    const f = (async (_u: any, init?: RequestInit) => { received = init?.signal ?? undefined; init?.signal?.throwIfAborted(); return new Response('x'); }) as any;
    await expect(safeFetch(URL_, { signal: ac.signal }, { lookup, fetchImpl: f })).rejects.toThrow('caller gave up');
    expect(received?.aborted).toBe(true);
  });

  test('a caller signal does not displace the timeout, and aborting it mid-call still stops the call', async () => {
    // a fetch that never answers and rejects with the signal reason, as the real one does
    const hang = (entered = () => {}) => (async (_u: any, init?: RequestInit) => new Promise((_ok, fail) => {
      const s = init!.signal!;
      if (s.aborted) return fail(s.reason);
      s.addEventListener('abort', () => fail(s.reason), { once: true });
      entered();
    })) as any;
    await expect(safeFetch(URL_, { signal: new AbortController().signal }, { lookup, timeoutMs: 20, fetchImpl: hang() })).rejects.toMatchObject({ name: 'TimeoutError' });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const ac = new AbortController();
    const pending = safeFetch(URL_, { signal: ac.signal }, { lookup, fetchImpl: hang(entered) });
    await started;
    ac.abort(new Error('caller stopped it'));
    await expect(pending).rejects.toThrow('caller stopped it');
  });
});

// Local to this repo: specs/agent-history.md says exactly what safeFetch refuses. Each thing it lists is refused by the code.
describe('what specs/agent-history.md says safeFetch refuses', () => {
  const spec = readFileSync(new URL('../../../specs/agent-history.md', import.meta.url), 'utf8');
  const row = spec.split('\n').find((l) => l.startsWith("| the subject agent's own endpoint |")) ?? '';
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  test('the spec lists the refusals by name and does not call them "private or reserved"', () => {
    expect(row).toContain('a URL that is not https, a URL with credentials in it, a host that is or resolves to a loopback, private, link-local, CGNAT or unspecified address, and redirects');
    expect(row).not.toMatch(/reserved/);
  });
  test('each of them is refused by the code', async () => {
    expect(() => assertSafeUrl('http://example.com/')).toThrow(/https/);
    expect(() => assertSafeUrl('https://user:pw@example.com/')).toThrow(/credentials/);
    const examples: Record<string, string[]> = { loopback: ['127.0.0.1', '::1'], private: ['10.0.0.1', '172.16.0.1', '192.168.0.1', 'fd00::1'], 'link-local': ['169.254.169.254', 'fe80::1'], CGNAT: ['100.64.0.1'], unspecified: ['0.0.0.0', '::'] };
    for (const [kind, ips] of Object.entries(examples)) {
      expect(row, kind).toContain(kind);
      for (const ip of ips) expect(isPrivateAddress(ip), `${kind}: ${ip}`).toBe(true);
    }
    const redirect = (async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } })) as any;
    await expect(safeFetch('https://ok.example/', {}, { lookup, fetchImpl: redirect })).rejects.toThrow(/redirect/);
  });
});
