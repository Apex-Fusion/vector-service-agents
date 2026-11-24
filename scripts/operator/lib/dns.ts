// Registration signs only when three independent public resolvers show the same TXT value.
// Do not look up the name before the operator publishes it. Resolvers can cache a negative answer.
import { RECURSION_DESIRED, TRUNCATED_RESPONSE, encode, txt } from '@dnsquery/dns-packet';
import { connect } from 'node:http2';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';

/** The resolver name for reports and its RFC 8484 endpoint. */
export interface Resolver { readonly name: string; readonly url: string }

export const RESOLVERS: readonly Resolver[] = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/dns-query' },
  { name: 'quad9', url: 'https://dns.quad9.net/dns-query' },
];

/** How long one resolver is asked, in milliseconds. */
export const RESOLVER_TIMEOUT_MS = 10_000;

/** What one resolver showed: `seen` is true when it shows the value, and `error` says why not when it does not. */
export interface ResolverAnswer { resolver: string; seen: boolean; error: string | null }

/** The result of the check: `ok` only when all three resolvers show the value. */
export interface TxtCheck { ok: boolean; resolvers: ResolverAnswer[] }

export type DohLookup = (url: URL, signal: AbortSignal) => Promise<Buffer>;

const DNS_MESSAGE = 'application/dns-message';
const MAX_MESSAGE_BYTES = 65_535; // RFC 8484 section 6.
const MAX_REASON_CHARS = 200;
const QUERY_ID = 0; // HTTP matches each response to its request (RFC 8484 section 4.1).
const HEADER_BYTES = 12;
const TXT = 16;
const OPT = 41;
const IN = 1;
const DNS_LABEL = /^[A-Za-z0-9_-]{1,63}$/;

function requireWireResponse(status: number | undefined, contentType: string | null | undefined): void {
  if (status !== 200) throw new Error(`the resolver answered with the HTTP status ${status ?? 'missing'}`);
  if (contentType?.trim().toLowerCase() !== DNS_MESSAGE) throw new Error('the HTTP answer is not application/dns-message');
}

async function readWireBody(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  let length = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > MAX_MESSAGE_BYTES) throw new Error('the answer is too long to read');
    chunks.push(chunk);
  }
  const first = chunks[0];
  return chunks.length === 1 && Buffer.isBuffer(first) ? first : Buffer.concat(chunks, length);
}

/** Use an injected fetch for the same wire requests, without opening a separate connection. */
export function dohUsingFetch(fetchImpl: typeof fetch): DohLookup {
  return async (url, signal) => {
    const response = await fetchImpl(url.href, { method: 'GET', headers: { accept: DNS_MESSAGE }, redirect: 'manual', signal });
    try {
      if (response.redirected) throw new Error('the resolver redirected the query');
      requireWireResponse(response.status, response.headers.get('content-type'));
      if (response.body === null) throw new Error('the HTTP answer has no body');
    } catch (err) {
      void response.body?.cancel().catch(() => undefined);
      throw err;
    }
    return readWireBody(Readable.fromWeb(response.body as ReadableStream<Uint8Array>, { signal }));
  };
}

/** Use verified TLS and HTTP/2. Do not follow redirects or fall back to another protocol. */
export const dohOverHttp2: DohLookup = (url, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  if (url.protocol !== 'https:') throw new Error('the resolver URL must use HTTPS');
  const client = connect(url.origin, {
    ALPNProtocols: ['h2'], servername: url.hostname, rejectUnauthorized: true, settings: { enablePush: false },
  });
  let closed = false;
  let sent = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', abort);
    client.destroy();
  };
  const fail = (error: unknown) => { reject(error); close(); };
  const abort = () => fail(signal.reason);
  const incomplete = () => new Error('the HTTP/2 answer did not complete');
  signal.addEventListener('abort', abort, { once: true });
  client.on('error', fail);
  client.once('close', () => { if (!sent && !closed) fail(incomplete()); });
  client.once('connect', () => {
    try {
      if (client.alpnProtocol !== 'h2') throw new Error('the resolver did not negotiate HTTP/2');
      const stream = client.request({
        ':method': 'GET', ':authority': url.host, ':path': `${url.pathname}${url.search}`, accept: DNS_MESSAGE,
      }, { endStream: true });
      sent = true;
      stream.on('error', fail);
      let answered = false;
      stream.once('close', () => { if (!answered || !stream.readableEnded || stream.rstCode !== 0) fail(incomplete()); });
      stream.once('response', (headers) => {
        try {
          const type = headers['content-type'];
          requireWireResponse(headers[':status'], typeof type === 'string' ? type : undefined);
          answered = true;
          void readWireBody(stream).then((body) => {
            if (stream.rstCode !== 0) fail(incomplete());
            else { resolve(body); close(); }
          }, fail);
        } catch (err) { fail(err); }
      });
    } catch (err) { fail(err); }
  });
});

/** Compare wire labels and accept compression only to label boundaries of earlier names. */
function readName(body: Buffer, start: number, expected: Buffer, known: Set<number>): { end: number; matches: boolean } {
  let at = start;
  let end: number | undefined;
  let used = 0;
  let matches = true;
  let jumps = 0;
  while (true) {
    const size = body.readUInt8(at);
    if ((size & 0xc0) === 0xc0) {
      const target = body.readUInt16BE(at) & 0x3fff;
      if (target >= start || !known.has(target) || ++jumps > 128) throw new Error('invalid DNS compression pointer');
      if (end === undefined) { known.add(at); end = at + 2; }
      at = start = target;
      continue;
    }
    if (size > 63 || used + size + 1 > 255 || at + size >= body.length) throw new Error('invalid DNS label');
    if (end === undefined) known.add(at);
    matches &&= size === expected[used];
    at += 1;
    used += 1;
    for (let i = 0; matches && i < size; i += 1) {
      const byte = body[at + i]!;
      matches = (byte >= 65 && byte <= 90 ? byte + 32 : byte) === expected[used + i];
    }
    at += size;
    used += size;
    if (size === 0) return { end: end ?? at, matches: matches && used === expected.length };
  }
}

function matchesTxt(chunks: readonly Uint8Array[], expected: Buffer): boolean {
  let at = 0;
  for (const chunk of chunks) {
    const end = at + chunk.length;
    if (!expected.subarray(at, end).equals(chunk)) return false;
    at = end;
  }
  return at === expected.length;
}

/** Check the DNS frame and count only complete TXT records in the answer for the exact question. */
function refusalOf(body: Buffer, name: Buffer, plain: Buffer, tagged: Buffer): string | null {
  try {
    const flags = body.readUInt16BE(2);
    if (body.readUInt16BE(0) !== QUERY_ID || (flags & 0xf840) !== 0x8000) return 'the DNS response has the wrong ID or flags';
    if ((flags & TRUNCATED_RESPONSE) !== 0) return 'the DNS answer is truncated';
    if ((flags & 15) !== 0) return `the answer has the DNS status ${flags & 15}`;
    if (body.readUInt16BE(4) !== 1) return 'the DNS response does not have one question';
    const answers = body.readUInt16BE(6);
    const authorities = body.readUInt16BE(8);
    const records = answers + authorities + body.readUInt16BE(10);
    const known = new Set<number>();
    const question = readName(body, HEADER_BYTES, name, known);
    if (!question.matches || body.readUInt16BE(question.end) !== TXT || body.readUInt16BE(question.end + 2) !== IN) {
      return 'the DNS response has the wrong question';
    }

    let position = question.end + 4;
    let count = 0;
    let found = false;
    let edns = false;
    for (let i = 0; i < records; i += 1) {
      const owner = readName(body, position, name, known);
      const type = body.readUInt16BE(owner.end);
      const klass = body.readUInt16BE(owner.end + 2);
      const end = owner.end + 10 + body.readUInt16BE(owner.end + 8);
      if (end > body.length) throw new Error('invalid DNS resource record length');
      if (type === OPT) {
        if (edns || i < answers + authorities || owner.end !== position + 1 || body[position] !== 0 || body[owner.end + 5] !== 0) {
          throw new Error('invalid DNS OPT record');
        }
        edns = true;
        const extended = body[owner.end + 4]!;
        if (extended !== 0) return `the answer has the DNS status ${extended << 4}`;
        for (let option = owner.end + 10; option < end;) {
          if (option + 4 > end) throw new Error('invalid DNS option length');
          option += 4 + body.readUInt16BE(option + 2);
          if (option > end) throw new Error('invalid DNS option length');
        }
      }
      if (type === TXT) {
        // The codec reads the length field followed by the character strings.
        const chunks = txt.decode(body.subarray(owner.end + 8, end));
        if (chunks.length === 0) throw new Error('missing DNS character string');
        if (i < answers && klass === IN && owner.matches) {
          count += 1;
          found ||= matchesTxt(chunks, plain) || matchesTxt(chunks, tagged);
        }
      }
      position = end;
    }
    if (position !== body.length) throw new Error('trailing bytes in DNS message');
    if (found) return null;
    if (count === 0) return 'the answer has no TXT record for this name and class';
    return `the answer has no TXT record with this value (${count} TXT record(s) of other values)`;
  } catch {
    return 'the body is not a complete, valid DNS message';
  }
}

async function ask(lookup: DohLookup, resolver: Resolver, query: string, name: Buffer, plain: Buffer, tagged: Buffer, timeoutMs: number): Promise<ResolverAnswer> {
  const url = new URL(resolver.url);
  url.searchParams.set('dns', query);
  const signal = AbortSignal.timeout(timeoutMs);
  let error: string | null;
  try {
    const body = await lookup(url, signal);
    signal.throwIfAborted();
    error = refusalOf(body, name, plain, tagged);
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, MAX_REASON_CHARS);
    error = signal.aborted || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
      ? `the resolver timed out after ${timeoutMs / 1000} s` : `the call failed (${reason})`;
  }
  return { resolver: resolver.name, seen: error === null, error };
}

/**
 * Asks the three public resolvers for the TXT records of `name`, all at the same time, and says for each whether it shows `value`. `ok` is true only when all three do. `options.timeoutMs`
 * changes the limit of 10 seconds for each resolver (a test uses a short one).
 */
export async function checkTxt(lookup: DohLookup, name: string, value: string, options: { timeoutMs?: number } = {}): Promise<TxtCheck> {
  if (typeof name !== 'string') throw new TypeError('checkTxt needs a DNS record name');
  const unrooted = name.replace(/\.$/, '');
  if (unrooted.length > 253 || !unrooted.split('.').every((label) => DNS_LABEL.test(label))) throw new TypeError('checkTxt needs a valid DNS record name');
  const canonical = unrooted.toLowerCase();
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('checkTxt needs a value that is not empty');
  const timeoutMs = options.timeoutMs ?? RESOLVER_TIMEOUT_MS;
  const encoded = encode({ type: 'query', id: QUERY_ID, flags: RECURSION_DESIRED, questions: [{ name: canonical, type: 'TXT', class: 'IN' }] });
  const wire = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const query = wire.toString('base64url');
  const owner = wire.subarray(HEADER_BYTES, -4);
  const plain = Buffer.from(value);
  const tagged = Buffer.from(`did=${value}`);
  const resolvers = await Promise.all(RESOLVERS.map((resolver) => ask(lookup, resolver, query, owner, plain, tagged, timeoutMs)));
  return { ok: resolvers.every((one) => one.seen), resolvers };
}
