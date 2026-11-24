// The public TXT check: three resolvers over DNS-over-HTTPS, each asked once, and a value that counts only when all three show it. A fake `fetch` stands for the resolvers, so no test uses the
// network or a real DNS server. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { RESOLVERS, RESOLVER_TIMEOUT_MS, checkTxt } from '../lib/dns.ts';
import type { TxtCheck } from '../lib/dns.ts';

const NAME = '_did.demo.example';
const VALUE = `did:vector:${'ab'.repeat(32)}`;
const OTHER = `did:vector:${'cd'.repeat(32)}`;
const NAMES = RESOLVERS.map((resolver) => resolver.name);

/** What a resolver does for one call: it answers with a body and a status, or its call fails with an error, or it never answers until the call is aborted. */
type Behaviour = { body: string; status?: number } | { fails: unknown } | { hangs: true };
interface Call { resolver: string; url: URL; accept: string | null; signal: AbortSignal | undefined; redirect: RequestRedirect | undefined }

/** The body of a DNS-over-HTTPS answer with TXT records. A text in `data` is the text of one record, as a resolver writes it (with its quotes). */
const answer = (...data: string[]): string => JSON.stringify({ Status: 0, Answer: data.map((text) => ({ name: NAME, type: 16, TTL: 60, data: text })) });
/** The text of a record that holds one character string, with the quotes that Cloudflare writes. */
const quoted = (text: string): string => `"${text}"`;

/** A `fetch` that stands for the three resolvers. `behave` says what each resolver does, by name. A resolver that is not named answers like all three do in the base case: with the value. */
function resolvers(behave: Partial<Record<string, Behaviour>> = {}, base: Behaviour = { body: answer(quoted(VALUE)) }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const resolver = RESOLVERS.find((one) => new URL(one.url).host === url.host);
    if (resolver === undefined) throw new Error('the test fetch was asked for a host that is no resolver');
    const headers = new Headers(init?.headers);
    calls.push({ resolver: resolver.name, url, accept: headers.get('accept'), signal: init?.signal ?? undefined, redirect: init?.redirect });
    const what = behave[resolver.name] ?? base;
    if ('fails' in what) throw what.fails;
    if ('hangs' in what) {
      // The executor form: the library of the target (es2022) has no Promise.withResolvers.
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason); }); });
    }
    return new Response(what.body, { status: what.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const seen = (result: TxtCheck): boolean[] => result.resolvers.map((one) => one.seen);

describe('the resolvers', () => {
  it('are Cloudflare, Google and Quad9, and each is asked for 10 seconds at most', () => {
    expect(RESOLVERS.map((resolver) => [resolver.name, resolver.url])).toEqual([
      ['cloudflare', 'https://cloudflare-dns.com/dns-query'], ['google', 'https://dns.google/resolve'], ['quad9', 'https://dns.quad9.net:5053/dns-query'],
    ]);
    expect(RESOLVER_TIMEOUT_MS).toBe(10_000);
  });
});

describe('checkTxt: the call to each resolver', () => {
  it('asks each of the three resolvers once, with a GET that holds the name and the type TXT, the header accept for DNS JSON, a time limit and no redirect', async () => {
    const { fetchImpl, calls } = resolvers();
    await checkTxt(fetchImpl, NAME, VALUE);
    expect(calls.map((call) => call.resolver).sort()).toEqual([...NAMES].sort());
    for (const call of calls) {
      const resolver = RESOLVERS.find((one) => one.name === call.resolver)!;
      expect(`${call.url.origin}${call.url.pathname}`).toBe(resolver.url);
      expect([...call.url.searchParams.keys()].sort()).toEqual(['name', 'type']);
      expect(call.url.searchParams.get('name')).toBe(NAME);
      expect(call.url.searchParams.get('type')).toBe('TXT');
      expect(call.accept).toBe('application/dns-json');
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.redirect).toBe('manual');
    }
  });
  it('gives one answer for each resolver, in the order of the list, with its name', async () => {
    const result = await checkTxt(resolvers().fetchImpl, NAME, VALUE);
    expect(result.resolvers.map((one) => one.resolver)).toEqual(NAMES);
  });
});

describe('checkTxt: when the value counts', () => {
  it('is ok when all three resolvers show the value, and says for each that it was seen and has no error', async () => {
    const result = await checkTxt(resolvers().fetchImpl, NAME, VALUE);
    expect(result.ok).toBe(true);
    expect(result.resolvers).toEqual(NAMES.map((resolver) => ({ resolver, seen: true, error: null })));
  });
  for (const hidden of NAMES) {
    it(`is not ok when ${hidden} does not show the value, names it, and gives the reason of that resolver only`, async () => {
      const { fetchImpl, calls } = resolvers({ [hidden]: { body: JSON.stringify({ Status: 0 }) } });
      const result = await checkTxt(fetchImpl, NAME, VALUE);
      expect(result.ok).toBe(false);
      expect(result.resolvers.map((one) => [one.resolver, one.seen])).toEqual(NAMES.map((resolver) => [resolver, resolver !== hidden]));
      for (const one of result.resolvers) expect(one.error === null, one.resolver).toBe(one.resolver !== hidden);
      // The other two resolvers are asked as well: the answer of one resolver does not stop the others.
      expect(calls).toHaveLength(3);
    });
  }
  it('is not ok when only two of the three show the value', async () => {
    const result = await checkTxt(resolvers({ google: { body: JSON.stringify({ Status: 0 }) }, quad9: { body: JSON.stringify({ Status: 3 }) } }).fetchImpl, NAME, VALUE);
    expect(result.ok).toBe(false);
    expect(seen(result)).toEqual([true, false, false]);
  });
  it('counts a record that is the value, a record that is did= and the value, and a record with the value among other records', async () => {
    for (const data of [quoted(VALUE), quoted(`did=${VALUE}`), VALUE, `did=${VALUE}`, `  ${quoted(VALUE)}  `]) {
      const result = await checkTxt(resolvers({}, { body: answer(data) }).fetchImpl, NAME, VALUE);
      expect(result.ok, data).toBe(true);
    }
    const among = answer(quoted('v=spf1 -all'), quoted(OTHER), quoted(VALUE));
    expect((await checkTxt(resolvers({}, { body: among }).fetchImpl, NAME, VALUE)).ok).toBe(true);
  });
  it('does not count a record that only holds the value, or that is another form of it', async () => {
    const texts = [`${VALUE} extra`, `extra ${VALUE}`, `did:${VALUE}`, `DID=${VALUE}`, `did = ${VALUE}`, `did=did=${VALUE}`, VALUE.slice(0, -1), `${VALUE}0`, VALUE.toUpperCase(), ''];
    for (const text of texts) {
      const result = await checkTxt(resolvers({}, { body: answer(quoted(text)) }).fetchImpl, NAME, VALUE);
      expect(result.ok, JSON.stringify(text)).toBe(false);
      expect(seen(result), JSON.stringify(text)).toEqual([false, false, false]);
    }
  });
  it('joins the character strings of one record: a value in two strings counts, and a record of two strings that do not make the value does not', async () => {
    const cut = 20;
    const two = (head: string, tail: string): string => `${quoted(head)} ${quoted(tail)}`;
    expect((await checkTxt(resolvers({}, { body: answer(two(VALUE.slice(0, cut), VALUE.slice(cut))) }).fetchImpl, NAME, VALUE)).ok).toBe(true);
    expect((await checkTxt(resolvers({}, { body: answer(two(`did=${VALUE.slice(0, cut)}`, VALUE.slice(cut))) }).fetchImpl, NAME, VALUE)).ok).toBe(true);
    expect((await checkTxt(resolvers({}, { body: answer(three(VALUE.slice(0, 5), VALUE.slice(5, 30), VALUE.slice(30))) }).fetchImpl, NAME, VALUE)).ok).toBe(true);
    expect((await checkTxt(resolvers({}, { body: answer(two(VALUE.slice(cut), VALUE.slice(0, cut))) }).fetchImpl, NAME, VALUE)).ok).toBe(false);
    expect((await checkTxt(resolvers({}, { body: answer(two(VALUE.slice(0, cut), `${VALUE.slice(cut)}0`)) }).fetchImpl, NAME, VALUE)).ok).toBe(false);
    function three(a: string, b: string, c: string): string { return `${quoted(a)} ${quoted(b)} ${quoted(c)}`; }
  });
  it('trims the joined text, reads the escapes of a record, and counts a value that holds a colon written as a decimal escape', async () => {
    expect((await checkTxt(resolvers({}, { body: answer(quoted(` ${VALUE} `)) }).fetchImpl, NAME, VALUE)).ok).toBe(true);
    expect((await checkTxt(resolvers({}, { body: answer(quoted(VALUE.replaceAll(':', '\\058'))) }).fetchImpl, NAME, VALUE)).ok).toBe(true);
    expect((await checkTxt(resolvers({}, { body: answer(quoted(VALUE.replaceAll(':', '\\059'))) }).fetchImpl, NAME, VALUE)).ok).toBe(false);
    expect((await checkTxt(resolvers({}, { body: answer(quoted('say \\"hi\\" \\\\ now')) }).fetchImpl, NAME, 'say "hi" \\ now')).ok).toBe(true);
    expect((await checkTxt(resolvers({}, { body: answer('"never closed') }).fetchImpl, NAME, 'never closed')).ok).toBe(false);
  });
  it('does not count a TXT record for another DID, and does not write the other value into its reason', async () => {
    const result = await checkTxt(resolvers({ google: { body: answer(quoted(OTHER)) } }).fetchImpl, NAME, VALUE);
    expect(result.ok).toBe(false);
    const google = result.resolvers.find((one) => one.resolver === 'google')!;
    expect(google).toMatchObject({ seen: false });
    expect(google.error).toContain('no TXT record with this value');
    expect(google.error).not.toContain(OTHER);
    expect(result.resolvers.filter((one) => one.seen)).toHaveLength(2);
  });
  it('counts only TXT records: a record of another type that holds the value does not count', async () => {
    const body = JSON.stringify({ Status: 0, Answer: [{ name: NAME, type: 5, TTL: 60, data: VALUE }, { name: NAME, type: 16, TTL: 60 }, { name: NAME, type: 16, TTL: 60, data: 7 }, 'text', null] });
    const result = await checkTxt(resolvers({}, { body }).fetchImpl, NAME, VALUE);
    expect(seen(result)).toEqual([false, false, false]);
    const twin = JSON.stringify({ Status: 0, Answer: [{ name: NAME, type: 5, TTL: 60, data: 'other.example.' }, { name: NAME, type: 16, TTL: 60, data: quoted(VALUE) }] });
    expect((await checkTxt(resolvers({}, { body: twin }).fetchImpl, NAME, VALUE)).ok).toBe(true);
  });
});

describe('checkTxt: an answer that is no answer', () => {
  const NOT_SEEN: Array<[string, Behaviour, string]> = [
    ['no answer', { body: JSON.stringify({ Status: 0 }) }, 'no TXT record'],
    ['an empty list of answers', { body: JSON.stringify({ Status: 0, Answer: [] }) }, 'no TXT record'],
    ['a body that is not JSON', { body: 'not json at all' }, 'not JSON'],
    ['a body that is empty', { body: '' }, 'not JSON'],
    ['JSON that is not an object', { body: '[1, 2]' }, 'not a DNS answer'],
    ['JSON with no status', { body: JSON.stringify({ Answer: [{ type: 16, data: quoted(VALUE) }] }) }, 'not a DNS answer'],
    ['an answer that is no list', { body: JSON.stringify({ Status: 0, Answer: 'x' }) }, 'not a DNS answer'],
    ['the DNS status 3, no such name', { body: JSON.stringify({ Status: 3 }) }, 'DNS status 3'],
    ['the DNS status 2, a failure of the server', { body: JSON.stringify({ Status: 2 }) }, 'DNS status 2'],
    ['the DNS status 3 with a record that holds the value', { body: JSON.stringify({ Status: 3, Answer: [{ type: 16, data: quoted(VALUE) }] }) }, 'DNS status 3'],
    ['an HTTP status 503', { body: answer(quoted(VALUE)), status: 503 }, 'HTTP status 503'],
    ['an HTTP status 301', { body: answer(quoted(VALUE)), status: 301 }, 'HTTP status 301'],
    ['an HTTP status 404', { body: answer(quoted(VALUE)), status: 404 }, 'HTTP status 404'],
    ['a body that is far too long', { body: JSON.stringify({ Status: 0, Answer: [{ type: 16, data: quoted(`${'x'.repeat(2_000_000)}${VALUE}`) }] }) }, 'too long'],
  ];
  for (const [label, behaviour, phrase] of NOT_SEEN) {
    it(`is not seen for ${label}, with a reason that says so, and the twin that shows the value is seen`, async () => {
      const result = await checkTxt(resolvers({ google: behaviour }).fetchImpl, NAME, VALUE);
      const google = result.resolvers.find((one) => one.resolver === 'google')!;
      expect(google.seen).toBe(false);
      expect(google.error).toContain(phrase);
      expect(result.ok).toBe(false);
      expect(seen(await checkTxt(resolvers().fetchImpl, NAME, VALUE))).toEqual([true, true, true]);
    });
  }
});

describe('checkTxt: a call that fails', () => {
  it('is not seen for a timeout, with the reason, and the other resolvers are still asked', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { fetchImpl, calls } = resolvers({ quad9: { fails: timeout } });
    const result = await checkTxt(fetchImpl, NAME, VALUE);
    expect(result.ok).toBe(false);
    expect(seen(result)).toEqual([true, true, false]);
    expect(result.resolvers[2]!.error).toContain('timed out');
    expect(calls).toHaveLength(3);
    expect((await checkTxt(resolvers().fetchImpl, NAME, VALUE)).ok).toBe(true);
  });
  it('gives up on a resolver that never answers, when the time limit passes, and the other resolvers are not held back', async () => {
    const result = await checkTxt(resolvers({ cloudflare: { hangs: true } }).fetchImpl, NAME, VALUE, { timeoutMs: 5 });
    expect(result.ok).toBe(false);
    expect(seen(result)).toEqual([false, true, true]);
    expect(result.resolvers[0]!.error).toContain('timed out');
    // The same resolver, when it answers, is seen.
    expect((await checkTxt(resolvers().fetchImpl, NAME, VALUE, { timeoutMs: 5 })).ok).toBe(true);
  });
  it('is not seen for a network error, and never throws: all three can fail and the result says so', async () => {
    const down = (): Behaviour => ({ fails: new TypeError('fetch failed') });
    const result = await checkTxt(resolvers({ cloudflare: down(), google: down(), quad9: down() }).fetchImpl, NAME, VALUE);
    expect(result.ok).toBe(false);
    expect(seen(result)).toEqual([false, false, false]);
    for (const one of result.resolvers) expect(one.error).toContain('fetch failed');
  });
  it('is not seen when the call throws something that is no error, and never throws', async () => {
    const result = await checkTxt(resolvers({ google: { fails: 'a text' } }).fetchImpl, NAME, VALUE);
    expect(seen(result)).toEqual([true, false, true]);
    expect(result.resolvers[1]!.error).toContain('a text');
  });
});

describe('checkTxt: the arguments', () => {
  it('refuses a value or a name that is empty, before any call, so that an empty record can never match', async () => {
    const { fetchImpl, calls } = resolvers({}, { body: answer(quoted('')) });
    await expect(checkTxt(fetchImpl, NAME, '')).rejects.toBeInstanceOf(TypeError);
    await expect(checkTxt(fetchImpl, NAME, '   ')).rejects.toBeInstanceOf(TypeError);
    await expect(checkTxt(fetchImpl, '', VALUE)).rejects.toBeInstanceOf(TypeError);
    await expect(checkTxt(fetchImpl, 'a name with spaces', VALUE)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
    expect((await checkTxt(resolvers().fetchImpl, NAME, VALUE)).ok).toBe(true);
  });
  it('writes a name with odd characters into the query as text, and not as a part of the URL', async () => {
    const { fetchImpl, calls } = resolvers();
    await checkTxt(fetchImpl, '_did.a-b_c.example', VALUE);
    expect(calls[0]!.url.searchParams.get('name')).toBe('_did.a-b_c.example');
  });
});
