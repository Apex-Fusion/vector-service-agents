// packages/buyer-core/test/fake-fetch.ts
// A fake fetch for the fleet client tests: it answers by "METHOD url" from a table and records every call it gets, with the headers and the
// body as the client wrote them and the signal the client gave it. An unrouted call is answered 404 and recorded, so a test sees it in `calls`.
// Not a vendored fixture, so it sits outside test/fixtures/ (every file there needs a row in VENDORED-FROM.md).
export interface SeenCall { method: string; url: string; headers: Record<string, string>; body: string | undefined; signal: AbortSignal | undefined }
export type Answer = Response | ((call: SeenCall) => Response | Promise<Response>);
export interface FakeFetch { fetchImpl: typeof fetch; calls: SeenCall[] }

/** A JSON answer. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An answer that never comes: it settles only when the call's signal fires, as a real fetch does. */
export const hang: Answer = (call) => new Promise<Response>((_resolve, reject) => {
  call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
});

// A Response answer is read once and rebuilt for each call, so one entry can answer many. It is not cloned: a clone is a tee of the body, and the
// cancel of one branch (what safeFetch does with a body over its cap) settles only when the other branch is cancelled too, which nobody would do.
const snapshots = new WeakMap<Response, Promise<{ status: number; headers: Array<[string, string]>; text: string }>>();
async function rebuilt(answer: Response): Promise<Response> {
  let snapshot = snapshots.get(answer);
  if (snapshot === undefined) {
    snapshot = answer.text().then((text) => ({ status: answer.status, headers: [...answer.headers], text }));
    snapshots.set(answer, snapshot);
  }
  const { status, headers, text } = await snapshot;
  return new Response(text === '' ? null : text, { status, headers });
}

/** A fetch that answers from `routes`, keyed "GET https://host/path". */
export function routedFetch(routes: Record<string, Answer>): FakeFetch {
  const calls: SeenCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    const call: SeenCall = { method: init.method ?? 'GET', url, headers, body: typeof init.body === 'string' ? init.body : undefined, signal: init.signal ?? undefined };
    calls.push(call);
    const answer = routes[`${call.method} ${url}`];
    if (answer === undefined) return json(404, { reason: 'no_route', message: `fake fetch: nothing is routed for ${call.method} ${url}` });
    return typeof answer === 'function' ? answer(call) : rebuilt(answer);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
