// packages/usecase-kit/test/access/url.test.ts: the URL of a call is read as a parsed URL, and a call goes to the host of its kind. The fetch of Node removes the dot segments of a URL, so a check
// that compares the text lets `…/erp/../po` carry a token to another route. Each refusal has an accepted twin, and each one is sent: false with no request at the server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callWithJwtSvid, callWithToken, callWithX509Svid, fetchJwtSvid, fetchX509Svid, jwtSvidTarget, requestRouteToken, tokenTarget, x509Target } from '../../src/access/index.ts';
import type { CallDeps, MockBases, MtlsRequest, TokenTarget } from '../../src/access/index.ts';
import { BASES, FakeClock, erpTarget, expectTarget, gatewayWorld, startStub, viaStub, type StubServer } from './support.ts';

let stub: StubServer;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
});

const NOT_SENT = { ok: false, code: 'mock_system_failed', status: null, sent: false } as const;

function world() {
  const w = gatewayWorld();
  const root = w.gateway.delegate({ delegator: { principalKey: w.hirer }, delegate: w.agent, actions: ['erp.*', 'po.write'], resources: ['*'], remaining: 1 });
  const clock = new FakeClock(w.gateway.now());
  const tokenFor = async (target: TokenTarget) => {
    const issued = await requestRouteToken(
      { client: w.client },
      { target, holder: 'agent', subject: { did: w.agent.did, key: w.agent.authentication.privateKey }, dpopKey: w.agent.delegation.privateKey, delegation: root.id },
    );
    if (!issued.ok) throw new Error(`no token: ${issued.detail}`);
    return issued.value;
  };
  const deps: CallDeps = { fetch: viaStub(stub), clock, bases: BASES };
  return { ...w, clock, tokenFor, deps };
}

/** A fetch that records the URL of each call and answers 200. */
function recordingFetch(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return { urls, fetch: async (input) => (urls.push(String(input)), new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) };
}

describe('the URL of a call with a token', () => {
  const base = erpTarget().resource;
  const refused: [string, string, string][] = [
    ['a dot segment to another route', `${base}/../po`, 'dot segment'],
    ['two dot segments to another tenant', `${base}/../../run2/erp/stock/GLV-NIT-M`, 'dot segment'],
    ['an encoded dot segment', `${base}/%2e%2e/po`, 'dot segment'],
    ['a tab inside a dot segment, which a parser removes', `${base}/.\t./po`, 'removed'],
    ['a capital letter in the host', 'https://MOCK.example/t/run1/erp/stock/GLV-NIT-M', 'capital letter'],
    ['the default port written out', 'https://mock.example:443/t/run1/erp/stock/GLV-NIT-M', 'default port'],
    ['a backslash', `${base}/stock\\GLV-NIT-M`, 'backslash'],
    ['an encoded dot inside a segment', `${base}/stock/a%2eb`, 'encoded dot'],
    ['an upper case encoded dot', `${base}/stock/a%2Eb`, 'encoded dot'],
    ['an encoded slash', `${base}/..%2fpo`, 'encoded dot, slash or backslash'],
    ['an upper case encoded slash', `${base}/stock%2Fx`, 'encoded dot, slash or backslash'],
    ['an encoded backslash', `${base}/stock/a%5cb`, 'encoded dot, slash or backslash'],
    ['a query', `${base}/stock/GLV-NIT-M?tenant=run2`, 'query'],
    ['an empty query', `${base}/stock/GLV-NIT-M?`, 'query'],
    ['a fragment', `${base}/stock/GLV-NIT-M#x`, 'fragment'],
    ['an empty fragment', `${base}/stock/GLV-NIT-M#`, 'fragment'],
    ['a user part', 'https://user@mock.example/t/run1/erp/stock/GLV-NIT-M', 'user part'],
    ['a user and a password', 'https://user:secret@mock.example/t/run1/erp/stock/GLV-NIT-M', 'user part'],
    ['a path that only starts with the letters of the resource', 'https://mock.example/t/run1/erpx/stock/GLV-NIT-M', 'not below the resource'],
    ['another tenant', 'https://mock.example/t/run2/erp/stock/GLV-NIT-M', 'not below the resource'],
    ['a text that is not a URL', 'not a url', 'cannot be parsed'],
    ['a host that starts like the host of the base', 'https://mock.example.evil.test/t/run1/erp/stock/GLV-NIT-M', 'not on the host of its kind'],
    ['a port of the host', 'https://mock.example:8443/t/run1/erp/stock/GLV-NIT-M', 'not on the host of its kind'],
    ['http', 'http://mock.example/t/run1/erp/stock/GLV-NIT-M', 'not an https URL'],
  ];

  it.each(refused)('is not sent for %s', async (_name, url, why) => {
    const w = world();
    const token = await w.tokenFor(erpTarget());
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{}' });
    const result = await callWithToken(w.deps, token, { ...erpTarget(), url });
    expect(result).toMatchObject({ ...NOT_SENT, detail: expect.stringContaining(why) });
    expect(stub.requests).toHaveLength(0);
  });

  it('is not sent when the URL is not text', async () => {
    const w = world();
    const token = await w.tokenFor(erpTarget());
    expect(await callWithToken(w.deps, token, { ...erpTarget(), url: undefined as never })).toMatchObject(NOT_SENT);
  });

  it.each([
    ['the resource itself', base],
    ['a path below it', `${base}/stock/MSK-N95`],
    ['a segment that is percent-encoded', `${base}/stock/A%20B`],
    ['a segment with an encoded percent sign, which is not an encoded dot', `${base}/stock/a%252eb`],
    ['a segment that contains dots', `${base}/stock/a.b..c`],
  ])('is sent for %s: the twin of each URL above', async (_name, url) => {
    const w = world();
    const token = await w.tokenFor(erpTarget());
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{"on_hand":1}' });
    expect(await callWithToken(w.deps, token, { ...erpTarget(), url })).toMatchObject({ ok: true });
    expect(stub.requests).toHaveLength(1);
  });

  it('keeps the token away from a URL that the fetch of Node would turn into the path of another route', async () => {
    const w = world();
    const token = await w.tokenFor(erpTarget());
    stub.requests.length = 0;
    const result = await callWithToken(w.deps, token, { ...erpTarget(), url: `${base}/../../run2/erp/stock/GLV-NIT-M` });
    expect(result).toMatchObject(NOT_SENT);
    expect(stub.requests.map((r) => r.path)).toStrictEqual([]);
  });
});

describe('the URL of a call with a JWT-SVID', () => {
  async function svidWorld() {
    const w = world();
    const intake = w.gateway.createAgent({ label: 'insurer-intake' });
    const requests = expectTarget(jwtSvidTarget(BASES, 'run1', 'insurer.requests'));
    const issued = await fetchJwtSvid({ client: w.client }, { did: intake.did, key: intake.authentication.privateKey }, requests);
    if (!issued.ok) throw new Error(`no SVID: ${issued.detail}`);
    return { ...w, intake, requests, svid: issued.value };
  }

  it.each([
    ['a dot segment to another tenant', (audience: string) => `${audience}/../../run2/insurer/requests`, 'dot segment'],
    ['an encoded slash', (audience: string) => `${audience}/..%2frequests`, 'encoded dot, slash or backslash'],
    ['a query', (audience: string) => `${audience}/requests?tenant=run2`, 'query'],
    ['a user part', () => 'https://user@mock.example/t/run1/insurer/requests', 'user part'],
    ['another system on the same tenant', () => 'https://mock.example/t/run1/erp/stock/x', 'not below the resource'],
  ])('is not sent for %s, and the bearer goes nowhere', async (_name, urlOf, why) => {
    const w = await svidWorld();
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{}' });
    const result = await callWithJwtSvid(w.deps, w.svid, { ...w.requests, url: urlOf(w.requests.audience) }, { request_number: 'R1' });
    expect(result).toMatchObject({ ...NOT_SENT, detail: expect.stringContaining(why) });
    expect(stub.requests).toHaveLength(0);
  });

  it('is sent for the URL of the route: the twin', async () => {
    const w = await svidWorld();
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{}' });
    expect(await callWithJwtSvid(w.deps, w.svid, w.requests, { request_number: 'R1' })).toMatchObject({ ok: true });
    expect(stub.requests.map((r) => r.path)).toStrictEqual(['/t/run1/insurer/requests']);
  });
});

describe('the URL of a call with an X.509-SVID', () => {
  async function x509World() {
    const w = world();
    const desk = w.gateway.createAgent({ label: 'order-desk' });
    const issued = await fetchX509Svid({ client: w.client }, { did: desk.did, key: desk.authentication.privateKey });
    if (!issued.ok) throw new Error(`no SVID: ${issued.detail}`);
    const calls: MtlsRequest[] = [];
    const deps = { ...w.deps, transport: async (request: MtlsRequest) => (calls.push(request), { status: 200, body: '{}' }) };
    return { ...w, svid: issued.value, calls, deps, catalogue: expectTarget(x509Target(BASES, 'run1', 'supplier.catalogue', { sku: 'MSK-N95' })) };
  }

  it.each([
    ['the host of the tokens', 'https://mock.example/t/run1/supplier/catalogue/MSK-N95', 'not on the host of its kind'],
    ['a dot segment to another system', 'https://mock-mtls.example/t/run1/supplier/../erp/stock/x', 'dot segment'],
    ['another tenant', 'https://mock-mtls.example/t/run2/supplier/catalogue/MSK-N95', 'not below the resource'],
    ['a path that only starts with the letters of the system', 'https://mock-mtls.example/t/run1/supplierx/catalogue/MSK-N95', 'not below the resource'],
    ['a query', 'https://mock-mtls.example/t/run1/supplier/catalogue/MSK-N95?x=1', 'query'],
    ['an encoded slash', 'https://mock-mtls.example/t/run1/supplier/..%2ferp', 'encoded dot, slash or backslash'],
    ['a user part', 'https://user@mock-mtls.example/t/run1/supplier/catalogue/MSK-N95', 'user part'],
    ['http', 'http://mock-mtls.example/t/run1/supplier/catalogue/MSK-N95', 'not an https URL'],
  ])('is not sent for %s, and the transport gets no certificate', async (_name, url, why) => {
    const w = await x509World();
    const result = await callWithX509Svid(w.deps, w.svid, { ...w.catalogue, url });
    expect(result).toMatchObject({ ...NOT_SENT, detail: expect.stringContaining(why) });
    expect(w.calls).toHaveLength(0);
  });

  it('is sent for the URL of the route on the client-certificate base: the twin', async () => {
    const w = await x509World();
    expect(await callWithX509Svid(w.deps, w.svid, w.catalogue)).toMatchObject({ ok: true });
    expect(w.calls.map((c) => c.url)).toStrictEqual(['https://mock-mtls.example/t/run1/supplier/catalogue/MSK-N95']);
  });

  it('is not sent when the resource of the route is not a URL', async () => {
    const w = await x509World();
    expect(await callWithX509Svid(w.deps, w.svid, { ...w.catalogue, resource: 'not a url' })).toMatchObject({ ...NOT_SENT, detail: expect.stringContaining('not a URL') });
    expect(w.calls).toHaveLength(0);
  });
});

describe('a call goes to the host of its kind', () => {
  const ELSEWHERE: MockBases = { publicBase: 'https://elsewhere.example', mtlsBase: 'https://elsewhere-mtls.example' };

  it('does not send a token to a host that is not the public base, although the token is for the resource on that host; the twin is the public base of that host', async () => {
    const w = world();
    const target = expectTarget(tokenTarget(ELSEWHERE, 'run1', 'erp.stock', { sku: 'GLV-NIT-M' }));
    const token = await w.tokenFor(target);
    const recorder = recordingFetch();
    expect(await callWithToken({ fetch: recorder.fetch, clock: w.clock, bases: BASES }, token, target)).toMatchObject({ ...NOT_SENT, detail: expect.stringContaining('not on the host of its kind') });
    expect(recorder.urls).toHaveLength(0);
    expect(await callWithToken({ fetch: recorder.fetch, clock: w.clock, bases: ELSEWHERE }, token, target)).toMatchObject({ ok: true });
    expect(recorder.urls).toStrictEqual(['https://elsewhere.example/t/run1/erp/stock/GLV-NIT-M']);
  });

  it('does not send a JWT-SVID to a host that is not the public base; the twin is the public base of that host', async () => {
    const w = world();
    const intake = w.gateway.createAgent({ label: 'insurer-intake' });
    const target = expectTarget(jwtSvidTarget(ELSEWHERE, 'run1', 'insurer.requests'));
    const svid = await fetchJwtSvid({ client: w.client }, { did: intake.did, key: intake.authentication.privateKey }, target);
    if (!svid.ok) throw new Error(svid.detail);
    const recorder = recordingFetch();
    expect(await callWithJwtSvid({ fetch: recorder.fetch, clock: w.clock, bases: BASES }, svid.value, target, { request_number: 'R1' })).toMatchObject(NOT_SENT);
    expect(recorder.urls).toHaveLength(0);
    expect(await callWithJwtSvid({ fetch: recorder.fetch, clock: w.clock, bases: ELSEWHERE }, svid.value, target, { request_number: 'R1' })).toMatchObject({ ok: true });
  });

  it('does not send an X.509-SVID to a host that is not the client-certificate base; the twin is the client-certificate base of that host', async () => {
    const w = world();
    const desk = w.gateway.createAgent({ label: 'order-desk' });
    const svid = await fetchX509Svid({ client: w.client }, { did: desk.did, key: desk.authentication.privateKey });
    if (!svid.ok) throw new Error(svid.detail);
    const target = expectTarget(x509Target(ELSEWHERE, 'run1', 'supplier.catalogue', { sku: 'MSK-N95' }));
    const calls: string[] = [];
    const transport = async (request: MtlsRequest) => (calls.push(request.url), { status: 200, body: '{}' });
    expect(await callWithX509Svid({ fetch, clock: w.clock, bases: BASES, transport }, svid.value, target)).toMatchObject(NOT_SENT);
    expect(calls).toHaveLength(0);
    expect(await callWithX509Svid({ fetch, clock: w.clock, bases: ELSEWHERE, transport }, svid.value, target)).toMatchObject({ ok: true });
    expect(calls).toStrictEqual(['https://elsewhere-mtls.example/t/run1/supplier/catalogue/MSK-N95']);
  });

  it.each([
    ['a public base that is not https', { publicBase: 'http://mock.example', mtlsBase: BASES.mtlsBase }],
    ['a public base with a path', { publicBase: 'https://mock.example/x', mtlsBase: BASES.mtlsBase }],
    ['no bases', undefined],
  ])('does not send a token when the bases are wrong: %s', async (_name, bases) => {
    const w = world();
    const token = await w.tokenFor(erpTarget());
    stub.requests.length = 0;
    expect(await callWithToken({ ...w.deps, bases: bases as never }, token, erpTarget())).toMatchObject(NOT_SENT);
    expect(stub.requests).toHaveLength(0);
  });

  it('does not send an X.509-SVID when the client-certificate base is wrong', async () => {
    const w = world();
    const desk = w.gateway.createAgent({ label: 'order-desk' });
    const svid = await fetchX509Svid({ client: w.client }, { did: desk.did, key: desk.authentication.privateKey });
    if (!svid.ok) throw new Error(svid.detail);
    const calls: string[] = [];
    const transport = async (request: MtlsRequest) => (calls.push(request.url), { status: 200, body: '{}' });
    const target = expectTarget(x509Target(BASES, 'run1', 'supplier.catalogue', { sku: 'MSK-N95' }));
    expect(await callWithX509Svid({ fetch, clock: w.clock, bases: { ...BASES, mtlsBase: 'not a url' }, transport }, svid.value, target)).toMatchObject(NOT_SENT);
    expect(calls).toHaveLength(0);
  });
});
