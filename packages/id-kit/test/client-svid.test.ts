// packages/id-kit/test/client-svid.test.ts: the SVID calls of the client against the stub gateway: the X.509-SVID with its nonce, proof and certification request, and the JWT-SVID.
import { describe, it, expect } from 'vitest';
import { X509Certificate, KeyObject, createPublicKey } from 'node:crypto';
import { createCertificationRequest, pem } from '../src/client/index.ts';
import { resolveKey } from '../src/common/keys.ts';
import { ed25519Key, identifier, p256Key, signerOf, LISTS_UNAVAILABLE, START_TIME, type StubAgent } from '../src/testing/index.ts';
import { children, decode } from '../src/vendored/m4/der.ts';
import { derFromText, parseCertificationRequest } from '../src/testing/x509.ts';
import { decodeJwt, requestTo, signedBy, world } from './support.ts';

const identity = (agent: StubAgent) => ({ did: agent.did, key: agent.authentication.privateKey });

describe('requestX509Svid', () => {
  it('gets an X.509-SVID for a key that the client makes: the SPIFFE ID, a certificate for that key, the CA certificate, the end time, and the private key', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509' });
    const result = await client.x509Svid({ agent: identity(agent) });
    if (!result.ok) throw new Error(`the request failed: ${result.rule} ${result.detail}`);
    const svid = result.value;
    expect(svid.spiffeId).toBe(`spiffe://id.vector.apexfusion.org/agent/${agent.id}`);
    expect(svid.privateKey).toBeInstanceOf(KeyObject);
    const certificate = new X509Certificate(svid.certificate);
    const ca = new X509Certificate(svid.bundle);
    expect(certificate.verify(ca.publicKey)).toBe(true);
    expect(certificate.checkIssued(ca)).toBe(true);
    expect(certificate.publicKey.export({ format: 'jwk' })).toStrictEqual(createPublicKey(svid.privateKey!).export({ format: 'jwk' }));
    expect(certificate.subjectAltName).toBe(`URI:${svid.spiffeId}`);
    expect(Date.parse(certificate.validFrom)).toBe(START_TIME - 60_000);
    expect(Date.parse(certificate.validTo)).toBe(START_TIME - 60_000 + 3_600_000);
    expect(svid.expiresAt).toBe((START_TIME - 60_000 + 3_600_000) / 1000);
  });

  it('with a key that the caller gives (a key object or a sign function) the client makes no key, and the result has no private key', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509 given' });
    const asObject = p256Key('x509 given object');
    const asFunction = p256Key('x509 given function');
    for (const [key, input] of [[asObject, asObject.privateKey], [asFunction, signerOf(asFunction)]] as const) {
      const result = await client.x509Svid({ agent: identity(agent), svidKey: input });
      if (!result.ok) throw new Error(result.detail);
      expect(result.value.privateKey).toBeNull();
      expect(new X509Certificate(result.value.certificate).publicKey.export({ format: 'jwk' })).toStrictEqual(createPublicKey(key.privateKey).export({ format: 'jwk' }));
    }
  });

  it('proves the key with the nonce of the gateway: the proof holds the nonce and the public key of the certificate, and it is signed by the authentication key', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509 proof' });
    const key = p256Key('x509 proof key');
    await client.x509Svid({ agent: identity(agent), svidKey: key.privateKey });
    const requested = gateway.requests.filter((r) => r.path === '/spiffe/nonce');
    expect(requested).toHaveLength(1);
    const sent = JSON.parse(requestTo(gateway, '/spiffe/x509-svid').body) as { csr: string; proof: string };
    const { header, payload } = decodeJwt(sent.proof);
    expect(header).toStrictEqual({ alg: 'EdDSA', kid: `${agent.did}#${agent.authentication.keyHash}`, typ: 'JWT' });
    expect(payload).toMatchObject({ iss: agent.did, sub: agent.did, aud: `${gateway.baseUrl}/token`, cnf: { jwk: key.jwk } });
    expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]{54}$/);
    expect(signedBy(sent.proof, 'Ed25519', agent.authentication.publicKey)).toBe(true);
    expect(requestTo(gateway, '/spiffe/nonce').method).toBe('POST');
  });

  it('an ES256 authentication key can sign the proof, as the gateway allows for an X.509-SVID', async () => {
    const { gateway, client } = world();
    const auth = p256Key('x509 es256 auth');
    const agent = gateway.createAgent({ label: 'x509 es256', authentication: auth, keys: [{ key: auth, purposes: 1 }] });
    const result = await client.x509Svid({ agent: { did: agent.did, key: auth.privateKey } });
    expect(result.ok).toBe(true);
    const sent = JSON.parse(requestTo(gateway, '/spiffe/x509-svid').body) as { proof: string };
    expect(decodeJwt(sent.proof).header.alg).toBe('ES256');
  });

  it('writes a certification request that the gateway reads: version 0, an empty subject, the P-256 key, no attribute, ecdsa-with-SHA256, and a signature that verifies', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509 csr' });
    const key = p256Key('x509 csr key');
    await client.x509Svid({ agent: identity(agent), svidKey: key.privateKey });
    const sent = JSON.parse(requestTo(gateway, '/spiffe/x509-svid').body) as { csr: string };
    expect(sent.csr).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n([A-Za-z0-9+/]{64}\n)+[A-Za-z0-9+/=]{1,64}\n-----END CERTIFICATE REQUEST-----\n$/);
    const der = derFromText(sent.csr, ['CERTIFICATE REQUEST'])!;
    const parsed = parseCertificationRequest(der);
    expect(parsed.jwk).toStrictEqual({ kty: 'EC', crv: 'P-256', x: (key.jwk as { x: string }).x, y: (key.jwk as { y: string }).y });
    const info = children(children(decode(der))[0]!);
    expect(info[0]!.bytes.toString('hex')).toBe('020100');
    expect(info[1]!.bytes.toString('hex')).toBe('3000');
    expect(info[3]!.bytes.toString('hex')).toBe('a000');
    expect(children(children(decode(der))[1]!)[0]!.bytes.toString('hex')).toBe('06082a8648ce3d040302');
  });

  it('createCertificationRequest and pem: a request for a key that is not P-256 is refused, and pem writes 64 characters in a line', async () => {
    const ed = resolveKey(ed25519Key('x509 ed').privateKey);
    await expect(createCertificationRequest(ed)).rejects.toThrow(/P-256 key/);
    const der = await createCertificationRequest(resolveKey(p256Key('x509 csr direct').privateKey));
    expect(pem('CERTIFICATE REQUEST', der).split('\n').slice(1, -3).every((line) => line.length === 64)).toBe(true);
    expect(derFromText(pem('CERTIFICATE REQUEST', der), ['CERTIFICATE REQUEST'])!.equals(der)).toBe(true);
  });

  it('every request fetches a new nonce: two requests in a row both work, and the second nonce is not the first', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509 twice' });
    expect((await client.x509Svid({ agent: identity(agent) })).ok).toBe(true);
    expect((await client.x509Svid({ agent: identity(agent) })).ok).toBe(true);
    const nonces = gateway.requests.filter((r) => r.path === '/spiffe/x509-svid').map((r) => decodeJwt((JSON.parse(r.body) as { proof: string }).proof).payload.nonce);
    expect(new Set(nonces).size).toBe(2);
  });

  it('refuses a key that is not P-256 before it sends anything, and accepts a P-256 key', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509 refuse' });
    await expect(client.x509Svid({ agent: identity(agent), svidKey: ed25519Key('x509 refuse ed').privateKey })).rejects.toThrow(/P-256 key/);
    expect(gateway.requests).toHaveLength(0);
    expect((await client.x509Svid({ agent: identity(agent), svidKey: p256Key('x509 refuse p256').privateKey })).ok).toBe(true);
  });

  it('an agent that is suspended gets no SVID: gateway.refused with 403 agent_not_active; an unknown agent gets 400 invalid_proof', async () => {
    const { gateway, client } = world();
    const suspended = gateway.createAgent({ label: 'x509 suspended', status: 'suspended' });
    expect(await client.x509Svid({ agent: identity(suspended) })).toMatchObject({ ok: false, rule: 'gateway.refused', status: 403, error: 'agent_not_active' });
    const nobody = { did: `did:vector:${identifier('x509 nobody')}`, key: ed25519Key('x509 nobody').privateKey };
    expect(await client.x509Svid({ agent: nobody })).toMatchObject({ ok: false, rule: 'gateway.refused', status: 400, error: 'invalid_proof' });
  });

  it('a failure of the nonce call is the result of the request, and the request goes no further', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509 nonce down' });
    gateway.fault('/spiffe/nonce', LISTS_UNAVAILABLE);
    expect(await client.x509Svid({ agent: identity(agent) })).toMatchObject({ ok: false, rule: 'gateway.unavailable', status: 503, retryAfterSeconds: 5 });
    expect(gateway.requests.map((r) => r.path)).toStrictEqual(['/spiffe/nonce']);
    gateway.fault('/spiffe/nonce', { status: 200, body: '{"expires_in":300}' });
    expect(await client.x509Svid({ agent: identity(agent) })).toMatchObject({ ok: false, rule: 'gateway.bad_response' });
  });

  it('an answer with a certificate for another key is gateway.bad_response, and so is an answer with a missing member', async () => {
    const other = world();
    const otherAgent = other.gateway.createAgent({ label: 'x509 other' });
    const foreign = await other.client.x509Svid({ agent: identity(otherAgent) });
    if (!foreign.ok) throw new Error(foreign.detail);
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509 swapped' });
    gateway.fault('/spiffe/x509-svid', { status: 200, body: JSON.stringify({ spiffe_id: foreign.value.spiffeId, x509_svid: foreign.value.certificate, bundle: foreign.value.bundle, expires_at: foreign.value.expiresAt }) });
    expect(await client.x509Svid({ agent: identity(agent) })).toMatchObject({ ok: false, rule: 'gateway.bad_response', detail: expect.stringMatching(/not for the key of the request/) });
    gateway.fault('/spiffe/x509-svid', { status: 200, body: JSON.stringify({ spiffe_id: foreign.value.spiffeId }) });
    expect(await client.x509Svid({ agent: identity(agent) })).toMatchObject({ ok: false, rule: 'gateway.bad_response' });
    gateway.fault('/spiffe/x509-svid', { status: 200, body: JSON.stringify({ spiffe_id: 'x', x509_svid: 'not a certificate', bundle: 'x', expires_at: 1 }) });
    expect(await client.x509Svid({ agent: identity(agent) })).toMatchObject({ ok: false, rule: 'gateway.bad_response', detail: expect.stringMatching(/is not a certificate/) });
  });
});

describe('requestJwtSvid', () => {
  it('gets a JWT-SVID for one audience: ES256, typ JWT, sub is the SPIFFE ID, aud is a string, and it lasts 5 minutes', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'jwt svid' });
    const result = await client.jwtSvid({ agent: identity(agent), audience: 'https://mp-mock.example' });
    if (!result.ok) throw new Error(`the request failed: ${result.rule} ${result.detail}`);
    const { header, payload } = decodeJwt(result.value.svid);
    expect(header).toStrictEqual({ alg: 'ES256', kid: `${gateway.gatewayDid}#${gateway.keys.p256.keyHash}`, typ: 'JWT' });
    expect(payload).toMatchObject({ sub: `spiffe://id.vector.apexfusion.org/agent/${agent.id}`, aud: 'https://mp-mock.example', iat: START_TIME / 1000, exp: START_TIME / 1000 + 300 });
    expect(result.value).toMatchObject({ spiffeId: `spiffe://id.vector.apexfusion.org/agent/${agent.id}`, expiresAt: START_TIME / 1000 + 300 });
    expect(signedBy(result.value.svid, 'P256', gateway.keys.p256.publicKey)).toBe(true);
  });

  it('several audiences are a list, and the request names them as the gateway reads them', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'jwt svid many' });
    const result = await client.jwtSvid({ agent: identity(agent), audience: ['https://a.example', 'https://b.example'] });
    if (!result.ok) throw new Error(result.detail);
    expect(decodeJwt(result.value.svid).payload.aud).toStrictEqual(['https://a.example', 'https://b.example']);
    const sent = JSON.parse(requestTo(gateway, '/spiffe/jwt-svid').body) as { audience: unknown; subject_token: string };
    expect(sent.audience).toStrictEqual(['https://a.example', 'https://b.example']);
    expect(decodeJwt(sent.subject_token).payload).toMatchObject({ iss: agent.did, aud: `${gateway.baseUrl}/token` });
  });

  it.each<[string, unknown]>([
    ['no audience', []],
    ['an empty audience', ''],
    ['nine audiences', Array.from({ length: 9 }, (_, i) => `urn:rs:${i}`)],
    ['an audience of 513 characters', 'a'.repeat(513)],
  ])('refuses %s, and sends nothing; the limits themselves are accepted', async (_name, audience) => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'jwt svid refuse' });
    await expect(client.jwtSvid({ agent: identity(agent), audience: audience as never })).rejects.toThrow(/audience of a JWT-SVID/);
    expect(gateway.requests).toHaveLength(0);
    expect((await client.jwtSvid({ agent: identity(agent), audience: Array.from({ length: 8 }, (_, i) => `urn:rs:${i}`) })).ok).toBe(true);
    expect((await client.jwtSvid({ agent: identity(agent), audience: 'a'.repeat(512) })).ok).toBe(true);
  });

  it('needs an Ed25519 authentication key: the gateway reads a subject token only if it is EdDSA', async () => {
    const { gateway, client } = world();
    const auth = p256Key('jwt svid es256');
    const agent = gateway.createAgent({ label: 'jwt svid es256', authentication: auth, keys: [{ key: auth, purposes: 1 }] });
    await expect(client.jwtSvid({ agent: { did: agent.did, key: auth.privateKey }, audience: 'https://rs.example' })).rejects.toThrow(/must use EdDSA/);
  });

  it('a suspended agent gets no JWT-SVID (403), a failure of the network is gateway.unreachable, and an answer in a wrong form is gateway.bad_response', async () => {
    const { gateway, client } = world();
    const suspended = gateway.createAgent({ label: 'jwt svid suspended', status: 'suspended' });
    expect(await client.jwtSvid({ agent: identity(suspended), audience: 'https://rs.example' })).toMatchObject({ ok: false, rule: 'gateway.refused', status: 403, error: 'agent_not_active' });
    const agent = gateway.createAgent({ label: 'jwt svid faults' });
    gateway.fault('/spiffe/jwt-svid', 'network');
    expect(await client.jwtSvid({ agent: identity(agent), audience: 'https://rs.example' })).toMatchObject({ ok: false, rule: 'gateway.unreachable' });
    gateway.fault('/spiffe/jwt-svid', { status: 200, body: '{"spiffe_id":"spiffe://x/agent/y","svid":"not a jws","expires_at":1}' });
    expect(await client.jwtSvid({ agent: identity(agent), audience: 'https://rs.example' })).toMatchObject({ ok: false, rule: 'gateway.bad_response' });
    gateway.fault('/spiffe/jwt-svid', null);
    expect((await client.jwtSvid({ agent: identity(agent), audience: 'https://rs.example' })).ok).toBe(true);
  });
});
