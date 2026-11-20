// Does the service ever honour a token call whose authority ended or never existed? Each test makes one call that must be refused, and has the call that is accepted beside it: the same
// call with the same agent and delegation, but with the fault taken away. The tokens, the status lists and the DID resolution are the stub gateway's; the check of the delegation is the
// real `checkDelegationUse` of buyer-core on a ledger of fixture data that follows the stub gateway; the clock of the gateway, the verifier and the service is one clock.
import { describe, expect, it } from 'vitest';
import { LISTS_UNAVAILABLE, createStubGateway } from '@vsa/id-kit/testing';
import { createGatewayClient } from '@vsa/id-kit';
import { callWithToken, delegateTo, purchaseOrder, scenario, tokenFor } from './support/scenario.ts';
import type { Delegate, Scenario } from './support/scenario.ts';
import { PUBLIC_BASE, resourceOf } from './support/world.ts';

const TENANT = 'run1';
const PO = '/po';

async function poCall(s: Scenario, who: Delegate, number: string, tenant = s.tenant) {
  return callWithToken(s, who, 'po', 'POST', PO, purchaseOrder(tenant, number), tenant);
}

async function setup() {
  const s = await scenario(TENANT);
  const agent = delegateTo(s, 'reorder', [['po.write', 'po'], ['erp.stock.read', 'erp']]);
  return { s, agent };
}

const refused = (reply: { status: number; json: Record<string, unknown> | null }, status: number, code: string) => {
  expect([reply.status, reply.json?.error]).toEqual([status, code]);
};

/** The refusals of the last log line of the service: the rule that refused. */
const lastRule = (s: Scenario): unknown => s.harness.logged().at(-1)?.rule;

describe('a token that is right', () => {
  it('is honoured: the agent writes a purchase order, and the call is in the log with the identity that was verified', async () => {
    const { s, agent } = await setup();
    const reply = await poCall(s, agent, 'run1-1');
    expect(reply.status, reply.text).toBe(201);
    expect(s.harness.logged().at(-1)).toMatchObject({
      tenant: TENANT, route: 'POST /po', method: 'POST', host: 'token', credential: 'token', sub: expect.stringContaining('/principals/key/'), act: [agent.agent.did], delegation: agent.delegation.id,
      decision: 'allowed', status: 201, code: null, rule: null,
    });
  });
  it('is honoured for the second route of the same delegation, with its own token', async () => {
    const { s, agent } = await setup();
    expect((await callWithToken(s, agent, 'erp', 'GET', '/erp/stock/GLV-NIT-M')).status).toBe(200);
  });
  it('is honoured up to the leeway of the verifier after its end, and not after it', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    s.world.advance(310_000);
    const inside = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') });
    expect(inside.status, inside.text).toBe(201);
    s.world.advance(90_000);
    const outside = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    refused(outside, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.expired');
  });
});

describe('a token that is not there or not valid', () => {
  it('no Authorization header, another scheme, and a text that is no token are 401 token_invalid, with the challenge for a DPoP token', async () => {
    const { s, agent } = await setup();
    const none = await s.harness.call({ method: 'POST', path: PO.replace('/', `/t/${TENANT}/`), body: purchaseOrder(TENANT, 'run1-1') });
    refused(none, 401, 'token_invalid');
    expect(none.headers['www-authenticate']).toBe('DPoP algs="ES256 EdDSA"');
    expect(lastRule(s)).toBe('token.missing');
    const credential = await tokenFor(s, agent, 'po');
    const headers = await s.world.presented(credential, 'POST', `${PUBLIC_BASE}/t/${TENANT}${PO}`);
    const bearer = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers: { ...headers, authorization: headers.authorization!.replace('DPoP ', 'Bearer ') }, body: purchaseOrder(TENANT, 'run1-1') });
    refused(bearer, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.scheme');
    const garbage = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers: { ...headers, authorization: 'DPoP not-a-token' }, body: purchaseOrder(TENANT, 'run1-1') });
    refused(garbage, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.malformed');
    const fine = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers, body: purchaseOrder(TENANT, 'run1-1') });
    expect(fine.status, fine.text).toBe(201);
  });
  it('a token that another gateway signed is refused: the key is not in the key set, and the agent never existed here', async () => {
    const { s, agent } = await setup();
    const other = createStubGateway({ baseUrl: 'https://id.other-domain.test', now: s.world.now });
    const stranger = other.createAgent({ label: 'reorder' });
    const delegation = other.delegate({ delegator: { principalKey: s.world.member }, delegate: stranger, actions: ['po.write'], resources: [resourceOf(TENANT, 'po')] });
    const client = createGatewayClient({ baseUrl: other.baseUrl, fetch: other.fetch, now: s.world.now });
    const issued = await client.requestToken({ subject: { did: stranger.did, key: stranger.authentication.privateKey }, dpopKey: stranger.delegation.privateKey, resource: resourceOf(TENANT, 'po'), delegation: { identifier: delegation.id } });
    if (!issued.ok) throw new Error(issued.detail);
    const headers = await s.world.presented({ accessToken: issued.value.accessToken, key: stranger.delegation }, 'POST', `${PUBLIC_BASE}/t/${TENANT}${PO}`);
    const reply = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers, body: purchaseOrder(TENANT, 'run1-1') });
    refused(reply, 401, 'token_invalid');
    expect(['token.kid', 'token.signature', 'token.issuer']).toContain(lastRule(s));
    expect((await poCall(s, agent, 'run1-1')).status).toBe(201);
  });
  it('an expired token is refused, and the same token a moment before its end was honoured', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    s.world.advance(200_000);
    expect((await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') })).status).toBe(201);
    s.world.advance(200_000);
    const late = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    refused(late, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.expired');
    expect((await s.harness.call({ path: `/t/${TENANT}/state` })).json).toMatchObject({ po_store: { orders: [{ po_number: 'run1-1' }] } });
  });
});

describe('a token for another audience, another action, another resource or another tenant', () => {
  it('a token of another audience is refused: the audience of the token is the resource of the route', async () => {
    const { s, agent } = await setup();
    const forErp = await tokenFor(s, agent, 'erp');
    const wrong = await s.harness.tokenCall({ tenant: TENANT, credential: forErp, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') });
    refused(wrong, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.audience');
    expect((await poCall(s, agent, 'run1-1')).status).toBe(201);
  });
  it('a token for another route is refused when its audience is right and its grant covers another action', async () => {
    const s = await scenario(TENANT);
    const reader = delegateTo(s, 'reader', [['erp.stock.read', 'po']]);
    const wrong = await poCall(s, reader, 'run1-1');
    refused(wrong, 403, 'not_covered');
    expect(lastRule(s)).toBe('delegation.action');
    const writer = delegateTo(s, 'writer', [['po.write', 'po']]);
    expect((await poCall(s, writer, 'run1-1')).status).toBe(201);
  });
  it('a token is refused when its audience and its action are right and its grant is for another resource of the same tenant', async () => {
    const s = await scenario(TENANT);
    const elsewhere = delegateTo(s, 'elsewhere', [['po.write', 'erp']]);
    const wrong = await poCall(s, elsewhere, 'run1-1');
    refused(wrong, 403, 'not_covered');
    expect(lastRule(s)).toBe('delegation.resource');
  });
  it('a token with no delegation at all gives no right, whatever the agent is', async () => {
    const { s } = await setup();
    const agent = s.world.agent('plain');
    const issued = await s.world.client.requestToken({ subject: { did: agent.did, key: agent.authentication.privateKey }, dpopKey: agent.delegation.privateKey, resource: resourceOf(TENANT, 'po') });
    if (!issued.ok) throw new Error(issued.detail);
    const headers = await s.world.presented({ accessToken: issued.value.accessToken, key: agent.delegation }, 'POST', `${PUBLIC_BASE}/t/${TENANT}${PO}`);
    const reply = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers, body: purchaseOrder(TENANT, 'run1-1') });
    refused(reply, 403, 'not_covered');
    expect(lastRule(s)).toBe('delegation.missing');
  });
  it('a token for the resource of another tenant is refused at this tenant, by its audience, and a grant for another tenant is refused when the audience is forced', async () => {
    const s = await scenario(TENANT);
    expect((await s.harness.seed('run2')).status).toBe(201);
    const run2 = delegateTo(s, 'run2-agent', [['po.write', 'po']], { tenant: 'run2' });
    const byAudience = await s.harness.tokenCall({ tenant: TENANT, credential: await tokenFor(s, run2, 'po', 'run2'), method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') });
    refused(byAudience, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.audience');
    const forced = await s.harness.tokenCall({ tenant: TENANT, credential: await tokenFor(s, run2, 'po', TENANT), method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') });
    refused(forced, 403, 'not_covered');
    expect(lastRule(s)).toBe('delegation.resource');
    expect((await callWithToken(s, run2, 'po', 'POST', PO, purchaseOrder('run2', 'run2-1'), 'run2')).status).toBe(201);
    const first = (await s.harness.call({ path: `/t/${TENANT}/state` })).json as { po_store: { orders: unknown[] } };
    expect(first.po_store.orders).toEqual([]);
  });
});

describe('a proof that is not right', () => {
  it('a proof that was used is refused the second time, and the first call was honoured', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    const headers = await s.world.presented(credential, 'POST', `${PUBLIC_BASE}/t/${TENANT}${PO}`);
    const first = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers, body: purchaseOrder(TENANT, 'run1-1') });
    expect(first.status, first.text).toBe(201);
    const replay = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers, body: purchaseOrder(TENANT, 'run1-2') });
    refused(replay, 401, 'token_invalid');
    expect(lastRule(s)).toBe('dpop.replay');
    const fresh = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    expect(fresh.status).toBe(201);
  });
  it('a call with no proof, a proof for another method, a proof for another URL and a proof of another key are refused', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    const url = `${PUBLIC_BASE}/t/${TENANT}${PO}`;
    const call = (headers: Record<string, string>) => s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers, body: purchaseOrder(TENANT, 'run1-1') });
    const good = await s.world.presented(credential, 'POST', url);
    const noProof = await call({ authorization: good.authorization! });
    refused(noProof, 401, 'token_invalid');
    expect(lastRule(s)).toBe('dpop.missing');
    refused(await call(await s.world.presented(credential, 'GET', url)), 401, 'token_invalid');
    expect(lastRule(s)).toBe('dpop.method');
    refused(await call(await s.world.presented(credential, 'POST', `${PUBLIC_BASE}/t/${TENANT}/erp`)), 401, 'token_invalid');
    expect(lastRule(s)).toBe('dpop.url');
    refused(await call(await s.world.presented({ ...credential, key: agent.agent.authentication }, 'POST', url)), 401, 'token_invalid');
    expect(lastRule(s)).toBe('dpop.binding');
    const twoProofs = await call({ ...(await s.world.presented(credential, 'POST', url)), dpop: `${good.dpop!}, ${(await s.world.presented(credential, 'POST', url)).dpop!}` });
    refused(twoProofs, 401, 'token_invalid');
    expect(lastRule(s)).toBe('dpop.multiple');
    expect((await call(await s.world.presented(credential, 'POST', url))).status).toBe(201);
  });
  it('a proof that names the public URL is checked against the public URL, and not against the address behind the proxy', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    const behind = `http://127.0.0.1:${s.harness.port}/t/${TENANT}${PO}`;
    refused(await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers: await s.world.presented(credential, 'POST', behind), body: purchaseOrder(TENANT, 'run1-1') }), 401, 'token_invalid');
    expect(lastRule(s)).toBe('dpop.url');
  });
});

describe('a delegation that ended', () => {
  it('a token whose delegation was ended on the ledger after the token was made is refused, though the token is still valid', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    expect((await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') })).status).toBe(201);
    s.world.end(agent.delegation);
    const after = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    refused(after, 403, 'delegation_ended');
    expect(lastRule(s)).toBe('delegation.refused');
    expect(after.json?.message).toMatch(/not live|undelegated|does not exist/);
    const line = s.harness.logged().at(-1)!;
    expect(line).toMatchObject({ decision: 'refused', status: 403, code: 'delegation_ended', delegation: agent.delegation.id, act: [agent.agent.did] });
    expect((await s.harness.call({ path: `/t/${TENANT}/state` })).json).toMatchObject({ po_store: { orders: [{ po_number: 'run1-1' }] } });
  });
  it('a delegation whose period has passed is refused on the ledger while its token is still inside the leeway of the verifier, and the token is refused by its time after the leeway', async () => {
    const s = await scenario(TENANT);
    const agent = s.world.agent('late');
    const short = s.world.delegate({ delegate: agent, actions: ['po.write'], resources: [resourceOf(TENANT, 'po')], notBefore: s.world.now() - 3_600_000, notAfter: s.world.now() + 120_000 });
    const credential = await s.world.token(agent, short, resourceOf(TENANT, 'po'));
    expect((await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') })).status).toBe(201);
    // The token ends with the period of its delegation. The verifier takes a token for 30 seconds after its end, so for 10 seconds the token is good and the delegation is not.
    s.world.advance(130_000);
    const inLeeway = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    refused(inLeeway, 403, 'delegation_ended');
    expect(lastRule(s)).toBe('delegation.refused');
    expect(inLeeway.json?.message).toMatch(/period|expired|ended|window/i);
    s.world.advance(30_000);
    const late = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    refused(late, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.expired');
  });
  it('a delegation that the ledger does not hold is refused, though the gateway issued the token: the ledger decides', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'ghost', [['po.write', 'po']]);
    const credential = await tokenFor(s, agent, 'po');
    // The ledger forgets the delegation, as it would for a delegation that never existed on it: only the gateway knows it.
    s.world.delegations.length = 0;
    const reply = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') });
    refused(reply, 403, 'delegation_ended');
  });
  it('a ledger that cannot be read refuses the call with 503, and the call is not honoured', async () => {
    const { s, agent } = await setup();
    s.world.ledgerFault = new Error('the node does not answer');
    const reply = await poCall(s, agent, 'run1-1');
    refused(reply, 503, 'ledger_unavailable');
    expect(lastRule(s)).toBe('delegation.refused');
    s.world.ledgerFault = null;
    expect((await poCall(s, agent, 'run1-1')).status).toBe(201);
  });
});

describe('an agent that is no longer Active', () => {
  it('the agent that asks is refused when its record is suspended, though its status list is old: the DID is resolved at each call', async () => {
    const { s, agent } = await setup();
    s.world.gateway.lists.freeze();
    const credential = await tokenFor(s, agent, 'po');
    const call = (number: string) => s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, number) });
    expect((await call('run1-1')).status).toBe(201);
    s.world.gateway.setStatus(agent.agent, 'suspended', 'hold');
    const reply = await call('run1-2');
    refused(reply, 403, 'actor_not_active');
    expect(lastRule(s)).toBe('actors.refused');
    expect(reply.json?.message).toContain(agent.agent.did);
    s.world.gateway.setStatus(agent.agent, 'active');
    expect((await call('run1-2')).status).toBe(201);
  });
  it('an agent that is in the act chain and did not ask is refused when its record is revoked', async () => {
    const s = await scenario(TENANT);
    const boss = delegateTo(s, 'boss', [['erp.stock.read', 'erp']]);
    const helper = delegateTo(s, 'helper', [['erp.stock.read', 'erp']], { parent: undefined, parentDelegation: undefined });
    void helper;
    // A helper that is no subagent of the boss: its delegation comes from the boss, so the chain is [helper, boss].
    const other = s.world.agent('other');
    const sub = s.world.delegate({ delegator: boss.agent, delegate: other, parent: boss.delegation, actions: ['erp.stock.read'], resources: [resourceOf(TENANT, 'erp')], remaining: 0 });
    s.world.gateway.lists.freeze();
    const credential = await s.world.token(other, sub, resourceOf(TENANT, 'erp'));
    const ok = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'GET', route: '/erp/stock/GLV-NIT-M' });
    expect(ok.status, ok.text).toBe(200);
    s.world.gateway.setStatus(boss.agent, 'revoked');
    const reply = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'GET', route: '/erp/stock/GLV-NIT-M' });
    refused(reply, 403, 'actor_not_active');
    expect(reply.json?.message).toContain(boss.agent.did);
    expect(s.harness.logged().at(-1)).toMatchObject({ act: [other.did, boss.agent.did], decision: 'refused' });
  });
  it('the agent that asks is refused by the status list, once the list shows the change', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    expect((await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') })).status).toBe(201);
    s.world.gateway.setStatus(agent.agent, 'suspended', 'hold');
    s.world.advance(70_000);
    s.world.gateway.lists.refresh();
    const reply = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    refused(reply, 401, 'token_invalid');
    expect(lastRule(s)).toBe('status.suspended');
  });
  it('a gateway that cannot resolve a DID refuses the call with 503, and the call is not honoured', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    s.world.gateway.fault(`/1.0/identifiers/${agent.agent.did}`, 'network');
    const reply = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') });
    refused(reply, 503, 'gateway_unavailable');
    s.world.gateway.fault(`/1.0/identifiers/${agent.agent.did}`, null);
    expect((await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') })).status).toBe(201);
  });
});

describe('the depth of the act chain', () => {
  it('a route for an agent takes the chain of the agent and refuses the chain of its subagent', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const sub = delegateTo(s, 'sub', [['po.write', 'po']], { parent: agent.agent, parentDelegation: agent.delegation });
    const deep = await poCall(s, sub, 'run1-1');
    refused(deep, 403, 'chain_too_deep');
    expect(lastRule(s)).toBe('act.depth');
    expect(s.harness.logged().at(-1)).toMatchObject({ act: [sub.agent.did, agent.agent.did], delegation: sub.delegation.id, decision: 'refused' });
    expect((await poCall(s, agent, 'run1-1')).status).toBe(201);
  });
  it('a route for a subagent takes the chain of the subagent, and the chain of the agent that is one shorter', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['erp.stock.read', 'erp']]);
    const sub = delegateTo(s, 'stock-reader', [['erp.stock.read', 'erp']], { parent: agent.agent, parentDelegation: agent.delegation });
    expect((await callWithToken(s, sub, 'erp', 'GET', '/erp/stock/GLV-NIT-M')).status).toBe(200);
    expect((await callWithToken(s, agent, 'erp', 'GET', '/erp/stock/GLV-NIT-M')).status).toBe(200);
  });
  it('a chain of three is refused on every route', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'a', [['erp.stock.read', 'erp']], { remaining: 2 });
    const sub = delegateTo(s, 'b', [['erp.stock.read', 'erp']], { parent: agent.agent, parentDelegation: agent.delegation, remaining: 1 });
    const subsub = delegateTo(s, 'c', [['erp.stock.read', 'erp']], { parent: sub.agent, parentDelegation: sub.delegation });
    const reply = await callWithToken(s, subsub, 'erp', 'GET', '/erp/stock/GLV-NIT-M');
    refused(reply, 403, 'chain_too_deep');
    expect(lastRule(s)).toBe('act.depth');
  });
});

describe('the status list', () => {
  it('a list that cannot be read does not refuse a call, and the service writes it to the log', async () => {
    const { s, agent } = await setup();
    s.world.gateway.fault('/status/tsl/0', LISTS_UNAVAILABLE);
    const reply = await poCall(s, agent, 'run1-1');
    expect(reply.status, reply.text).toBe(201);
    expect(s.harness.logged().at(-1)).toMatchObject({ decision: 'allowed', token_status: { read: false, reason: 'unavailable' } });
    expect((s.harness.logged().at(-1)!.token_status as { detail: string }).detail).toContain('503');
  });
  it('a list that is over does not refuse a call either, and the log says that it is old', async () => {
    const { s, agent } = await setup();
    s.world.gateway.lists.freeze();
    const credential = await tokenFor(s, agent, 'po');
    expect((await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') })).status).toBe(201);
    expect(s.harness.logged().at(-1)).toMatchObject({ token_status: { read: true } });
    // The gateway serves its last list, which ends after one hour: the token of one hour later is new.
    s.world.advance(3_700_000);
    const later = await tokenFor(s, agent, 'po');
    const reply = await s.harness.tokenCall({ tenant: TENANT, credential: later, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    expect(reply.status, reply.text).toBe(201);
    expect(s.harness.logged().at(-1)).toMatchObject({ decision: 'allowed', token_status: { read: false, reason: 'stale' } });
  });
  it('a list that shows the agent revoked refuses the call, whatever its age', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    expect((await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-1') })).status).toBe(201);
    s.world.gateway.setStatus(agent.agent, 'revoked');
    s.world.advance(70_000);
    s.world.gateway.lists.refresh();
    const reply = await s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: PO, body: purchaseOrder(TENANT, 'run1-2') });
    refused(reply, 401, 'token_invalid');
    expect(lastRule(s)).toBe('status.revoked');
  });
  it('a key set that cannot be read refuses the call with 503', async () => {
    const { s, agent } = await setup();
    s.world.gateway.fault('/.well-known/jwks.json', { status: 503 });
    const reply = await poCall(s, agent, 'run1-1');
    refused(reply, 503, 'gateway_unavailable');
    expect(lastRule(s)).toBe('keys.unavailable');
  });
});

describe('what a refusal tells', () => {
  it('has the error and the message only, never the token, the proof or the body of the call', async () => {
    const { s, agent } = await setup();
    const credential = await tokenFor(s, agent, 'po');
    const headers = await s.world.presented(credential, 'POST', `${PUBLIC_BASE}/t/${TENANT}/erp`);
    const reply = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${PO}`, headers, body: purchaseOrder(TENANT, 'secret-po-number') });
    expect(Object.keys(reply.json!)).toEqual(['error', 'message']);
    for (const text of [credential.accessToken, headers.dpop!, 'secret-po-number']) {
      expect(reply.text).not.toContain(text);
      expect(s.harness.lines.join('\n')).not.toContain(text);
    }
  });
});
