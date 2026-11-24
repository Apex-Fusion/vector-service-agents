// All DNS tests use synthetic wire data and a fake fetch or HTTP/2 session.
import { decode, encode, RECURSION_DESIRED, TRUNCATED_RESPONSE } from '@dnsquery/dns-packet';
import type { Packet, TxtAnswer } from '@dnsquery/dns-packet';
import { EventEmitter } from 'node:events';
import { connect } from 'node:http2';
import type { ClientHttp2Session } from 'node:http2';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RESOLVERS, RESOLVER_TIMEOUT_MS, checkTxt, dohOverHttp2, dohUsingFetch } from '../lib/dns.ts';
import type { TxtCheck } from '../lib/dns.ts';

vi.mock('node:http2', () => ({ connect: vi.fn() }));

const NAME = '_did.demo.example';
const VALUE = `did:vector:${'ab'.repeat(32)}`;
const OTHER = `did:vector:${'cd'.repeat(32)}`;
const MIME = 'application/dns-message';
const QUESTION = { name: NAME, type: 'TXT', class: 'IN' } as const;
const NAMES = ['cloudflare', 'google', 'quad9'];
const QUAD9_URL = 'https://dns.quad9.net/dns-query';

// A fixed RFC 1035 response, independent of the test encoder. The answer owner points to the
// question at byte 12. The two TXT strings are "did=did:vector:" and the synthetic identifier.
const RECORDED = Buffer.from(
  '000081800001000100000000' + '045f6469640464656d6f076578616d706c650000100001'
  + 'c00c001000010000003c00510f6469643d6469643a766563746f723a40' + '6162'.repeat(32),
  'hex',
);
const OWNER_OFFSET = 35;
const RR_HEADER_OFFSET = OWNER_OFFSET + 2;

const txt = (data: TxtAnswer['data'] = VALUE, fields: Partial<TxtAnswer> = {}): TxtAnswer => ({ ...QUESTION, ttl: 60, data, ...fields });
const answer = (fields: Partial<Packet> = {}) => Buffer.from(encode({
  type: 'response', id: 0, flags: 0x0180, questions: [QUESTION], answers: [txt()], ...fields,
}));
const wordAt = (offset: number, value: number) => {
  const wire = Buffer.from(RECORDED);
  wire.writeUInt16BE(value, offset);
  return wire;
};

type Reply = { wire: Uint8Array<ArrayBuffer>; status?: number; mime?: string } | { fails: unknown } | { stalls: 'headers' | 'body' };
interface Call { url: URL; init?: RequestInit }

function fakeResolvers(replies: Partial<Record<string, Reply>> = {}, defaultReply: Reply = { wire: RECORDED }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const resolver = RESOLVERS.find((one) => new URL(one.url).origin === url.origin);
    if (resolver === undefined) throw new Error('not a test resolver');
    const reply = replies[resolver.name] ?? defaultReply;
    if ('fails' in reply) throw reply.fails;
    if ('stalls' in reply) {
      if (reply.stalls === 'headers') {
        return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
      }
      const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(RECORDED) });
      return new Response(body, { headers: { 'content-type': MIME } });
    }
    return new Response(reply.wire, { status: reply.status ?? 200, headers: { 'content-type': reply.mime ?? MIME, location: 'https://redirect.example/dns-query' } });
  };
  return { calls, lookup: dohUsingFetch(fetchImpl) };
}

const seen = (result: TxtCheck) => result.resolvers.map((one) => one.seen);

describe('registration DNS queries', () => {
  it('asks the three independent resolvers once, over the fixed HTTPS endpoints, with an RFC 8484 IN TXT query', async () => {
    const { calls, lookup } = fakeResolvers();
    expect(RESOLVER_TIMEOUT_MS).toBe(10_000);
    expect(await checkTxt(lookup, '_DID.Demo.Example.', VALUE)).toEqual({
      ok: true, resolvers: NAMES.map((resolver) => ({ resolver, seen: true, error: null })),
    });
    expect(calls.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([
      'https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query', QUAD9_URL,
    ]);
    for (const { url, init } of calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(new Headers(init?.headers).get('accept')).toBe(MIME);
      expect([...url.searchParams.keys()]).toEqual(['dns']);
      const query = url.searchParams.get('dns')!;
      expect(query).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decode(Buffer.from(query, 'base64url'))).toMatchObject({
        id: 0, type: 'query', flags: RECURSION_DESIRED, questions: [QUESTION],
        answers: [], authorities: [], additionals: [],
      });
    }
  });

  it.each(NAMES)('refuses when %s does not show the value, even when the other two show it', async (missing) => {
    const { calls, lookup } = fakeResolvers({ [missing]: { wire: answer({ answers: [] }) } });
    const result = await checkTxt(lookup, NAME, VALUE);
    expect(result.ok).toBe(false);
    expect(result.resolvers.map(({ seen: shown, resolver }) => [resolver, shown])).toEqual(NAMES.map((resolver) => [resolver, resolver !== missing]));
    expect(result.resolvers.find(({ resolver }) => resolver === missing)?.error).toContain('no TXT record');
    expect(calls).toHaveLength(3);
  });

  it('rejects invalid names and an empty value without a request', async () => {
    const { calls, lookup } = fakeResolvers();
    for (const name of ['', 'with a space', 'missing..label', `${'x'.repeat(64)}.example`, 'K.example']) {
      await expect(checkTxt(lookup, name, VALUE)).rejects.toBeInstanceOf(TypeError);
    }
    for (const value of ['', '  ']) await expect(checkTxt(lookup, NAME, value)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });
});

describe('DNS response binding', () => {
  it('accepts the fixed response, but refuses when its last TXT byte changes', async () => {
    expect((await checkTxt(fakeResolvers().lookup, NAME, VALUE)).ok).toBe(true);
    const wire = Buffer.from(RECORDED);
    wire[wire.length - 1] = 0x63;
    const result = await checkTxt(fakeResolvers({ quad9: { wire } }).lookup, NAME, VALUE);
    expect(result.ok).toBe(false);
    expect(seen(result)).toEqual([true, true, false]);
  });

  it('accepts a TXT reply with a glue owner compressed to the nameserver in NS RDATA', async () => {
    const headerAndAnswer = wordAt(8, 1); // One authority RR.
    headerAndAnswer.writeUInt16BE(1, 10); // One additional RR.
    const nsHeader = Buffer.from('c011000200010000003c0006', 'hex'); // demo.example IN NS.
    const nsName = Buffer.from('036e7331c011', 'hex'); // ns1.demo.example.
    const glue = Buffer.from('0000000100010000003c0004c0000201', 'hex'); // IN A 192.0.2.1.
    glue.writeUInt16BE(0xc000 | (headerAndAnswer.length + nsHeader.length), 0);
    const wire = Buffer.concat([headerAndAnswer, nsHeader, nsName, glue]);
    expect((await checkTxt(fakeResolvers({ quad9: { wire } }).lookup, NAME, VALUE)).ok).toBe(true);
  });

  it('compares all character strings of one record as bytes, not their presentation or separate records', async () => {
    const first = VALUE.slice(0, 20);
    const last = VALUE.slice(20);
    const accepted = answer({ questions: [{ ...QUESTION, name: NAME.toUpperCase() }], answers: [txt(OTHER), txt([first, last], { name: NAME.toUpperCase() })] });
    expect((await checkTxt(fakeResolvers({}, { wire: accepted }).lookup, NAME, VALUE)).ok).toBe(true);
    for (const records of [[txt(first), txt(last)], [txt([last, first])], [txt([VALUE, ' extra'])], [txt(` ${VALUE}`)], [txt(`"${VALUE}"`)], [txt(VALUE.toUpperCase())], [txt(OTHER)]]) {
      const result = await checkTxt(fakeResolvers({ quad9: { wire: answer({ answers: records }) } }).lookup, NAME, VALUE);
      expect(result.resolvers[2]?.error).toContain('no TXT record with this value');
      expect(result.resolvers[2]?.error).not.toContain(OTHER);
      expect(result.ok).toBe(false);
    }
  });

  it.each([
    ['different question name', answer({ questions: [{ ...QUESTION, name: '_did.other.example' }] }), 'wrong question'],
    ['different question class', wordAt(OWNER_OFFSET - 2, 3), 'wrong question'],
    ['different question type', wordAt(OWNER_OFFSET - 4, 1), 'wrong question'],
    ['two questions', answer({ questions: [QUESTION, QUESTION] }), 'one question'],
    ['different answer owner', answer({ answers: [txt(VALUE, { name: 'other.example' })] }), 'no TXT record'],
    ['different owner label boundaries', Buffer.concat([
      RECORDED.subarray(0, OWNER_OFFSET), Buffer.from([9]), Buffer.from('_did.demo'), Buffer.from([0xc0, 0x16]), RECORDED.subarray(RR_HEADER_OFFSET),
    ]), 'no TXT record'],
    ['different answer class', wordAt(RR_HEADER_OFFSET + 2, 0x8001), 'no TXT record'],
    ['different answer type', wordAt(RR_HEADER_OFFSET, 10), 'no TXT record'],
    ['TXT only in authority', answer({ answers: [], authorities: [txt()] }), 'no TXT record'],
    ['TXT only in additional', answer({ answers: [], additionals: [txt()] }), 'no TXT record'],
    ['different ID', wordAt(0, 1), 'wrong ID or flags'],
    ['a query instead of a response', wordAt(2, 0x0180), 'wrong ID or flags'],
    ['wrong opcode', wordAt(2, 0x8980), 'wrong ID or flags'],
    ['NXDOMAIN with matching TXT', wordAt(2, 0x8183), 'DNS status 3'],
    ['extended negative DNS status', Buffer.concat([wordAt(10, 1), Buffer.from('00002904d0010000000000', 'hex')]), 'DNS status 16'],
    ['truncation flag', wordAt(2, 0x8180 | TRUNCATED_RESPONSE), 'truncated'],
    ['truncated RDATA', RECORDED.subarray(0, -1), 'not a complete, valid DNS message'],
    ['invalid TXT length', wordAt(RR_HEADER_OFFSET + 10, 0xff64), 'not a complete, valid DNS message'],
    ['invalid compression pointer', wordAt(OWNER_OFFSET, 0xc003), 'not a complete, valid DNS message'],
    ['incorrect answer count', wordAt(6, 2), 'not a complete, valid DNS message'],
    ['trailing bytes', Buffer.concat([RECORDED, Buffer.from([0])]), 'not a complete, valid DNS message'],
    ['empty body', Buffer.alloc(0), 'not a complete, valid DNS message'],
  ] satisfies Array<[string, Uint8Array<ArrayBuffer>, string]>)('refuses %s', async (_label, wire, reason) => {
    const result = await checkTxt(fakeResolvers({ quad9: { wire } }).lookup, NAME, VALUE);
    expect(result.ok).toBe(false);
    expect(result.resolvers[2]?.error).toContain(reason);
  });
});

describe('DNS transport failures', () => {
  it.each([
    ['redirect', { wire: RECORDED, status: 301 }, 'HTTP status 301'],
    ['server error', { wire: RECORDED, status: 503 }, 'HTTP status 503'],
    ['wrong media type', { wire: RECORDED, mime: 'application/dns-json' }, 'not application/dns-message'],
    ['oversize wire response', { wire: Buffer.alloc(65_536) }, 'too long'],
    ['network error', { fails: new TypeError('fetch failed') }, 'fetch failed'],
    ['non-error failure', { fails: 'a text' }, 'a text'],
  ] satisfies Array<[string, Reply, string]>)('fails closed for %s', async (_label, reply, reason) => {
    const result = await checkTxt(fakeResolvers({ quad9: reply }).lookup, NAME, VALUE);
    expect(seen(result)).toEqual([true, true, false]);
    expect(result.resolvers[2]?.error).toContain(reason);
  });

  it.each(['headers', 'body'] as const)('enforces the deadline while waiting for %s', async (stalls) => {
    const result = await checkTxt(fakeResolvers({ quad9: { stalls } }).lookup, NAME, VALUE, { timeoutMs: 50 });
    expect(seen(result)).toEqual([true, true, false]);
    expect(result.resolvers[2]?.error).toContain('timed out');
  });
});

describe('live HTTP/2 transport (no socket)', () => {
  function session(alpn: string, status = 200, rstCode = 0) {
    const client = new EventEmitter();
    const stream = Object.assign(new PassThrough(), { rstCode });
    const request = vi.fn(() => {
      queueMicrotask(() => {
        stream.emit('response', { ':status': status, 'content-type': MIME });
        stream.write(RECORDED.subarray(0, 40));
        stream.end(RECORDED.subarray(40));
      });
      return stream;
    });
    const destroy = vi.fn(() => { stream.destroy(); client.emit('close'); });
    vi.mocked(connect).mockImplementationOnce(() => {
      queueMicrotask(() => client.emit('connect'));
      return Object.assign(client, { alpnProtocol: alpn, request, destroy }) as unknown as ClientHttp2Session;
    });
    return { request, destroy };
  }

  const url = new URL(`${QUAD9_URL}?dns=synthetic`);

  it('requires authenticated HTTP/2 for the exact Quad9 origin and reads a split wire body', async () => {
    const { request, destroy } = session('h2');
    await expect(dohOverHttp2(url, AbortSignal.timeout(1000))).resolves.toEqual(RECORDED);
    expect(connect).toHaveBeenLastCalledWith('https://dns.quad9.net', {
      ALPNProtocols: ['h2'], servername: 'dns.quad9.net', rejectUnauthorized: true, settings: { enablePush: false },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      { ':method': 'GET', ':authority': 'dns.quad9.net', ':path': '/dns-query?dns=synthetic', accept: MIME },
      { endStream: true },
    );
    expect(destroy).toHaveBeenCalled();
  });

  it.each([
    ['http/1.1', 200, 0, 'did not negotiate HTTP/2'],
    ['h2', 302, 0, 'HTTP status 302'],
    ['h2', 200, 8, 'did not complete'],
  ] as const)('refuses ALPN %s, status %i, reset %i unless it is a complete HTTP/2 success', async (alpn, status, rst, reason) => {
    const { request, destroy } = session(alpn, status, rst);
    await expect(dohOverHttp2(url, AbortSignal.timeout(1000))).rejects.toThrow(reason);
    expect(request).toHaveBeenCalledTimes(alpn === 'h2' ? 1 : 0);
    expect(destroy).toHaveBeenCalled();
  });
});
