// packages/id-kit/test/verify-reader.test.ts: how the reader reads what the gateway publishes: the copies and their time, the wait after a failure, and the two soft results (a list that
// cannot be read and a list that is over), which a relying party does not refuse a call for. The gateway is the stub, and its clock is the clock of the reader.
import { describe, expect, it } from 'vitest';
import { LISTS_UNAVAILABLE, type StubGateway } from '../src/testing/index.ts';
import { b64url } from '../src/vendored/m4/jose.ts';
import { createGatewayReader, isSoftListRule, type GatewayReader, type GatewayReaderOptions } from '../src/verify/index.ts';
import { world } from './support.ts';

const TSL = '/status/tsl/0';
const count = (gateway: StubGateway, path: string): number => gateway.requests.filter((r) => r.path === path).length;

function reading(options: Partial<GatewayReaderOptions> = {}): { gateway: StubGateway; reader: GatewayReader; uri: string } {
  const { gateway } = world();
  gateway.createAgent({ label: 'reader agent' });
  return { gateway, reader: createGatewayReader({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now, ...options }), uri: `${gateway.baseUrl}${TSL}` };
}

describe('the status lists in the reader', () => {
  it('a list is used for its ttl of 60 seconds: three reads make one request, and a read after 60 seconds makes a new one', async () => {
    const { gateway, reader, uri } = reading();
    for (let i = 0; i < 3; i++) expect((await reader.tokenList(uri)).ok).toBe(true);
    expect(count(gateway, TSL)).toBe(1);
    gateway.advance(59_000);
    await reader.tokenList(uri);
    expect(count(gateway, TSL)).toBe(1);
    gateway.advance(2_000);
    await reader.tokenList(uri);
    expect(count(gateway, TSL)).toBe(2);
  });

  it('listCacheSeconds shortens the time that a list is used', async () => {
    const { gateway, reader, uri } = reading({ listCacheSeconds: 10 });
    await reader.tokenList(uri);
    gateway.advance(9_000);
    await reader.tokenList(uri);
    expect(count(gateway, TSL)).toBe(1);
    gateway.advance(2_000);
    await reader.tokenList(uri);
    expect(count(gateway, TSL)).toBe(2);
  });

  it('two reads at the same time make one request', async () => {
    const { gateway, reader, uri } = reading();
    const [a, b] = await Promise.all([reader.tokenList(uri), reader.tokenList(uri)]);
    expect(a.ok && b.ok).toBe(true);
    expect(count(gateway, TSL)).toBe(1);
  });

  it('a list that answers 503 is list.unavailable, and the reader does not ask again before the wait that the gateway names (30 seconds here)', async () => {
    const { gateway, reader, uri } = reading();
    gateway.fault(TSL, { ...LISTS_UNAVAILABLE, headers: { ...LISTS_UNAVAILABLE.headers, 'retry-after': '30' } });
    const first = await reader.tokenList(uri);
    expect(first).toMatchObject({ ok: false, rule: 'list.unavailable', detail: expect.stringContaining('503') });
    expect(isSoftListRule('list.unavailable')).toBe(true);
    expect(count(gateway, TSL)).toBe(1);
    expect(await reader.tokenList(uri)).toMatchObject({ ok: false, rule: 'list.unavailable' });
    gateway.advance(29_000);
    await reader.tokenList(uri);
    expect(count(gateway, TSL)).toBe(1);
    gateway.advance(2_000);
    await reader.tokenList(uri);
    expect(count(gateway, TSL)).toBe(2);
    gateway.fault(TSL, null);
    gateway.advance(31_000);
    expect((await reader.tokenList(uri)).ok).toBe(true);
    expect(count(gateway, TSL)).toBe(3);
  });

  it('with no Retry-After the wait is 5 seconds, and a network failure is list.unavailable too', async () => {
    const { gateway, reader, uri } = reading();
    gateway.fault(TSL, 'network');
    expect(await reader.tokenList(uri)).toMatchObject({ ok: false, rule: 'list.unavailable' });
    gateway.advance(4_000);
    await reader.tokenList(uri);
    expect(count(gateway, TSL)).toBe(1);
    gateway.advance(2_000);
    await reader.tokenList(uri);
    expect(count(gateway, TSL)).toBe(2);
  });

  it('when a fresh read fails, the older copy is used while it is valid, with the reason; when the copy has ended, the result is list.unavailable', async () => {
    const { gateway, reader, uri } = reading();
    const first = await reader.tokenList(uri);
    if (!first.ok) throw new Error(first.detail);
    gateway.advance(61_000);
    gateway.fault(TSL, LISTS_UNAVAILABLE);
    const second = await reader.tokenList(uri);
    expect(second).toMatchObject({ ok: true, value: { fetchedAt: first.value.fetchedAt, refreshError: expect.stringContaining('503') } });
    gateway.advance(3_600_000);
    expect(await reader.tokenList(uri)).toMatchObject({ ok: false, rule: 'list.unavailable' });
  });

  it('a list that is over is list.expired (soft); the older copy is not used when it is over too', async () => {
    const { gateway, reader, uri } = reading();
    gateway.lists.freeze();
    gateway.advance(3_700_000);
    const old = await reader.tokenList(uri);
    expect(old).toMatchObject({ ok: false, rule: 'list.expired' });
    expect(isSoftListRule('list.expired')).toBe(true);
  });

  it('a list that is read and is wrong is a refusal that is not soft: a bad signature, and a list for another URL', async () => {
    const { gateway, reader, uri } = reading();
    const list = await (await gateway.fetch(uri)).text();
    const [h, p] = list.split('.');
    gateway.fault(TSL, { status: 200, body: `${h}.${p}.${b64url(Buffer.alloc(64))}` });
    const bad = await reader.tokenList(uri);
    expect(bad).toMatchObject({ ok: false, rule: 'list.signature' });
    expect(isSoftListRule('list.signature')).toBe(false);
    gateway.fault(TSL, null);
    gateway.advance(6_000);
    const other = await reader.tokenList(`${gateway.baseUrl}/status/tsl/1`);
    expect(other).toMatchObject({ ok: false });
  });

  it('a Bitstring Status List is read the same way', async () => {
    const { gateway, reader } = reading();
    const url = `${gateway.baseUrl}/status/bsl/0`;
    expect((await reader.bitstringList(url)).ok).toBe(true);
    expect((await reader.bitstringList(url)).ok).toBe(true);
    expect(count(gateway, '/status/bsl/0')).toBe(1);
    gateway.advance(61_000);
    gateway.fault('/status/bsl/0', 'network');
    expect(await reader.bitstringList(url)).toMatchObject({ ok: true, value: { refreshError: expect.any(String) } });
  });
});

describe('the key set and the bundle in the reader', () => {
  it('the key set is used for 300 seconds and read again after that; a key set that cannot be read again is used for an hour, and then keys.unavailable', async () => {
    const { gateway, reader } = reading();
    const jwks = '/.well-known/jwks.json';
    for (let i = 0; i < 3; i++) expect((await reader.keys()).ok).toBe(true);
    expect(count(gateway, jwks)).toBe(1);
    gateway.advance(301_000);
    gateway.fault(jwks, 'network');
    expect((await reader.keys()).ok).toBe(true);
    expect(count(gateway, jwks)).toBe(2);
    gateway.advance(3_600_000);
    expect(await reader.keys()).toMatchObject({ ok: false, rule: 'keys.unavailable' });
  });

  it('a forced read of the key set happens only when the copy is 30 seconds old', async () => {
    const { gateway, reader } = reading();
    const jwks = '/.well-known/jwks.json';
    await reader.keys();
    await reader.keys(true);
    expect(count(gateway, jwks)).toBe(1);
    gateway.advance(31_000);
    await reader.keys(true);
    expect(count(gateway, jwks)).toBe(2);
  });

  it('the bundle is used for its refresh hint of 300 seconds, and read again after that', async () => {
    const { gateway, reader } = reading();
    expect((await reader.bundle()).ok).toBe(true);
    gateway.advance(299_000);
    await reader.bundle();
    expect(count(gateway, '/spiffe/bundle')).toBe(1);
    gateway.advance(2_000);
    await reader.bundle();
    expect(count(gateway, '/spiffe/bundle')).toBe(2);
    gateway.fault('/spiffe/bundle', { status: 503, body: '{}' });
    gateway.advance(301_000);
    expect((await reader.bundle()).ok).toBe(true);
  });

  it('with no copy, a bundle that cannot be read is bundle.unavailable, and a body that is not JSON is a failed read too', async () => {
    const { gateway, reader } = reading();
    gateway.fault('/spiffe/bundle', 'network');
    expect(await reader.bundle()).toMatchObject({ ok: false, rule: 'bundle.unavailable' });
    const again = reading();
    again.gateway.fault('/spiffe/bundle', { status: 200, body: 'not json' });
    expect(await again.reader.bundle()).toMatchObject({ ok: false, rule: 'bundle.unavailable' });
  });

  it('a reader needs the origin of a gateway: an http URL (not a loopback host) and a URL with a path are refused', () => {
    expect(() => createGatewayReader({ baseUrl: 'http://id.example' })).toThrow(TypeError);
    expect(() => createGatewayReader({ baseUrl: 'https://id.example/x' })).toThrow(TypeError);
    expect(createGatewayReader({ baseUrl: 'https://id.example' }).trustDomain).toBe('id.example');
  });
});
