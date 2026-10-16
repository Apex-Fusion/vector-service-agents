// agents/audio-snippets/test/fake-fetch.ts
// A fetch that answers from a table keyed "GET <url>", keeps a body as bytes, and records every call. The URLs are https IP literals of 203.0.113.0/24: public
// for safeFetch, and with no host lookup, so no test depends on DNS.
export interface SeenCall { method: string; url: string; redirect: RequestRedirect | undefined }
export type Answer = () => Response | Promise<Response>;
export function routedFetch(routes: Record<string, Answer>): { fetchImpl: typeof fetch; calls: SeenCall[] } {
  const calls: SeenCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: SeenCall = { method: init.method ?? 'GET', url: String(input), redirect: init.redirect };
    calls.push(call);
    const answer = routes[`${call.method} ${call.url}`];
    return answer === undefined ? new Response('no route', { status: 404 }) : answer();
  }) as typeof fetch;
  return { fetchImpl, calls };
}
export const reply = (status: number, body: Uint8Array | string | null, headers: Record<string, string> = {}): Response => new Response(body as BodyInit | null, { status, headers });
export const noFetch = (async () => { throw new Error('this test makes no outbound call'); }) as typeof fetch;
