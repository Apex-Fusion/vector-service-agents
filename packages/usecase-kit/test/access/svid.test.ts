// packages/usecase-kit/test/access/svid.test.ts: the SVIDs of a counterparty, against the stub gateway of id-kit. An X.509-SVID call goes through the transport port, and a JWT-SVID call goes through
// `fetch` to a mock system on a loopback port. Each refusal has an accepted twin.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpsTransport, callWithJwtSvid, callWithX509Svid, fetchJwtSvid, fetchX509Svid, jwtSvidTarget, x509Target } from '../../src/access/index.ts';
import type { GatewayClient } from '@vsa/id-kit/client';
import type { StubAgent, StubGateway } from '@vsa/id-kit/testing';
import type { CallDeps, JwtSvidTarget, MtlsRequest, MtlsTransport, SvidAgent, SystemResult, X509SvidCredential, X509Target } from '../../src/access/index.ts';
import { BASES, FakeClock, claimsOf, expectTarget, gatewayWorld, startStub, viaStub, type StubServer } from './support.ts';

let stub: StubServer;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
});

interface SvidWorld {
  readonly gateway: StubGateway;
  readonly client: GatewayClient;
  readonly orderDesk: StubAgent;
  readonly clock: FakeClock;
  readonly catalogue: X509Target;
  readonly orders: X509Target;
  readonly requirements: JwtSvidTarget;
  readonly requests: JwtSvidTarget;
  /** The agent as the client of id-kit takes it: its DID and its authentication key. */
  agent(a: StubAgent): SvidAgent;
}

function world(): SvidWorld {
  const w = gatewayWorld();
  return {
    gateway: w.gateway,
    client: w.client,
    orderDesk: w.gateway.createAgent({ label: 'order-desk' }),
    clock: new FakeClock(w.gateway.now()),
    catalogue: expectTarget(x509Target(BASES, 'run1', 'supplier.catalogue', { sku: 'MSK-N95' })),
    orders: expectTarget(x509Target(BASES, 'run1', 'supplier.orders')),
    requirements: expectTarget(jwtSvidTarget(BASES, 'run1', 'insurer.requirements', { service_code: 'SYN-MRI-LS' })),
    requests: expectTarget(jwtSvidTarget(BASES, 'run1', 'insurer.requests')),
    agent: (a) => ({ did: a.did, key: a.authentication.privateKey }),
  };
}

/** A transport that records each request and answers what the test says. */
function transportOf(reply: { status: number; body: string } | (() => Promise<never>)): { transport: MtlsTransport; calls: MtlsRequest[] } {
  const calls: MtlsRequest[] = [];
  return { calls, transport: async (request) => (calls.push(request), typeof reply === 'function' ? reply() : reply) };
}

async function x509Of(w: SvidWorld): Promise<X509SvidCredential> {
  const result = await fetchX509Svid({ client: w.client }, w.agent(w.orderDesk));
  if (!result.ok) throw new Error(`no SVID: ${result.code}`);
  return result.value;
}

describe('an X.509-SVID', () => {
  it('has its certificate, its SPIFFE ID and its end, and what a TLS client needs: the key matches the certificate', async () => {
    const w = world();
    const svid = await x509Of(w);
    expect(svid.spiffeId).toBe(`spiffe://id.vector.apexfusion.org/agent/${w.orderDesk.id}`);
    expect(svid.certificate).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(svid.bundle).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(svid.expiresAt).toBeGreaterThan(w.gateway.now());
    expect(svid.expiresAt).toBeLessThanOrEqual(w.gateway.now() + 3_600_000);
    const tls = svid.tls();
    expect(tls.cert).toBe(svid.certificate);
    expect(tls.key).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(new X509Certificate(tls.cert).checkPrivateKey(createPrivateKey(tls.key))).toBe(true);
  });

  it('has a new key for each job', async () => {
    const w = world();
    const first = (await x509Of(w)).tls();
    const second = (await x509Of(w)).tls();
    expect(first.key).not.toBe(second.key);
    expect(first.cert).not.toBe(second.cert);
  });

  it('shows no key in its properties, its JSON text, its string form and its log form', async () => {
    const w = world();
    const svid = await x509Of(w);
    const { key } = svid.tls();
    const body = key.split('\n').filter((line) => line.length > 20 && !line.startsWith('-----'));
    for (const text of [JSON.stringify(svid), String(svid), inspect(svid, { showHidden: true, depth: 6 }), JSON.stringify(Object.getOwnPropertyNames(svid))]) {
      expect(text).not.toContain('PRIVATE KEY');
      for (const line of body) expect(text).not.toContain(line);
    }
    expect(JSON.parse(JSON.stringify(svid))).toStrictEqual({ spiffeId: svid.spiffeId, expiresAt: svid.expiresAt });
  });

  it('is refused for an agent that is not Active, and issued for one that is: the twin', async () => {
    const w = world();
    w.gateway.setStatus(w.orderDesk, 'suspended');
    expect(await fetchX509Svid({ client: w.client }, w.agent(w.orderDesk))).toMatchObject({ ok: false, code: 'gateway_refused', status: 403 });
    w.gateway.setStatus(w.orderDesk, 'active');
    expect((await fetchX509Svid({ client: w.client }, w.agent(w.orderDesk))).ok).toBe(true);
  });

  it('has its own result for a gateway that cannot be reached, and for a bad DID, with no request for the DID', async () => {
    const w = world();
    w.gateway.fault('/spiffe/nonce', 'network');
    expect(await fetchX509Svid({ client: w.client }, w.agent(w.orderDesk))).toMatchObject({ ok: false, code: 'gateway_unreachable' });
    w.gateway.fault('/spiffe/nonce', null);
    const before = w.gateway.requests.length;
    expect(await fetchX509Svid({ client: w.client }, { did: 'did:vector:xyz', key: w.orderDesk.authentication.privateKey })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(w.gateway.requests.length).toBe(before);
  });
});

describe('a call with an X.509-SVID', () => {
  const deps = (w: SvidWorld, transport: MtlsTransport, over: Partial<CallDeps> = {}) => ({ fetch, clock: w.clock, transport, ...over });

  it('goes to the client-certificate host through the transport, with the certificate and the key, and gives the body', async () => {
    const w = world();
    const svid = await x509Of(w);
    const { transport, calls } = transportOf({ status: 200, body: '{"sku":"MSK-N95","on_hand":150}' });
    const result = await callWithX509Svid(deps(w, transport), svid, w.catalogue);
    expect(result).toStrictEqual({ ok: true, status: 200, body: { sku: 'MSK-N95', on_hand: 150 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://mock-mtls.example/t/run1/supplier/catalogue/MSK-N95', method: 'GET', body: null, cert: svid.tls().cert, key: svid.tls().key });
    expect(calls[0]!.headers).toStrictEqual({ accept: 'application/json' });
    expect(calls[0]!.maxBodyBytes).toBe(1_048_576);
  });

  it('writes a JSON body with a content type', async () => {
    const w = world();
    const { transport, calls } = transportOf({ status: 201, body: '{"order_id":"o1"}' });
    const result = await callWithX509Svid(deps(w, transport), await x509Of(w), w.orders, { po_number: 'PO-1', sku: 'MSK-N95', lot: 'lot-small', quantity: 100 });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ po_number: 'PO-1' });
  });

  it.each([
    [403, 'organisation_mismatch'],
    [403, 'organisation_unverified'],
    [403, 'agent_not_active'],
    [401, 'svid_invalid'],
    [401, 'svid_missing'],
  ])('is refused_by_system for %i %s, with the code of the system', async (status, code) => {
    const w = world();
    const { transport } = transportOf({ status, body: JSON.stringify({ error: code, message: 'words' }) });
    expect(await callWithX509Svid(deps(w, transport), await x509Of(w), w.catalogue)).toMatchObject({ ok: false, code: 'refused_by_system', reason: code, status });
  });

  it('maps every other answer as a call with a token does', async () => {
    const w = world();
    const svid = await x509Of(w);
    const map = async (status: number, body: string): Promise<SystemResult> => callWithX509Svid(deps(w, transportOf({ status, body }).transport), svid, w.catalogue);
    expect(await map(403, JSON.stringify({ ok: true }))).toMatchObject({ ok: false, code: 'refused_by_system', reason: 'refusal_without_code' });
    expect(await map(200, 'OK')).toMatchObject({ ok: false, code: 'mock_system_failed', status: 200 });
    expect(await map(404, JSON.stringify({ error: 'sku_not_found' }))).toMatchObject({ ok: false, code: 'mock_system_failed', status: 404, systemCode: 'sku_not_found' });
    expect(await map(400, JSON.stringify({ error: 'client_certificate_unexpected' }))).toMatchObject({ ok: false, code: 'mock_system_failed', status: 400, systemCode: 'client_certificate_unexpected' });
    expect(await map(421, JSON.stringify({ error: 'wrong_host' }))).toMatchObject({ ok: false, code: 'mock_system_failed', status: 421 });
    expect(await map(200, '{"a":1}')).toMatchObject({ ok: true });
  });

  it('is mock_system_failed when the transport fails, sent one time, with no key in the text', async () => {
    const w = world();
    const svid = await x509Of(w);
    const { key } = svid.tls();
    const { transport, calls } = transportOf(async () => {
      throw new Error(`TLS failed with ${key}`);
    });
    const result = await callWithX509Svid(deps(w, transport), svid, w.catalogue);
    expect(result).toMatchObject({ ok: false, code: 'mock_system_failed', status: null, sent: true });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(result)).toContain('[removed]');
  });

  it('ends at the time limit of the clock, and aborts the request; it gives the answer when it comes in time', async () => {
    const w = world();
    const svid = await x509Of(w);
    let aborted = false;
    const hang: MtlsTransport = (request) => new Promise<never>(() => request.signal.addEventListener('abort', () => (aborted = true)));
    const result = await w.clock.run(callWithX509Svid(deps(w, hang, { timeoutMs: 4_000 }), svid, w.catalogue));
    expect(result).toMatchObject({ ok: false, code: 'mock_system_failed', status: null, sent: true });
    expect(aborted).toBe(true);
    expect(w.clock.waiting).toBe(0);
    expect((await callWithX509Svid(deps(w, transportOf({ status: 200, body: '{}' }).transport, { timeoutMs: 4_000 }), svid, w.catalogue)).ok).toBe(true);
    expect(w.clock.waiting).toBe(0);
  });

  it('is not sent after the certificate ended, and is sent before', async () => {
    const w = world();
    const svid = await x509Of(w);
    const { transport, calls } = transportOf({ status: 200, body: '{}' });
    await w.clock.advance(svid.expiresAt - w.clock.now() - 1);
    expect((await callWithX509Svid(deps(w, transport), svid, w.catalogue)).ok).toBe(true);
    await w.clock.advance(1);
    expect(await callWithX509Svid(deps(w, transport), svid, w.catalogue)).toMatchObject({ ok: false, sent: false, detail: 'the X.509-SVID has ended' });
    expect(calls).toHaveLength(1);
  });

  it('is not sent with a body on a GET, or with no body on a POST', async () => {
    const w = world();
    const svid = await x509Of(w);
    const { transport, calls } = transportOf({ status: 200, body: '{}' });
    expect(await callWithX509Svid(deps(w, transport), svid, w.catalogue, {})).toMatchObject({ ok: false, sent: false });
    expect(await callWithX509Svid(deps(w, transport), svid, w.orders)).toMatchObject({ ok: false, sent: false });
    expect(calls).toHaveLength(0);
  });

  it('is refused by the default transport for a URL that is not https, with no network', async () => {
    const abort = new AbortController();
    await expect(httpsTransport({ url: 'http://mock-mtls.example/x', method: 'GET', headers: {}, body: null, cert: 'c', key: 'k', maxBodyBytes: 10, signal: abort.signal })).rejects.toThrow(/https/);
  });
});

describe('a JWT-SVID', () => {
  it('names the audience of the insurer system, and its subject is the SPIFFE ID of the agent', async () => {
    const w = world();
    const result = await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requirements);
    if (!result.ok) throw new Error('no SVID');
    expect(result.value).toMatchObject({ spiffeId: `spiffe://id.vector.apexfusion.org/agent/${w.orderDesk.id}`, audience: ['https://mock.example/t/run1/insurer'] });
    expect(result.value.expiresAt).toBeGreaterThan(w.gateway.now());
    expect(result.value.expiresAt).toBeLessThanOrEqual(w.gateway.now() + 300_000);
    const jwt = result.value.bearer().slice('Bearer '.length);
    expect(claimsOf(jwt)).toMatchObject({ sub: result.value.spiffeId, aud: 'https://mock.example/t/run1/insurer' });
  });

  it('is the same audience for both routes of the insurer system, and another tenant has another audience', async () => {
    const w = world();
    expect(w.requirements.audience).toBe(w.requests.audience);
    const other = jwtSvidTarget(BASES, 'run2', 'insurer.requests');
    expect(other.ok && other.value.audience).toBe('https://mock.example/t/run2/insurer');
  });

  it('shows no token in its properties, its JSON text, its string form and its log form', async () => {
    const w = world();
    const result = await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requirements);
    if (!result.ok) throw new Error('no SVID');
    const jwt = result.value.bearer().slice('Bearer '.length);
    for (const text of [JSON.stringify(result.value), String(result.value), inspect(result.value, { showHidden: true, depth: 6 }), JSON.stringify(Object.getOwnPropertyNames(result.value))]) {
      for (const part of jwt.split('.')) expect(text).not.toContain(part);
    }
  });

  it('is refused for an agent that is not Active, and issued for one that is: the twin', async () => {
    const w = world();
    w.gateway.setStatus(w.orderDesk, 'suspended');
    expect(await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requirements)).toMatchObject({ ok: false, code: 'gateway_refused', status: 403 });
    w.gateway.setStatus(w.orderDesk, 'active');
    expect((await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requirements)).ok).toBe(true);
  });

  it('goes as a Bearer header, with no DPoP proof, and gives the body', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{"service_code":"SYN-MRI-LS","requirements":[]}' });
    const svid = await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requirements);
    if (!svid.ok) throw new Error('no SVID');
    const result = await callWithJwtSvid({ fetch: viaStub(stub), clock: w.clock }, svid.value, w.requirements);
    expect(result).toMatchObject({ ok: true, status: 200, body: { service_code: 'SYN-MRI-LS' } });
    expect(stub.requests).toHaveLength(1);
    const sent = stub.requests[0]!;
    expect(sent.path).toBe('/t/run1/insurer/requirements/SYN-MRI-LS');
    expect(sent.headers.authorization).toBe(svid.value.bearer());
    expect(sent.headers.dpop).toBeUndefined();
  });

  it('writes a JSON body, and is refused_by_system for a 403, and a failure for any other answer', async () => {
    const w = world();
    stub.requests.length = 0;
    const svid = await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requests);
    if (!svid.ok) throw new Error('no SVID');
    const deps: CallDeps = { fetch: viaStub(stub), clock: w.clock };
    stub.reply({ status: 201, body: '{"intake_id":"i1"}' });
    expect(await callWithJwtSvid(deps, svid.value, w.requests, { request: { request_number: 'R1' }, status: 'complete' })).toMatchObject({ ok: true, status: 201 });
    expect(stub.requests[0]!.headers['content-type']).toBe('application/json');
    stub.reply({ status: 403, body: JSON.stringify({ error: 'organisation_mismatch', message: 'the record names another organisation' }) });
    expect(await callWithJwtSvid(deps, svid.value, w.requests, { request: {}, status: 'complete' })).toMatchObject({ ok: false, code: 'refused_by_system', reason: 'organisation_mismatch', status: 403 });
    stub.reply({ status: 409, body: JSON.stringify({ error: 'duplicate_request' }) });
    expect(await callWithJwtSvid(deps, svid.value, w.requests, { request: {}, status: 'complete' })).toMatchObject({ ok: false, code: 'mock_system_failed', status: 409, systemCode: 'duplicate_request' });
    stub.reply({ status: 201, body: 'created' });
    expect(await callWithJwtSvid(deps, svid.value, w.requests, { request: {}, status: 'complete' })).toMatchObject({ ok: false, code: 'mock_system_failed', status: 201 });
  });

  it('is not sent for the insurer system of another tenant, and is sent for its own tenant', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{}' });
    const svid = await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requirements);
    if (!svid.ok) throw new Error('no SVID');
    const other = jwtSvidTarget(BASES, 'run2', 'insurer.requirements', { service_code: 'SYN-MRI-LS' });
    if (!other.ok) throw new Error('target');
    const deps: CallDeps = { fetch: viaStub(stub), clock: w.clock };
    expect(await callWithJwtSvid(deps, svid.value, other.value)).toMatchObject({ ok: false, sent: false });
    expect(stub.requests).toHaveLength(0);
    expect((await callWithJwtSvid(deps, svid.value, w.requirements)).ok).toBe(true);
    stub.requests.length = 0;
    for (const url of ['https://elsewhere.example/t/run1/insurer/requirements/x', 'https://mock.example/t/run1/insurerx/requirements/x', 'https://mock.example/t/run1/po']) {
      expect(await callWithJwtSvid(deps, svid.value, { ...w.requirements, url }), url).toMatchObject({ ok: false, code: 'mock_system_failed', sent: false });
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('is not sent after it ended, and is sent a millisecond before', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{}' });
    const svid = await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requirements);
    if (!svid.ok) throw new Error('no SVID');
    const deps: CallDeps = { fetch: viaStub(stub), clock: w.clock };
    await w.clock.advance(svid.value.expiresAt - w.clock.now() - 1);
    expect((await callWithJwtSvid(deps, svid.value, w.requirements)).ok).toBe(true);
    await w.clock.advance(1);
    expect(await callWithJwtSvid(deps, svid.value, w.requirements)).toMatchObject({ ok: false, sent: false, detail: 'the JWT-SVID has ended' });
    expect(stub.requests).toHaveLength(1);
  });

  it('holds no token in the result of a failed call', async () => {
    const w = world();
    const svid = await fetchJwtSvid({ client: w.client }, w.agent(w.orderDesk), w.requirements);
    if (!svid.ok) throw new Error('no SVID');
    const jwt = svid.value.bearer().slice('Bearer '.length);
    const result = await callWithJwtSvid({ fetch: async (_url, init) => { throw new Error(`down: ${String((init?.headers as Record<string, string>).authorization)}`); }, clock: w.clock }, svid.value, w.requirements);
    expect(result).toMatchObject({ ok: false, code: 'mock_system_failed', sent: true });
    for (const part of [jwt, ...jwt.split('.')]) expect(JSON.stringify(result)).not.toContain(part);
  });
});

describe('a client that gives no private key for the certificate', () => {
  it('gives gateway_bad_response, and gives the credential when the client gives the key', async () => {
    const w = world();
    const real = await w.client.x509Svid({ agent: w.agent(w.orderDesk) });
    if (!real.ok) throw new Error('no SVID');
    const client = (privateKey: typeof real.value.privateKey) => ({ jwtSvid: w.client.jwtSvid, x509Svid: async () => ({ ok: true as const, value: { ...real.value, privateKey } }) });
    expect(await fetchX509Svid({ client: client(null) }, w.agent(w.orderDesk))).toMatchObject({ ok: false, code: 'gateway_bad_response' });
    expect((await fetchX509Svid({ client: client(real.value.privateKey) }, w.agent(w.orderDesk))).ok).toBe(true);
  });
});
