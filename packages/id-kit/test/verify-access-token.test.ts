// packages/id-kit/test/verify-access-token.test.ts: the verifier at a resource, against the stub gateway. The review focus of this package is "a token whose authority ended is never
// honoured": each rule below has a refusal and an accepted twin (the call that the first test makes, changed in one place). Tokens with a defect are signed with the key of the stub
// gateway, which the test holds, so that each claim can be wrong while the signature is right.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { newJti, presentToken, tokenHash } from '../src/client/index.ts';
import { DELEGATION_DETAILS_TYPE, LIST_SIZE } from '../src/common/constants.ts';
import { resolveKey } from '../src/common/keys.ts';
import type { Check } from '../src/common/result.ts';
import { ed25519Key, identifier, LISTS_UNAVAILABLE, p256Key, type StubAgent, type StubDelegation, type TestKey } from '../src/testing/index.ts';
import { b64url, signJws } from '../src/vendored/m4/jose.ts';
import { ACCESS_TOKEN_RULES, CALL_RULES, createReplayStore, createVerifier, gatewayActorCheck, parseAuthorization, type AccessTokenPolicy, type CallRequest, type CallRule, type VerifiedCall, type Verifier } from '../src/verify/index.ts';
import { decodeJwt, world, type World } from './support.ts';

const AUDIENCE = 'https://mp-mock.example/t/1/erp';
const URL_OF_CALL = `${AUDIENCE}/stock`;
const ACTION = 'erp.stock.read';
const POLICY: AccessTokenPolicy = { audience: AUDIENCE, require: { action: ACTION, resource: AUDIENCE } };

/** The rules that the tests below saw refused: the last test checks that each rule of the verifier is in it. */
const seen = new Set<string>();
type Result = Check<VerifiedCall, CallRule>;
function refused(result: Result, rule: string): void {
  expect(result.ok, `the call is refused by ${rule}`).toBe(false);
  if (!result.ok) {
    expect(result.rule).toBe(rule);
    expect(result.detail.length).toBeGreaterThan(0);
    seen.add(rule);
  }
}
function accepted(result: Result): VerifiedCall {
  if (!result.ok) throw new Error(`the call is refused: ${result.rule}: ${result.detail}`);
  return result.value;
}

interface Scene extends World {
  readonly verifier: Verifier;
  readonly boss: StubAgent;
  readonly agent: StubAgent;
  readonly root: StubDelegation;
}

/** A principal agent `boss` delegates `erp.*` on one resource to `agent`; a verifier reads the stub gateway. */
function scene(verifier: Partial<Parameters<typeof createVerifier>[0]> = {}): Scene {
  const w = world();
  const boss = w.gateway.createAgent({ label: 'rp boss' });
  const agent = w.gateway.createAgent({ label: 'rp agent' });
  const root = w.gateway.delegate({ delegator: boss, delegate: agent, actions: ['erp.*'], resources: [AUDIENCE] });
  return { ...w, boss, agent, root, verifier: createVerifier({ baseUrl: w.gateway.baseUrl, fetch: w.gateway.fetch, now: w.gateway.now, ...verifier }) };
}

/** A real access token from the stub gateway: with the delegation (the default), or for the agent alone. */
async function issue(s: Scene, delegated = true): Promise<string> {
  const result = await s.client.requestToken({
    subject: { did: s.agent.did, key: s.agent.authentication.privateKey },
    dpopKey: s.agent.delegation.privateKey,
    resource: AUDIENCE,
    ...(delegated ? { delegation: { identifier: s.root.id } } : {}),
  });
  if (!result.ok) throw new Error(`the token request failed: ${result.detail}`);
  return result.value.accessToken;
}

/** A token with the claims of `token` changed by `mutate`, signed by the key of the gateway. */
async function forge(s: Scene, token: string, mutate: (claims: Record<string, unknown>) => void, header: Record<string, unknown> = {}): Promise<string> {
  const claims = structuredClone(decodeJwt(token).payload);
  mutate(claims);
  return signJws({ alg: 'ES256', kid: `${s.gateway.gatewayDid}#${s.gateway.keys.p256.keyHash}`, typ: 'at+jwt', ...header }, claims, resolveKey(s.gateway.keys.p256.privateKey));
}

interface ProofChange {
  readonly key?: TestKey;
  readonly header?: Record<string, unknown>;
  readonly claims?: Record<string, unknown>;
}

/** A DPoP proof for `token` for POST on the URL of the call; `change` makes one part wrong. */
function proofFor(s: Scene, token: string, change: ProofChange = {}): Promise<string> {
  const key = change.key ?? s.agent.delegation;
  return signJws(
    { typ: 'dpop+jwt', alg: 'EdDSA', jwk: key.jwk, ...change.header },
    { jti: newJti(), htm: 'POST', htu: URL_OF_CALL, iat: Math.floor(s.gateway.now() / 1000), ath: tokenHash(token), ...change.claims },
    resolveKey(key.privateKey),
  );
}

/** The call, with a good proof for `token` unless the test gives another. */
async function call(s: Scene, token: string, request: Partial<CallRequest> = {}, policy: AccessTokenPolicy = POLICY): Promise<Result> {
  const presented = await presentToken(token, s.agent.delegation.privateKey, { method: 'POST', url: URL_OF_CALL }, { now: s.gateway.now });
  return s.verifier.accessToken({ authorization: presented.authorization, dpop: presented.dpop, method: 'POST', url: URL_OF_CALL, ...request }, policy);
}

const callWith = async (s: Scene, token: string, proof: string | readonly string[] | undefined, policy: AccessTokenPolicy = POLICY): Promise<Result> =>
  s.verifier.accessToken({ authorization: `DPoP ${token}`, dpop: proof, method: 'POST', url: URL_OF_CALL }, policy);

describe('accessToken: a call that is right', () => {
  it('is accepted, with the facts of the token: the principal, the actors, the grant, the status entry and what the Token Status List says', async () => {
    const s = scene();
    const call1 = accepted(await call(s, await issue(s)));
    expect(call1).toMatchObject({
      issuer: s.gateway.baseUrl,
      audience: [AUDIENCE],
      subject: s.boss.did,
      principal: { kind: 'agent', did: s.boss.did },
      clientId: s.agent.did,
      actors: [s.agent.did],
      delegation: { identifier: s.root.id, actions: ['erp.*'], locations: [AUDIENCE], purpose: null },
      statusClaim: { uri: `${s.gateway.baseUrl}/status/tsl/0`, index: s.agent.index },
      keyThumbprint: s.agent.delegation.thumbprint,
      issuedAt: s.gateway.now(),
      expiresAt: s.gateway.now() + 300_000,
    });
    expect(call1.status).toStrictEqual({ read: true, list: `${s.gateway.baseUrl}/status/tsl/0`, fetchedAt: s.gateway.now() });
  });

  it('a token for the agent alone (no delegation) is accepted when the call needs no grant, and the subject is the agent', async () => {
    const s = scene();
    const plain = accepted(await call(s, await issue(s, false), {}, { audience: AUDIENCE }));
    expect(plain).toMatchObject({ subject: s.agent.did, principal: { kind: 'agent', did: s.agent.did }, actors: [], delegation: null });
  });

  it('a delegation from a principal key has a principal of the kind key', async () => {
    const s = scene();
    const keyPrincipal = ed25519Key('rp key principal');
    const root = s.gateway.delegate({ delegator: { principalKey: keyPrincipal }, delegate: s.agent, actions: ['erp.*'], resources: [AUDIENCE] });
    const result = await s.client.requestToken({ subject: { did: s.agent.did, key: s.agent.authentication.privateKey }, dpopKey: s.agent.delegation.privateKey, resource: AUDIENCE, delegation: { identifier: root.id } });
    if (!result.ok) throw new Error(result.detail);
    const verified = accepted(await call(s, result.value.accessToken));
    expect(verified.principal).toStrictEqual({ kind: 'key', keyHash: keyPrincipal.keyHash, id: `${s.gateway.baseUrl}/principals/key/${keyPrincipal.keyHash}` });
  });

  it('the token and its proof can be used for several calls with new proofs: a token is not single-use, a proof is', async () => {
    const s = scene();
    const token = await issue(s);
    for (let i = 0; i < 3; i++) accepted(await call(s, token));
  });
});

describe('accessToken: the token', () => {
  const forgedCases: Array<[string, (claims: Record<string, unknown>, now: number) => void, Record<string, unknown>?]> = [
    ['token.alg', () => undefined, { alg: 'HS256' }],
    ['token.alg', () => undefined, { alg: 'none' }],
    ['token.typ', () => undefined, { typ: 'JWT' }],
    ['token.kid', () => undefined, { kid: `did:vector:${'a'.repeat(64)}#${'b'.repeat(56)}` }],
    ['token.issuer', (c) => (c.iss = 'https://evil.example')],
    ['token.audience', (c) => (c.aud = 'https://other.example/t/1/erp')],
    ['token.audience', (c) => (c.aud = [])],
    ['token.lifetime', (c) => (c.exp = Number(c.iat) + 301)],
    ['token.lifetime', (c) => (c.exp = Number(c.iat))],
    ['token.lifetime', (c) => delete c.iat],
    ['token.not_yet_valid', (c, now) => ((c.iat = now / 1000 + 100), (c.exp = now / 1000 + 400))],
    ['token.not_yet_valid', (c, now) => (c.nbf = now / 1000 + 100)],
    ['token.claims', (c) => delete c.jti],
    ['token.claims', (c) => (c.client_id = 'not a did')],
    ['token.claims', (c) => delete c.sub],
    ['token.claims', (c) => delete c.cnf],
    ['token.claims', (c) => (c.cnf = { jkt: '' })],
    ['token.claims', (c) => (c.sub = 'https://id.example/principals/key/abc')],
    ['token.claims', (c) => (c.client_id = `did:vector:${identifier('somebody else')}`)],
    ['act.invalid', (c) => (c.act = { sub: 'not a did' })],
    ['act.invalid', (c) => (c.act = null)],
    ['act.invalid', (c) => delete c.act],
    ['delegation.details', (c) => (c.authorization_details = [{ type: 'urn:other' }])],
    ['delegation.details', (c) => (c.authorization_details = [{ type: 'urn:other', identifier: 'a'.repeat(64), actions: ['erp.*'], locations: [AUDIENCE] }])],
    ['delegation.details', (c) => (c.authorization_details = [])],
    ['delegation.details', (c) => { const entry = { type: DELEGATION_DETAILS_TYPE, identifier: 'a'.repeat(64), actions: ['erp.*'], locations: [AUDIENCE] }; c.authorization_details = [entry, entry]; }],
    ['delegation.details', (c) => (c.authorization_details = [{ type: DELEGATION_DETAILS_TYPE, identifier: 'abc', actions: ['erp.*'], locations: [AUDIENCE] }])],
    ['delegation.details', (c) => (c.authorization_details = [{ type: DELEGATION_DETAILS_TYPE, identifier: 'a'.repeat(64), actions: [], locations: [AUDIENCE] }])],
    ['delegation.details', (c) => (c.authorization_details = [{ type: DELEGATION_DETAILS_TYPE, identifier: 'a'.repeat(64), actions: ['Bad Action'], locations: [AUDIENCE] }])],
    ['delegation.details', (c) => (c.authorization_details = [{ type: DELEGATION_DETAILS_TYPE, identifier: 'a'.repeat(64), actions: ['erp.*'], locations: ['ftp://x'] }])],
    ['status.claim', (c) => (c.status = undefined)],
    ['status.claim', (c) => (c.status = { status_list: { idx: 1.5, uri: 'https://id.vector.apexfusion.org/status/tsl/0' } })],
    ['status.claim', (c) => (c.status = { status_list: { idx: LIST_SIZE, uri: 'https://id.vector.apexfusion.org/status/tsl/0' } })],
    ['status.claim', (c) => (c.status = { status_list: { idx: 1, uri: 'https://evil.example/status/tsl/0' } })],
    ['status.claim', (c) => (c.status = { status_list: { idx: 1, uri: 'https://id.vector.apexfusion.org/status/bsl/0' } })],
    ['status.claim', (c) => (c.status = { status_list: { idx: 1, uri: 'https://id.vector.apexfusion.org/status/tsl/0?x=1' } })],
  ];
  it.each(forgedCases)('refuses a token with a wrong claim: %s', async (rule, mutate, header) => {
    const s = scene();
    const token = await forge(s, await issue(s), (claims) => mutate(claims, s.gateway.now()), header);
    refused(await callWith(s, token, await proofFor(s, token)), rule);
    // The twin: the same forging with no change is accepted, so the refusal is for the change.
    const twin = await forge(s, await issue(s), () => undefined);
    accepted(await callWith(s, twin, await proofFor(s, twin)));
  });

  it('a token whose kid names the Ed25519 key of the gateway is token.kid: only the P-256 key signs a token', async () => {
    const s = scene();
    const token = await forge(s, await issue(s), () => undefined, { kid: `${s.gateway.gatewayDid}#${s.gateway.keys.ed25519.keyHash}` });
    refused(await callWith(s, token, await proofFor(s, token)), 'token.kid');
    const twin = await forge(s, await issue(s), () => undefined);
    accepted(await callWith(s, twin, await proofFor(s, twin)));
  });

  it('an unsecured token (alg none, an empty signature) is refused: token.alg', async () => {
    const s = scene();
    const token = await issue(s);
    const unsecured = `${b64url(JSON.stringify({ ...decodeJwt(token).header, alg: 'none' }))}.${token.split('.')[1]}.`;
    refused(await callWith(s, unsecured, await proofFor(s, unsecured)), 'token.alg');
    accepted(await callWith(s, token, await proofFor(s, token)));
  });

  it('a token whose signature does not verify is refused: a changed claim, and another key with the same kid', async () => {
    const s = scene();
    const token = await issue(s);
    const [h, p, sig] = token.split('.');
    const claims = decodeJwt(token).payload;
    const changed = `${h}.${b64url(JSON.stringify({ ...claims, exp: Number(claims.exp) + 1 }))}.${sig}`;
    refused(await callWith(s, changed, await proofFor(s, changed)), 'token.signature');
    const strange = await signJws({ alg: 'ES256', kid: `${s.gateway.gatewayDid}#${s.gateway.keys.p256.keyHash}`, typ: 'at+jwt' }, claims, resolveKey(p256Key('rp other gateway').privateKey));
    refused(await callWith(s, strange, await proofFor(s, strange)), 'token.signature');
    accepted(await callWith(s, token, await proofFor(s, token)));
  });

  it('text that is not a JWS is token.malformed; a token of another kind (a JWT-SVID, a status list, a credential) is token.typ', async () => {
    const s = scene();
    refused(await call(s, 'notajwt'), 'token.malformed');
    const svid = await s.client.jwtSvid({ agent: { did: s.agent.did, key: s.agent.authentication.privateKey }, audience: AUDIENCE });
    if (!svid.ok) throw new Error(svid.detail);
    refused(await callWith(s, svid.value.svid, await proofFor(s, svid.value.svid)), 'token.typ');
    const list = await (await s.gateway.fetch(`${s.gateway.baseUrl}/status/tsl/0`)).text();
    refused(await callWith(s, list, await proofFor(s, list)), 'token.typ');
    const credential = await s.client.credential(s.agent.did);
    if (!credential.ok) throw new Error(credential.detail);
    refused(await callWith(s, credential.value, await proofFor(s, credential.value)), 'token.typ');
  });

  it('the header field: a missing one is token.missing, and a scheme that is not DPoP is token.scheme (a token that is bound to a key is no bearer token)', async () => {
    const s = scene();
    const token = await issue(s);
    refused(await s.verifier.accessToken({ dpop: undefined, method: 'POST', url: URL_OF_CALL }, POLICY), 'token.missing');
    refused(await s.verifier.accessToken({ authorization: `Bearer ${token}`, dpop: await proofFor(s, token), method: 'POST', url: URL_OF_CALL }, POLICY), 'token.scheme');
    refused(await s.verifier.accessToken({ authorization: 'DPoP', dpop: undefined, method: 'POST', url: URL_OF_CALL }, POLICY), 'token.scheme');
    accepted(await s.verifier.accessToken({ authorization: `dpop ${token}`, dpop: await proofFor(s, token), method: 'POST', url: URL_OF_CALL }, POLICY));
    expect(parseAuthorization('DPoP abc')).toStrictEqual({ ok: true, value: 'abc' });
    expect(parseAuthorization(undefined)).toMatchObject({ ok: false, rule: 'token.missing' });
    expect(parseAuthorization('DPoP a b')).toMatchObject({ ok: false, rule: 'token.scheme' });
  });

  it('the life of a token: 300 seconds is accepted and 301 is refused; a token that ended 29 seconds ago is accepted (the leeway) and one that ended 31 seconds ago is refused', async () => {
    const s = scene();
    const base = await issue(s);
    const longest = await forge(s, base, () => undefined);
    accepted(await callWith(s, longest, await proofFor(s, longest)));
    s.gateway.advance(300_000 + 29_000);
    accepted(await callWith(s, longest, await proofFor(s, longest)));
    s.gateway.advance(2_000);
    refused(await callWith(s, longest, await proofFor(s, longest)), 'token.expired');
  });

  it('a verifier with no leeway refuses a token at the second that it ends', async () => {
    const s = scene({ leewaySeconds: 0 });
    const token = await issue(s);
    s.gateway.advance(299_000);
    accepted(await callWith(s, token, await proofFor(s, token)));
    s.gateway.advance(1_000);
    refused(await callWith(s, token, await proofFor(s, token)), 'token.expired');
  });
});

describe('accessToken: the DPoP proof', () => {
  it.each<[string, ProofChange]>([
    ['dpop.typ', { header: { typ: 'JWT' } }],
    ['dpop.alg', { header: { alg: 'none' } }],
    ['dpop.alg', { header: { alg: 'ES256' } }],
    ['dpop.key', { header: { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA', d: 'AAAA' } } }],
    ['dpop.key', { header: { jwk: undefined } }],
    ['dpop.signature', { header: { jwk: ed25519Key('rp other proof key').jwk } }],
    ['dpop.jti', { claims: { jti: '' } }],
    ['dpop.method', { claims: { htm: 'GET' } }],
    ['dpop.url', { claims: { htu: 'https://other.example/t/1/erp/stock' } }],
    ['dpop.url', { claims: { htu: `${URL_OF_CALL}/other` } }],
    ['dpop.iat', { claims: { iat: 1 } }],
    ['dpop.iat', { claims: { iat: 9_999_999_999 } }],
    ['dpop.ath', { claims: { ath: 'AAAA' } }],
    ['dpop.ath', { claims: { ath: undefined } }],
    ['dpop.binding', { key: ed25519Key('rp another key') }],
  ])('refuses a proof with a wrong part: %s', async (rule, change) => {
    const s = scene();
    const token = await issue(s);
    refused(await callWith(s, token, await proofFor(s, token, change)), rule);
    accepted(await callWith(s, token, await proofFor(s, token)));
  });

  it('refuses a call with no proof, with two proofs, with a proof that is not a JWT, and with a proof that was used before', async () => {
    const s = scene();
    const token = await issue(s);
    refused(await callWith(s, token, undefined), 'dpop.missing');
    refused(await callWith(s, token, ''), 'dpop.missing');
    refused(await callWith(s, token, [await proofFor(s, token), await proofFor(s, token)]), 'dpop.multiple');
    refused(await callWith(s, token, `${await proofFor(s, token)}, ${await proofFor(s, token)}`), 'dpop.multiple');
    refused(await callWith(s, token, 'abc'), 'dpop.malformed');
    const proof = await proofFor(s, token);
    accepted(await callWith(s, token, proof));
    refused(await callWith(s, token, proof), 'dpop.replay');
    accepted(await callWith(s, token, await proofFor(s, token)));
  });

  it('a proof for the same URL with a query and a fragment is accepted, and so is a proof from 29 seconds in the future and one from 299 seconds ago', async () => {
    const s = scene();
    const token = await issue(s);
    accepted(await callWith(s, token, await proofFor(s, token, { claims: { htu: `${URL_OF_CALL}?a=1#x` } })));
    accepted(await callWith(s, token, await proofFor(s, token, { claims: { iat: Math.floor(s.gateway.now() / 1000) + 29 } })));
    accepted(await callWith(s, token, await proofFor(s, token, { claims: { iat: Math.floor(s.gateway.now() / 1000) - 299 } })));
    refused(await callWith(s, token, await proofFor(s, token, { claims: { iat: Math.floor(s.gateway.now() / 1000) + 31 } })), 'dpop.iat');
    refused(await callWith(s, token, await proofFor(s, token, { claims: { iat: Math.floor(s.gateway.now() / 1000) - 301 } })), 'dpop.iat');
  });

  it.each<[string, string, string, boolean]>([
    ['the default port of https in the proof', 'https://mp-mock.example:443/t/1/erp/stock', URL_OF_CALL, true],
    ['the default port of https in the request', URL_OF_CALL, 'https://mp-mock.example:443/t/1/erp/stock', true],
    ['an upper case scheme and host in the proof', 'HTTPS://MP-MOCK.EXAMPLE/t/1/erp/stock', URL_OF_CALL, true],
    ['an upper case scheme and host in the request', URL_OF_CALL, 'HTTPS://MP-MOCK.EXAMPLE/t/1/erp/stock', true],
    ['a query and a fragment', `${URL_OF_CALL}?a=1#b`, `${URL_OF_CALL}?c=2`, true],
    ['a trailing slash', `${URL_OF_CALL}/`, URL_OF_CALL, false],
    ['a path with another case', 'https://mp-mock.example/T/1/erp/stock', URL_OF_CALL, false],
    ['a percent-encoded letter in the proof', 'https://mp-mock.example/t/1/erp/st%6Fck', URL_OF_CALL, false],
    ['a percent-encoded letter in the request', URL_OF_CALL, 'https://mp-mock.example/t/1/erp/st%6Fck', false],
    ['another port', 'https://mp-mock.example:8443/t/1/erp/stock', URL_OF_CALL, false],
    ['another scheme', 'http://mp-mock.example/t/1/erp/stock', URL_OF_CALL, false],
  ])('the htu of a proof against the URL of the request: %s', async (_name, htu, url, accepts) => {
    const s = scene();
    const token = await issue(s);
    const result = await s.verifier.accessToken({ authorization: `DPoP ${token}`, dpop: await proofFor(s, token, { claims: { htu } }), method: 'POST', url }, POLICY);
    if (accepts) accepted(result);
    else refused(result, 'dpop.url');
  });

  it('the method and the URL of the call are the ones that the verifier gets: a proof for POST is refused for a GET', async () => {
    const s = scene();
    const token = await issue(s);
    refused(await s.verifier.accessToken({ authorization: `DPoP ${token}`, dpop: await proofFor(s, token), method: 'GET', url: URL_OF_CALL }, POLICY), 'dpop.method');
    refused(await s.verifier.accessToken({ authorization: `DPoP ${token}`, dpop: await proofFor(s, token), method: 'POST', url: 'https://other.example/x' }, POLICY), 'dpop.url');
  });

  it('a store of used proofs that is full refuses a new proof instead of dropping an old one', async () => {
    const s = scene({ replay: createReplayStore({ maxEntries: 1 }) });
    const token = await issue(s);
    accepted(await call(s, token));
    refused(await call(s, token), 'dpop.replay_store');
  });
});

describe('accessToken: the grant and the chain of actors', () => {
  it('a token with no delegation names no grant: a call that needs one is refused (delegation.missing), and the same token is accepted for a call that needs none', async () => {
    const s = scene();
    const token = await issue(s, false);
    refused(await call(s, token), 'delegation.missing');
    accepted(await call(s, token, {}, { audience: AUDIENCE }));
  });

  it('a pattern of the grant must cover the action and the resource of the call', async () => {
    const s = scene();
    const token = await issue(s);
    refused(await call(s, token, {}, { audience: AUDIENCE, require: { action: 'hr.read', resource: AUDIENCE } }), 'delegation.action');
    refused(await call(s, token, {}, { audience: AUDIENCE, require: { action: 'erp', resource: AUDIENCE } }), 'delegation.action');
    refused(await call(s, token, {}, { audience: AUDIENCE, require: { action: ACTION, resource: 'https://other.example/t/1/erp' } }), 'delegation.resource');
    accepted(await call(s, token, {}, { audience: AUDIENCE, require: { action: 'erp.stock.write', resource: AUDIENCE } }));
    refused(await call(s, token, {}, { audience: AUDIENCE }), 'delegation.unchecked');
  });

  it('a token that carries a delegation is refused when the policy names no action and no resource: the delegate chooses the audience, and nothing else compares the grant with the call (delegation.unchecked)', async () => {
    const s = scene();
    const other = 'https://mp-mock.example/t/2/hr';
    const asked = await s.client.requestToken({ subject: { did: s.agent.did, key: s.agent.authentication.privateKey }, dpopKey: s.agent.delegation.privateKey, resource: other, delegation: { identifier: s.root.id } });
    if (!asked.ok) throw new Error(asked.detail);
    const callAt = async (token: string, policy: AccessTokenPolicy) => {
      const url = `${other}/stock`;
      const presented = await presentToken(token, s.agent.delegation.privateKey, { method: 'POST', url }, { now: s.gateway.now });
      return s.verifier.accessToken({ authorization: presented.authorization, dpop: presented.dpop, method: 'POST', url }, policy);
    };
    refused(await callAt(asked.value.accessToken, { audience: other }), 'delegation.unchecked');
    refused(await callAt(asked.value.accessToken, { audience: other, require: { action: ACTION, resource: other } }), 'delegation.resource');
    // The twin: a token for the agent alone, for the same resource, is accepted with the same policy.
    const direct = await s.client.requestToken({ subject: { did: s.agent.did, key: s.agent.authentication.privateKey }, dpopKey: s.agent.delegation.privateKey, resource: other });
    if (!direct.ok) throw new Error(direct.detail);
    accepted(await callAt(direct.value.accessToken, { audience: other }));
  });

  it('the policy has three cases: with no require only a token with no delegation is accepted, with require only a token with a delegation, and with require and acceptDirect both', async () => {
    const s = scene();
    const delegated = await issue(s);
    const direct = await issue(s, false);
    accepted(await call(s, direct, {}, { audience: AUDIENCE }));
    refused(await call(s, delegated, {}, { audience: AUDIENCE }), 'delegation.unchecked');
    accepted(await call(s, delegated));
    refused(await call(s, direct), 'delegation.missing');
    accepted(await call(s, delegated, {}, { ...POLICY, acceptDirect: true }));
    accepted(await call(s, direct, {}, { ...POLICY, acceptDirect: true }));
    refused(await call(s, delegated, {}, { audience: AUDIENCE, require: { action: 'hr.read', resource: AUDIENCE }, acceptDirect: true }), 'delegation.action');
  });

  it('the pattern rule is exact for a prefix: oc.* does not cover ocr.read, and * covers every action and resource', async () => {
    const s = scene();
    const token = await issue(s);
    const widen = async (actions: string[], locations: string[]) => forge(s, token, (c) => (c.authorization_details = [{ type: DELEGATION_DETAILS_TYPE, identifier: s.root.id, actions, locations }]));
    const check = async (actions: string[], locations: string[], action: string, resource = AUDIENCE) => {
      const forged = await widen(actions, locations);
      return callWith(s, forged, await proofFor(s, forged), { audience: AUDIENCE, require: { action, resource } });
    };
    refused(await check(['oc.*'], [AUDIENCE], 'ocr.read'), 'delegation.action');
    accepted(await check(['ocr.*'], [AUDIENCE], 'ocr.read'));
    accepted(await check(['*'], ['*'], 'anything.at.all', 'https://any.example/x'));
    refused(await check(['erp.stock.read'], [AUDIENCE], 'erp.stock.write'), 'delegation.action');
    refused(await check(['erp.*'], [`${AUDIENCE}/stock`], 'erp.stock.read'), 'delegation.resource');
  });

  it('a call that asks for a pattern as its action or resource is a mistake of the caller, and it throws', async () => {
    const s = scene();
    const token = await issue(s);
    for (const require of [{ action: 'erp.*', resource: AUDIENCE }, { action: '*', resource: AUDIENCE }, { action: ACTION, resource: '*' }, { action: 'Bad Action', resource: AUDIENCE }]) {
      await expect(call(s, token, {}, { audience: AUDIENCE, require })).rejects.toThrow(TypeError);
    }
  });

  it('acceptDirect with no require is a mistake of the caller, and it throws', async () => {
    const s = scene();
    await expect(call(s, await issue(s, false), {}, { audience: AUDIENCE, acceptDirect: true })).rejects.toThrow(TypeError);
  });

  it('the chain of actors: 4 levels are accepted and 5 are refused, and an actor must be a DID', async () => {
    const s = scene();
    const token = await issue(s);
    const chain = (levels: number) => {
      let act: Record<string, unknown> = { sub: `did:vector:${identifier('actor 0')}` };
      for (let i = 1; i < levels; i++) act = { sub: `did:vector:${identifier(`actor ${i}`)}`, act };
      return { ...act, sub: s.agent.did };
    };
    const withChain = async (levels: number) => {
      const forged = await forge(s, token, (c) => (c.act = chain(levels)));
      return callWith(s, forged, await proofFor(s, forged));
    };
    accepted(await withChain(4));
    refused(await withChain(5), 'act.depth');
    const shallow = scene({ maxActDepth: 1 });
    const t2 = await issue(shallow);
    accepted(await call(shallow, t2));
    const forged = await forge(shallow, t2, (c) => (c.act = chain(2)));
    refused(await callWith(shallow, forged, await proofFor(shallow, forged)), 'act.depth');
  });

  it('a real chain of two links has both actors, the requester first', async () => {
    const s = scene();
    const scorer = s.gateway.createAgent({ label: 'rp scorer' });
    const child = s.gateway.delegate({ delegator: s.agent, delegate: scorer, parent: s.root, actions: ['erp.stock.read'], resources: [AUDIENCE] });
    const result = await s.client.requestToken({ subject: { did: scorer.did, key: scorer.authentication.privateKey }, dpopKey: scorer.delegation.privateKey, resource: AUDIENCE, delegation: { identifier: child.id } });
    if (!result.ok) throw new Error(result.detail);
    const presented = await presentToken(result.value.accessToken, scorer.delegation.privateKey, { method: 'POST', url: URL_OF_CALL }, { now: s.gateway.now });
    const verified = accepted(await s.verifier.accessToken({ authorization: presented.authorization, dpop: presented.dpop, method: 'POST', url: URL_OF_CALL }, POLICY));
    expect(verified.actors).toStrictEqual([scorer.did, s.agent.did]);
    expect(verified.principal).toStrictEqual({ kind: 'agent', did: s.boss.did });
    expect(verified.clientId).toBe(scorer.did);
  });
});

describe('accessToken: authority that ended', () => {
  it('an agent that is revoked after it got a token: the call is refused with status.revoked, and the same call a moment before was accepted', async () => {
    const s = scene({ listCacheSeconds: 0 });
    const token = await issue(s);
    accepted(await call(s, token));
    s.gateway.setStatus(s.agent, 'revoked');
    refused(await call(s, token), 'status.revoked');
  });

  it('the list is read again after its ttl of 60 seconds: a change of status shows within that time, and a verifier that wants it sooner sets listCacheSeconds', async () => {
    const s = scene();
    const token = await issue(s);
    accepted(await call(s, token));
    s.gateway.setStatus(s.agent, 'revoked');
    accepted(await call(s, token));
    s.gateway.advance(61_000);
    refused(await call(s, token), 'status.revoked');
  });

  it('an agent that is suspended is refused with status.suspended, and a hold that ends does not bring the token back: the entry reads suspended until the token cannot be accepted', async () => {
    const s = scene({ listCacheSeconds: 0 });
    const token = await issue(s);
    s.gateway.setStatus(s.agent, 'suspended', 'hold');
    refused(await call(s, token), 'status.suspended');
    s.gateway.setStatus(s.agent, 'active');
    refused(await call(s, token), 'status.suspended');
    s.gateway.advance(300_000 + 31_000);
    refused(await call(s, token), 'token.expired');
  });

  it('a principal that is suspended after the token was issued: the entry of the requester reads suspended, so the call is refused although the requester is Active', async () => {
    const s = scene({ listCacheSeconds: 0 });
    const token = await issue(s);
    accepted(await call(s, token));
    s.gateway.setStatus(s.boss, 'suspended', 'hold');
    refused(await call(s, token), 'status.suspended');
  });

  it('a list that is behind (frozen) does not show the change, and the check of the actors does: actors.refused', async () => {
    const s = scene();
    const token = await issue(s);
    const policy: AccessTokenPolicy = { ...POLICY, checkActors: gatewayActorCheck(s.client) };
    accepted(await call(s, token, {}, policy));
    s.gateway.lists.freeze();
    s.gateway.setStatus(s.boss, 'revoked');
    accepted(await call(s, token, {}, POLICY));
    refused(await call(s, token, {}, policy), 'actors.refused');
  });

  it('the check of the actors gets the actors, the principal when it is an agent, and the requester, without doubles; a check that refuses or throws refuses the call', async () => {
    const s = scene();
    const token = await issue(s);
    const asked: string[][] = [];
    accepted(await call(s, token, {}, { ...POLICY, checkActors: (agents) => (asked.push([...agents]), { ok: true }) }));
    expect(asked).toStrictEqual([[s.agent.did, s.boss.did]]);
    refused(await call(s, token, {}, { ...POLICY, checkActors: () => ({ ok: false, detail: 'an actor is on a list' }) }), 'actors.refused');
    const thrown = await call(s, token, {}, { ...POLICY, checkActors: () => { throw new Error('the register is down'); } });
    refused(thrown, 'actors.refused');
    if (!thrown.ok) expect(thrown.detail).toBe('the check failed: the register is down');
  });

  it('the check of the delegation runs for a delegation token with its grant, and its refusal refuses the call; it does not run for a token with no delegation', async () => {
    const s = scene();
    const token = await issue(s);
    const seenContext: unknown[] = [];
    accepted(await call(s, token, {}, { ...POLICY, checkDelegation: (context) => (seenContext.push({ id: context.delegation.identifier, actors: context.actors, require: context.require }), { ok: true }) }));
    expect(seenContext).toStrictEqual([{ id: s.root.id, actors: [s.agent.did], require: POLICY.require }]);
    refused(await call(s, token, {}, { ...POLICY, checkDelegation: () => ({ ok: false, detail: 'the delegation is not on the ledger any more' }) }), 'delegation.refused');
    refused(await call(s, token, {}, { ...POLICY, checkDelegation: async () => Promise.reject(new Error('the ledger is down')) }), 'delegation.refused');
    let ran = false;
    accepted(await call(s, await issue(s, false), {}, { audience: AUDIENCE, checkDelegation: () => ((ran = true), { ok: true }) }));
    expect(ran).toBe(false);
  });

  it('gatewayActorCheck resolves each DID: Active passes; Suspended, deactivated, unknown and an unreachable gateway refuse', async () => {
    const s = scene();
    const check = gatewayActorCheck(s.client);
    expect(await check([s.agent.did, s.boss.did])).toStrictEqual({ ok: true });
    const parent = s.gateway.createAgent({ label: 'rp parent' });
    const child = s.gateway.createAgent({ label: 'rp child', parent });
    s.gateway.setStatus(parent, 'revoked');
    expect(await check([s.agent.did, child.did])).toMatchObject({ ok: false, detail: expect.stringContaining('has the effective status revoked (parentRevoked)') });
    s.gateway.setStatus(s.boss, 'suspended');
    expect(await check([s.boss.did])).toMatchObject({ ok: false, detail: expect.stringContaining('has the effective status suspended') });
    expect(await check([`did:vector:${identifier('rp nobody')}`])).toMatchObject({ ok: false, detail: expect.stringContaining('does not resolve to an agent') });
    s.gateway.fault(`/1.0/identifiers/${s.agent.did}`, 'network');
    expect(await check([s.agent.did])).toMatchObject({ ok: false, detail: expect.stringContaining('cannot be resolved') });
  });
});

describe('accessToken: the lists that the token names', () => {
  const tslPath = '/status/tsl/0';

  it('a list that answers 503 does not refuse the call: the result says the list was not read, with the reason, so that the caller can log it', async () => {
    const s = scene();
    const token = await issue(s);
    s.gateway.fault(tslPath, LISTS_UNAVAILABLE);
    const verified = accepted(await call(s, token));
    expect(verified.status).toMatchObject({ read: false, reason: 'unavailable', list: `${s.gateway.baseUrl}/status/tsl/0` });
    if (!verified.status.read) expect(verified.status.detail).toMatch(/503/);
    s.gateway.fault(tslPath, 'network');
    s.gateway.advance(61_000);
    expect(accepted(await call(s, token)).status).toMatchObject({ read: false, reason: 'unavailable' });
  });

  it('a list that is old does not refuse the call either: the result says stale', async () => {
    const s = scene();
    s.gateway.lists.freeze();
    s.gateway.advance(59 * 60_000);
    const token = await issue(s);
    s.gateway.advance(2 * 60_000);
    const verified = accepted(await call(s, token));
    expect(verified.status).toMatchObject({ read: false, reason: 'stale' });
  });

  it('a list that cannot be read again after its ttl: the older copy is checked, and the result says that the list was stale, with the reason that the new read failed', async () => {
    const s = scene();
    const token = await issue(s);
    expect(accepted(await call(s, token)).status.read).toBe(true);
    s.gateway.advance(61_000);
    s.gateway.fault(tslPath, LISTS_UNAVAILABLE);
    const verified = accepted(await call(s, token));
    expect(verified.status).toMatchObject({ read: false, reason: 'stale', list: `${s.gateway.baseUrl}${tslPath}` });
    if (!verified.status.read) expect(verified.status.detail).toMatch(/503/);
    // The twin: the gateway answers again, and the list is read.
    s.gateway.fault(tslPath, null);
    s.gateway.advance(6_000);
    expect(accepted(await call(s, token)).status.read).toBe(true);
  });

  it('an older copy that shows the agent revoked is no way round: when the new read fails, the call is still refused with status.revoked', async () => {
    const s = scene();
    const token = await issue(s);
    s.gateway.setStatus(s.agent, 'revoked');
    refused(await call(s, token), 'status.revoked');
    s.gateway.advance(61_000);
    s.gateway.fault(tslPath, LISTS_UNAVAILABLE);
    refused(await call(s, token), 'status.revoked');
  });

  it('a list that is read and is wrong refuses the call: status.list (a list that another key signed), and status.value (a value that the gateway never writes)', async () => {
    const s = scene();
    const token = await issue(s);
    const signer = resolveKey(s.gateway.keys.p256.privateKey);
    const header = { alg: 'ES256', kid: `${s.gateway.gatewayDid}#${s.gateway.keys.p256.keyHash}`, typ: 'statuslist+jwt' };
    const iat = Math.floor(s.gateway.now() / 1000);
    const list = (value: number) => {
      const bytes = Buffer.alloc(LIST_SIZE / 4);
      bytes[s.agent.index >> 2] = value << ((s.agent.index & 3) * 2);
      return signJws(header, { iss: s.gateway.baseUrl, sub: `${s.gateway.baseUrl}${tslPath}`, iat, exp: iat + 3600, ttl: 60, status_list: { bits: 2, lst: b64url(deflateSync(bytes)) } }, signer);
    };
    const serve = async (jwt: string) => s.gateway.fault(tslPath, { status: 200, body: jwt, headers: { 'content-type': 'application/statuslist+jwt' } });
    await serve(await list(3));
    refused(await call(s, token), 'status.value');
    s.gateway.advance(61_000);
    await serve(await list(1));
    refused(await call(s, token), 'status.revoked');
    s.gateway.advance(61_000);
    await serve(await list(0));
    expect(accepted(await call(s, token)).status.read).toBe(true);
    const [h, p] = (await list(0)).split('.');
    s.gateway.advance(61_000);
    await serve(`${h}.${p}.${b64url(Buffer.alloc(64))}`);
    refused(await call(s, token), 'status.list');
  });

  it('the keys of the gateway: a verifier that cannot read them refuses (keys.unavailable), and so does a key set that is wrong', async () => {
    const s = scene();
    const token = await issue(s);
    const jwks = '/.well-known/jwks.json';
    s.gateway.fault(jwks, 'network');
    refused(await call(s, token), 'keys.unavailable');
    s.gateway.fault(jwks, { status: 200, body: '{}' });
    const other = scene();
    const otherToken = await issue(other);
    other.gateway.fault(jwks, { status: 200, body: '{}' });
    refused(await call(other, otherToken), 'jwks.malformed');
    const p256 = s.gateway.keys.p256;
    const again = scene();
    again.gateway.fault(jwks, { status: 200, body: JSON.stringify({ keys: [{ ...p256.jwk, d: 'AAAA', kid: 'x' }] }) });
    refused(await call(again, await issue(again)), 'jwks.private_key');
    const empty = scene();
    empty.gateway.fault(jwks, { status: 200, body: '{"keys":[]}' });
    refused(await call(empty, await issue(empty)), 'jwks.no_usable_key');
  });

  it('a token that names a key that the verifier does not hold yet: after 30 seconds the verifier reads the key set again, and accepts', async () => {
    const s = scene();
    const token = await issue(s);
    const jwks = '/.well-known/jwks.json';
    const stale = JSON.stringify({ keys: [{ ...s.gateway.keys.ed25519.jwk, kid: 'only-key', alg: 'EdDSA', use: 'sig' }] });
    s.gateway.fault(jwks, { status: 200, body: stale });
    refused(await call(s, token), 'token.kid');
    s.gateway.fault(jwks, null);
    s.gateway.advance(31_000);
    accepted(await call(s, token));
  });
});

describe('accessToken: the last position of a list', () => {
  it('a token of an agent at position 131,071 is accepted, and refused when the suspension bit of that position is set (the last bit of the Bitstring Status List)', async () => {
    const s = scene({ listCacheSeconds: 0 });
    const last = s.gateway.createAgent({ label: 'rp last position', statusIndex: LIST_SIZE - 1 });
    const root = s.gateway.delegate({ delegator: s.boss, delegate: last, actions: ['erp.*'], resources: [AUDIENCE] });
    const asked = await s.client.requestToken({ subject: { did: last.did, key: last.authentication.privateKey }, dpopKey: last.delegation.privateKey, resource: AUDIENCE, delegation: { identifier: root.id } });
    if (!asked.ok) throw new Error(asked.detail);
    const callAsLast = async () => {
      const presented = await presentToken(asked.value.accessToken, last.delegation.privateKey, { method: 'POST', url: URL_OF_CALL }, { now: s.gateway.now });
      return s.verifier.accessToken({ authorization: presented.authorization, dpop: presented.dpop, method: 'POST', url: URL_OF_CALL }, POLICY);
    };
    const verified = accepted(await callAsLast());
    expect(verified.statusClaim.index).toBe(LIST_SIZE - 1);
    expect(verified.status.read).toBe(true);
    s.gateway.setStatus(last, 'suspended');
    refused(await callAsLast(), 'status.suspended');
  });
});

describe('the rules of the verifier', () => {
  it('each rule of an access token call has a refusal in this file', () => {
    const untested = [...new Set([...ACCESS_TOKEN_RULES, ...CALL_RULES])].filter((rule) => !seen.has(rule));
    expect(untested).toStrictEqual([]);
  });

  it('a hash of a token is the SHA-256 hash in base64url (the name of a token in a proof)', () => {
    expect(tokenHash('abc')).toBe(createHash('sha256').update('abc').digest('base64url'));
  });
});
