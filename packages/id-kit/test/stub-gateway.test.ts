// packages/id-kit/test/stub-gateway.test.ts: the stub gateway keeps the rules of the real gateway. The tests of the client and of the verifier trust these rules, so each one has a
// test here: what the gateway refuses, the formats of the lists, and the world of a test (clock, faults, request log). The lists are read here with code of their own (zlib and bit
// operations), not with the code of the verifier.
import { describe, it, expect } from 'vitest';
import { X509Certificate, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { gunzipSync, inflateSync } from 'node:zlib';
import { createAgentJwt, createCertificationRequest, createDpopProof, createSubjectToken, pem } from '../src/client/index.ts';
import { DELEGATION_DETAILS_TYPE, LIST_SIZE } from '../src/common/constants.ts';
import { createStubGateway, ed25519Key, LISTS_UNAVAILABLE, p256Key, START_TIME, type StubAgent, type StubGateway, type TestKey } from '../src/testing/index.ts';
import { bitString, children, decode, decodeOid, explicit, oid, sequence, unsignedInteger } from '../src/vendored/m4/der.ts';
import { signJws } from '../src/vendored/m4/jose.ts';
import { resolveKey } from '../src/common/keys.ts';
import { decodeJwt, world } from './support.ts';

const FORM = 'application/x-www-form-urlencoded';
const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

interface RawOptions {
  readonly subject?: string;
  readonly proof?: string | string[] | null;
  readonly params?: Record<string, string | string[] | null>;
  readonly contentType?: string;
}

/** A token request that the test writes by hand, so that each part can be wrong. */
async function raw(gateway: StubGateway, agent: StubAgent, options: RawOptions = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const endpoint = `${gateway.baseUrl}/token`;
  const form = new URLSearchParams();
  const params: Record<string, string | string[] | null> = {
    grant_type: GRANT,
    subject_token: options.subject ?? (await createSubjectToken({ did: agent.did, key: agent.authentication.privateKey }, endpoint, { now: gateway.now })),
    subject_token_type: JWT_TYPE,
    audience: 'https://rs.example',
    ...options.params,
  };
  for (const [name, value] of Object.entries(params)) for (const v of value === null ? [] : typeof value === 'string' ? [value] : value) form.append(name, v);
  const headers = new Headers({ 'content-type': options.contentType ?? FORM });
  const proofs = options.proof === null ? [] : typeof options.proof === 'string' ? [options.proof] : (options.proof ?? [await createDpopProof(agent.delegation.privateKey, { method: 'POST', url: endpoint, now: gateway.now })]);
  for (const proof of proofs) headers.append('dpop', proof);
  const response = await gateway.fetch(endpoint, { method: 'POST', headers, body: form.toString() });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

const bslBits = (jwt: string): Buffer => {
  const encoded = String((decodeJwt(jwt).payload.credentialSubject as { encodedList: string }).encodedList);
  expect(encoded.charAt(0)).toBe('u');
  return gunzipSync(Buffer.from(encoded.substring(1), 'base64url'));
};
const bit = (bits: Buffer, i: number): boolean => (bits[i >> 3]! & (0x80 >> (i & 7))) !== 0;
const tslValue = (jwt: string, p: number): number => {
  const bytes = inflateSync(Buffer.from((decodeJwt(jwt).payload.status_list as { lst: string }).lst, 'base64url'));
  return (bytes[p >> 2]! >> ((p & 3) * 2)) & 3;
};
const getText = async (gateway: StubGateway, path: string): Promise<{ status: number; body: string; headers: Headers }> => {
  const response = await gateway.fetch(`${gateway.baseUrl}${path}`);
  return { status: response.status, body: await response.text(), headers: response.headers };
};

describe('stub gateway: the token endpoint refuses what the gateway refuses', () => {
  it('a request that is right is accepted (the twin of every refusal below)', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub twin' });
    const answer = await raw(gateway, agent);
    expect(answer.status).toBe(200);
    expect(answer.body.token_type).toBe('DPoP');
  });

  it('the subject token is single-use: the same token again is refused', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub replay' });
    const subject = await createSubjectToken({ did: agent.did, key: agent.authentication.privateKey }, `${gateway.baseUrl}/token`, { now: gateway.now });
    expect((await raw(gateway, agent, { subject })).status).toBe(200);
    expect(await raw(gateway, agent, { subject })).toMatchObject({ status: 400, body: { error: 'invalid_request', error_description: 'subject_token: the jti was already used' } });
  });

  it('the DPoP proof is single-use too, and a request that did not authenticate does not use it up', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub dpop replay' });
    const proof = await createDpopProof(agent.delegation.privateKey, { method: 'POST', url: `${gateway.baseUrl}/token`, now: gateway.now });
    expect((await raw(gateway, agent, { subject: 'not a jwt', proof })).status).toBe(400);
    expect((await raw(gateway, agent, { proof })).status).toBe(200);
    expect(await raw(gateway, agent, { proof })).toMatchObject({ status: 400, body: { error: 'invalid_dpop_proof', error_description: 'the DPoP proof was already used' } });
  });

  it('an expired subject token is refused, and one that is within the clock leeway of 30 seconds is not', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub expiry' });
    const make = (secondsAgo: number, lifetimeSeconds: number) =>
      createSubjectToken({ did: agent.did, key: agent.authentication.privateKey }, `${gateway.baseUrl}/token`, { now: () => gateway.now() - secondsAgo * 1000, lifetimeSeconds });
    expect(await raw(gateway, agent, { subject: await make(400, 300) })).toMatchObject({ status: 400, body: { error_description: 'subject_token: the token has expired' } });
    expect((await raw(gateway, agent, { subject: await make(140, 120) })).status).toBe(200);
    expect(await raw(gateway, agent, { subject: await make(-60, 120) })).toMatchObject({ status: 400, body: { error_description: 'subject_token: iat is in the future' } });
  });

  it('a subject token for another audience, from another agent key, with a wrong kid or with a life over 5 minutes is refused', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub subject' });
    const identity = { did: agent.did, key: agent.authentication.privateKey };
    const otherAudience = await createAgentJwt(identity, 'https://other.example/token', { now: gateway.now, algorithms: ['EdDSA'] });
    expect(await raw(gateway, agent, { subject: otherAudience })).toMatchObject({ status: 400, body: { error_description: expect.stringMatching(/subject_token: aud must be https:\/\/id\.vector\.apexfusion\.org\/token/) } });
    const wrongKey = ed25519Key('stub wrong key');
    const forged = await signJws({ alg: 'EdDSA', kid: `${agent.did}#${agent.authentication.keyHash}` }, { iss: agent.did, sub: agent.did, aud: `${gateway.baseUrl}/token`, iat: START_TIME / 1000, exp: START_TIME / 1000 + 100, jti: 'forged' }, resolveKey(wrongKey.privateKey));
    expect(await raw(gateway, agent, { subject: forged })).toMatchObject({ status: 400, body: { error_description: 'subject_token: the signature does not verify' } });
    const unlistedKey = await signJws({ alg: 'EdDSA', kid: `${agent.did}#${wrongKey.keyHash}` }, { iss: agent.did, sub: agent.did, aud: `${gateway.baseUrl}/token`, iat: START_TIME / 1000, exp: START_TIME / 1000 + 100, jti: 'unlisted' }, resolveKey(wrongKey.privateKey));
    expect(await raw(gateway, agent, { subject: unlistedKey })).toMatchObject({ status: 400, body: { error_description: 'subject_token: the key in kid is not an authentication key of the agent' } });
    const other = gateway.createAgent({ label: 'stub other' });
    const claimsOfOther = await createAgentJwt({ did: other.did, key: agent.authentication.privateKey }, `${gateway.baseUrl}/token`, { now: gateway.now, algorithms: ['EdDSA'] });
    expect(await raw(gateway, agent, { subject: claimsOfOther })).toMatchObject({ status: 400, body: { error_description: expect.stringMatching(/subject_token: the (signature does not verify|key in kid)/) } });
    const long = await signJws({ alg: 'EdDSA', kid: `${agent.did}#${agent.authentication.keyHash}` }, { iss: agent.did, sub: agent.did, aud: `${gateway.baseUrl}/token`, iat: START_TIME / 1000, exp: START_TIME / 1000 + 301, jti: 'long' }, resolveKey(agent.authentication.privateKey));
    expect(await raw(gateway, agent, { subject: long })).toMatchObject({ status: 400, body: { error_description: 'subject_token: exp - iat must be more than 0 and at most 300 seconds' } });
  });

  it('refuses a DPoP proof that is missing, doubled, for another URL or method, too old, or too far in the future', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub proofs' });
    const key = agent.delegation.privateKey;
    const proof = (url: string, method: string, skew = 0) => createDpopProof(key, { method, url, now: () => gateway.now() + skew * 1000 });
    const token = `${gateway.baseUrl}/token`;
    const refused = async (options: RawOptions, message: RegExp) => expect(await raw(gateway, agent, options)).toMatchObject({ status: 400, body: { error: 'invalid_dpop_proof', error_description: expect.stringMatching(message) } });
    await refused({ proof: null }, /a DPoP proof is required/);
    await refused({ proof: [await proof(token, 'POST'), await proof(token, 'POST')] }, /more than one DPoP header field/);
    await refused({ proof: await proof('https://other.example/token', 'POST') }, /htu must be/);
    await refused({ proof: await proof(token, 'GET') }, /htm must be POST/);
    await refused({ proof: await proof(token, 'POST', -301) }, /iat is outside the accepted window/);
    await refused({ proof: await proof(token, 'POST', 31) }, /iat is outside the accepted window/);
    await refused({ proof: 'a.b' }, /is not a JWT/);
    expect((await raw(gateway, agent, { proof: await proof(`${token}?x=1`, 'POST') })).status).toBe(200);
    expect((await raw(gateway, agent, { proof: await proof(token, 'POST', -299) })).status).toBe(200);
    expect((await raw(gateway, agent, { proof: await proof(token, 'POST', 29) })).status).toBe(200);
  });

  it('refuses the form that the gateway refuses: the media type, a repeated parameter, a missing or wrong value, scope, actor tokens, and a request with no audience', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub form' });
    const refused = async (options: RawOptions, status: number, error: string, message: RegExp) => expect(await raw(gateway, agent, options)).toMatchObject({ status, body: { error, error_description: expect.stringMatching(message) } });
    await refused({ contentType: 'application/json' }, 400, 'invalid_request', /must be application\/x-www-form-urlencoded/);
    await refused({ params: { grant_type: 'password' } }, 400, 'unsupported_grant_type', /supports only/);
    await refused({ params: { grant_type: null } }, 400, 'invalid_request', /grant_type is missing/);
    await refused({ params: { subject_token_type: 'urn:other' } }, 400, 'invalid_request', /subject_token_type must be/);
    await refused({ params: { requested_token_type: 'urn:other' } }, 400, 'invalid_request', /requested_token_type must be/);
    await refused({ params: { scope: 'read' } }, 400, 'invalid_scope', /no scopes/);
    await refused({ params: { actor_token: 'x' } }, 400, 'invalid_request', /does not accept actor tokens/);
    await refused({ params: { grant_type: [GRANT, GRANT] } }, 400, 'invalid_request', /appears more than once/);
    await refused({ params: { audience: null } }, 400, 'invalid_target', /name the token's audience/);
    await refused({ params: { audience: null, resource: 'https://rs.example/a#frag' } }, 400, 'invalid_target', /absolute URI without a fragment/);
    await refused({ params: { audience: Array.from({ length: 9 }, (_, i) => `urn:rs:${i}`) } }, 400, 'invalid_target', /at most 8 audiences/);
    await refused({ params: { client_assertion: 'x' } }, 401, 'invalid_client', /does not authenticate clients/);
  });

  it('refuses authorization details that are not exactly one object of the delegation type with known members and a good identifier', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub details' });
    const identifier = 'a'.repeat(64);
    const refused = async (details: string, message: RegExp) => expect(await raw(gateway, agent, { params: { authorization_details: details } })).toMatchObject({ status: 400, body: { error: 'invalid_authorization_details', error_description: expect.stringMatching(message) } });
    await refused('not json', /is not JSON/);
    await refused('{}', /must be a list with one delegation object/);
    await refused('[]', /must be a list with one delegation object/);
    await refused(JSON.stringify([{ type: DELEGATION_DETAILS_TYPE, identifier }, { type: DELEGATION_DETAILS_TYPE, identifier }]), /must be a list with one delegation object/);
    await refused(JSON.stringify([{ type: 'urn:other', identifier }]), /type must be/);
    await refused(JSON.stringify([{ type: DELEGATION_DETAILS_TYPE, identifier, extra: 1 }]), /unknown authorization details member extra/);
    await refused(JSON.stringify([{ type: DELEGATION_DETAILS_TYPE, identifier: 'ABC' }]), /identifier must be the delegation identifier/);
    await refused(JSON.stringify([{ type: DELEGATION_DETAILS_TYPE, identifier, actions: [] }]), /actions must not be empty/);
    await refused(JSON.stringify([{ type: DELEGATION_DETAILS_TYPE, identifier, actions: ['Bad Action'] }]), /actions must be a list of at most 16 patterns/);
    await refused(JSON.stringify([{ type: DELEGATION_DETAILS_TYPE, identifier, locations: [] }]), /locations must not be empty/);
    await refused(JSON.stringify([{ type: DELEGATION_DETAILS_TYPE, identifier }]), /does not exist/);
  });

  it('the access token lasts 5 minutes at most and its `status` claim names the position of the agent in the Token Status List', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub status claim', statusIndex: LIST_SIZE + 9 });
    const answer = await raw(gateway, agent);
    const { payload } = decodeJwt(String(answer.body.access_token));
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
    expect(payload.status).toStrictEqual({ status_list: { idx: 9, uri: `${gateway.baseUrl}/status/tsl/1` } });
    expect(answer.body.expires_in).toBe(300);
  });
});

describe('stub gateway: the status lists', () => {
  it('writes both formats with the positions of the agents: revoked and retired in the revocation bit, suspended in the suspension bit, and Active in neither', async () => {
    const { gateway } = world();
    const active = gateway.createAgent({ label: 'list active' });
    const suspended = gateway.createAgent({ label: 'list suspended', status: 'suspended' });
    const revoked = gateway.createAgent({ label: 'list revoked', status: 'revoked' });
    const retired = gateway.createAgent({ label: 'list retired', status: 'retired' });
    const child = gateway.createAgent({ label: 'list child', parent: suspended });
    const bsl = (await getText(gateway, '/status/bsl/0')).body;
    const tsl = (await getText(gateway, '/status/tsl/0')).body;
    const bits = bslBits(bsl);
    expect(bits).toHaveLength((2 * LIST_SIZE) / 8);
    const expected: Array<[StubAgent, boolean, boolean, number]> = [[active, false, false, 0], [suspended, false, true, 2], [revoked, true, false, 1], [retired, true, false, 1], [child, false, true, 2]];
    for (const [agent, revocation, suspension, value] of expected) {
      expect([bit(bits, agent.index), bit(bits, LIST_SIZE + agent.index)], agent.name).toStrictEqual([revocation, suspension]);
      expect(tslValue(tsl, agent.index), agent.name).toBe(value);
    }
    expect(bit(bits, 100)).toBe(false);
  });

  it('the Bitstring Status List is a credential: typ vc+jwt, cty vc, both purposes, the URL as its id, the issuer, one hour of validity, and the ttl in milliseconds', async () => {
    const { gateway } = world();
    gateway.createAgent({ label: 'list shape' });
    const reply = await getText(gateway, '/status/bsl/0');
    expect(reply.headers.get('content-type')).toBe('application/vc+jwt');
    expect(reply.headers.get('cache-control')).toBe('public, max-age=60');
    expect(reply.headers.get('access-control-allow-origin')).toBe('*');
    const { header, payload } = decodeJwt(reply.body);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'vc+jwt', cty: 'vc', kid: `${gateway.gatewayDid}#${gateway.keys.p256.keyHash}` });
    expect(payload).toMatchObject({
      id: `${gateway.baseUrl}/status/bsl/0`,
      type: ['VerifiableCredential', 'BitstringStatusListCredential'],
      issuer: gateway.gatewayDid,
      validFrom: '2026-11-19T12:00:00Z',
      validUntil: '2026-11-19T13:00:00Z',
      credentialSubject: { id: `${gateway.baseUrl}/status/bsl/0#list`, type: 'BitstringStatusList', statusPurpose: ['revocation', 'suspension'], ttl: 60_000 },
    });
  });

  it('the Token Status List is a token: typ statuslist+jwt, 2 bits for each entry, the URL as its sub, one hour to exp, and the ttl in seconds', async () => {
    const { gateway } = world();
    gateway.createAgent({ label: 'list tsl shape' });
    const reply = await getText(gateway, '/status/tsl/0');
    expect(reply.headers.get('content-type')).toBe('application/statuslist+jwt');
    const { header, payload } = decodeJwt(reply.body);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'statuslist+jwt' });
    expect(payload).toMatchObject({ iss: gateway.baseUrl, sub: `${gateway.baseUrl}/status/tsl/0`, iat: START_TIME / 1000, exp: START_TIME / 1000 + 3600, ttl: 60, status_list: { bits: 2 } });
  });

  it('a list exists for each block of 131,072 positions that an agent uses: list 1 exists when an agent is at position 131,072 or more, and list 2 does not exist', async () => {
    const { gateway } = world();
    expect((await getText(gateway, '/status/bsl/1')).status).toBe(404);
    gateway.createAgent({ label: 'list far', statusIndex: LIST_SIZE + 3, status: 'revoked' });
    expect((await getText(gateway, '/status/bsl/1')).status).toBe(200);
    expect((await getText(gateway, '/status/tsl/2')).status).toBe(404);
    expect(bit(bslBits((await getText(gateway, '/status/bsl/1')).body), 3)).toBe(true);
    expect(bit(bslBits((await getText(gateway, '/status/bsl/0')).body), 3)).toBe(false);
  });

  it('frozen lists stay as they were while an agent changes and the clock moves, and thawed lists follow the world again', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'list frozen' });
    gateway.lists.freeze();
    const before = (await getText(gateway, '/status/tsl/0')).body;
    gateway.setStatus(agent, 'revoked');
    gateway.advance(30 * 60_000);
    expect((await getText(gateway, '/status/tsl/0')).body).toBe(before);
    expect(tslValue(before, agent.index)).toBe(0);
    expect(gateway.lists.builtAt()).toBe(START_TIME);
    gateway.lists.refresh();
    expect(tslValue((await getText(gateway, '/status/tsl/0')).body, agent.index)).toBe(1);
    gateway.setStatus(agent, 'active');
    expect(tslValue((await getText(gateway, '/status/tsl/0')).body, agent.index)).toBe(1);
    gateway.lists.thaw();
    expect(tslValue((await getText(gateway, '/status/tsl/0')).body, agent.index)).toBe(0);
  });

  it('the entry of the requester of a token reads Suspended in the Token Status List after a change that revoked the token, even when the requester is Active, until the token cannot be accepted', async () => {
    const { gateway, client } = world();
    const boss = gateway.createAgent({ label: 'held boss' });
    const worker = gateway.createAgent({ label: 'held worker' });
    const delegation = gateway.delegate({ delegator: boss, delegate: worker, actions: ['erp.*'], resources: ['https://rs.example/x'] });
    const issued = await client.requestToken({ subject: { did: worker.did, key: worker.authentication.privateKey }, dpopKey: worker.delegation.privateKey, audience: 'https://rs.example', delegation: { identifier: delegation.id } });
    expect(issued.ok).toBe(true);
    const entry = async () => tslValue((await getText(gateway, '/status/tsl/0')).body, worker.index);
    expect(await entry()).toBe(0);
    gateway.setStatus(boss, 'suspended', 'hold');
    expect(await entry()).toBe(2);
    gateway.setStatus(boss, 'active');
    expect(await entry()).toBe(2);
    gateway.advance(300_000 + 29_000);
    expect(await entry()).toBe(2);
    gateway.advance(2_000);
    expect(await entry()).toBe(0);
  });

  it('a list is not available while the fault is set, with the answer that the live gateway gives, and it is again when the fault is gone', async () => {
    const { gateway } = world();
    gateway.createAgent({ label: 'list fault' });
    gateway.fault('/status/tsl/0', LISTS_UNAVAILABLE);
    const reply = await getText(gateway, '/status/tsl/0');
    expect(reply.status).toBe(503);
    expect(reply.headers.get('retry-after')).toBe('5');
    expect(JSON.parse(reply.body)).toStrictEqual({ error: 'temporarily_unavailable', error_description: 'the status lists could not be built from the ledger' });
    expect((await getText(gateway, '/status/bsl/0')).status).toBe(200);
    gateway.fault('/status/tsl/0', null);
    expect((await getText(gateway, '/status/tsl/0')).status).toBe(200);
  });
});

describe('stub gateway: keys, SPIFFE and the other routes', () => {
  it('serves its two keys as a key set with the kid of each, and the metadata that names the delegation type', async () => {
    const { gateway } = world();
    const jwks = JSON.parse((await getText(gateway, '/.well-known/jwks.json')).body) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys).toStrictEqual([
      { ...gateway.keys.ed25519.jwk, kid: `${gateway.gatewayDid}#${gateway.keys.ed25519.keyHash}`, alg: 'EdDSA', use: 'sig' },
      { ...gateway.keys.p256.jwk, kid: `${gateway.gatewayDid}#${gateway.keys.p256.keyHash}`, alg: 'ES256', use: 'sig' },
    ]);
    const metadata = JSON.parse((await getText(gateway, '/.well-known/oauth-authorization-server')).body) as Record<string, unknown>;
    expect(metadata).toMatchObject({ issuer: gateway.baseUrl, token_endpoint: `${gateway.baseUrl}/token`, authorization_details_types_supported: [DELEGATION_DETAILS_TYPE], grant_types_supported: [GRANT] });
  });

  it('the bundle has one key for X.509-SVIDs with the CA certificate in x5c, one key for JWT-SVIDs with a kid, and a refresh hint of 300 seconds', async () => {
    const { gateway } = world();
    const bundle = JSON.parse((await getText(gateway, '/spiffe/bundle')).body) as { spiffe_sequence: number; spiffe_refresh_hint: number; keys: Array<Record<string, unknown>> };
    expect(bundle.spiffe_refresh_hint).toBe(300);
    expect(bundle.spiffe_sequence).toBe(START_TIME / 1000);
    expect(bundle.keys.map((k) => k.use)).toStrictEqual(['x509-svid', 'jwt-svid']);
    expect('kid' in bundle.keys[0]!).toBe(false);
    expect(bundle.keys[1]!.kid).toBe(`${gateway.gatewayDid}#${gateway.keys.p256.keyHash}`);
    const ca = new X509Certificate(Buffer.from((bundle.keys[0]!.x5c as string[])[0]!, 'base64'));
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe(`O=${gateway.trustDomain}`);
    expect(ca.issuer).toBe(`O=${gateway.trustDomain}`);
    expect(ca.verify(ca.publicKey)).toBe(true);
  });

  it('issues an X.509-SVID with the layout of the gateway: an empty subject, one critical URI name, cA false, digitalSignature only, no revocation pointer, and noRevAvail', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'stub x509 layout' });
    const result = await client.x509Svid({ agent: { did: agent.did, key: agent.authentication.privateKey } });
    if (!result.ok) throw new Error(result.detail);
    const cert = new X509Certificate(result.value.certificate);
    const tbs = children(decode(cert.raw))[0]!;
    const fields = children(tbs);
    expect(fields[5]!.bytes.toString('hex')).toBe('3000');
    const extensions = new Map(children(children(fields.find((f) => f.tag === 0xa3)!)[0]!).map((e) => {
      const parts = children(e);
      return [decodeOid(parts[0]!), { critical: parts.length === 3 && parts[1]!.content[0] === 0xff, value: parts[parts.length - 1]!.content.toString('hex') }] as const;
    }));
    expect(extensions.get('2.5.29.56')).toStrictEqual({ critical: false, value: '0500' });
    expect(extensions.get('2.5.29.15')).toStrictEqual({ critical: true, value: '03020780' });
    expect(extensions.get('2.5.29.19')).toStrictEqual({ critical: true, value: '3000' });
    expect(extensions.get('2.5.29.17')?.critical).toBe(true);
    expect(extensions.has('2.5.29.31')).toBe(false);
    expect(cert.keyUsage).toStrictEqual(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
    expect(cert.ca).toBe(false);
  });

  /** An X.509-SVID request that the test writes by hand: its own nonce, proof key and request, so that each part can be wrong. */
  async function x509Raw(gateway: StubGateway, agent: StubAgent, options: { nonce?: string | null; proofJwk?: unknown; csr?: string; key?: TestKey; authKey?: TestKey } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const key = options.key ?? p256Key('stub x509 raw key');
    let nonce = options.nonce;
    if (nonce === undefined) nonce = (JSON.parse(await (await gateway.fetch(`${gateway.baseUrl}/spiffe/nonce`, { method: 'POST' })).text()) as { nonce: string }).nonce;
    const csr = options.csr ?? pem('CERTIFICATE REQUEST', await createCertificationRequest(resolveKey(key.privateKey)));
    const proof = await createAgentJwt({ did: agent.did, key: (options.authKey ?? agent.authentication).privateKey }, `${gateway.baseUrl}/token`, {
      now: gateway.now,
      algorithms: ['EdDSA', 'ES256'],
      extraClaims: { ...(nonce === null ? {} : { nonce }), cnf: { jwk: options.proofJwk === undefined ? key.jwk : options.proofJwk } },
    });
    const response = await gateway.fetch(`${gateway.baseUrl}/spiffe/x509-svid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csr, proof }) });
    return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
  }

  it('issues an X.509-SVID for a request that is right (the twin of every refusal below)', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub x509 twin' });
    const answer = await x509Raw(gateway, agent);
    expect(answer.status).toBe(200);
    expect(answer.body.spiffe_id).toBe(`spiffe://${gateway.trustDomain}/agent/${agent.id}`);
  });

  it('the nonce is single-use and lasts 5 minutes, and a nonce that the stub never issued, or none, is refused', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub nonce' });
    const issued = JSON.parse(await (await gateway.fetch(`${gateway.baseUrl}/spiffe/nonce`, { method: 'POST' })).text()) as { nonce: string; expires_in: number };
    expect(issued.expires_in).toBe(300);
    expect(issued.nonce).toMatch(/^[A-Za-z0-9_-]{54}$/);
    expect((await x509Raw(gateway, agent, { nonce: issued.nonce })).status).toBe(200);
    expect(await x509Raw(gateway, agent, { nonce: issued.nonce })).toMatchObject({ status: 400, body: { error: 'invalid_nonce', error_description: 'the nonce is unknown or was already used' } });
    expect(await x509Raw(gateway, agent, { nonce: 'made-up' })).toMatchObject({ status: 400, body: { error: 'invalid_nonce' } });
    expect(await x509Raw(gateway, agent, { nonce: null })).toMatchObject({ status: 400, body: { error: 'invalid_nonce', error_description: 'proof: the nonce claim is missing' } });

    const old = JSON.parse(await (await gateway.fetch(`${gateway.baseUrl}/spiffe/nonce`, { method: 'POST' })).text()) as { nonce: string };
    gateway.advance(299_000);
    expect((await x509Raw(gateway, agent, { nonce: old.nonce })).status).toBe(200);
    const late = JSON.parse(await (await gateway.fetch(`${gateway.baseUrl}/spiffe/nonce`, { method: 'POST' })).text()) as { nonce: string };
    gateway.advance(300_001);
    expect(await x509Raw(gateway, agent, { nonce: late.nonce })).toMatchObject({ status: 400, body: { error: 'invalid_nonce', error_description: 'the nonce is older than 5 minutes' } });
  });

  it('the proof must name the key of the request in cnf.jwk, and be signed by a key with the authentication purpose', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub x509 proof' });
    const mismatch = { error: 'invalid_proof', error_description: 'proof: cnf.jwk must be the public key of the certificate request' };
    expect(await x509Raw(gateway, agent, { proofJwk: p256Key('stub x509 other key').jwk })).toMatchObject({ status: 400, body: mismatch });
    expect(await x509Raw(gateway, agent, { proofJwk: null })).toMatchObject({ status: 400, body: mismatch });
    const assertionOnly = ed25519Key('stub x509 assertion only');
    const other = gateway.createAgent({ label: 'stub x509 assertion agent', keys: [{ key: assertionOnly, purposes: 2 }] });
    expect(await x509Raw(gateway, other, { authKey: assertionOnly })).toMatchObject({ status: 400, body: { error: 'invalid_proof', error_description: expect.stringMatching(/not an authentication key of the agent/) } });
    const p256Auth = p256Key('stub x509 p256 auth');
    const withP256 = gateway.createAgent({ label: 'stub x509 p256 agent', keys: [{ key: p256Auth, purposes: 1 }] });
    expect((await x509Raw(gateway, withP256, { authKey: p256Auth })).status).toBe(200);
  });

  it('refuses a certification request that is not P-256, that is not signed by its key, that has bytes after it, or that is not a request at all', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'stub x509 csr' });
    const good = await createCertificationRequest(resolveKey(p256Key('stub x509 csr good').privateKey));
    const broken = Buffer.from(good);
    broken[broken.length - 1]! ^= 1;
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey;
    const info = sequence(unsignedInteger(Uint8Array.of(0)), sequence(), createPublicKey(p384).export({ format: 'der', type: 'spki' }), explicit(0, Buffer.alloc(0)));
    const forP384 = sequence(info, sequence(oid('1.2.840.10045.4.3.2')), bitString(sign('sha256', info, { key: p384, dsaEncoding: 'der' })));
    const refused = async (csr: string, error: string, message: RegExp) => expect(await x509Raw(gateway, agent, { csr })).toMatchObject({ status: 400, body: { error, error_description: expect.stringMatching(message) } });
    await refused(pem('CERTIFICATE REQUEST', broken), 'invalid_csr', /signature does not verify/);
    await refused(pem('CERTIFICATE REQUEST', forP384), 'invalid_csr', /not a P-256 key/);
    await refused(pem('CERTIFICATE REQUEST', Buffer.concat([good, Buffer.from([0])])), 'invalid_csr', /not valid DER/);
    await refused('not a request!', 'invalid_request', /PEM certificate request/);
    await refused(pem('CERTIFICATE', good), 'invalid_request', /PEM certificate request/);
    expect((await x509Raw(gateway, agent, { csr: good.toString('base64url'), key: p256Key('stub x509 csr good') })).status).toBe(200);
  });

  it('a JWT-SVID lives 5 minutes and has a jti of 128 random bits', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'stub jwt svid' });
    const result = await client.jwtSvid({ agent: { did: agent.did, key: agent.authentication.privateKey }, audience: 'https://rs.example' });
    if (!result.ok) throw new Error(result.detail);
    const { payload } = decodeJwt(result.value.svid);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
    expect(String(payload.jti)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('answers 405 with the allowed method for a wrong method, and 404 for a route that it does not have (the stub has no /introspect and no /revoke)', async () => {
    const { gateway } = world();
    const get = await gateway.fetch(`${gateway.baseUrl}/token`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const post = await gateway.fetch(`${gateway.baseUrl}/spiffe/bundle`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    expect((await gateway.fetch(`${gateway.baseUrl}/introspect`, { method: 'POST' })).status).toBe(404);
    expect((await getText(gateway, '/healthz')).body).toBe('{"status":"ok"}');
  });

  it('serves its own origin only: a request to another origin is a network failure', async () => {
    const { gateway } = world();
    await expect(gateway.fetch('https://other.example/status/tsl/0')).rejects.toThrow(/serves https:\/\/id\.vector\.apexfusion\.org only/);
  });

  it('records each request with the method, the URL, the path, the header fields in lower case and the body; a fault answers instead of the route and a request is recorded all the same', async () => {
    const { gateway } = world();
    await gateway.fetch(`${gateway.baseUrl}/status/tsl/0?x=1`, { headers: { 'X-Test': 'yes' } });
    expect(gateway.requests[0]).toStrictEqual({ method: 'GET', url: `${gateway.baseUrl}/status/tsl/0?x=1`, path: '/status/tsl/0', headers: { 'x-test': 'yes' }, body: '' });
    gateway.fault('/healthz', { status: 418, body: 'teapot' });
    const reply = await gateway.fetch(`${gateway.baseUrl}/healthz`);
    expect(reply.status).toBe(418);
    expect(await reply.text()).toBe('teapot');
    expect(gateway.requests).toHaveLength(2);
    gateway.fault('/healthz', 'network');
    await expect(gateway.fetch(`${gateway.baseUrl}/healthz`)).rejects.toThrow(/network failure/);
    gateway.fault('/healthz', null);
    expect((await gateway.fetch(`${gateway.baseUrl}/healthz`)).status).toBe(200);
  });

  it('a request with a signal that is already aborted fails, as fetch does', async () => {
    const { gateway } = world();
    await expect(gateway.fetch(`${gateway.baseUrl}/healthz`, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});

describe('stub gateway: the clock and the world of a test', () => {
  it('starts at a fixed time, moves with setNow and advance, and follows the clock that the caller gives', () => {
    const { gateway } = world();
    expect(gateway.now()).toBe(START_TIME);
    gateway.advance(5_000);
    expect(gateway.now()).toBe(START_TIME + 5_000);
    gateway.setNow(START_TIME);
    expect(gateway.now()).toBe(START_TIME);
    let time = 1_000_000;
    const own = createStubGateway({ now: () => time });
    expect(own.now()).toBe(1_000_000);
    time += 10;
    expect(own.now()).toBe(1_000_010);
    expect(() => own.setNow(5)).toThrow(/clock that the caller gave/);
    expect(() => own.advance(5)).toThrow(/clock that the caller gave/);
  });

  it('gives each agent a position from 0, refuses a label or a position that is taken, and a label gives the same identifier in each stub', () => {
    const { gateway } = world();
    const a = gateway.createAgent({ label: 'one' });
    const b = gateway.createAgent();
    expect([a.index, b.index]).toStrictEqual([0, 1]);
    expect(() => gateway.createAgent({ label: 'one' })).toThrow(/has an agent with the label one/);
    expect(() => gateway.createAgent({ statusIndex: 1 })).toThrow(/position 1 is taken/);
    expect(world().gateway.createAgent({ label: 'one' }).id).toBe(a.id);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a.did).toBe(`did:vector:${a.id}`);
  });

  it('removes a key from the record, or changes its purposes, and refuses a key that the record does not list', () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'keys of a record' });
    gateway.setPurposes(agent, agent.delegation, 1 | 16);
    expect(agent.keys.find((k) => k.key === agent.delegation)?.purposes).toBe(17);
    gateway.removeKey(agent, agent.delegation.keyHash);
    expect(agent.keys).toHaveLength(1);
    expect(() => gateway.removeKey(agent, agent.delegation)).toThrow(/does not list this key/);
    expect(() => gateway.setPurposes(agent, agent.delegation, 1)).toThrow(/does not list this key/);
  });

  it('refuses an origin that is not an https origin (http only for a loopback host)', () => {
    expect(() => createStubGateway({ baseUrl: 'http://id.example' })).toThrow(/https URL/);
    expect(() => createStubGateway({ baseUrl: 'https://id.example/path' })).toThrow(/no path/);
    expect(createStubGateway({ baseUrl: 'http://127.0.0.1:8080' }).trustDomain).toBe('127.0.0.1');
  });
});
