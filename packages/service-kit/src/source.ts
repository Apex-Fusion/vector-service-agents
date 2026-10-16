// packages/service-kit/src/source.ts
// Loading what a request names by URL: safeFetch (https only, no credentials, private and reserved addresses refused, redirects refused, the body read to a byte
// cap while it streams, one time budget for the whole call, the host lookup included) around the fetch the service is given. The URL comes from the person
// who hired the service, so none of that is optional. safeFetch hands back the body as text, which would replace every byte above 127 of a binary file, so the
// fetch it calls is a thin tap: it passes the body through chunk by chunk, only as fast as safeFetch reads it, and keeps a copy of what went by. safeFetch
// stays the one that enforces the cap, the budget and the status; the tap only remembers. Moved from agents/document-pipeline/src/source.ts; every refusal
// is made by the service's own `refuse`, with these words.
import { createHash } from 'node:crypto';
import { safeFetch } from '@vsa/vector-read';
import { clip } from './text.ts';

export type SourceRefusal = 'source_fetch_failed' | 'source_too_large';
export interface UrlBytes { bytes: Uint8Array; contentType: string | null }
export interface UrlFetchOptions {
  /** The fetch safeFetch calls once it has vetted the host. A service passes the platform fetch; a test passes a fake. */
  fetchImpl: typeof fetch;
  /** The most bytes the body may have. */
  maxBytes: number;
  /** The budget of the whole fetch, the host lookup included. */
  timeoutMs: number;
  /** Makes the service's refusal for a code and its words. */
  refuse: (code: SourceRefusal, message: string) => Error;
}

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

const SAFE_FETCH_PREFIX = 'safeFetch: ';
// The two sentences safeFetch refuses an oversized body with (a content-length over the cap, and a body that crosses it while streaming). Anchored on
// both ends: its other messages repeat text of the far end (the Location of a redirect), which must not be able to pose as this one.
const OVER_THE_CAP = /^safeFetch: response of (?:at least )?\d+ bytes exceeds the \d+ byte cap$/;

/** What a failed safeFetch becomes. Its policy refusals say why and are passed on; a network failure is not described, because its cause can name an address. */
function fetchFailure(error: unknown, maxBytes: number, refuse: UrlFetchOptions['refuse']): Error {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  const message = error instanceof Error ? error.message : '';
  if (OVER_THE_CAP.test(message)) return refuse('source_too_large', `the source is larger than ${maxBytes} bytes`);
  if (name === 'TimeoutError' || name === 'AbortError') return refuse('source_fetch_failed', 'could not fetch the source: the server did not finish answering within the time limit');
  if (message.startsWith(SAFE_FETCH_PREFIX)) return refuse('source_fetch_failed', `could not fetch the source: ${clip(message.slice(SAFE_FETCH_PREFIX.length), 200)}`);
  return refuse('source_fetch_failed', 'could not fetch the source: network error');
}

/** The body of a 200 at `url`, byte for byte, and the Content-Type the server sent. Any other answer, and any failure, is a refusal made by `refuse`. */
export async function fetchUrlBytes(url: string, opts: UrlFetchOptions): Promise<UrlBytes> {
  const tap = tapBody(opts.fetchImpl);
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(url, {}, { fetchImpl: tap.fetch, maxResponseBytes: opts.maxBytes, timeoutMs: opts.timeoutMs });
  } catch (error) {
    throw fetchFailure(error, opts.maxBytes, opts.refuse);
  }
  if (res.status !== 200) throw opts.refuse('source_fetch_failed', `could not fetch the source: the server answered ${res.status}`);
  return { bytes: tap.bytes(), contentType: res.headers.get('content-type') };
}

/** The sha256 of the bytes, as hex: what a result commits to as source.sha256. */
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
