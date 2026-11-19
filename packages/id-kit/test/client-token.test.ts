// packages/id-kit/test/client-token.test.ts: the token request of the client against the stub gateway. A token for an agent, a token for a delegation chain, what the client
// refuses before it sends, and what it makes of each refusal of the gateway.
import { describe, it, expect } from 'vitest';
import { DELEGATION_DETAILS_TYPE } from '../src/common/constants.ts';
import { ed25519Key, identifier, p256Key, signerOf, LISTS_UNAVAILABLE, type StubAgent, type StubDelegation, type TestKey } from '../src/testing/index.ts';
import type { GatewayClient } from '../src/client/index.ts';
import { jwkThumbprint } from '../src/vendored/m4/jose.ts';
import { decodeJwt, requestTo, signedBy, text, world, type World } from './support.ts';

const AUDIENCE = 'https://rs.example';
const RESOURCE = 'https://mp-mock.example/t/1/erp';

/** The token request of an agent with its own delegation key as the DPoP key. */
const ask = (client: GatewayClient, agent: StubAgent, extra: Record<string, unknown> = {}) =>
  client.requestToken({ subject: { did: agent.did, key: agent.authentication.privateKey }, dpopKey: agent.delegation.privateKey, audience: AUDIENCE, ...extra });

/** A world with a principal key that delegates `erp.*` and `po.write` on one resource to an agent. */
interface ChainWorld extends World {
  readonly principal: TestKey;
  readonly reader: StubAgent;
  readonly root: StubDelegation;
}

function chainWorld(): ChainWorld {
  const w = world();
  const principal = ed25519Key('token principal');
  const reader = w.gateway.createAgent({ label: 'reader' });
  const root = w.gateway.delegate({ delegator: { principalKey: principal }, delegate: reader, actions: ['erp.*', 'po.write'], resources: [RESOURCE] });
  return { ...w, principal, reader, root };
}

describe('requestToken: a token for the agent', () => {
  it('gets a DPoP-bound access token: the answer, the claims and the signature of the gateway', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'plain' });
    const result = await ask(client, agent);
    if (!result.ok) throw new Error(`the request failed: ${result.rule} ${result.detail}`);
    const token = result.value;
    expect(token).toMatchObject({ tokenType: 'DPoP', issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token', expiresIn: 300, expiresAt: gateway.now() + 300_000, authorizationDetails: null });
    const { header, payload } = decodeJwt(token.accessToken);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid: `${gateway.gatewayDid}#${gateway.keys.p256.keyHash}` });
    expect(signedBy(token.accessToken, 'P256', gateway.keys.p256.publicKey)).toBe(true);
    expect(payload).toMatchObject({ iss: gateway.baseUrl, sub: agent.did, aud: AUDIENCE, client_id: agent.did, iat: gateway.now() / 1000, exp: gateway.now() / 1000 + 300 });
    expect(payload.cnf).toStrictEqual({ jkt: agent.delegation.thumbprint });
    expect(payload.status).toStrictEqual({ status_list: { idx: agent.index, uri: `${gateway.baseUrl}/status/tsl/0` } });
    expect('act' in payload).toBe(false);
    expect('authorization_details' in payload).toBe(false);
  });

  it('sends what the gateway reads: a form with the grant, the subject token and its type and the audience, and a DPoP header for POST on the token endpoint', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'wire' });
    await ask(client, agent, { audience: ['https://a.example', 'https://b.example'], resource: 'https://c.example/x' });
    const sent = requestTo(gateway, '/token');
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(`${gateway.baseUrl}/token`);
    expect(sent.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(sent.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(form.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(form.getAll('audience')).toStrictEqual(['https://a.example', 'https://b.example']);
    expect(form.getAll('resource')).toStrictEqual(['https://c.example/x']);
    expect(form.has('authorization_details')).toBe(false);
    expect(decodeJwt(text(form.get('subject_token'))).payload).toMatchObject({ iss: agent.did, sub: agent.did, aud: `${gateway.baseUrl}/token` });
    const proof = decodeJwt(sent.headers.dpop!);
    expect(proof.header.typ).toBe('dpop+jwt');
    expect(proof.payload).toMatchObject({ htm: 'POST', htu: `${gateway.baseUrl}/token` });
    expect(jwkThumbprint(proof.header.jwk as never)).toBe(agent.delegation.thumbprint);
  });

  it('the audience of the token is every audience and every resource: one value is a string, several are a list', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'audiences' });
    const claims = async (extra: Record<string, unknown>) => {
      const result = await client.requestToken({ subject: { did: agent.did, key: agent.authentication.privateKey }, dpopKey: agent.delegation.privateKey, ...extra });
      if (!result.ok) throw new Error(result.detail);
      return decodeJwt(result.value.accessToken).payload.aud;
    };
    await expect(claims({ resource: 'https://c.example/x' })).resolves.toBe('https://c.example/x');
    await expect(claims({ audience: 'urn:rs' })).resolves.toBe('urn:rs');
    await expect(claims({ audience: ['https://a.example', 'https://b.example'], resource: 'https://c.example/x' })).resolves.toStrictEqual(['https://c.example/x', 'https://a.example', 'https://b.example']);
  });

  it('works with a sign function for the subject and for the DPoP key, and with a P-256 DPoP key (a token without a delegation is bound to any key)', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'forms' });
    const dpop = p256Key('token dpop p256');
    const result = await client.requestToken({ subject: { did: agent.did, key: signerOf(agent.authentication) }, dpopKey: signerOf(dpop), audience: AUDIENCE });
    if (!result.ok) throw new Error(result.detail);
    expect(decodeJwt(result.value.accessToken).payload.cnf).toStrictEqual({ jkt: dpop.thumbprint });
  });

  it('asks for the other token type when it is told to, and the answer says which type it is', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'type' });
    const result = await ask(client, agent, { requestedTokenType: 'jwt' });
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.issuedTokenType).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(new URLSearchParams(requestTo(gateway, '/token').body).get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
  });

  it('each request has its own subject token and proof: three requests in a row all work', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'repeat' });
    for (let i = 0; i < 3; i++) expect((await ask(client, agent)).ok).toBe(true);
    const bodies = gateway.requests.filter((r) => r.path === '/token').map((r) => new URLSearchParams(r.body).get('subject_token'));
    expect(new Set(bodies).size).toBe(3);
  });
});

describe('requestToken: what the client refuses before it sends', () => {
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no audience and no resource', { audience: undefined }, /name the audience of the token/],
    ['an empty audience list', { audience: [] }, /name the audience of the token/],
    ['a resource that is not an absolute URI', { audience: undefined, resource: '/relative/path' }, /absolute URI without a fragment/],
    ['a resource with a fragment', { audience: undefined, resource: 'https://rs.example/a#top' }, /absolute URI without a fragment/],
    ['nine audiences', { audience: Array.from({ length: 9 }, (_, i) => `urn:rs:${i}`) }, /at most 8 audiences/],
    ['an audience of 513 characters', { audience: 'a'.repeat(513) }, /at most 8 audiences of at most 512 characters/],
    ['a delegation identifier that is not 64 hex characters', { delegation: { identifier: 'abc' } }, /64 lowercase hex characters/],
    ['a delegation identifier in upper case', { delegation: { identifier: 'A'.repeat(64) } }, /64 lowercase hex characters/],
    ['an empty action list', { delegation: { identifier: 'a'.repeat(64), actions: [] } }, /actions must be a list of 1 to 16 patterns/],
    ['17 actions', { delegation: { identifier: 'a'.repeat(64), actions: Array.from({ length: 17 }, (_, i) => `a.b${i}`) } }, /actions must be a list of 1 to 16 patterns/],
    ['an action that is not a pattern', { delegation: { identifier: 'a'.repeat(64), actions: ['Not An Action'] } }, /actions must be a list of 1 to 16 patterns/],
    ['9 locations', { delegation: { identifier: 'a'.repeat(64), locations: Array.from({ length: 9 }, (_, i) => `https://rs.example/${i}`) } }, /locations must be a list of 1 to 8 patterns/],
    ['a location that is not a pattern', { delegation: { identifier: 'a'.repeat(64), locations: ['ftp://rs.example'] } }, /locations must be a list of 1 to 8 patterns/],
    ['a P-256 DPoP key with a delegation', { dpopKey: p256Key('token refuse p256').privateKey, delegation: { identifier: 'a'.repeat(64) } }, /Ed25519 delegate key/],
  ];
  it.each(refused)('refuses %s, and sends nothing', async (_name, extra, message) => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'refused' });
    await expect(ask(client, agent, extra)).rejects.toThrow(message);
    expect(gateway.requests).toHaveLength(0);
  });

  it('the twins: the limits themselves are accepted (8 audiences, an audience of 512 characters, 16 actions, 8 locations, a resource with a query)', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'limits' });
    const eight = Array.from({ length: 8 }, (_, i) => `urn:rs:${i}`);
    expect((await ask(client, agent, { audience: eight })).ok).toBe(true);
    expect((await ask(client, agent, { audience: 'a'.repeat(512) })).ok).toBe(true);
    expect((await ask(client, agent, { audience: undefined, resource: 'https://rs.example/a?b=1' })).ok).toBe(true);
    const w = chainWorld();
    const sixteen = ['erp.*', ...Array.from({ length: 15 }, (_, i) => `erp.a${i}`)];
    const eightLocations = [RESOURCE, ...Array.from({ length: 7 }, (_, i) => `https://mp-mock.example/t/${i}/x`)];
    const result = await w.client.requestToken({
      subject: { did: w.reader.did, key: w.reader.authentication.privateKey },
      dpopKey: w.reader.delegation.privateKey,
      audience: AUDIENCE,
      delegation: { identifier: w.root.id, actions: sixteen, locations: eightLocations },
    });
    // The gateway refuses it, because the delegation does not cover all of them. It is the gateway that decides, not the client.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe('gateway.refused');
  });
});

describe('requestToken: a token for a delegation chain', () => {
  it('a token for a delegation from a principal key: sub is the principal, act names the requester, and the grant is in authorization_details', async () => {
    const { gateway, client, principal, reader, root } = chainWorld();
    const result = await client.requestToken({ subject: { did: reader.did, key: reader.authentication.privateKey }, dpopKey: reader.delegation.privateKey, resource: RESOURCE, delegation: { identifier: root.id } });
    if (!result.ok) throw new Error(`the request failed: ${result.rule} ${result.detail}`);
    const grant = { type: DELEGATION_DETAILS_TYPE, identifier: root.id, actions: ['erp.*', 'po.write'], locations: [RESOURCE] };
    expect(result.value.authorizationDetails).toStrictEqual([grant]);
    const { payload } = decodeJwt(result.value.accessToken);
    expect(payload).toMatchObject({ sub: `${gateway.baseUrl}/principals/key/${principal.keyHash}`, act: { sub: reader.did }, client_id: reader.did, aud: RESOURCE });
    expect(payload.authorization_details).toStrictEqual([grant]);
    expect(payload.cnf).toStrictEqual({ jkt: reader.delegation.thumbprint });
    const form = new URLSearchParams(requestTo(gateway, '/token').body);
    expect(JSON.parse(text(form.get('authorization_details')))).toStrictEqual([{ type: DELEGATION_DETAILS_TYPE, identifier: root.id }]);
  });

  it('the grant can be narrower than the delegation: the requested actions and locations are what the token holds', async () => {
    const { client, reader, root } = chainWorld();
    const result = await client.requestToken({
      subject: { did: reader.did, key: reader.authentication.privateKey },
      dpopKey: reader.delegation.privateKey,
      audience: AUDIENCE,
      delegation: { identifier: root.id, actions: ['erp.stock.read'], locations: [RESOURCE] },
    });
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.authorizationDetails).toStrictEqual([{ type: DELEGATION_DETAILS_TYPE, identifier: root.id, actions: ['erp.stock.read'], locations: [RESOURCE] }]);
  });

  it('a token for a chain of two links: act nests the delegates with the requester outermost, and sub is still the principal', async () => {
    const { gateway, client, principal, reader, root } = chainWorld();
    const scorer = gateway.createAgent({ label: 'scorer' });
    const child = gateway.delegate({ delegator: reader, delegate: scorer, parent: root, actions: ['erp.stock.read'], resources: [RESOURCE] });
    const result = await client.requestToken({ subject: { did: scorer.did, key: scorer.authentication.privateKey }, dpopKey: scorer.delegation.privateKey, resource: RESOURCE, delegation: { identifier: child.id } });
    if (!result.ok) throw new Error(`the request failed: ${result.rule} ${result.detail}`);
    const { payload } = decodeJwt(result.value.accessToken);
    expect(payload.sub).toBe(`${gateway.baseUrl}/principals/key/${principal.keyHash}`);
    expect(payload.act).toStrictEqual({ sub: scorer.did, act: { sub: reader.did } });
    expect((payload.authorization_details as Array<{ identifier: string }>)[0]!.identifier).toBe(child.id);
  });

  it('the token of a delegation never lives past the end of the delegation', async () => {
    const { gateway, client, reader } = chainWorld();
    const soon = gateway.delegate({ delegator: { principalKey: ed25519Key('token short') }, delegate: reader, actions: ['erp.*'], resources: [RESOURCE], notAfter: gateway.now() + 90_000 });
    const result = await client.requestToken({ subject: { did: reader.did, key: reader.authentication.privateKey }, dpopKey: reader.delegation.privateKey, audience: AUDIENCE, delegation: { identifier: soon.id } });
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.expiresIn).toBe(90);
  });

  /** The refusals of the gateway for a delegation, each with the same request that works in the first test of this block. */
  const refusals: Array<[string, (w: ChainWorld) => { extra?: Record<string, unknown>; as?: StubAgent }, RegExp]> = [
    ['a delegation that does not exist', () => ({ extra: { delegation: { identifier: identifier('no such delegation') } } }), /does not exist/],
    ['a delegation that ended with an Undelegate', (w) => (w.gateway.endDelegation(w.root), {}), /was undelegated/],
    ['a delegation with 29 confirmations (the gateway counts it from 30)', (w) => ((w.root.confirmations = 29), {}), /fewer than 30 confirmations/],
    ['a time after the end of the delegation', (w) => (w.gateway.advance(2 * 86_400_000), {}), /outside the period of delegation/],
    ['an action that the delegation does not cover', () => ({ extra: { delegation: { identifier: '', actions: ['hr.read'] } } }), /does not cover the requested actions/],
    ['a resource that the delegation does not cover', () => ({ extra: { delegation: { identifier: '', locations: ['https://other.example/x'] } } }), /does not cover the requested resources/],
    ['a delegate key that the record of the delegate no longer lists', (w) => (w.gateway.removeKey(w.reader, w.reader.delegation), {}), /delegate_key is not a listed Ed25519 key/],
    ['a delegate key without the delegation purpose', (w) => (w.gateway.setPurposes(w.reader, w.reader.delegation, 1), {}), /delegate_key is not a listed Ed25519 key/],
    ['a DPoP key that is not the delegate key', () => ({ extra: { dpopKey: ed25519Key('token other dpop key').privateKey } }), /DPoP proof key is not the delegate_key/],
    ['an agent that is not the delegate of the delegation', (w) => ({ as: w.gateway.createAgent({ label: 'other agent' }) }), /subject is not the delegate/],
  ];
  it.each(refusals)('refuses %s with invalid_authorization_details', async (_name, change, message) => {
    const w = chainWorld();
    const { extra = {}, as = w.reader } = change(w);
    const delegation = extra.delegation === undefined ? { identifier: w.root.id } : { ...(extra.delegation as object), identifier: (extra.delegation as { identifier: string }).identifier || w.root.id };
    const result = await ask(w.client, as, { ...extra, delegation });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toMatchObject({ rule: 'gateway.refused', status: 400, error: 'invalid_authorization_details' });
    expect(result.detail).toMatch(message);
  });

  it('a delegator agent that is not Active ends the delegation for the token request', async () => {
    const { gateway, client, reader } = chainWorld();
    const boss = gateway.createAgent({ label: 'boss' });
    const own = gateway.delegate({ delegator: boss, delegate: reader, actions: ['erp.*'], resources: [RESOURCE] });
    const ok = await ask(client, reader, { delegation: { identifier: own.id } });
    expect(ok.ok).toBe(true);
    gateway.setStatus(boss, 'suspended', 'hold');
    const refused = await ask(client, reader, { delegation: { identifier: own.id } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused).toMatchObject({ rule: 'gateway.refused', error: 'invalid_authorization_details', detail: expect.stringMatching(/delegator agent [0-9a-f]{64} has effective status suspended, not active/) });
  });

  it('refuses the chain rules that the contract checked when it made each link: a child that is not narrower, one outside the period, one that exceeds the hops, and a chain deeper than 4', async () => {
    const { gateway, client, reader, root } = chainWorld();
    const make = (n: number): StubAgent => gateway.createAgent({ label: `link ${n}` });
    const asked = async (child: StubDelegation, agent: StubAgent) => ask(client, agent, { delegation: { identifier: child.id } });

    const widerAgent = make(1);
    const wider = gateway.delegate({ delegator: reader, delegate: widerAgent, parent: root, actions: ['hr.read'], resources: [RESOURCE] });
    expect(await asked(wider, widerAgent)).toMatchObject({ ok: false, detail: expect.stringMatching(/is not narrower than its parent/) });

    const lateAgent = make(2);
    const late = gateway.delegate({ delegator: reader, delegate: lateAgent, parent: root, actions: ['erp.read'], resources: [RESOURCE], notAfter: root.notAfter + 1000 });
    expect(await asked(late, lateAgent)).toMatchObject({ ok: false, detail: expect.stringMatching(/outside the period of its parent/) });

    const hopsAgent = make(3);
    const hops = gateway.delegate({ delegator: reader, delegate: hopsAgent, parent: root, actions: ['erp.read'], resources: [RESOURCE], remaining: 1 });
    expect(await asked(hops, hopsAgent)).toMatchObject({ ok: false, detail: expect.stringMatching(/exceeds the hops that its parent allows/) });

    const okAgent = make(4);
    const fine = gateway.delegate({ delegator: reader, delegate: okAgent, parent: root, actions: ['erp.read'], resources: [RESOURCE] });
    expect((await asked(fine, okAgent)).ok).toBe(true);

    // Five links in a line: the chain is deeper than 4.
    const agents = Array.from({ length: 5 }, (_, i) => gateway.createAgent({ label: `deep ${i}` }));
    let parent: StubDelegation | undefined;
    let delegator: StubAgent | { principalKey: TestKey } = { principalKey: ed25519Key('deep principal') };
    let leaf: StubDelegation | undefined;
    for (const [i, delegate] of agents.entries()) {
      leaf = gateway.delegate({ delegator, delegate, ...(parent ? { parent } : {}), actions: ['erp.read'], resources: [RESOURCE], remaining: 4 - i - 1 < 0 ? 0 : 4 - i - 1 });
      parent = leaf;
      delegator = delegate;
    }
    expect(await asked(leaf!, agents[4]!)).toMatchObject({ ok: false, detail: expect.stringMatching(/deeper than 4/) });
  });
});

describe('requestToken: what the client makes of each answer of the gateway', () => {
  it('an agent that the gateway does not know: gateway.refused with the error and the words of the gateway', async () => {
    const { client } = world();
    const result = await client.requestToken({ subject: { did: `did:vector:${identifier('nobody')}`, key: ed25519Key('token nobody').privateKey }, dpopKey: ed25519Key('token nobody dpop').privateKey, audience: AUDIENCE });
    expect(result).toMatchObject({ ok: false, rule: 'gateway.refused', status: 400, error: 'invalid_request', retryAfterSeconds: null });
    if (!result.ok) expect(result.detail).toBe('subject_token: the DID does not resolve to a registered agent');
  });

  it('a key that the record does not list as an authentication key', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'wrong key' });
    const result = await client.requestToken({ subject: { did: agent.did, key: ed25519Key('token wrong key').privateKey }, dpopKey: agent.delegation.privateKey, audience: AUDIENCE });
    expect(result).toMatchObject({ ok: false, rule: 'gateway.refused', error: 'invalid_request' });
    if (!result.ok) expect(result.detail).toMatch(/not an authentication key of the agent/);
  });

  it('the delegation key does not have the authentication purpose, so it cannot sign a subject token', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'purpose' });
    const result = await client.requestToken({ subject: { did: agent.did, key: agent.delegation.privateKey }, dpopKey: agent.delegation.privateKey, audience: AUDIENCE });
    expect(result).toMatchObject({ ok: false, rule: 'gateway.refused' });
  });

  it('an agent that is suspended gets no token', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'suspended', status: 'suspended' });
    const result = await ask(client, agent);
    expect(result).toMatchObject({ ok: false, rule: 'gateway.refused', error: 'invalid_request' });
    if (!result.ok) expect(result.detail).toMatch(/effective status is suspended, not active/);
  });

  it('503 is gateway.unavailable with the wait that the gateway asks for', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'down' });
    gateway.fault('/token', LISTS_UNAVAILABLE);
    expect(await ask(client, agent)).toMatchObject({ ok: false, rule: 'gateway.unavailable', status: 503, error: 'temporarily_unavailable', retryAfterSeconds: 5 });
  });

  it('a network failure is gateway.unreachable, with status 0', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'network' });
    gateway.fault('/token', 'network');
    expect(await ask(client, agent)).toMatchObject({ ok: false, rule: 'gateway.unreachable', status: 0, error: null });
  });

  it.each<[string, string]>([
    ['not JSON', 'not json'],
    ['JSON that is not an object', '[1]'],
    ['an answer with no access token', '{"token_type":"DPoP","issued_token_type":"x","expires_in":300}'],
    ['an access token that is not a JWS', '{"access_token":"abc","token_type":"DPoP","issued_token_type":"x","expires_in":300}'],
    ['a token type that is not DPoP', '{"access_token":"a.b.c","token_type":"Bearer","issued_token_type":"x","expires_in":300}'],
    ['no life', '{"access_token":"a.b.c","token_type":"DPoP","issued_token_type":"x"}'],
    ['authorization details that are not a list of objects', '{"access_token":"a.b.c","token_type":"DPoP","issued_token_type":"x","expires_in":300,"authorization_details":"x"}'],
  ])('a 200 answer that is %s is gateway.bad_response', async (_name, body) => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'bad answer' });
    gateway.fault('/token', { status: 200, body });
    expect(await ask(client, agent)).toMatchObject({ ok: false, rule: 'gateway.bad_response', status: 200 });
  });

  it('the twin of the bad answers: a good answer in the same form is accepted', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'good answer' });
    gateway.fault('/token', { status: 200, body: '{"access_token":"a.b.c","token_type":"DPoP","issued_token_type":"x","expires_in":300}' });
    expect(await ask(client, agent)).toMatchObject({ ok: true, value: { accessToken: 'a.b.c', expiresIn: 300 } });
  });

  it('the proof of a delegation request is made with the key that the caller gives, also as a sign function', async () => {
    const { gateway, client, reader, root } = chainWorld();
    const result = await client.requestToken({ subject: { did: reader.did, key: signerOf(reader.authentication) }, dpopKey: signerOf(reader.delegation), audience: AUDIENCE, delegation: { identifier: root.id } });
    expect(result.ok).toBe(true);
    expect(gateway.requests).toHaveLength(1);
  });
});
