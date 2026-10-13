// Record every outbound call into a JSON map, or replay from it. Key = method + url + body.
import type { Fetch } from './koios.ts';
export type FixtureStore = Record<string, { status: number; body: string }>;
const keyOf = (url: string, init?: RequestInit) => `${init?.method ?? 'GET'} ${url} ${typeof init?.body === 'string' ? init.body : ''}`;
export function recordingFetch(real: Fetch, store: FixtureStore): Fetch {
  return (async (url: any, init?: RequestInit) => {
    const res = await real(url, init);
    const body = await res.text();
    store[keyOf(String(url), init)] = { status: res.status, body };
    return new Response(body, { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as Fetch;
}
export function replayFetch(store: FixtureStore): Fetch {
  return (async (url: any, init?: RequestInit) => {
    const hit = store[keyOf(String(url), init)];
    if (!hit) throw new Error(`fixture miss: ${keyOf(String(url), init)}`);
    return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
  }) as Fetch;
}
