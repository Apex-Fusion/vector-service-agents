// agents/document-pipeline/test/fake-fetch.ts
// A fake fetch for the source tests. It answers by "METHOD url" from a table, records every call, and, unlike the text-based fake of
// packages/buyer-core/test/fake-fetch.ts, it keeps a body as bytes: a PDF or a PNG must reach the code under test byte for byte, and a fake that
// reads a body as text first would hide the very bug these tests are for. An unrouted call is answered 404 and recorded, so a test sees it in `calls`.
// The URLs of the tests are https IP literals of the documentation range 203.0.113.0/24: public for safeFetch, and no host lookup, so no test
// depends on DNS (ruling R20).
export interface SeenCall { method: string; url: string; redirect: RequestRedirect | undefined; signal: AbortSignal | undefined }
export type Answer = (call: SeenCall) => Response | Promise<Response>;
export interface FakeFetch { fetchImpl: typeof fetch; calls: SeenCall[] }

/** A fetch that answers from `routes`, keyed "GET https://203.0.113.7/letter.pdf". Each answer is a function, so every call gets a body of its own. */
export function routedFetch(routes: Record<string, Answer>): FakeFetch {
  const calls: SeenCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: SeenCall = { method: init.method ?? 'GET', url: String(input), redirect: init.redirect, signal: init.signal ?? undefined };
    calls.push(call);
    const answer = routes[`${call.method} ${call.url}`];
    return answer === undefined ? new Response('no route', { status: 404 }) : answer(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** An answer with a body of bytes, and the headers it is given. */
export function reply(status: number, body: Uint8Array | string | null, headers: Record<string, string> = {}): Response {
  return new Response(body as BodyInit | null, { status, headers });
}

/** A redirect, with the Location a server would give it. The body is empty. */
export const redirect = (status: number, location = 'https://203.0.113.9/elsewhere.pdf') => reply(status, null, { location });

/** An answer that fails the way a dropped connection does: the fetch itself rejects. */
export function boom(message = 'fetch failed', cause?: Error): never { throw new TypeError(message, { cause }); }

/** An answer that never comes. Like a real fetch it settles when the call's signal fires, and then with the signal's reason. */
export const hang: Answer = (call) => new Promise<Response>((_resolve, reject) => {
  if (call.signal?.aborted) { reject(call.signal.reason); return; }
  call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
});

export interface StreamStats { pulls: number; cancelled: boolean }

/**
 * A body of chunks of the given sizes (zeros after an optional `prefix` in the first chunk), made only as fast as the reader asks: `stats.pulls` is
 * how many chunks were handed out, `stats.cancelled` whether the reader gave up on the body (what a real connection would feel as a dropped socket).
 * A reader that stops early leaves `pulls` below the number of chunks.
 */
export function streamed(chunkSizes: number[], init: ResponseInit = {}, prefix?: Uint8Array): { response: Response; stats: StreamStats } {
  const stats: StreamStats = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stats.pulls >= chunkSizes.length) { controller.close(); return; }
      const chunk = new Uint8Array(chunkSizes[stats.pulls]);
      if (stats.pulls === 0 && prefix !== undefined) chunk.set(prefix.subarray(0, chunk.length));
      stats.pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, init), stats };
}

/** A 200 whose headers come at once, with one chunk of `first`, and then nothing until the call's signal fires (a server that stalls mid-body). */
export function stallsAfter(first: Uint8Array, call: SeenCall): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(first); return undefined; }
      return new Promise<void>((_resolve, reject) => {
        if (call.signal?.aborted) { reject(call.signal.reason); return; }
        call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
      });
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: 200 });
}
