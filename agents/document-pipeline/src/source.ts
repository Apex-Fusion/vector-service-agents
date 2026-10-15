// agents/document-pipeline/src/source.ts
// Loading the document the request names: an https URL, or base64 carried in the request. What comes back is the exact bytes, their sha256 (the
// result commits to it as source.sha256) and a mime read from the first bytes. Nothing here posts an escrow: every refusal is a RequestError
// (422), thrown while the job has cost nothing.
//
// A URL is fetched through safeFetch, wrapped around the fetch that is injected (ruling R20): https only, no credentials, private and reserved
// addresses refused, redirects refused, the body read to a byte cap while it streams, one time budget for the whole call, the host lookup included.
// The URL comes from the person who hired the service, and the service has the buyer key, so none of that is optional.
//
// safeFetch hands back the body as UTF-8 text, which is right for the JSON it was written for and wrong for a PDF: every byte above 127 would be
// replaced and the document lost. So the fetch that safeFetch calls is a thin tap: it passes the body through chunk by chunk, only as fast as
// safeFetch reads it, and keeps a copy of what went by. safeFetch stays the one that enforces the cap, the budget and the status; the tap only
// remembers. It has no say, and nothing it keeps is used unless safeFetch returned.
import { createHash } from 'node:crypto';
import { safeFetch } from '@vsa/vector-read';
import { RequestError } from './request.ts';
import type { PipelineRequest } from './request.ts';

export interface SourceBytes {
  bytes: Uint8Array;
  mime: 'application/pdf' | 'image/png' | 'image/jpeg';
  sha256: string;
  origin: 'url' | 'inline';
}
export interface SourceDeps {
  /** The fetch safeFetch calls once it has vetted the host. Production passes the platform fetch; tests pass a fake. */
  fetchImpl: typeof fetch;
  /** The most bytes a source may have, fetched or inline. Default 20 MB. */
  maxBytes?: number;
  /** The budget of the whole fetch, the host lookup included. Default 60 s. */
  timeoutMs?: number;
}

/** 20 MB, as the spec says. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const SOURCE_FETCH_TIMEOUT_MS = 60_000;

type Mime = SourceBytes['mime'];
const MIMES: readonly string[] = ['application/pdf', 'image/png', 'image/jpeg'];
// The type of a document is what its first bytes say, at byte 0. A PDF with anything in front of its header is refused: the check is the same one for
// every type, and a file that is two things at once is the one to be suspicious of.
const SIGNATURES: ReadonlyArray<{ mime: Mime; magic: readonly number[] }> = [
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
];

/** The type named by the first bytes, or null when they are none of the three. */
export function sniffMime(bytes: Uint8Array): Mime | null {
  for (const { mime, magic } of SIGNATURES) if (bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte)) return mime;
  return null;
}

// Text that comes from the far end goes into a message cut short.
const clip = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max)}...` : s);

/**
 * A fetch that behaves as `inner` does and remembers the body of a 200. The body it hands on is pulled only when the reader asks (no read ahead), a
 * cancel by the reader is passed to the real body, and an error of the real body is the error of this one: the cap, the abort and the budget of
 * safeFetch work on it as they would on the real thing. Any answer but a 200 is passed on as it is.
 */
function tapBody(inner: typeof fetch): { fetch: typeof fetch; bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const tapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    if (res.body === null || res.status !== 200) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        chunks.push(value);
        total += value.byteLength;
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    }, { highWaterMark: 0 });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
  return {
    fetch: tapped,
    bytes: () => {
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
      chunks.length = 0;
      return out;
    },
  };
}

/** The type a Content-Type header claims, when it claims one of the three. Any other header (octet-stream, text/html, none) claims nothing. */
function claimedByHeader(header: string | null): Mime | null {
  const type = (header ?? '').split(';')[0].trim().toLowerCase();
  return MIMES.includes(type) ? (type as Mime) : null;
}

const SAFE_FETCH_PREFIX = 'safeFetch: ';
// The two sentences safeFetch refuses an oversized body with (a content-length over the cap, and a body that crosses it while streaming). Anchored on
// both ends: its other messages repeat text of the far end (the Location of a redirect), which must not be able to pose as this one.
const OVER_THE_CAP = /^safeFetch: response of (?:at least )?\d+ bytes exceeds the \d+ byte cap$/;
/** What a failed safeFetch becomes. Its policy refusals say why and are passed on; a network failure is not described, because its cause can name an address. */
function fetchFailure(error: unknown, maxBytes: number): RequestError {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  const message = error instanceof Error ? error.message : '';
  if (OVER_THE_CAP.test(message)) return new RequestError('source_too_large', `the source is larger than ${maxBytes} bytes`);
  if (name === 'TimeoutError' || name === 'AbortError') return new RequestError('source_fetch_failed', 'could not fetch the source: the server did not finish answering within the time limit');
  if (message.startsWith(SAFE_FETCH_PREFIX)) return new RequestError('source_fetch_failed', `could not fetch the source: ${clip(message.slice(SAFE_FETCH_PREFIX.length))}`);
  return new RequestError('source_fetch_failed', 'could not fetch the source: network error');
}

/** The checks both origins share: the first bytes name a supported type, and it is the type that was claimed, if anything claimed one. */
function describeSource(bytes: Uint8Array, claimed: Mime | null, claim: 'served as' | 'declared as', origin: SourceBytes['origin']): SourceBytes {
  const mime = sniffMime(bytes);
  if (mime === null) throw new RequestError('source_unsupported', 'the source is not a PDF, PNG or JPEG file (the type is read from the first bytes of the file)');
  if (claimed !== null && claimed !== mime) throw new RequestError('source_mime_mismatch', `the source is ${mime} but was ${claim} ${claimed}`);
  return { bytes, mime, sha256: createHash('sha256').update(bytes).digest('hex'), origin };
}

async function fromUrl(url: string, fetchImpl: typeof fetch, maxBytes: number, timeoutMs: number): Promise<SourceBytes> {
  const tap = tapBody(fetchImpl);
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(url, {}, { fetchImpl: tap.fetch, maxResponseBytes: maxBytes, timeoutMs });
  } catch (error) {
    throw fetchFailure(error, maxBytes);
  }
  if (res.status !== 200) throw new RequestError('source_fetch_failed', `could not fetch the source: the server answered ${res.status}`);
  return describeSource(tap.bytes(), claimedByHeader(res.headers.get('content-type')), 'served as', 'url');
}

function fromInline(base64: string, claimed: Mime, maxBytes: number): SourceBytes {
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length > maxBytes) throw new RequestError('source_too_large', `the source is larger than ${maxBytes} bytes`);
  // A copy: a small Buffer sits in a pool shared with other buffers, and its .buffer holds more than its bytes.
  return describeSource(new Uint8Array(decoded), claimed, 'declared as', 'inline');
}

/**
 * The document of a request. A URL is fetched under the rules above and an inline source is decoded. The mime is read from the first bytes. It is a
 * RequestError (source_mime_mismatch) when the bytes are a different supported type from the one the request declared (inline) or the server
 * served (a Content-Type that names one of the three), and source_unsupported when they are none of the three.
 */
export async function loadSource(req: PipelineRequest, deps: SourceDeps): Promise<SourceBytes> {
  const maxBytes = deps.maxBytes ?? MAX_SOURCE_BYTES;
  const { source } = req;
  if ('url' in source) return fromUrl(source.url, deps.fetchImpl, maxBytes, deps.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS);
  return fromInline('pdf_b64' in source ? source.pdf_b64 : source.image_b64, source.mime, maxBytes);
}
