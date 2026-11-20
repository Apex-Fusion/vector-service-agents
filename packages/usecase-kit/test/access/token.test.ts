// packages/usecase-kit/test/access/token.test.ts: a token for one route, against the stub gateway of id-kit. Each refusal has an accepted twin.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { GatewayClient, GatewayResult, IssuedToken, KeyInput, TokenRequest } from '@vsa/id-kit/client';
import { RouteToken, askWhileTooYoung, requestRouteToken, requestSubagentToken, tokenTarget } from '../../src/access/index.ts';
import type { RouteTokenRequest, RouteTokenResult, TokenTarget } from '../../src/access/index.ts';
import { BASES, FakeClock, NOW, claimsOf, erpTarget, expectTarget, gatewayWorld } from './support.ts';

/** The gateway world with the delegation of the hirer to the agent, and the sub-delegation of the agent to its reader. The client records each request and each answer. */
function world(over: { rootConfirmations?: number; childConfirmations?: number } = {}) {
  const w = gatewayWorld();
  const erp = erpTarget(BASES, 'run1');
  const po = expectTarget(tokenTarget(BASES, 'run1', 'po.write'));
  const root = w.gateway.delegate({
    delegator: { principalKey: w.hirer }, delegate: w.agent, actions: ['erp.stock.read', 'po.write'], resources: [erp.resource, po.resource], remaining: 1,
    ...(over.rootConfirmations === undefined ? {} : { confirmations: over.rootConfirmations }),
  });
  const child = w.gateway.delegate({
    delegator: w.agent, delegate: w.reader, parent: root, actions: ['erp.stock.read'], resources: [erp.resource], remaining: 0, ...(over.childConfirmations === undefined ? {} : { confirmations: over.childConfirmations }),
  });
  const seen: { request: TokenRequest; answer: GatewayResult<IssuedToken> }[] = [];
  const client: Pick<GatewayClient, 'requestToken'> = {
    requestToken: async (request) => {
      const answer = await w.client.requestToken(request);
      seen.push({ request, answer });
      return answer;
    },
  };
  const agentRequest = (target: TokenTarget, over2: Partial<RouteTokenRequest> = {}): RouteTokenRequest => ({
    target, holder: 'agent', subject: { did: w.agent.did, key: w.agent.authentication.privateKey }, dpopKey: w.agent.delegation.privateKey, delegation: root.id, ...over2,
  });
  const readerRequest = (target: TokenTarget) => ({
    target, subagent: { did: w.reader.did, authenticationKey: w.reader.authentication.privateKey, delegationKey: w.reader.delegation.privateKey }, subDelegation: child.id,
  });
  const tokenRequests = (): number => w.gateway.requests.filter((r) => r.path === '/token').length;
  return { ...w, erp, po, root, child, client, seen, agentRequest, readerRequest, tokenRequests };
}

const failure = (result: RouteTokenResult) => {
  if (result.ok) throw new Error('a token was issued');
  return result;
};

describe('a token for one route', () => {
  it('is issued for the resource of the route, with the one action and the one resource that were asked for, even when the delegation covers more', async () => {
    const w = world();
    const result = await requestRouteToken({ client: w.client }, w.agentRequest(w.erp));
    expect(result.ok).toBe(true);
    const sent = w.seen[0]!;
    expect(sent.request.resource).toBe('https://mock.example/t/run1/erp');
    expect(sent.request.delegation).toStrictEqual({ identifier: w.root.id, actions: ['erp.stock.read'], locations: ['https://mock.example/t/run1/erp'] });
    const claims = claimsOf(sent.answer.ok ? sent.answer.value.accessToken : '');
    expect(claims.aud).toBe('https://mock.example/t/run1/erp');
    expect(claims.authorization_details).toMatchObject([{ identifier: w.root.id, actions: ['erp.stock.read'], locations: ['https://mock.example/t/run1/erp'] }]);
    expect(w.root.actions).toStrictEqual(['erp.stock.read', 'po.write']);
  });

  it('has an act chain of one link for the agent, and of two links for its subagent', async () => {
    const w = world();
    await requestRouteToken({ client: w.client }, w.agentRequest(w.erp));
    const sub = await requestSubagentToken({ client: w.client }, w.readerRequest(w.erp));
    expect(sub.ok).toBe(true);
    const [agentClaims, readerClaims] = w.seen.map((s) => claimsOf(s.answer.ok ? s.answer.value.accessToken : ''));
    expect(agentClaims!.act).toStrictEqual({ sub: w.agent.did });
    expect(readerClaims!.act).toStrictEqual({ sub: w.reader.did, act: { sub: w.agent.did } });
    expect(readerClaims!.client_id).toBe(w.reader.did);
    expect(readerClaims!.authorization_details).toMatchObject([{ identifier: w.child.id }]);
  });

  it('is the token of its route: the object holds the route, the action, the resource and the holder', async () => {
    const w = world();
    const result = await requestRouteToken({ client: w.client }, w.agentRequest(w.erp));
    expect(result.ok && result.value).toMatchObject({ route: 'erp.stock', action: 'erp.stock.read', resource: w.erp.resource, holder: 'agent', callers: 'agent-or-subagent' });
    const sub = await requestSubagentToken({ client: w.client }, w.readerRequest(w.erp));
    expect(sub.ok && sub.value.holder).toBe('subagent');
  });

  it('is asked again for each use: nothing is kept for another route', async () => {
    const w = world();
    await requestRouteToken({ client: w.client }, w.agentRequest(w.erp));
    await requestRouteToken({ client: w.client }, w.agentRequest(w.erp));
    await requestRouteToken({ client: w.client }, w.agentRequest(w.po));
    expect(w.tokenRequests()).toBe(3);
    expect(w.seen[2]!.request.delegation?.actions).toStrictEqual(['po.write']);
    expect(w.seen[2]!.request.resource).toBe(w.po.resource);
  });

  it('is refused by the gateway for a route that the delegation does not cover, and issued for one that it does', async () => {
    const w = world();
    const uncovered = expectTarget(tokenTarget(BASES, 'run1', 'vendors.list'));
    expect(failure(await requestRouteToken({ client: w.client }, w.agentRequest(uncovered)))).toMatchObject({ code: 'gateway_refused', status: 400, gatewayError: 'invalid_authorization_details' });
    expect((await requestRouteToken({ client: w.client }, w.agentRequest(w.po))).ok).toBe(true);
  });

  it('is refused for the tenant that the delegation does not name, and issued for the one that it names', async () => {
    const w = world();
    expect(failure(await requestRouteToken({ client: w.client }, w.agentRequest(erpTarget(BASES, 'run2')))).code).toBe('gateway_refused');
    expect((await requestRouteToken({ client: w.client }, w.agentRequest(erpTarget(BASES, 'run1')))).ok).toBe(true);
  });
});

describe('a delegation that is too young', () => {
  it('has its own result, with the answer of the gateway, so that a caller can wait', async () => {
    const w = world({ childConfirmations: 12 });
    const result = failure(await requestSubagentToken({ client: w.client }, w.readerRequest(w.erp)));
    expect(result).toMatchObject({ ok: false, code: 'delegation_too_young', status: 400, gatewayError: 'invalid_authorization_details' });
    expect(result.detail).toMatch(/has fewer than 30 confirmations/);
  });

  it('is the same when a parent in the chain is too young', async () => {
    const w = world({ rootConfirmations: 3 });
    expect(failure(await requestSubagentToken({ client: w.client }, w.readerRequest(w.erp))).code).toBe('delegation_too_young');
    expect(failure(await requestRouteToken({ client: w.client }, w.agentRequest(w.erp))).code).toBe('delegation_too_young');
  });

  it('is not the result for a delegation that ended, and is not the result for one with 30 confirmations', async () => {
    const w = world();
    w.gateway.endDelegation(w.child);
    expect(failure(await requestSubagentToken({ client: w.client }, w.readerRequest(w.erp))).code).toBe('gateway_refused');
    const old = world({ childConfirmations: 30 });
    expect((await requestSubagentToken({ client: old.client }, old.readerRequest(old.erp))).ok).toBe(true);
  });
});

describe('askWhileTooYoung', () => {
  const options = { waitMs: 30_000, pollMs: 10_000 };

  it('asks again while the delegation is too young, and gives the token when it has 30 confirmations', async () => {
    const w = world({ childConfirmations: 10 });
    const clock = new FakeClock(NOW);
    let asks = 0;
    const ask = (): Promise<RouteTokenResult> => {
      asks += 1;
      if (asks === 3) w.child.confirmations = 30;
      return requestSubagentToken({ client: w.client }, w.readerRequest(w.erp));
    };
    const result = await clock.run(askWhileTooYoung(clock, ask, options));
    expect(result.ok).toBe(true);
    expect(asks).toBe(3);
    expect(clock.now()).toBe(NOW + 20_000);
  });

  it('stops at the bound, with the last result: at most waitMs / pollMs + 1 requests', async () => {
    const w = world({ childConfirmations: 10 });
    const clock = new FakeClock(NOW);
    let asks = 0;
    const ask = (): Promise<RouteTokenResult> => {
      asks += 1;
      return requestSubagentToken({ client: w.client }, w.readerRequest(w.erp));
    };
    const result = await clock.run(askWhileTooYoung(clock, ask, options));
    expect(failure(result).code).toBe('delegation_too_young');
    expect(asks).toBe(4);
    expect(clock.now()).toBe(NOW + 30_000);
  });

  it('asks one time when the wait is 0', async () => {
    const w = world({ childConfirmations: 10 });
    let asks = 0;
    await askWhileTooYoung(new FakeClock(NOW), () => (asks += 1, requestSubagentToken({ client: w.client }, w.readerRequest(w.erp))), { waitMs: 0, pollMs: 1 });
    expect(asks).toBe(1);
  });

  it('does not ask again after any other failure', async () => {
    const w = world();
    w.gateway.endDelegation(w.child);
    const clock = new FakeClock(NOW);
    let asks = 0;
    const result = await clock.run(askWhileTooYoung(clock, () => (asks += 1, requestSubagentToken({ client: w.client }, w.readerRequest(w.erp))), options));
    expect(failure(result).code).toBe('gateway_refused');
    expect(asks).toBe(1);
  });

  it.each([[{ waitMs: -1, pollMs: 1 }], [{ waitMs: 1.5, pollMs: 1 }], [{ waitMs: 10, pollMs: 0 }], [{ waitMs: 10, pollMs: Number.NaN }], [{ waitMs: 86_400_001, pollMs: 1 }], [{ waitMs: 10, pollMs: 86_400_001 }]])('refuses the bounds %j and asks nothing', async (bad) => {
    let asks = 0;
    const result = await askWhileTooYoung(new FakeClock(NOW), () => (asks += 1, Promise.reject(new Error('not asked'))), bad);
    expect(failure(result).code).toBe('bad_request');
    expect(asks).toBe(0);
  });
});

describe('a gateway that fails', () => {
  it('is unreachable when no answer comes, unavailable with its wait on a 503, and a bad response for a body that is not a token', async () => {
    const w = world();
    w.gateway.fault('/token', 'network');
    expect(failure(await requestRouteToken({ client: w.client }, w.agentRequest(w.erp)))).toMatchObject({ code: 'gateway_unreachable', status: 0 });
    w.gateway.fault('/token', { status: 503, body: JSON.stringify({ error: 'temporarily_unavailable', error_description: 'try later' }), headers: { 'retry-after': '7', 'content-type': 'application/json' } });
    expect(failure(await requestRouteToken({ client: w.client }, w.agentRequest(w.erp)))).toMatchObject({ code: 'gateway_unavailable', status: 503, retryAfterSeconds: 7 });
    w.gateway.fault('/token', { status: 200, body: 'not json' });
    expect(failure(await requestRouteToken({ client: w.client }, w.agentRequest(w.erp))).code).toBe('gateway_bad_response');
    w.gateway.fault('/token', null);
    expect((await requestRouteToken({ client: w.client }, w.agentRequest(w.erp))).ok).toBe(true);
  });

  it('is never a token when the client of id-kit gives a rule that it does not know', async () => {
    const odd: Pick<GatewayClient, 'requestToken'> = { requestToken: async () => ({ ok: false, rule: 'gateway.something_new', detail: 'new', status: 418, error: null, retryAfterSeconds: null } as never) };
    const w = world();
    expect(failure(await requestRouteToken({ client: odd }, w.agentRequest(w.erp))).code).toBe('gateway_bad_response');
  });

  it('is refused when the grant of the token is not the route that was asked for', async () => {
    const w = world();
    const grant = (details: Record<string, unknown>[] | null): Pick<GatewayClient, 'requestToken'> => ({
      requestToken: async () => ({ ok: true, value: { accessToken: 'a.b.c', tokenType: 'DPoP', issuedTokenType: 'x', expiresIn: 300, expiresAt: NOW + 300_000, authorizationDetails: details } }),
    });
    const exact = { identifier: w.root.id, actions: ['erp.stock.read'], locations: [w.erp.resource] };
    expect((await requestRouteToken({ client: grant([exact]) }, w.agentRequest(w.erp))).ok).toBe(true);
    for (const wrong of [
      null, [], [exact, exact], [{ ...exact, actions: ['erp.stock.read', 'po.write'] }], [{ ...exact, actions: ['po.write'] }], [{ ...exact, locations: [w.po.resource] }],
      [{ ...exact, locations: [w.erp.resource, w.po.resource] }], [{ ...exact, identifier: w.child.id }], [{ identifier: w.root.id }],
    ]) {
      expect(failure(await requestRouteToken({ client: grant(wrong) }, w.agentRequest(w.erp))).code, JSON.stringify(wrong)).toBe('gateway_bad_response');
    }
  });
});

describe('a request that is wrong', () => {
  it('is refused before anything is sent', async () => {
    const w = world();
    const before = w.gateway.requests.length;
    const bad: Partial<RouteTokenRequest>[] = [
      { subject: { did: 'did:vector:xyz', key: w.agent.authentication.privateKey } },
      { subject: { did: w.agent.did.toUpperCase(), key: w.agent.authentication.privateKey } },
      { delegation: 'abc' },
      { delegation: w.root.id.toUpperCase() },
    ];
    for (const over of bad) expect(failure(await requestRouteToken({ client: w.client }, w.agentRequest(w.erp, over))).code, JSON.stringify(Object.keys(over))).toBe('bad_request');
    expect(w.gateway.requests.length).toBe(before);
    expect((await requestRouteToken({ client: w.client }, w.agentRequest(w.erp))).ok).toBe(true);
  });

  it('gives a subagent no token for a route that takes the agent only, and sends nothing', async () => {
    const w = world();
    const before = w.gateway.requests.length;
    expect(failure(await requestSubagentToken({ client: w.client }, w.readerRequest(w.po))).code).toBe('bad_request');
    expect(failure(await requestRouteToken({ client: w.client }, w.agentRequest(w.po, { holder: 'subagent' }))).code).toBe('bad_request');
    expect(w.gateway.requests.length).toBe(before);
    expect((await requestRouteToken({ client: w.client }, w.agentRequest(w.po))).ok).toBe(true);
  });

  it('is refused for a key that is not an Ed25519 key, without a request that the gateway would refuse', async () => {
    const w = world();
    const p256 = w.gateway.keys.p256.privateKey;
    const result = failure(await requestRouteToken({ client: w.client }, w.agentRequest(w.erp, { dpopKey: p256 })));
    expect(result.code).toBe('bad_request');
    expect(w.tokenRequests()).toBe(0);
  });
});

describe('what a result and a token show', () => {
  it('shows no key material when a function of the caller throws', async () => {
    const w = world();
    const secret = 'SECRET-KEY-MATERIAL-0123456789';
    const key: KeyInput = { algorithm: 'EdDSA', publicKey: w.agent.authentication.publicKey, sign: () => { throw new Error(secret); } };
    const result = failure(await requestRouteToken({ client: w.client }, w.agentRequest(w.erp, { subject: { did: w.agent.did, key } })));
    expect(result.code).toBe('bad_request');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.detail).toContain('Error');
  });

  it('shows neither the token nor the key in its JSON text, its string form, its properties and its log form', async () => {
    const w = world();
    const result = await requestRouteToken({ client: w.client }, w.agentRequest(w.erp));
    if (!result.ok) throw new Error('no token');
    const accessToken = w.seen[0]!.answer.ok ? w.seen[0]!.answer.value.accessToken : '';
    expect(accessToken.length).toBeGreaterThan(50);
    const jwk = JSON.stringify(w.agent.delegation.jwk);
    for (const text of [JSON.stringify(result.value), String(result.value), inspect(result.value, { showHidden: true, depth: 5 }), JSON.stringify(Object.getOwnPropertyNames(result.value)), inspect(result)]) {
      expect(text).not.toContain(accessToken);
      expect(text).not.toContain(accessToken.split('.')[1]!);
      expect(text).not.toContain(jwk);
      expect(text).not.toContain(w.agent.delegation.jwk.x);
    }
    expect(result.value instanceof RouteToken).toBe(true);
    expect(JSON.parse(JSON.stringify(result.value))).toMatchObject({ route: 'erp.stock', holder: 'agent' });
  });
});

describe('what counts as a delegation that is too young', () => {
  interface Answer {
    readonly status?: number;
    readonly error?: string | null;
    readonly detail?: string;
  }
  const answering = (over: Answer): Pick<GatewayClient, 'requestToken'> => ({
    requestToken: async () => ({
      ok: false, rule: 'gateway.refused', detail: over.detail ?? `delegation ${'ab'.repeat(32)} has fewer than 30 confirmations`, status: over.status ?? 400,
      error: over.error === undefined ? 'invalid_authorization_details' : over.error, retryAfterSeconds: null,
    }),
  });
  const code = async (over: Answer): Promise<string> => {
    const w = world();
    return failure(await requestRouteToken({ client: answering(over) }, w.agentRequest(w.erp))).code;
  };

  it('is the answer of the gateway for a young delegation, and no other answer', async () => {
    expect(await code({})).toBe('delegation_too_young');
    expect(await code({ status: 403 })).toBe('gateway_refused');
    expect(await code({ status: 429 })).toBe('gateway_refused');
    expect(await code({ error: 'invalid_request' })).toBe('gateway_refused');
    expect(await code({ error: null })).toBe('gateway_refused');
    for (const detail of [
      `delegation ${'ab'.repeat(32)} has fewer than 29 confirmations`, `delegation ${'AB'.repeat(32)} has fewer than 30 confirmations`, `delegation abc has fewer than 30 confirmations`,
      `delegation ${'ab'.repeat(32)} has fewer than 30 confirmations and was undelegated`, `the delegation ${'ab'.repeat(32)} has fewer than 30 confirmations`,
      `delegation ${'ab'.repeat(32)} was undelegated`,
    ]) expect(await code({ detail }), detail).toBe('gateway_refused');
  });
});
