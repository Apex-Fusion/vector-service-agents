// packages/id-kit/test/client-jwt.test.ts: what the client signs without a call: the subject token of an agent and the DPoP proof.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createDpopProof, createSubjectToken, presentToken, proofTarget, tokenHash } from '../src/client/index.ts';
import { didOf } from '../src/common/did.ts';
import { ed25519Key, identifier, p256Key, signerOf } from '../src/testing/index.ts';
import { jwkThumbprint } from '../src/vendored/m4/jose.ts';
import { decodeJwt, signedBy } from './support.ts';

const ENDPOINT = 'https://id.vector.apexfusion.org/token';
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const clock = () => NOW;
const agent = { id: identifier('client-jwt agent'), key: ed25519Key('client-jwt agent key') };
const did = didOf(agent.id);

describe('createSubjectToken', () => {
  it('signs an EdDSA JWT: kid is the DID URL of the key, iss and sub are the DID, aud is the token endpoint, and the life is 120 seconds by default', async () => {
    const jwt = await createSubjectToken({ did, key: agent.key.privateKey }, ENDPOINT, { now: clock });
    const { header, payload } = decodeJwt(jwt);
    expect(header).toStrictEqual({ alg: 'EdDSA', kid: `${did}#${agent.key.keyHash}`, typ: 'JWT' });
    expect(Object.keys(payload).sort()).toStrictEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    expect(payload).toMatchObject({ iss: did, sub: did, aud: ENDPOINT, iat: NOW / 1000, exp: NOW / 1000 + 120 });
    expect(signedBy(jwt, 'Ed25519', agent.key.publicKey)).toBe(true);
  });

  it('a sign function gives the same kind of token as a key object, and its signature verifies', async () => {
    const jwt = await createSubjectToken({ did, key: signerOf(agent.key) }, ENDPOINT, { now: clock });
    expect(decodeJwt(jwt).header.kid).toBe(`${did}#${agent.key.keyHash}`);
    expect(signedBy(jwt, 'Ed25519', agent.key.publicKey)).toBe(true);
  });

  it('the jti is single-use: 200 tokens at one instant have 200 different jti values of 128 random bits', async () => {
    const jtis = new Set<string>();
    for (let i = 0; i < 200; i++) jtis.add(String(decodeJwt(await createSubjectToken({ did, key: agent.key.privateKey }, ENDPOINT, { now: clock })).payload.jti));
    expect(jtis.size).toBe(200);
    for (const jti of jtis) expect(jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('the life is 5 minutes at most: 300 seconds is accepted, 301 and 0 are refused, and so is a life that is not a whole number', async () => {
    const life = async (lifetimeSeconds: number) => {
      const { payload } = decodeJwt(await createSubjectToken({ did, key: agent.key.privateKey }, ENDPOINT, { now: clock, lifetimeSeconds }));
      return Number(payload.exp) - Number(payload.iat);
    };
    await expect(life(300)).resolves.toBe(300);
    await expect(life(1)).resolves.toBe(1);
    await expect(life(301)).rejects.toThrow(RangeError);
    await expect(life(0)).rejects.toThrow(RangeError);
    await expect(life(1.5)).rejects.toThrow(RangeError);
  });

  it.each<[string, { did: string; key: unknown }, RegExp]>([
    ['a P-256 key: the gateway reads a subject token only if it is EdDSA', { did, key: p256Key('client-jwt p256').privateKey }, /must use EdDSA, not ES256/],
    ['a public key', { did, key: agent.key.publicKey }, /must be a private key/],
    ['a DID in the legacy form', { did: `did:vector:agent:${'a'.repeat(56)}:${agent.id}`, key: agent.key.privateKey }, /must be "did:vector:" and 64 lowercase hex/],
    ['a DID with upper case hex', { did: `did:vector:${agent.id.toUpperCase()}`, key: agent.key.privateKey }, /must be "did:vector:" and 64 lowercase hex/],
  ])('refuses %s', async (_name, input, message) => {
    await expect(createSubjectToken(input as never, ENDPOINT, { now: clock })).rejects.toThrow(message);
  });
});

describe('createDpopProof', () => {
  it('signs a proof for a token request: typ dpop+jwt, the public JWK in the header and no private member, htm, htu, iat and jti, and no ath', async () => {
    const key = ed25519Key('client-jwt dpop');
    const proof = await createDpopProof(key.privateKey, { method: 'POST', url: ENDPOINT, now: clock });
    const { header, payload } = decodeJwt(proof);
    expect(header).toStrictEqual({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: { kty: 'OKP', crv: 'Ed25519', x: key.jwk.kty === 'OKP' ? key.jwk.x : '' } });
    expect(Object.keys(payload).sort()).toStrictEqual(['htm', 'htu', 'iat', 'jti']);
    expect(payload).toMatchObject({ htm: 'POST', htu: ENDPOINT, iat: NOW / 1000 });
    expect(signedBy(proof, 'Ed25519', key.publicKey)).toBe(true);
  });

  it('works with a P-256 key too: ES256 and a JWK with the member y', async () => {
    const key = p256Key('client-jwt dpop p256');
    const proof = await createDpopProof(key.privateKey, { method: 'GET', url: 'https://rs.example/a', now: clock });
    const { header } = decodeJwt(proof);
    expect(header.alg).toBe('ES256');
    expect(Object.keys(header.jwk as object).sort()).toStrictEqual(['crv', 'kty', 'x', 'y']);
    expect(signedBy(proof, 'P256', key.publicKey)).toBe(true);
  });

  it('names the access token with ath, the SHA-256 hash of the token in base64url, when a token is given, and not otherwise', async () => {
    const key = ed25519Key('client-jwt ath');
    const accessToken = 'aaa.bbb.ccc';
    const withToken = decodeJwt(await createDpopProof(key.privateKey, { method: 'POST', url: ENDPOINT, accessToken, now: clock })).payload;
    expect(withToken.ath).toBe(createHash('sha256').update(accessToken, 'ascii').digest('base64url'));
    expect(withToken.ath).toBe(tokenHash(accessToken));
    const without = decodeJwt(await createDpopProof(key.privateKey, { method: 'POST', url: ENDPOINT, now: clock })).payload;
    expect('ath' in without).toBe(false);
  });

  it('names the URL without its query and its fragment, and with the port when it is not the default one', async () => {
    const key = ed25519Key('client-jwt htu');
    const htu = async (url: string) => decodeJwt(await createDpopProof(key.privateKey, { method: 'GET', url, now: clock })).payload.htu;
    await expect(htu('https://rs.example/t/a/b?x=1&y=2#top')).resolves.toBe('https://rs.example/t/a/b');
    await expect(htu('https://rs.example:8443/t')).resolves.toBe('https://rs.example:8443/t');
    await expect(htu('https://rs.example:443/t')).resolves.toBe('https://rs.example/t');
    expect(proofTarget('https://rs.example/a?b#c')).toBe('https://rs.example/a');
  });

  it('every proof has its own jti', async () => {
    const key = ed25519Key('client-jwt proof jti');
    const jtis = new Set<unknown>();
    for (let i = 0; i < 100; i++) jtis.add(decodeJwt(await createDpopProof(key.privateKey, { method: 'POST', url: ENDPOINT, now: clock })).payload.jti);
    expect(jtis.size).toBe(100);
  });

  it.each<[string, { method: string; url: string }, RegExp]>([
    ['a method in lower case', { method: 'post', url: ENDPOINT }, /upper case HTTP method/],
    ['an empty method', { method: '', url: ENDPOINT }, /upper case HTTP method/],
    ['a URL that is not a URL', { method: 'POST', url: 'not a url' }, /is not a URL/],
    ['a URL that is not http or https', { method: 'POST', url: 'ftp://rs.example/a' }, /http or https URL/],
  ])('refuses %s', async (_name, request, message) => {
    await expect(createDpopProof(ed25519Key('client-jwt refuse').privateKey, { ...request, now: clock })).rejects.toThrow(message);
  });

  it('the proof of a token request and the thumbprint: cnf.jkt of the token will be the thumbprint of the key', async () => {
    const key = ed25519Key('client-jwt thumbprint');
    const { header } = decodeJwt(await createDpopProof(key.privateKey, { method: 'POST', url: ENDPOINT, now: clock }));
    expect(jwkThumbprint(header.jwk as never)).toBe(key.thumbprint);
  });
});

describe('presentToken', () => {
  it('gives the two header fields of a call: Authorization DPoP with the token, and a proof for this method and URL that names the token', async () => {
    const key = ed25519Key('client-jwt present');
    const presented = await presentToken('aaa.bbb.ccc', key.privateKey, { method: 'POST', url: 'https://rs.example/t/x/erp?a=1' }, { now: clock });
    expect(presented.authorization).toBe('DPoP aaa.bbb.ccc');
    const { payload } = decodeJwt(presented.dpop);
    expect(payload).toMatchObject({ htm: 'POST', htu: 'https://rs.example/t/x/erp', ath: tokenHash('aaa.bbb.ccc') });
  });
});
