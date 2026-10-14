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
    expect(row).toContain('a URL that is not https, a URL with credentials in it, a host that is or resolves to a loopback, private, link-local, CGNAT, benchmarking (198.18.0.0/15), multicast, class E (240.0.0.0/4), IETF protocol (192.0.0.0/24) or unspecified address (or an IPv6 site-local one; an IPv6 address in ::ffff:0:0/96 or 64:ff9b::/96 counts as the IPv4 address inside it, and one in ::/96 is refused whatever it carries), and redirects');
    expect(row).not.toMatch(/reserved/);
  });
  test('each of them is refused by the code', async () => {
    expect(() => assertSafeUrl('http://example.com/')).toThrow(/https/);
    expect(() => assertSafeUrl('https://user:pw@example.com/')).toThrow(/credentials/);
    const examples: Record<string, string[]> = {
      loopback: ['127.0.0.1', '::1'], private: ['10.0.0.1', '172.16.0.1', '192.168.0.1', 'fd00::1'], 'link-local': ['169.254.169.254', 'fe80::1'], CGNAT: ['100.64.0.1'],
      unspecified: ['0.0.0.0', '::'], 'site-local': ['fec0::1'], multicast: ['ff02::1', '224.0.0.1', '239.255.255.255'],
      benchmarking: ['198.18.0.1', '198.19.255.255'], 'class E': ['240.0.0.1', '255.255.255.255'], 'IETF protocol': ['192.0.0.1'],
    };
    for (const [kind, ips] of Object.entries(examples)) {
      expect(row, kind).toContain(kind);
      for (const ip of ips) expect(isPrivateAddress(ip), `${kind}: ${ip}`).toBe(true);
    }
    const redirect = (async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } })) as any;
    await expect(safeFetch('https://ok.example/', {}, { lookup, fetchImpl: redirect })).rejects.toThrow(/redirect/);
  });
  test('the sentence about an IPv4 address inside an IPv6 one is exact: mapped and NAT64 count as the address inside, all of ::/96 is refused', () => {
    for (const prefix of ['::ffff:0:0/96', '64:ff9b::/96', '::/96']) expect(row, prefix).toContain(prefix);
    // counts as the IPv4 address inside it: a private one inside is refused, a public one inside is not
    for (const ip of ['::ffff:10.0.0.1', '64:ff9b::10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['::ffff:8.8.8.8', '64:ff9b::8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
    // refused whatever it carries: the IPv4-compatible form of a public address is refused all the same
    for (const ip of ['::8.8.8.8', '::808:808', '::1.2.3.4', '::']) expect(isPrivateAddress(ip), ip).toBe(true);
  });
});

// Hardening made here first (the MCP server vendors this file): the budget covers the host lookup, and an address is judged by its range in whatever
// spelling it arrives. Injected lookup and fetch only, no network.
describe('safeFetch: the budget covers the host lookup', () => {
  const ok = (async () => new Response('x')) as any;
  test('a lookup that never answers is cut at the timeout with the same TimeoutError, and fetch is never reached', async () => {
    let fetched = false;
    const lookup = () => new Promise<never>(() => {});
    const f = (async () => { fetched = true; return new Response('x'); }) as any;
    const t0 = performance.now();
    await expect(safeFetch('https://slow.example/', {}, { lookup, timeoutMs: 30, fetchImpl: f })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(fetched).toBe(false);
  });
  test('the lookup and the fetch share one budget: a slow lookup leaves the fetch what is left of it', async () => {
    const lookup = () => new Promise<Array<{ address: string; family: number }>>((resolve) => setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 300));
    // a fetch that never answers and rejects with the signal reason, as the real one does
    const hang = (async (_u: any, init?: RequestInit) => new Promise((_ok, fail) => { const s = init!.signal!; if (s.aborted) fail(s.reason); s.addEventListener('abort', () => fail(s.reason), { once: true }); })) as any;
    const t0 = performance.now();
    await expect(safeFetch('https://slow.example/', {}, { lookup, timeoutMs: 600, fetchImpl: hang })).rejects.toMatchObject({ name: 'TimeoutError' });
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(520); // the whole budget was used
    expect(ms).toBeLessThan(850); // and not the lookup time on top of it (300 + 600)
  });
  test('a lookup that fails or answers after the budget is dropped: no unhandled rejection, no fetch', async () => {
    let fetched = false;
    const lookup = () => new Promise<never>((_ok, fail) => setTimeout(() => fail(new Error('the resolver answered late')), 80));
    const f = (async () => { fetched = true; return new Response('x'); }) as any;
    await expect(safeFetch('https://slow.example/', {}, { lookup, timeoutMs: 20, fetchImpl: f })).rejects.toMatchObject({ name: 'TimeoutError' });
    await new Promise((r) => setTimeout(r, 200)); // the late failure arrives; the test run fails if it is unhandled
    expect(fetched).toBe(false);
  });
  test('a lookup that answers in time is untouched by the budget; the host is what the lookup was asked for', async () => {
    const asked: string[] = [];
    const lookup = async (h: string) => { asked.push(h); return [{ address: '8.8.8.8', family: 4 }]; };
    await expect(safeFetch('https://ok.example/p', {}, { lookup, timeoutMs: 5_000, fetchImpl: ok })).resolves.toMatchObject({ status: 200, text: 'x' });
    expect(asked).toEqual(['ok.example']);
  });
});

describe('safeFetch: IPv6 literals are judged directly, with no lookup', () => {
  const mustNotLookUp = async () => { throw new Error('lookup must not be called for an address literal'); };
  const reached = () => { const urls: string[] = []; return { urls, f: (async (u: any) => { urls.push(String(u)); return new Response('x'); }) as any }; };
  test('URL.hostname keeps the brackets, and a literal of a private or special range is refused all the same', async () => {
    expect(new URL('https://[::1]/').hostname).toBe('[::1]'); // the reason for stripping them
    for (const host of ['[::1]', '[::]', '[fd00::1]', '[fe80::1]', '[fec0::1]', '[ff02::1]', '[::ffff:10.0.0.1]', '[::ffff:a9fe:a9fe]', '[::10.0.0.1]', '[64:ff9b::a00:1]', '[0:0:0:0:0:0:0:1]']) {
      const { urls, f } = reached();
      await expect(safeFetch(`https://${host}/x`, {}, { lookup: mustNotLookUp, fetchImpl: f }), host).rejects.toThrow(/private/);
      expect(urls, host).toEqual([]);
    }
  });
  test('a public IPv6 literal, and one that maps or translates to a public IPv4 address, goes straight to fetch', async () => {
    for (const host of ['[2606:4700::1111]', '[2001:4860:4860::8888]', '[::ffff:8.8.8.8]', '[64:ff9b::808:808]']) {
      const { urls, f } = reached();
      await expect(safeFetch(`https://${host}/p`, {}, { lookup: mustNotLookUp, fetchImpl: f }), host).resolves.toMatchObject({ status: 200 });
      expect(urls, host).toHaveLength(1);
    }
  });
  test('an address that comes back from the lookup is judged in whatever form the resolver gives it', async () => {
    for (const address of ['0:0:0:0:0:0:0:1', '::0001', '0:0:0:0:0:ffff:10.0.0.1', '::FFFF:A00:1', '::10.0.0.1', '64:ff9b::a00:1', 'FEC0::1', 'FF02::1']) {
      const lookup = async () => [{ address, family: 6 }];
      await expect(safeFetch('https://sneaky.example/', {}, { lookup, fetchImpl: (async () => new Response('x')) as any }), address).rejects.toThrow(/private/);
    }
    // One private answer among public ones is enough to refuse the host.
    const mixed = async () => [{ address: '2606:4700::1111', family: 6 }, { address: '::ffff:10.0.0.1', family: 6 }];
    await expect(safeFetch('https://sneaky.example/', {}, { lookup: mixed, fetchImpl: (async () => new Response('x')) as any })).rejects.toThrow(/private/);
  });
});

describe('isPrivateAddress reads every spelling of an IPv6 address', () => {
  test('loopback and unspecified, written out, padded or compressed', () => {
    for (const ip of ['::1', '0:0:0:0:0:0:0:1', '::0001', '0000:0000:0000:0000:0000:0000:0000:0001', '::', '0:0:0:0:0:0:0:0', '0::0']) expect(isPrivateAddress(ip), ip).toBe(true);
  });
  test('mapped and NAT64 addresses count as the IPv4 address inside them, and the compatible form is refused: dotted or in hex', () => {
    for (const ip of ['::ffff:10.0.0.1', '0:0:0:0:0:ffff:10.0.0.1', '::FFFF:A00:1', '::ffff:7f00:1', '::ffff:c0a8:101', '::ffff:ac10:1', '::ffff:a9fe:a9fe', '::ffff:6440:1', '::10.0.0.1', '::a00:1', '::127.0.0.1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1', '0064:ff9b:0:0:0:0:a00:1', '64:ff9b::7f00:1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '64:ff9b::8.8.8.8', '::ffff:172.32.0.1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  test('unique-local, link-local, site-local and multicast, in either case and with or without a zone', () => {
    for (const ip of ['fc00::1', 'fd00::1', 'FD00::1', 'fdff::1', 'fd00:0:0:0:0:0:0:1', 'fe80::1', 'FE80::1', 'febf::1', 'fe80::1%eth0', 'fec0::1', 'feff::1', 'ff00::', 'ff02::1', 'FF05::2']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['2606:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::', '2000::1', '3fff::1', 'fbff::1', 'fe7f::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  test('text that is not an address is refused, and the IPv4 rules of before still hold (the four new ranges have their own tests)', () => {
    for (const ip of ['', 'localhost', '[::1]', '1.2.3', '::g', '1:2:3:4:5:6:7:8:9', '1::2::3', 'example.com']) expect(isPrivateAddress(ip), JSON.stringify(ip)).toBe(true);
    for (const ip of ['0.0.0.0', '10.1.2.3', '100.127.255.255', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.253.0.1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

// The IPv4 ranges that are never a public host, one test for each. In each: the first, the last and some addresses in between are refused, the address just
// outside the range is not (where it is itself public), and the same addresses inside an IPv4-mapped (::ffff:a.b.c.d) and a NAT64 (64:ff9b::a.b.c.d)
// address are judged the same way, because those count as the IPv4 address they carry. The hex forms are checked against the dotted ones by hand:
// c000 0001 is 192.0.0.1, c612 is 198.18, c613 is 198.19, e000 is 224.0, efff is 239.255, f000 is 240.0.
describe('isPrivateAddress refuses the IPv4 ranges that are never a public host', () => {
  const refused = (ips: string[]) => { for (const ip of ips) expect(isPrivateAddress(ip), ip).toBe(true); };
  const allowed = (ips: string[]) => { for (const ip of ips) expect(isPrivateAddress(ip), ip).toBe(false); };
  test('192.0.0.0/24, the IETF protocol assignments', () => {
    refused(['192.0.0.0', '192.0.0.9', '192.0.0.170', '192.0.0.255', '::ffff:192.0.0.1', '::ffff:c000:1', '64:ff9b::c000:1', '64:ff9b::192.0.0.255']);
    allowed(['191.255.255.255', '192.0.1.0', '192.0.1.1', '::ffff:192.0.1.1', '::ffff:c000:101', '64:ff9b::c000:101']);
  });
  test('198.18.0.0/15, benchmarking', () => {
    refused(['198.18.0.0', '198.18.0.1', '198.19.0.1', '198.19.255.255', '::ffff:198.18.0.1', '::ffff:c612:1', '64:ff9b::c613:ffff']);
    allowed(['198.17.255.255', '198.20.0.0', '198.20.0.1', '::ffff:198.20.0.1', '::ffff:c614:1', '64:ff9b::c611:ffff']);
  });
  test('224.0.0.0/4, multicast', () => {
    refused(['224.0.0.0', '224.0.0.1', '224.0.0.251', '232.1.2.3', '239.255.255.255', '::ffff:224.0.0.1', '::ffff:e000:1', '64:ff9b::efff:ffff']);
    allowed(['223.255.255.255', '::ffff:223.255.255.255', '::ffff:dfff:ffff', '64:ff9b::dfff:ffff']);
  });
  test('240.0.0.0/4, class E, with the broadcast address; it follows the multicast range without a gap', () => {
    refused(['239.255.255.255', '240.0.0.0', '240.0.0.1', '248.1.2.3', '254.255.255.255', '255.255.255.255', '::ffff:240.0.0.1', '::ffff:f000:1', '::ffff:255.255.255.255', '64:ff9b::ffff:ffff']);
  });
  test('a host that is one of these addresses, or resolves to one, is refused before fetch; the public neighbours are not', async () => {
    const mustNotLookUp = async () => { throw new Error('lookup must not be called for an address literal'); };
    for (const ip of ['192.0.0.9', '198.18.0.1', '224.0.0.251', '255.255.255.255']) {
      let fetched = false;
      const f = (async () => { fetched = true; return new Response('x'); }) as any;
      await expect(safeFetch(`https://${ip}/x`, {}, { lookup: mustNotLookUp, fetchImpl: f }), ip).rejects.toThrow(/private/);
      await expect(safeFetch('https://sneaky.example/', {}, { lookup: async () => [{ address: ip, family: 4 }], fetchImpl: f }), ip).rejects.toThrow(/private/);
      expect(fetched, ip).toBe(false);
    }
    for (const ip of ['192.0.1.1', '198.20.0.1', '223.255.255.255']) {
      await expect(safeFetch(`https://${ip}/x`, {}, { lookup: mustNotLookUp, fetchImpl: (async () => new Response('x')) as any }), ip).resolves.toMatchObject({ status: 200 });
    }
  });
});

describe('safeFetch keeps its own redirect policy', () => {
  test('a caller redirect option cannot defeat redirect: manual, because the module\'s own init wins', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const seen: Array<RequestInit | undefined> = [];
    const f = (async (_u: any, init?: RequestInit) => { seen.push(init); return new Response('', { status: 302, headers: { location: 'http://evil.example/' } }); }) as any;
    for (const redirect of ['follow', 'error'] as const) {
      await expect(safeFetch('https://ok.example/', { redirect }, { lookup, fetchImpl: f }), redirect).rejects.toThrow(/redirect/);
      expect(seen.at(-1)?.redirect, redirect).toBe('manual');
    }
    expect(seen).toHaveLength(2);
  });
});
