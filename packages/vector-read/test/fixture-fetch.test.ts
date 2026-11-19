import { describe, test, expect } from 'vitest';
import { extendingFetch } from '../src/index.ts';
import type { FixtureStore } from '../src/index.ts';

describe('extendingFetch', () => {
  const POST = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
  const URL_ = 'https://koios.example/api/v1/address_utxos';
  // A network that answers every call with a row of its own, and notes what it was asked.
  const network = () => {
    const asked: string[] = [];
    const real: typeof fetch = async (url, init) => { asked.push(`${init?.method ?? 'GET'} ${String(url)} ${String(init?.body ?? '')}`); return new Response('[{"from":"network"}]', { status: 200 }); };
    return { real, asked };
  };
  test('answers a call that the store holds from the store, and makes no call', async () => {
    const store: FixtureStore = { [`POST ${URL_} {"a":1}`]: { status: 200, body: '[{"from":"store"}]' } };
    const { real, asked } = network();
    const res = await extendingFetch(real, store)(URL_, POST({ a: 1 }));
    expect(await res.json()).toEqual([{ from: 'store' }]);
    expect(asked).toEqual([]);
  });
  test('makes a call that the store lacks, records the answer, and answers the same call from the store afterwards', async () => {
    const store: FixtureStore = { [`POST ${URL_} {"a":1}`]: { status: 200, body: '[]' } };
    const { real, asked } = network();
    const f = extendingFetch(real, store);
    expect(await (await f(URL_, POST({ a: 2 }))).json()).toEqual([{ from: 'network' }]);
    expect(Object.keys(store)).toEqual([`POST ${URL_} {"a":1}`, `POST ${URL_} {"a":2}`]);
    expect(store[`POST ${URL_} {"a":2}`]).toEqual({ status: 200, body: '[{"from":"network"}]' });
    expect(await (await f(URL_, POST({ a: 2 }))).json()).toEqual([{ from: 'network' }]);
    expect(asked).toEqual([`POST ${URL_} {"a":2}`]); // one call: the second ask came from the store
  });
  test('keeps the recorded answer of a call, whatever status it has', async () => {
    const store: FixtureStore = { [`GET ${URL_} `]: { status: 503, body: '{}' } };
    const { real, asked } = network();
    const res = await extendingFetch(real, store)(URL_);
    expect(res.status).toBe(503);
    expect(asked).toEqual([]);
  });
});
