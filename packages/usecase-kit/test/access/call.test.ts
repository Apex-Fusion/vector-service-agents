// packages/usecase-kit/test/access/call.test.ts: a call to a mock system with a token. The mock system is a server on a loopback port, and the gateway is the stub of id-kit. The server checks the
// token and its DPoP proof with the verifier of id-kit, so a proof that is not right for the method and the URL of the call is a 401. Each refusal has an accepted twin.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifier } from '@vsa/id-kit/verify';
import { RUNTIME_BODY_LIMIT_BYTES, SYSTEM_REFUSALS, SYSTEM_REFUSAL_STATUS } from '../../src/protocol/index.ts';
import { RouteToken, callWithToken, requestRouteToken, requestSubagentToken, tokenTarget } from '../../src/access/index.ts';
import type { CallDeps, SystemResult, TokenTarget } from '../../src/access/index.ts';
import { BASES, FakeClock, expectTarget, gatewayWorld, startStub, viaStub, type StubServer } from './support.ts';

let stub: StubServer;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
});

/** The world: the agent holds a delegation that covers every route of the stub, and its reader holds a sub-delegation for the stock. */
function world() {
  const w = gatewayWorld();
  const bases = BASES;
  const erp = expectTarget(tokenTarget(bases, 'run1', 'erp.stock', { sku: 'GLV-NIT-M' }));
  const po = expectTarget(tokenTarget(bases, 'run1', 'po.write'));
  const root = w.gateway.delegate({ delegator: { principalKey: w.hirer }, delegate: w.agent, actions: ['erp.*', 'po.write'], resources: ['*'], remaining: 1 });
  const child = w.gateway.delegate({ delegator: w.agent, delegate: w.reader, parent: root, actions: ['erp.stock.read'], resources: ['*'], remaining: 0 });
  const clock = new FakeClock(w.gateway.now());
  const verifier = createVerifier({ baseUrl: w.gateway.baseUrl, fetch: w.gateway.fetch, now: w.gateway.now });
  const deps: CallDeps = { fetch: viaStub(stub), clock };
  const tokenFor = async (target: TokenTarget): Promise<RouteToken> => {
    const result = await requestRouteToken(
      { client: w.client },
      { target, holder: 'agent', subject: { did: w.agent.did, key: w.agent.authentication.privateKey }, dpopKey: w.agent.delegation.privateKey, delegation: root.id },
    );
    if (!result.ok) throw new Error(`no token: ${result.code}: ${result.detail}`);
    return result.value;
  };
  const readerToken = async (target: TokenTarget): Promise<RouteToken> => {
    const result = await requestSubagentToken(
      { client: w.client },
      { target, subagent: { did: w.reader.did, authenticationKey: w.reader.authentication.privateKey, delegationKey: w.reader.delegation.privateKey }, subDelegation: child.id },
    );
    if (!result.ok) throw new Error(`no token: ${result.code}: ${result.detail}`);
    return result.value;
  };
  /** The mock system: it verifies the token for the action and the resource of the route, and it answers 200 for a token that is right. */
  const serveVerified = (target: TokenTarget, answer: object = { sku: 'GLV-NIT-M', on_hand: 12 }, status = 200): void => {
    stub.reply(async (request) => {
      const verified = await verifier.accessToken(
        { authorization: String(request.headers.authorization), dpop: String(request.headers.dpop), method: request.method, url: `${BASES.publicBase}${request.path}` },
        { audience: target.resource, require: { action: target.action, resource: target.resource } },
      );
      return verified.ok ? { status, body: JSON.stringify(answer) } : { status: 401, body: JSON.stringify({ error: 'token_invalid', message: verified.rule }) };
    });
  };
  return { ...w, bases, erp, po, root, child, clock, deps, tokenFor, readerToken, serveVerified };
}

const refusal = (error: string): string => JSON.stringify({ error, message: 'words' });
const expectRefused = (result: SystemResult, reason: string, status?: number): void => {
  expect(result).toMatchObject({ ok: false, code: 'refused_by_system', reason, ...(status === undefined ? {} : { status }) });
};

describe('a call with a token', () => {
  it('sends the token with a DPoP proof that the verifier of the mock system accepts, and gives the body', async () => {
    const w = world();
    stub.requests.length = 0;
    w.serveVerified(w.erp);
    const result = await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp);
    expect(result).toStrictEqual({ ok: true, status: 200, body: { sku: 'GLV-NIT-M', on_hand: 12 } });
    expect(stub.requests.length).toBe(1);
    const sent = stub.requests[0]!;
    expect(sent.method).toBe('GET');
    expect(sent.path).toBe('/t/run1/erp/stock/GLV-NIT-M');
    expect(String(sent.headers.authorization)).toMatch(/^DPoP [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sent.headers.dpop).toBeTypeOf('string');
    expect(sent.headers['content-type']).toBeUndefined();
    expect(sent.body).toBe('');
  });

  it('sends a new proof for each call', async () => {
    const w = world();
    stub.requests.length = 0;
    w.serveVerified(w.erp);
    const token = await w.tokenFor(w.erp);
    expect((await callWithToken(w.deps, token, w.erp)).ok).toBe(true);
    expect((await callWithToken(w.deps, token, w.erp)).ok).toBe(true);
    expect(stub.requests[0]!.headers.dpop).not.toBe(stub.requests[1]!.headers.dpop);
  });

  it('is refused by the verifier when the proof is for another URL: the twin of the call above', async () => {
    const w = world();
    w.serveVerified(w.erp);
    const token = await w.tokenFor(w.erp);
    const other = expectTarget(tokenTarget(w.bases, 'run1', 'erp.stock', { sku: 'MSK-N95' }));
    const wrongUrl: typeof fetch = (_url, init) => viaStub(stub)(other.url, init);
    expect(await callWithToken({ ...w.deps, fetch: wrongUrl }, token, w.erp)).toMatchObject({ ok: false, code: 'refused_by_system', reason: 'token_invalid', status: 401 });
    expect((await callWithToken(w.deps, token, w.erp)).ok).toBe(true);
  });

  it('writes a JSON body with a content type, and gives the 201 answer', async () => {
    const w = world();
    stub.requests.length = 0;
    w.serveVerified(w.po, { record_id: 'rec-1' }, 201);
    const result = await callWithToken(w.deps, await w.tokenFor(w.po), w.po, { po_number: 'PO-1', quantity: 400 });
    expect(result).toMatchObject({ ok: true, status: 201, body: { record_id: 'rec-1' } });
    const sent = stub.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent.body)).toStrictEqual({ po_number: 'PO-1', quantity: 400 });
  });

  it('works for a subagent with the token of its sub-delegation', async () => {
    const w = world();
    w.serveVerified(w.erp);
    expect(await callWithToken(w.deps, await w.readerToken(w.erp), w.erp)).toMatchObject({ ok: true, status: 200 });
  });
});

describe('each refusal status of a mock system', () => {
  it.each(SYSTEM_REFUSALS.map((code) => [code, SYSTEM_REFUSAL_STATUS[code]] as const))('%s with %i is refused_by_system, and it is sent one time', async (code, status) => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status, body: refusal(code) });
    expectRefused(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp), code, status);
    expect(stub.requests.length).toBe(1);
  });

  it.each([[400], [404], [409], [413], [415], [500], [502], [503]])('%i is mock_system_failed with the code of the system, and it is sent one time', async (status) => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status, body: refusal('duplicate_po') });
    expect(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp)).toMatchObject({ ok: false, code: 'mock_system_failed', status, systemCode: 'duplicate_po', sent: true });
    expect(stub.requests.length).toBe(1);
  });

  it('is mock_system_failed for a 421, which the fetch of Node repeats one time by the Fetch standard; the mock service answers 421 before it reads a credential', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 421, body: refusal('wrong_host') });
    expect(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp)).toMatchObject({ ok: false, code: 'mock_system_failed', status: 421, systemCode: 'wrong_host', sent: true });
    expect(stub.requests.length).toBeLessThanOrEqual(2);
  });

  it('is a refusal for a body that says ok with the status 403, and is a failure for a 200 with a body that is not JSON', async () => {
    const w = world();
    stub.reply({ status: 403, body: JSON.stringify({ ok: true, allowed: true }) });
    expectRefused(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp), 'refusal_without_code', 403);
    stub.reply({ status: 403, body: JSON.stringify({ ok: true, error: 'not_covered' }) });
    expectRefused(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp), 'not_covered', 403);
    stub.reply({ status: 200, body: 'OK', headers: { 'content-type': 'text/plain' } });
    expect(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp)).toMatchObject({ ok: false, code: 'mock_system_failed', status: 200 });
    stub.reply({ status: 200, body: '' });
    expect(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp)).toMatchObject({ ok: false, code: 'mock_system_failed', status: 200 });
    stub.reply({ status: 200, body: '{"sku":"x"}' });
    expect((await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp)).ok).toBe(true);
  });

  it('is a failure for a 403 of a proxy with a page that is not JSON', async () => {
    const w = world();
    stub.reply({ status: 403, body: '<html>Forbidden</html>', headers: { 'content-type': 'text/html' } });
    expect(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp)).toMatchObject({ ok: false, code: 'mock_system_failed', status: 403 });
  });

  it('does not follow a redirect: it is a failure, and the second URL gets no request', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 302, headers: { location: `${stub.origin}/elsewhere` } });
    expect(await callWithToken(w.deps, await w.tokenFor(w.erp), w.erp)).toMatchObject({ ok: false, code: 'mock_system_failed', status: 302 });
    expect(stub.requests.map((r) => r.path)).toStrictEqual(['/t/run1/erp/stock/GLV-NIT-M']);
  });
});

describe('a call that gets no answer', () => {
  const never = (seen: { aborted: boolean }): typeof fetch => (_url, init) =>
    new Promise<Response>(() => {
      init?.signal?.addEventListener('abort', () => (seen.aborted = true));
    });

  it('ends at the time limit of the clock with mock_system_failed, aborts the request, and sends it one time', async () => {
    const w = world();
    const token = await w.tokenFor(w.erp);
    const seen = { aborted: false };
    let calls = 0;
    const hang = never(seen);
    const result = await w.clock.run(callWithToken({ ...w.deps, fetch: (url, init) => (calls += 1, hang(url, init)), timeoutMs: 5_000 }, token, w.erp));
    expect(result).toMatchObject({ ok: false, code: 'mock_system_failed', status: null, systemCode: null, sent: true });
    expect(w.clock.now()).toBe(w.gateway.now() + 5_000);
    expect(seen.aborted).toBe(true);
    expect(calls).toBe(1);
  });

  it('ends at the limit even when the fetch ignores the signal, and has no timer left', async () => {
    const w = world();
    const token = await w.tokenFor(w.erp);
    const result = await w.clock.run(callWithToken({ ...w.deps, fetch: () => new Promise<Response>(() => undefined), timeoutMs: 1_000 }, token, w.erp));
    expect(result).toMatchObject({ ok: false, code: 'mock_system_failed', status: null });
    expect(w.clock.waiting).toBe(0);
  });

  it('gives the answer when it comes in time, with no timer left: the twin', async () => {
    const w = world();
    const result = await callWithToken({ ...w.deps, fetch: async () => new Response('{"sku":"x"}', { status: 200 }), timeoutMs: 5_000 }, await w.tokenFor(w.erp), w.erp);
    expect(result).toMatchObject({ ok: true });
    expect(w.clock.waiting).toBe(0);
  });

  it('is mock_system_failed for a network error, sent one time, and the error text holds no credential', async () => {
    const w = world();
    const token = await w.tokenFor(w.erp);
    let calls = 0;
    const result = await callWithToken(
      { ...w.deps, fetch: async (_url, init) => { calls += 1; throw new TypeError(`fetch failed: could not send ${String((init?.headers as Record<string, string>).authorization)} and ${String((init?.headers as Record<string, string>).dpop)}`); } },
      token,
      w.erp,
    );
    expect(result).toMatchObject({ ok: false, code: 'mock_system_failed', status: null, sent: true });
    expect(calls).toBe(1);
    const text = JSON.stringify(result);
    expect(text).toContain('[removed]');
    expect(text).not.toMatch(/eyJ/);
  });

  it('is mock_system_failed for an answer that is longer than the limit, and gives the answer within it', async () => {
    const w = world();
    const token = await w.tokenFor(w.erp);
    const body = JSON.stringify({ data: 'x'.repeat(100) });
    const big = (): typeof fetch => async () => new Response(body, { status: 200 });
    expect(await callWithToken({ ...w.deps, fetch: big(), maxAnswerBytes: 50 }, token, w.erp)).toMatchObject({ ok: false, code: 'mock_system_failed', status: 200 });
    expect(await callWithToken({ ...w.deps, fetch: big(), maxAnswerBytes: 500 }, token, w.erp)).toMatchObject({ ok: true });
  });
});

describe('a token that is asked for one route is not sent to another', () => {
  it('is not sent to another route, and the twin is sent: the same route with another path parameter', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{}' });
    const token = await w.tokenFor(w.erp);
    expect(await callWithToken(w.deps, token, w.po, { po_number: 'x' })).toMatchObject({ ok: false, code: 'mock_system_failed', status: null, sent: false });
    expect(stub.requests.length).toBe(0);
    const sameRoute = expectTarget(tokenTarget(w.bases, 'run1', 'erp.stock', { sku: 'MSK-N95' }));
    expect((await callWithToken(w.deps, token, sameRoute)).ok).toBe(true);
    expect(stub.requests.map((r) => r.path)).toStrictEqual(['/t/run1/erp/stock/MSK-N95']);
  });

  it('is not sent to the route of another system or another action under the same resource', async () => {
    const w = world();
    stub.requests.length = 0;
    const records = expectTarget(tokenTarget(w.bases, 'run1', 'records.order', { order_id: 'ORD-1001' }));
    const submission = expectTarget(tokenTarget(w.bases, 'run1', 'records.submission', { order_id: 'ORD-1001' }));
    const token = new RouteToken({ route: records.route, action: records.action, resource: records.resource, callers: records.callers, holder: 'agent', expiresAt: w.clock.now() + 60_000 }, 'a.b.c', w.agent.delegation.privateKey);
    expect(await callWithToken(w.deps, token, submission, { request_number: 'R1', intake_id: 'I1' })).toMatchObject({ ok: false, sent: false });
    expect(stub.requests.length).toBe(0);
    stub.reply({ status: 200, body: '{}' });
    expect(await callWithToken(w.deps, token, records)).toMatchObject({ ok: true });
    expect(stub.requests.length).toBe(1);
  });

  it('is not sent for another tenant, and is sent for the tenant that it was asked for', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{}' });
    const token = await w.tokenFor(w.erp);
    const other = expectTarget(tokenTarget(w.bases, 'run2', 'erp.stock', { sku: 'GLV-NIT-M' }));
    expect(await callWithToken(w.deps, token, other)).toMatchObject({ ok: false, sent: false });
    expect(stub.requests.length).toBe(0);
    expect((await callWithToken(w.deps, token, w.erp)).ok).toBe(true);
  });

  it('is not sent to another host: the resource holds the origin', async () => {
    const w = world();
    stub.requests.length = 0;
    const token = await w.tokenFor(w.erp);
    const elsewhere = expectTarget(tokenTarget({ publicBase: 'https://elsewhere.example', mtlsBase: 'https://elsewhere-mtls.example' }, 'run1', 'erp.stock', { sku: 'GLV-NIT-M' }));
    expect(await callWithToken(w.deps, token, elsewhere)).toMatchObject({ ok: false, sent: false });
    expect(stub.requests.length).toBe(0);
  });

  it('is not sent by a subagent to a route that takes the agent only', async () => {
    const w = world();
    stub.requests.length = 0;
    const subagentToken = new RouteToken({ route: w.po.route, action: w.po.action, resource: w.po.resource, callers: 'agent', holder: 'subagent', expiresAt: w.clock.now() + 60_000 }, 'a.b.c', w.agent.delegation.privateKey);
    expect(await callWithToken(w.deps, subagentToken, w.po, { po_number: 'x' })).toMatchObject({ ok: false, sent: false });
    expect(stub.requests.length).toBe(0);
    const agentToken = new RouteToken({ route: w.po.route, action: w.po.action, resource: w.po.resource, callers: 'agent', holder: 'agent', expiresAt: w.clock.now() + 60_000 }, 'a.b.c', w.agent.delegation.privateKey);
    stub.reply({ status: 201, body: '{}' });
    expect((await callWithToken(w.deps, agentToken, w.po, { po_number: 'x' })).ok).toBe(true);
  });

  it('is not sent after it ended, and is sent a millisecond before', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 200, body: '{}' });
    const token = await w.tokenFor(w.erp);
    await w.clock.advance(token.expiresAt - w.clock.now() - 1);
    expect((await callWithToken(w.deps, token, w.erp)).ok).toBe(true);
    await w.clock.advance(1);
    expect(await callWithToken(w.deps, token, w.erp)).toMatchObject({ ok: false, sent: false, detail: 'the token has ended' });
    expect(stub.requests.length).toBe(1);
  });
});

describe('the body of a call', () => {
  it('is refused before it is sent when a GET has a body, when a POST has none, and when it is over the limit of the runtime', async () => {
    const w = world();
    stub.requests.length = 0;
    stub.reply({ status: 201, body: '{}' });
    const get = await w.tokenFor(w.erp);
    const post = await w.tokenFor(w.po);
    expect(await callWithToken(w.deps, get, w.erp, {})).toMatchObject({ ok: false, sent: false });
    expect(await callWithToken(w.deps, post, w.po)).toMatchObject({ ok: false, sent: false });
    expect(await callWithToken(w.deps, post, w.po, 'x'.repeat(RUNTIME_BODY_LIMIT_BYTES))).toMatchObject({ ok: false, sent: false });
    expect(stub.requests.length).toBe(0);
    expect((await callWithToken(w.deps, post, w.po, { po_number: 'x' })).ok).toBe(true);
    expect((await callWithToken(w.deps, get, w.erp)).ok).toBe(true);
    expect(stub.requests.length).toBe(2);
  });
});

describe('what a result of a call shows', () => {
  it('holds no token, no proof and no key, whatever the answer was', async () => {
    const w = world();
    const token = await w.tokenFor(w.erp);
    const seen: string[] = [];
    const record = (init: RequestInit | undefined): void => {
      const headers = init?.headers as Record<string, string>;
      seen.push(headers.authorization!, headers.dpop!, headers.authorization!.slice(5), ...headers.authorization!.slice(5).split('.'), ...headers.dpop!.split('.'));
    };
    const answers: [number, string][] = [[200, '{"a":1}'], [200, 'not json'], [401, refusal('token_invalid')], [403, JSON.stringify({ error: 'not_covered', message: `echo ${'x'.repeat(5)}` })], [500, 'boom'], [302, '']];
    const results: SystemResult[] = [];
    for (const [status, body] of answers) {
      results.push(await callWithToken({ ...w.deps, fetch: async (_url, init) => { record(init); return new Response(body, { status }); } }, token, w.erp));
    }
    results.push(await callWithToken({ ...w.deps, fetch: async (_url, init) => { record(init); throw new Error(`down ${String((init?.headers as Record<string, string>).dpop)}`); } }, token, w.erp));
    const shown = JSON.stringify(results);
    for (const secret of seen) expect(shown, secret.slice(0, 20)).not.toContain(secret);
    expect(shown).not.toContain(w.agent.delegation.jwk.x);
  });
});
