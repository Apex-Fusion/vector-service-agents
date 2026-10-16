// agents/document-pipeline/test/source.test.ts
// Loading the document: an https URL through safeFetch (ruling R20: safeFetch wraps the injected fetch, so its rules hold whatever fetch is injected),
// or inline base64. What comes back is the exact bytes, their sha256, and a mime read from the first bytes and nothing else. Every refusal is a
// RequestError with the code and the 422 the service answers with, and every one happens before an escrow is posted.
// The URLs are https IP literals of the documentation range 203.0.113.0/24 (public for safeFetch, no host lookup, so no test depends on DNS).
import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sniffMime } from '../src/mime.ts';
import { loadSource, MAX_SOURCE_BYTES, SOURCE_FETCH_TIMEOUT_MS } from '../src/source.ts';
import { RequestError } from '../src/request.ts';
import type { PipelineRequest } from '../src/request.ts';
import { boom, hang, redirect, reply, routedFetch, stallsAfter, streamed } from './fake-fetch.ts';
import { JPEG, PAGE_0_PNG, TWO_PAGES_PDF, text, toBase64 } from './support.ts';

const URL_PDF = 'https://203.0.113.7/letter.pdf';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const urlRequest = (url: string): PipelineRequest => ({ source: { url }, task: 'summary', language: 'en', max_pages: 5 });
const inlineRequest = (source: PipelineRequest['source']): PipelineRequest => ({ source, task: 'summary', language: 'en', max_pages: 5 });
/** A fetch that serves `body` at URL_PDF with the given content type (none when undefined). */
const serving = (body: Uint8Array, contentType?: string) => routedFetch({ [`GET ${URL_PDF}`]: () => reply(200, body, contentType === undefined ? {} : { 'content-type': contentType }) });
/** What loadSource throws: the error itself, so that a test reads its code, status and message. */
async function refusal(promise: Promise<unknown>): Promise<RequestError> {
  try { await promise; } catch (e) { expect(e).toBeInstanceOf(RequestError); return e as RequestError; }
  throw new Error('loadSource accepted the source');
}
const PDF_PREFIX = text('%PDF-1.7\n');
const MIB = 1024 * 1024;

describe('the constants', () => {
  test('20 MB streamed cap and 60 s, as the spec says', () => {
    expect(MAX_SOURCE_BYTES).toBe(20_971_520);
    expect(SOURCE_FETCH_TIMEOUT_MS).toBe(60_000);
  });
});

describe('sniffMime: the first bytes decide', () => {
  test('lives in src/mime.ts, a module with no imports, which src/source.ts and src/render.ts both import: the renderer does not load the fetch of a source', () => {
    const src = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    expect(src('mime.ts')).not.toMatch(/^import /m);
    expect(src('render.ts')).toMatch(/^import \{ sniffMime \} from '\.\/mime\.ts';$/m);
    expect(src('render.ts')).not.toMatch(/^import \{[^}]*\} from '\.\/source\.ts';$/m);
    expect(src('source.ts')).toMatch(/^import \{ sniffMime \} from '\.\/mime\.ts';$/m);
  });

  test.each([
    ['%PDF-', text('%PDF-1.4\n'), 'application/pdf'],
    ['the PNG signature', PAGE_0_PNG, 'image/png'],
    ['FF D8 FF', JPEG, 'image/jpeg'],
    ['a bare %PDF-', text('%PDF-'), 'application/pdf'],
    ['the 8 signature bytes and nothing else', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['FF D8 FF and nothing else', Uint8Array.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  ])('%s', (_name, bytes, mime) => { expect(sniffMime(bytes)).toBe(mime); });

  test.each([
    ['nothing', new Uint8Array(0)], ['%PDF without its dash', text('%PDF')], ['a PDF with a line break in front of it', text('\n%PDF-1.4')], ['a PDF with a byte of junk in front of it', text('x%PDF-1.4')],
    ['a PDF header in lower case', text('%pdf-1.4')], ['a PNG cut after 4 bytes', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], ['a PNG whose line-ending bytes are wrong', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x0d, 0x1a, 0x0a])],
    ['a JPEG cut after 2 bytes', Uint8Array.from([0xff, 0xd8])], ['FF D8 and a wrong third byte', Uint8Array.from([0xff, 0xd8, 0x00])], ['a GIF', text('GIF89a')],
    ['a WebP', text('RIFF\0\0\0\0WEBPVP8 ')], ['a ZIP', Uint8Array.from([0x50, 0x4b, 0x03, 0x04])], ['an HTML page', text('<!doctype html><title>x</title>')], ['text', text('Dear sir')],
  ])('not a document: %s', (_name, bytes) => { expect(sniffMime(bytes)).toBeNull(); });
});

describe('loadSource: a URL', () => {
  test('a PDF: its bytes, its sha256, mime application/pdf, origin url, and one GET that follows no redirect and is bounded by a signal', async () => {
    const f = serving(TWO_PAGES_PDF, 'application/pdf');
    const source = await loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl });
    expect(source).toStrictEqual({ bytes: TWO_PAGES_PDF, mime: 'application/pdf', sha256: sha256(TWO_PAGES_PDF), origin: 'url' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: URL_PDF, redirect: 'manual' });
    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  test('the sha256 is the real digest of the bytes: a known answer for a body of 16 bytes', async () => {
    const source = await loadSource(urlRequest(URL_PDF), { fetchImpl: serving(text('%PDF-1.4\n%%EOF\n')).fetchImpl });
    expect(source.sha256).toBe('14bcd090baf31edba64e9cbd8cdfc15f943344aa72cb3675ad8e91bfcbce03ad');
  });

  test('a body arrives byte for byte, every byte value included: it is never read as text on the way (a text read would damage every byte above 127)', async () => {
    const everyByte = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
    const body = new Uint8Array(PDF_PREFIX.length + everyByte.length);
    body.set(PDF_PREFIX);
    body.set(everyByte, PDF_PREFIX.length);
    const source = await loadSource(urlRequest(URL_PDF), { fetchImpl: serving(body, 'application/pdf').fetchImpl });
    expect(source.bytes).toStrictEqual(body);
    expect(source.sha256).toBe(sha256(body));
    // and a real PNG, whose signature starts with the byte 0x89 that is not valid UTF-8
    const png = await loadSource(urlRequest(URL_PDF), { fetchImpl: serving(PAGE_0_PNG, 'image/png').fetchImpl });
    expect(png).toStrictEqual({ bytes: PAGE_0_PNG, mime: 'image/png', sha256: sha256(PAGE_0_PNG), origin: 'url' });
  });

  test('a JPEG', async () => {
    const source = await loadSource(urlRequest(URL_PDF), { fetchImpl: serving(JPEG, 'image/jpeg').fetchImpl });
    expect(source).toStrictEqual({ bytes: JPEG, mime: 'image/jpeg', sha256: sha256(JPEG), origin: 'url' });
  });

  test('the bytes are a plain Uint8Array of their own, whose buffer holds exactly them', async () => {
    const source = await loadSource(urlRequest(URL_PDF), { fetchImpl: serving(TWO_PAGES_PDF).fetchImpl });
    expect(Object.getPrototypeOf(source.bytes)).toBe(Uint8Array.prototype);
    expect(source.bytes.buffer.byteLength).toBe(source.bytes.length);
    expect(source.bytes.byteOffset).toBe(0);
  });

  test.each([
    ['no content type', undefined], ['application/octet-stream', 'application/octet-stream'], ['binary/octet-stream', 'binary/octet-stream'], ['text/plain', 'text/plain'],
    ['text/html', 'text/html; charset=utf-8'], ['a type nobody uses for it', 'application/x-pdf'], ['application/pdf', 'application/pdf'], ['application/pdf with a parameter', 'application/pdf; charset=binary'], ['application/pdf in capitals', 'APPLICATION/PDF'],
  ])('a PDF served with %s is a PDF: the header never decides the type, it can only contradict it', async (_name, contentType) => {
    const source = await loadSource(urlRequest(URL_PDF), { fetchImpl: serving(TWO_PAGES_PDF, contentType).fetchImpl });
    expect(source.mime).toBe('application/pdf');
  });

  test.each([
    ['a PNG served as application/pdf', PAGE_0_PNG, 'application/pdf', 'image/png', 'application/pdf'],
    ['a PNG served as application/pdf with a parameter', PAGE_0_PNG, 'application/pdf; charset=binary', 'image/png', 'application/pdf'],
    ['a PNG served as APPLICATION/PDF', PAGE_0_PNG, 'APPLICATION/PDF', 'image/png', 'application/pdf'],
    ['a PNG served as image/jpeg', PAGE_0_PNG, 'image/jpeg', 'image/png', 'image/jpeg'],
    ['a PDF served as image/png', TWO_PAGES_PDF, 'image/png', 'application/pdf', 'image/png'],
    ['a JPEG served as image/png', JPEG, 'image/png', 'image/jpeg', 'image/png'],
    ['a JPEG served as application/pdf', JPEG, 'application/pdf', 'image/jpeg', 'application/pdf'],
  ])('source_mime_mismatch: %s', async (_name, body, contentType, sniffed, claimed) => {
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: serving(body, contentType).fetchImpl }));
    expect(error).toMatchObject({ code: 'source_mime_mismatch', status: 422 });
    expect(error.message).toContain(sniffed);
    expect(error.message).toContain(claimed);
  });

  test.each([
    ['an HTML page', text('<!doctype html><title>Sign in</title>'), 'text/html'], ['an empty body', new Uint8Array(0), 'application/pdf'], ['text', text('Dear sir, ...'), 'text/plain'],
    ['a GIF', text('GIF89a......'), 'image/gif'], ['a WebP', text('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'], ['a ZIP', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'application/zip'],
    ['a PDF with junk in front of its header', text('\n\n%PDF-1.4\n'), 'application/pdf'], ['no content type and not a document', text('hello'), undefined],
  ])('source_unsupported: %s', async (_name, body, contentType) => {
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: serving(body, contentType).fetchImpl }));
    expect(error).toMatchObject({ code: 'source_unsupported', status: 422 });
    expect(error.message).toMatch(/PDF, PNG or JPEG/);
  });

  test.each([301, 302, 303, 307, 308])('a %i redirect is refused, not followed: one request, and the message says why', async (status) => {
    const f = routedFetch({ [`GET ${URL_PDF}`]: () => redirect(status), 'GET https://203.0.113.9/elsewhere.pdf': () => reply(200, TWO_PAGES_PDF) });
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl }));
    expect(error).toMatchObject({ code: 'source_fetch_failed', status: 422 });
    expect(error.message).toMatch(/redirect/);
    expect(f.calls.map((c) => c.url)).toStrictEqual([URL_PDF]);
  });

  test.each([[204], [206], [400], [401], [403], [404], [410], [429], [500], [502], [503]])('an answer of %i is source_fetch_failed, and the message has the status', async (status) => {
    const f = routedFetch({ [`GET ${URL_PDF}`]: () => reply(status, status === 204 ? null : TWO_PAGES_PDF) });
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl }));
    expect(error).toMatchObject({ code: 'source_fetch_failed', status: 422 });
    expect(error.message).toContain(String(status));
  });

  test('a body over 20 MB is source_too_large, and it is cut while it streams: the reader stops pulling and gives the connection up', async () => {
    const { response, stats } = streamed(Array(40).fill(MIB), { status: 200 }, PDF_PREFIX); // 40 MiB on offer
    const f = routedFetch({ [`GET ${URL_PDF}`]: () => response });
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl }));
    expect(error).toMatchObject({ code: 'source_too_large', status: 422 });
    expect(stats.pulls).toBeLessThanOrEqual(22); // 20 MiB is the cap: the 21st chunk crosses it
    expect(stats.pulls).toBeLessThan(40);
    expect(stats.cancelled).toBe(true);
  });

  test('exactly 20 MiB passes and one byte more does not (the default cap is 20971520 bytes)', async () => {
    const exact = streamed([...Array(20).fill(MIB)], { status: 200 }, PDF_PREFIX).response;
    const ok = await loadSource(urlRequest(URL_PDF), { fetchImpl: routedFetch({ [`GET ${URL_PDF}`]: () => exact }).fetchImpl });
    expect(ok.bytes.length).toBe(20_971_520);
    expect(ok.mime).toBe('application/pdf');
    const expected = new Uint8Array(20_971_520);
    expected.set(PDF_PREFIX);
    expect(ok.sha256).toBe(sha256(expected));
    const over = streamed([...Array(20).fill(MIB), 1], { status: 200 }, PDF_PREFIX).response;
    await expect(loadSource(urlRequest(URL_PDF), { fetchImpl: routedFetch({ [`GET ${URL_PDF}`]: () => over }).fetchImpl })).rejects.toMatchObject({ code: 'source_too_large' });
  });

  test('a content-length over the cap is refused before a byte of the body is read', async () => {
    const { response, stats } = streamed([1000], { status: 200, headers: { 'content-length': '30000000' } }, PDF_PREFIX);
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: routedFetch({ [`GET ${URL_PDF}`]: () => response }).fetchImpl }));
    expect(error).toMatchObject({ code: 'source_too_large', status: 422 });
    expect(stats.pulls).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  test('maxBytes lowers the cap, and the boundary is exact: a body of maxBytes passes, one more byte is refused', async () => {
    const body = new Uint8Array(100);
    body.set(PDF_PREFIX);
    await expect(loadSource(urlRequest(URL_PDF), { fetchImpl: serving(body).fetchImpl, maxBytes: 100 })).resolves.toMatchObject({ mime: 'application/pdf' });
    await expect(loadSource(urlRequest(URL_PDF), { fetchImpl: serving(new Uint8Array(101).fill(0x41)).fetchImpl, maxBytes: 100 })).rejects.toMatchObject({ code: 'source_too_large', status: 422 });
  });

  test('every address and scheme that safeFetch refuses is refused before the fetch is called', async () => {
    const f = routedFetch({});
    for (const url of [
      'http://203.0.113.7/letter.pdf', 'https://user:pw@203.0.113.7/letter.pdf', 'not a url', '',
      'https://10.0.0.5/letter.pdf', 'https://127.0.0.1/letter.pdf', 'https://169.254.169.254/latest/meta-data/', 'https://192.168.1.10/letter.pdf', 'https://100.64.0.1/letter.pdf',
      'https://[::1]/letter.pdf', 'https://[::ffff:10.0.0.1]/letter.pdf', 'https://[fe80::1]/letter.pdf',
    ]) {
      const error = await refusal(loadSource(urlRequest(url), { fetchImpl: f.fetchImpl }));
      expect(error, url).toMatchObject({ code: 'source_fetch_failed', status: 422 });
    }
    expect(f.calls).toHaveLength(0);
  });

  test('the reason is in the message, without the name of the code that refused it', async () => {
    const redirecting = routedFetch({ [`GET ${URL_PDF}`]: () => redirect(302) });
    const nothing = routedFetch({}).fetchImpl;
    const messages: Array<[RequestError, string]> = [
      [await refusal(loadSource(urlRequest('http://203.0.113.7/a.pdf'), { fetchImpl: nothing })), 'only https URLs are allowed'],
      [await refusal(loadSource(urlRequest('https://10.0.0.5/a.pdf'), { fetchImpl: nothing })), 'resolves to a private or reserved address'],
      [await refusal(loadSource(urlRequest('not a url'), { fetchImpl: nothing })), 'malformed URL'],
      [await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: redirecting.fetchImpl })), 'redirect to https://203.0.113.9/elsewhere.pdf refused'],
    ];
    for (const [error, reason] of messages) {
      expect(error.message).toContain(reason);
      expect(error.message).not.toContain('safeFetch');
    }
  });

  test('a server that never answers is cut at the time limit', async () => {
    const f = routedFetch({ [`GET ${URL_PDF}`]: hang });
    const started = Date.now();
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl, timeoutMs: 40 }));
    expect(error).toMatchObject({ code: 'source_fetch_failed', status: 422 });
    expect(error.message).toMatch(/time/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a server that answers and then stalls in the middle of the body is cut at the same limit', async () => {
    const f = routedFetch({ [`GET ${URL_PDF}`]: (call) => stallsAfter(TWO_PAGES_PDF.subarray(0, 100), call) });
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl, timeoutMs: 40 }));
    expect(error).toMatchObject({ code: 'source_fetch_failed', status: 422 });
    expect(error.message).toMatch(/time/);
  });

  test('a dropped connection is source_fetch_failed, and the message keeps the cause (an address, a port) to itself', async () => {
    const f = routedFetch({ [`GET ${URL_PDF}`]: () => boom('fetch failed', new Error('connect ECONNREFUSED 10.1.2.3:443')) });
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl }));
    expect(error).toMatchObject({ code: 'source_fetch_failed', status: 422 });
    expect(error.message).toMatch(/network/);
    expect(error.message).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|443/);
  });

  test('what the server puts in a redirect cannot pose as another refusal: a Location that reads like the cap message is still a redirect', async () => {
    const f = routedFetch({ [`GET ${URL_PDF}`]: () => redirect(302, 'response of 99 bytes exceeds the 5 byte cap') });
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl }));
    expect(error).toMatchObject({ code: 'source_fetch_failed', status: 422 });
    expect(error.message).toMatch(/redirect/);
  });

  test('what the server puts in a redirect is clipped in the message', async () => {
    const f = routedFetch({ [`GET ${URL_PDF}`]: () => redirect(302, `https://203.0.113.9/${'x'.repeat(5000)}`) });
    const error = await refusal(loadSource(urlRequest(URL_PDF), { fetchImpl: f.fetchImpl }));
    expect(error.code).toBe('source_fetch_failed');
    expect(error.message.length).toBeLessThan(400);
  });
});

describe('loadSource: an inline source', () => {
  const noFetch = routedFetch({});

  test('pdf_b64 decodes to the exact bytes, hashed, origin inline, with no fetch', async () => {
    const source = await loadSource(inlineRequest({ pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' }), { fetchImpl: noFetch.fetchImpl });
    expect(source).toStrictEqual({ bytes: TWO_PAGES_PDF, mime: 'application/pdf', sha256: sha256(TWO_PAGES_PDF), origin: 'inline' });
    expect(noFetch.calls).toHaveLength(0);
  });

  test('image_b64, PNG and JPEG', async () => {
    expect(await loadSource(inlineRequest({ image_b64: toBase64(PAGE_0_PNG), mime: 'image/png' }), { fetchImpl: noFetch.fetchImpl }))
      .toStrictEqual({ bytes: PAGE_0_PNG, mime: 'image/png', sha256: sha256(PAGE_0_PNG), origin: 'inline' });
    expect(await loadSource(inlineRequest({ image_b64: toBase64(JPEG), mime: 'image/jpeg' }), { fetchImpl: noFetch.fetchImpl }))
      .toStrictEqual({ bytes: JPEG, mime: 'image/jpeg', sha256: sha256(JPEG), origin: 'inline' });
  });

  test('the sha256 is a known answer here too, and the bytes are a plain Uint8Array of their own even when they are small', async () => {
    const source = await loadSource(inlineRequest({ pdf_b64: toBase64(text('%PDF-1.4\n%%EOF\n')), mime: 'application/pdf' }), { fetchImpl: noFetch.fetchImpl });
    expect(source.sha256).toBe('14bcd090baf31edba64e9cbd8cdfc15f943344aa72cb3675ad8e91bfcbce03ad');
    expect(Object.getPrototypeOf(source.bytes)).toBe(Uint8Array.prototype);
    expect(source.bytes.buffer.byteLength).toBe(source.bytes.length);
  });

  test.each([
    ['PNG bytes given as a PDF', { pdf_b64: toBase64(PAGE_0_PNG), mime: 'application/pdf' as const }, 'image/png', 'application/pdf'],
    ['JPEG bytes given as a PDF', { pdf_b64: toBase64(JPEG), mime: 'application/pdf' as const }, 'image/jpeg', 'application/pdf'],
    ['PDF bytes given as a PNG', { image_b64: toBase64(TWO_PAGES_PDF), mime: 'image/png' as const }, 'application/pdf', 'image/png'],
    ['PDF bytes given as a JPEG', { image_b64: toBase64(TWO_PAGES_PDF), mime: 'image/jpeg' as const }, 'application/pdf', 'image/jpeg'],
    ['JPEG bytes given as a PNG', { image_b64: toBase64(JPEG), mime: 'image/png' as const }, 'image/jpeg', 'image/png'],
    ['PNG bytes given as a JPEG', { image_b64: toBase64(PAGE_0_PNG), mime: 'image/jpeg' as const }, 'image/png', 'image/jpeg'],
  ])('source_mime_mismatch: %s', async (_name, source, sniffed, claimed) => {
    const error = await refusal(loadSource(inlineRequest(source), { fetchImpl: noFetch.fetchImpl }));
    expect(error).toMatchObject({ code: 'source_mime_mismatch', status: 422 });
    expect(error.message).toContain(sniffed);
    expect(error.message).toContain(claimed);
  });

  test('source_unsupported: bytes that are no PDF, PNG or JPEG, whatever the claim', async () => {
    for (const source of [
      { pdf_b64: toBase64(text('hello')), mime: 'application/pdf' as const }, { image_b64: toBase64(text('GIF89a......')), mime: 'image/png' as const },
      { image_b64: 'AAAA', mime: 'image/jpeg' as const }, { pdf_b64: '', mime: 'application/pdf' as const },
    ]) {
      expect(await refusal(loadSource(inlineRequest(source), { fetchImpl: noFetch.fetchImpl })), JSON.stringify(source)).toMatchObject({ code: 'source_unsupported', status: 422 });
    }
  });

  test('maxBytes bounds an inline source too', async () => {
    const request = inlineRequest({ pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' });
    await expect(loadSource(request, { fetchImpl: noFetch.fetchImpl, maxBytes: TWO_PAGES_PDF.length })).resolves.toMatchObject({ origin: 'inline' });
    await expect(loadSource(request, { fetchImpl: noFetch.fetchImpl, maxBytes: TWO_PAGES_PDF.length - 1 })).rejects.toMatchObject({ code: 'source_too_large', status: 422 });
  });
});
