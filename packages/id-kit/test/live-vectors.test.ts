// packages/id-kit/test/live-vectors.test.ts: the verifier against what the live gateway publishes. The files under test/fixtures/live/ are public documents that scripts/capture-live-vectors.ts
// read with GET requests: the key set, the metadata, the SPIFFE bundle, both status lists and the credential of one public record. Each document is read at the time of the capture, because
// every list and credential has a time of validity. No test here makes a network call.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DELEGATION_DETAILS_TYPE, LIST_SIZE, TOKEN_EXCHANGE_GRANT } from '../src/common/constants.ts';
import type { Check } from '../src/common/result.ts';
import { b64url } from '../src/vendored/m4/jose.ts';
import { bitstringEntryStatus, checkCredential, createVerifier, decodeBitstringStatusList, decodeTokenStatusList, parseBundle, parseKeySet, tokenEntryStatus, verifyX509Svid } from '../src/verify/index.ts';
import { decodeJwt } from './support.ts';

const dir = new URL('./fixtures/live/', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, dir), 'utf8');
const manifest = JSON.parse(read('capture.json')) as { origin: string; capturedAtMs: number; agent: string; files: Record<string, { sha256: string; bytes: number; status: number }> };
const ORIGIN = manifest.origin;
const NOW = manifest.capturedAtMs;
const DAY_MS = 86_400_000;

function accepted<T>(result: Check<T>): T {
  if (!result.ok) throw new Error(`refused: ${result.rule}: ${result.detail}`);
  return result.value;
}

const keys = accepted(parseKeySet(JSON.parse(read('jwks.json'))));
const ctx = (kind: 'tsl' | 'bsl', nowMs = NOW) => ({ keys, issuer: ORIGIN, url: `${ORIGIN}/status/${kind}/0`, nowMs, leewaySeconds: 30 });
const tsl = () => accepted(decodeTokenStatusList(read('tsl-0.jwt').trim(), ctx('tsl')));
const bsl = () => accepted(decodeBitstringStatusList(read('bsl-0.jwt').trim(), ctx('bsl')));

/** A `fetch` that serves the captured files for the routes that the verifier reads. */
const fixtureFetch: typeof fetch = async (input) => {
  const files: Record<string, [string, string]> = {
    '/.well-known/jwks.json': ['jwks.json', 'application/json'],
    '/spiffe/bundle': ['bundle.json', 'application/json'],
    '/status/tsl/0': ['tsl-0.jwt', 'application/statuslist+jwt'],
    '/status/bsl/0': ['bsl-0.jwt', 'application/vc+jwt'],
  };
  const entry = files[new URL(String(input)).pathname];
  return entry === undefined ? new Response('not found', { status: 404 }) : new Response(read(entry[0]), { status: 200, headers: { 'content-type': entry[1] } });
};

describe('the captured files', () => {
  it('are the files of the capture: six files, each with the sha256 and the size that the manifest names, and a capture time', () => {
    expect(manifest.origin).toBe('https://id.vector.apexfusion.org');
    expect(Object.keys(manifest.files).sort()).toStrictEqual(['bsl-0.jwt', 'bundle.json', 'credential.jwt', 'jwks.json', 'metadata.json', 'tsl-0.jwt']);
    for (const [file, entry] of Object.entries(manifest.files)) {
      expect(entry.status, file).toBe(200);
      expect(createHash('sha256').update(read(file)).digest('hex'), `${file} changed since it was captured`).toBe(entry.sha256);
      expect(Buffer.byteLength(read(file))).toBe(entry.bytes);
    }
    expect(Number.isInteger(NOW) && NOW > Date.UTC(2026, 10, 1)).toBe(true);
  });
});

describe('the live metadata and keys', () => {
  it('the metadata names the delegation type, the grant type and the token endpoint that the package writes', () => {
    const metadata = JSON.parse(read('metadata.json')) as Record<string, unknown>;
    expect(metadata).toMatchObject({ issuer: ORIGIN, token_endpoint: `${ORIGIN}/token`, jwks_uri: `${ORIGIN}/.well-known/jwks.json` });
    expect(metadata.authorization_details_types_supported).toContain(DELEGATION_DETAILS_TYPE);
    expect(metadata.grant_types_supported).toContain(TOKEN_EXCHANGE_GRANT);
    expect(metadata.dpop_signing_alg_values_supported).toStrictEqual(expect.arrayContaining(['EdDSA', 'ES256']));
  });

  it('the key set has an Ed25519 key and a P-256 key, and the kid of each is the DID URL of the key', () => {
    expect([...keys.values()].map((k) => k.kind)).toStrictEqual(['Ed25519', 'P256']);
    for (const kid of keys.keys()) expect(kid).toMatch(/^did:vector:[0-9a-f]{64}#[0-9a-f]{56}$/);
  });

  it('the bundle has the CA of the trust domain, with the key of the gateway, and the key for JWT-SVIDs', () => {
    const bundle = accepted(parseBundle(JSON.parse(read('bundle.json'))));
    expect(bundle.refreshHintSeconds).toBe(300);
    expect(bundle.authorities).toHaveLength(1);
    const ca = bundle.authorities[0]!;
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe('O=id.vector.apexfusion.org');
    expect(ca.issuer).toBe('O=id.vector.apexfusion.org');
    expect(ca.verify(ca.publicKey)).toBe(true);
    const p256 = [...keys.values()].find((k) => k.kind === 'P256')!;
    expect(ca.publicKey.export({ format: 'jwk' })).toMatchObject({ x: (p256.jwk as { x: string }).x, y: (p256.jwk as { y: string }).y });
    expect([...bundle.jwtKeys.keys()]).toStrictEqual([p256.kid]);
  });

  it('the CA certificate that the live gateway made is read as exactly one certificate in each form: it is refused for what it is (x509.ca), not as malformed, and a byte after it is malformed', () => {
    const json = JSON.parse(read('bundle.json')) as { keys: Array<{ use: string; x5c?: string[] }> };
    const base64 = json.keys.find((k) => k.use === 'x509-svid')!.x5c![0]!;
    const der = Buffer.from(base64, 'base64');
    const context = { bundle: accepted(parseBundle(json)), trustDomain: new URL(ORIGIN).hostname, nowMs: NOW, leewaySeconds: 30 };
    const pem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    for (const form of [der, new Uint8Array(der), base64, pem]) expect(verifyX509Svid(form, context)).toMatchObject({ ok: false, rule: 'x509.ca' });
    expect(verifyX509Svid(Buffer.concat([der, Buffer.from([0])]), context)).toMatchObject({ ok: false, rule: 'x509.malformed' });
  });
});

describe('the live status lists', () => {
  it('both lists read at the time of the capture: the signature, the issuer, the URL, one hour of validity, 131,072 entries and the ttl of 60 seconds', () => {
    expect(tsl()).toMatchObject({ size: LIST_SIZE, bitsPerEntry: 2, ttlSeconds: 60 });
    expect(tsl().expiresAt - tsl().issuedAt).toBe(3_600_000);
    expect(bsl()).toMatchObject({ size: 2 * LIST_SIZE, purposes: ['revocation', 'suspension'], ttlMs: 60_000 });
    expect(bsl().validUntil - bsl().validFrom).toBe(3_600_000);
  });

  it('the two formats say the same of every position: a value of 1 is the revocation bit, a value of 2 is the suspension bit, and the lists are not empty', () => {
    const token = tsl();
    const bits = bsl();
    let revoked = 0;
    let suspended = 0;
    for (let p = 0; p < LIST_SIZE; p++) {
      const fromToken = accepted(tokenEntryStatus(token, p));
      const fromBits = accepted(bitstringEntryStatus(bits, p));
      if (fromToken !== fromBits) throw new Error(`position ${p}: ${fromToken} in the Token Status List and ${fromBits} in the Bitstring Status List`);
      if (fromToken === 'revoked') revoked++;
      if (fromToken === 'suspended') suspended++;
    }
    expect(revoked).toBeGreaterThan(0);
    expect(suspended).toBeGreaterThan(0);
  });

  it('a list is over after its hour: list.expired at 2 hours and list.time before the start', () => {
    expect(decodeTokenStatusList(read('tsl-0.jwt').trim(), ctx('tsl', NOW + 2 * 3_600_000))).toMatchObject({ ok: false, rule: 'list.expired' });
    expect(decodeBitstringStatusList(read('bsl-0.jwt').trim(), ctx('bsl', NOW + 2 * 3_600_000))).toMatchObject({ ok: false, rule: 'list.expired' });
    expect(decodeTokenStatusList(read('tsl-0.jwt').trim(), ctx('tsl', NOW - 3_600_000))).toMatchObject({ ok: false, rule: 'list.time' });
  });

  it('a list for another URL, and a list with a changed byte, are refused', () => {
    expect(decodeTokenStatusList(read('tsl-0.jwt').trim(), { ...ctx('tsl'), url: `${ORIGIN}/status/tsl/1` })).toMatchObject({ ok: false, rule: 'list.subject' });
    const [h, p, s] = read('tsl-0.jwt').trim().split('.');
    const claims = decodeJwt(read('tsl-0.jwt').trim()).payload;
    const changed = `${h}.${b64url(JSON.stringify({ ...claims, ttl: 61 }))}.${s}`;
    expect(decodeTokenStatusList(changed, ctx('tsl'))).toMatchObject({ ok: false, rule: 'list.signature' });
    expect(p!.length).toBeGreaterThan(10);
  });
});

describe('the live credential', () => {
  const jwt = (): string => read('credential.jwt').trim();
  const credentialCtx = (nowMs = NOW) => ({ keys, issuer: ORIGIN, nowMs, leewaySeconds: 30, subject: `did:vector:${manifest.agent}` });

  it('reads at the time of the capture: the subject, the issuer, one day of validity, and the two entries at p and 131,072 + p in list 0', () => {
    const verified = accepted(checkCredential(jwt(), credentialCtx()));
    expect(verified).toMatchObject({ did: `did:vector:${manifest.agent}`, origin: 'adopted', parent: null, status: { list: `${ORIGIN}/status/bsl/0` } });
    expect(verified.issuer).toBe([...keys.keys()][1]!.split('#')[0]);
    expect(verified.validUntil - verified.validFrom).toBe(DAY_MS);
    expect(verified.validFrom).toBeLessThanOrEqual(NOW);
    const entries = decodeJwt(jwt()).payload.credentialStatus as Array<{ statusListIndex: string; statusPurpose: string }>;
    expect(entries.map((e) => [e.statusPurpose, e.statusListIndex])).toStrictEqual([['revocation', String(verified.status.position)], ['suspension', String(LIST_SIZE + verified.status.position)]]);
  });

  it('the agent of the credential is Active in both lists, as the credential says', () => {
    const { position } = accepted(checkCredential(jwt(), credentialCtx())).status;
    expect(accepted(tokenEntryStatus(tsl(), position))).toBe('valid');
    expect(accepted(bitstringEntryStatus(bsl(), position))).toBe('valid');
  });

  it('a credential that anybody changed is refused (credential.signature), and a credential about another agent than the one asked for is refused', () => {
    const [h, , s] = jwt().split('.');
    const claims = decodeJwt(jwt()).payload as { credentialSubject: Record<string, unknown> };
    const changed = `${h}.${b64url(JSON.stringify({ ...claims, credentialSubject: { ...claims.credentialSubject, origin: 'registered' } }))}.${s}`;
    expect(checkCredential(changed, credentialCtx())).toMatchObject({ ok: false, rule: 'credential.signature' });
    expect(checkCredential(jwt(), { ...credentialCtx(), subject: `did:vector:${'a'.repeat(64)}` })).toMatchObject({ ok: false, rule: 'credential.subject' });
  });

  it('is over after its day: credential.expired at 25 hours, and credential.not_yet_valid before it was issued', () => {
    expect(checkCredential(jwt(), credentialCtx(NOW + DAY_MS + 3_600_000))).toMatchObject({ ok: false, rule: 'credential.expired' });
    expect(checkCredential(jwt(), credentialCtx(NOW - 3_600_000))).toMatchObject({ ok: false, rule: 'credential.not_yet_valid' });
  });

  it('the verifier, with the captured files as the gateway, accepts the credential and reads its list; two hours later the list is over, so the credential is refused for credential.status_unknown', async () => {
    let now = NOW;
    const verifier = createVerifier({ baseUrl: ORIGIN, fetch: fixtureFetch, now: () => now });
    const first = accepted(await verifier.credential(jwt(), { subject: `did:vector:${manifest.agent}` }));
    expect(first.listStatus).toMatchObject({ read: true, list: `${ORIGIN}/status/bsl/0` });
    now = NOW + 2 * 3_600_000;
    expect(await verifier.credential(jwt())).toMatchObject({ ok: false, rule: 'credential.status_unknown' });
    now = NOW + DAY_MS + 3_600_000;
    expect(await verifier.credential(jwt())).toMatchObject({ ok: false, rule: 'credential.expired' });
  });
});
