// packages/id-kit/test/verify-documents.test.ts: the checks of the documents that the gateway publishes: the key set and the bundle, both status list formats, the X.509-SVID, the JWT-SVID
// and the identity credential. Each rule has a refusal and an accepted twin. A document with a defect is signed with the key of the stub gateway, which the test holds.
import { describe, expect, it } from 'vitest';
import { X509Certificate, randomBytes } from 'node:crypto';
import { deflateSync, gzipSync } from 'node:zlib';
import { LIST_SIZE } from '../src/common/constants.ts';
import { resolveKey } from '../src/common/keys.ts';
import type { Check } from '../src/common/result.ts';
import { identifier, LISTS_UNAVAILABLE, p256Key, type StubGateway } from '../src/testing/index.ts';
import { bitString, boolean, children, decode, ecdsaSignatureDer, explicit, implicitPrimitive, octetString, oid, sequence, time, unsignedInteger, utf8String } from '../src/vendored/m4/der.ts';
import { b64url, signJws } from '../src/vendored/m4/jose.ts';
import {
  BUNDLE_RULES, CREDENTIAL_CALL_RULES, CREDENTIAL_RULES, JWT_SVID_RULES, KEY_SET_RULES, STATUS_LIST_RULES, X509_SVID_RULES, bitstringEntryStatus, checkCredential, createVerifier, decodeBitstringStatusList,
  decodeTokenStatusList, parseBundle, parseKeySet, tokenEntryStatus, verifyJwtSvid, verifyX509Svid, type KeySet, type SpiffeBundle,
} from '../src/verify/index.ts';
import { decodeJwt, repeatsCredential, world, type World } from './support.ts';

/** The rules that the tests of this file saw refused. The last test checks each rule of these documents is in it. */
const seen = new Set<string>();
function refused(result: Check<unknown>, rule: string): void {
  expect(result.ok, `refused by ${rule}`).toBe(false);
  if (!result.ok) {
    expect(result.rule).toBe(rule);
    seen.add(rule);
  }
}
function accepted<T>(result: Check<T>): T {
  if (!result.ok) throw new Error(`refused: ${result.rule}: ${result.detail}`);
  return result.value;
}

const get = async (gateway: StubGateway, path: string): Promise<string> => (await gateway.fetch(`${gateway.baseUrl}${path}`)).text();
const keysOf = async (gateway: StubGateway): Promise<KeySet> => accepted(parseKeySet(JSON.parse(await get(gateway, '/.well-known/jwks.json'))));
const bundleOf = async (gateway: StubGateway): Promise<SpiffeBundle> => accepted(parseBundle(JSON.parse(await get(gateway, '/spiffe/bundle'))));
const signer = (gateway: StubGateway) => resolveKey(gateway.keys.p256.privateKey);
const kid = (gateway: StubGateway) => `${gateway.gatewayDid}#${gateway.keys.p256.keyHash}`;
const sign = (gateway: StubGateway, header: Record<string, unknown>, claims: unknown) => signJws({ alg: 'ES256', kid: kid(gateway), ...header }, claims, signer(gateway));

/** The claims of a JWS, changed by `mutate`, and signed again by the key of the gateway. */
async function forged(gateway: StubGateway, jwt: string, mutate: (claims: Record<string, unknown>) => void, header: Record<string, unknown> = {}): Promise<string> {
  const { header: original, payload } = decodeJwt(jwt);
  const claims = structuredClone(payload);
  mutate(claims);
  return signJws({ ...original, ...header }, claims, signer(gateway));
}

// ── the key set and the bundle ──

describe('parseKeySet', () => {
  const ed = { kty: 'OKP', crv: 'Ed25519', x: 'xyCvuPYfgS8K-I1FoJn7uYBJW_924jBte9ALE9DkOJE', kid: 'k1', alg: 'EdDSA', use: 'sig' };
  it('reads the keys of the gateway, and ignores a key of another type, a key for another use, a key with no kid, and a key whose alg is not the one of its type', async () => {
    const { gateway } = world();
    const keys = accepted(parseKeySet(JSON.parse(await get(gateway, '/.well-known/jwks.json'))));
    expect([...keys.keys()]).toStrictEqual([kid(gateway).replace(gateway.keys.p256.keyHash, gateway.keys.ed25519.keyHash), kid(gateway)]);
    const mixed = accepted(parseKeySet({ keys: [{ kty: 'RSA', n: 'x', e: 'AQAB', kid: 'rsa' }, { ...ed, use: 'enc', kid: 'enc' }, { ...ed, kid: undefined }, { ...ed, alg: 'ES256', kid: 'wrong alg' }, ed] }));
    expect([...mixed.keys()]).toStrictEqual(['k1']);
  });
  it.each<[string, unknown, string]>([
    ['not an object', 'x', 'jwks.malformed'],
    ['no keys list', {}, 'jwks.malformed'],
    ['an entry that is not an object', { keys: [1] }, 'jwks.malformed'],
    ['a private member', { keys: [{ ...ed, d: 'AAAA' }] }, 'jwks.private_key'],
    ['two keys with one kid', { keys: [ed, ed] }, 'jwks.malformed'],
    ['no key that can be used', { keys: [{ kty: 'RSA', n: 'x', e: 'AQAB', kid: 'rsa' }] }, 'jwks.no_usable_key'],
  ])('refuses a key set that is %s', (_name, value, rule) => refused(parseKeySet(value), rule));
});

describe('parseBundle', () => {
  it('reads the bundle of the gateway: the sequence, the hint, the CA certificate of the authority and the key for JWT-SVIDs', async () => {
    const { gateway } = world();
    const bundle = await bundleOf(gateway);
    expect(bundle).toMatchObject({ sequence: Math.floor(gateway.now() / 1000), refreshHintSeconds: 300 });
    expect(bundle.authorities).toHaveLength(1);
    expect(bundle.authorities[0]!.ca).toBe(true);
    expect([...bundle.jwtKeys.keys()]).toStrictEqual([kid(gateway)]);
  });
  it.each<[string, (b: { keys: Array<Record<string, unknown>> }) => unknown]>([
    ['not an object with keys', () => 'x'],
    ['a key that is not an object', () => ({ keys: [1] })],
    ['a key for X.509-SVIDs with no x5c', (b) => ({ keys: [{ ...b.keys[0], x5c: undefined }] })],
    ['an x5c that is no certificate', (b) => ({ keys: [{ ...b.keys[0], x5c: ['AAAA'] }] })],
    ['a certificate that is not the key of its JWK', (b) => ({ keys: [{ ...b.keys[0], x: 'AAAA' }] })],
    ['a key for JWT-SVIDs with no kid', (b) => ({ keys: [{ ...b.keys[1], kid: undefined }] })],
  ])('refuses a bundle with %s', async (_name, change) => {
    const { gateway } = world();
    refused(parseBundle(change(JSON.parse(await get(gateway, '/spiffe/bundle')))), 'bundle.malformed');
  });
});

// ── the status lists ──

describe('status lists', () => {
  async function lists(w: World) {
    const { gateway } = w;
    const url = (kind: 'tsl' | 'bsl') => `${gateway.baseUrl}/status/${kind}/0`;
    const ctx = async (kind: 'tsl' | 'bsl') => ({ keys: await keysOf(gateway), issuer: gateway.baseUrl, url: url(kind), nowMs: gateway.now(), leewaySeconds: 30 });
    return { tsl: await get(gateway, '/status/tsl/0'), bsl: await get(gateway, '/status/bsl/0'), ctx, url };
  }

  it('both formats give the status of each agent: Active, Suspended, Revoked and Retired, and a subagent of a suspended parent, with a position in list 1 too', async () => {
    const w = world();
    const { gateway } = w;
    const agents = [
      gateway.createAgent({ label: 'sl active' }), gateway.createAgent({ label: 'sl suspended', status: 'suspended' }), gateway.createAgent({ label: 'sl revoked', status: 'revoked' }),
      gateway.createAgent({ label: 'sl retired', status: 'retired' }),
    ];
    const child = gateway.createAgent({ label: 'sl child', parent: agents[1]! });
    const far = gateway.createAgent({ label: 'sl far', statusIndex: LIST_SIZE + 5, status: 'suspended' });
    const expected = ['valid', 'suspended', 'revoked', 'revoked', 'suspended'] as const;
    const l = await lists(w);
    const tsl = accepted(decodeTokenStatusList(l.tsl, await l.ctx('tsl')));
    const bsl = accepted(decodeBitstringStatusList(l.bsl, await l.ctx('bsl')));
    expect(tsl).toMatchObject({ size: LIST_SIZE, bitsPerEntry: 2, ttlSeconds: 60, issuedAt: gateway.now(), expiresAt: gateway.now() + 3_600_000 });
    expect(bsl).toMatchObject({ size: 2 * LIST_SIZE, purposes: ['revocation', 'suspension'], ttlMs: 60_000, validFrom: gateway.now(), validUntil: gateway.now() + 3_600_000 });
    [...agents, child].forEach((agent, i) => {
      expect(accepted(tokenEntryStatus(tsl, agent.index)), `TSL ${agent.name}`).toBe(expected[i]);
      expect(accepted(bitstringEntryStatus(bsl, agent.index)), `BSL ${agent.name}`).toBe(expected[i]);
    });
    expect(accepted(tokenEntryStatus(tsl, 100))).toBe('valid');
    const second = { tsl: await get(gateway, '/status/tsl/1'), bsl: await get(gateway, '/status/bsl/1') };
    const ctx1 = async (kind: 'tsl' | 'bsl') => ({ ...(await l.ctx(kind)), url: `${gateway.baseUrl}/status/${kind}/1` });
    expect(accepted(tokenEntryStatus(accepted(decodeTokenStatusList(second.tsl, await ctx1('tsl'))), far.index - LIST_SIZE))).toBe('suspended');
    expect(accepted(bitstringEntryStatus(accepted(decodeBitstringStatusList(second.bsl, await ctx1('bsl'))), far.index - LIST_SIZE))).toBe('suspended');
  });

  it('the last position of a list (131,071) is read in both formats: the entry of the Token Status List, and the suspension bit at 262,143 of the Bitstring Status List', async () => {
    const w = world();
    const { gateway } = w;
    const revoked = gateway.createAgent({ label: 'sl second to last', statusIndex: LIST_SIZE - 2, status: 'revoked' });
    const suspended = gateway.createAgent({ label: 'sl last', statusIndex: LIST_SIZE - 1, status: 'suspended' });
    const l = await lists(w);
    const tsl = accepted(decodeTokenStatusList(l.tsl, await l.ctx('tsl')));
    const bsl = accepted(decodeBitstringStatusList(l.bsl, await l.ctx('bsl')));
    const positions = [LIST_SIZE - 3, revoked.index, suspended.index];
    expect(positions.map((p) => accepted(tokenEntryStatus(tsl, p)))).toStrictEqual(['valid', 'revoked', 'suspended']);
    expect(positions.map((p) => accepted(bitstringEntryStatus(bsl, p)))).toStrictEqual(['valid', 'revoked', 'suspended']);
    expect(bsl.bit(2 * LIST_SIZE - 1)).toBe(true);
    refused(tokenEntryStatus(tsl, LIST_SIZE), 'list.index');
    refused(bitstringEntryStatus(bsl, LIST_SIZE), 'list.index');
  });

  it('the entry lookups: a position that the list does not have is list.index, a value that the gateway never writes is list.value, a list that names one purpose only is list.malformed, and revocation wins', async () => {
    const w = world();
    w.gateway.createAgent({ label: 'sl lookups' });
    const l = await lists(w);
    const tsl = accepted(decodeTokenStatusList(l.tsl, await l.ctx('tsl')));
    const bsl = accepted(decodeBitstringStatusList(l.bsl, await l.ctx('bsl')));
    refused(tokenEntryStatus(tsl, LIST_SIZE), 'list.index');
    refused(tokenEntryStatus(tsl, -1), 'list.index');
    refused(tokenEntryStatus(tsl, 1.5), 'list.index');
    refused(bitstringEntryStatus(bsl, LIST_SIZE), 'list.index');
    refused(bitstringEntryStatus(bsl, -1), 'list.index');
    refused(bitstringEntryStatus({ ...bsl, purposes: ['revocation'] }, 0), 'list.malformed');
    refused(tokenEntryStatus({ ...tsl, value: () => 3 }, 0), 'list.value');
    expect(accepted(bitstringEntryStatus({ ...bsl, bit: () => true }, 0))).toBe('revoked');
    expect(() => tsl.value(LIST_SIZE)).toThrow(RangeError);
    expect(() => bsl.bit(2 * LIST_SIZE)).toThrow(RangeError);
  });

  /** A Token Status List and a Bitstring Status List with a wrong part, signed by the key of the gateway. */
  const tokenCases: Array<[string, (c: Record<string, unknown>, now: number) => void, Record<string, unknown>?]> = [
    ['list.alg', () => undefined, { alg: 'HS256' }],
    ['list.alg', () => undefined, { alg: 'none' }],
    ['list.typ', () => undefined, { typ: 'JWT' }],
    ['list.kid', () => undefined, { kid: `did:vector:${'a'.repeat(64)}#${'b'.repeat(56)}` }],
    ['list.issuer', (c) => (c.iss = 'https://evil.example')],
    ['list.subject', (c) => (c.sub = 'https://id.vector.apexfusion.org/status/tsl/9')],
    ['list.malformed', (c) => delete c.iat],
    ['list.malformed', (c) => (c.status_list = 'x')],
    ['list.time', (c, now) => ((c.iat = now / 1000 + 100), (c.exp = now / 1000 + 3700))],
    ['list.expired', (c, now) => ((c.iat = now / 1000 - 7200), (c.exp = now / 1000 - 3600))],
    ['list.encoding', (c) => (c.status_list = { bits: 3, lst: 'AAAA' })],
    ['list.encoding', (c) => (c.status_list = { bits: 2, lst: 'not base64url!' })],
    ['list.encoding', (c) => (c.status_list = { bits: 2, lst: b64url(Buffer.from('not zlib')) })],
    ['list.encoding', (c) => (c.status_list = { bits: 2, lst: b64url(deflateSync(Buffer.alloc(2_000_000))) })],
  ];
  it.each(tokenCases)('refuses a Token Status List with a wrong part: %s', async (rule, mutate, header) => {
    const w = world();
    w.gateway.createAgent({ label: 'sl token cases' });
    const l = await lists(w);
    const bad = await forged(w.gateway, l.tsl, (c) => mutate(c, w.gateway.now()), header);
    refused(decodeTokenStatusList(bad, await l.ctx('tsl')), rule);
    accepted(decodeTokenStatusList(await forged(w.gateway, l.tsl, () => undefined), await l.ctx('tsl')));
  });

  const bitstringCases: Array<[string, (c: Record<string, unknown> & { credentialSubject: Record<string, unknown> }, now: number) => void]> = [
    ['list.malformed', (c) => (c['@context'] = ['https://example.org'])],
    ['list.malformed', (c) => (c.type = ['VerifiableCredential'])],
    ['list.malformed', (c) => (c.validFrom = 'yesterday')],
    ['list.malformed', (c) => (c.credentialSubject.type = 'Other')],
    ['list.malformed', (c) => (c.credentialSubject.statusPurpose = [])],
    ['list.subject', (c) => (c.id = 'https://id.vector.apexfusion.org/status/bsl/9')],
    ['list.issuer', (c) => (c.issuer = `did:vector:${'a'.repeat(64)}`)],
    ['list.time', (c, now) => (c.validFrom = new Date(now + 3_600_000).toISOString().replace('.000Z', 'Z'))],
    ['list.expired', (c, now) => ((c.validFrom = new Date(now - 7_200_000).toISOString().replace('.000Z', 'Z')), (c.validUntil = new Date(now - 3_600_000).toISOString().replace('.000Z', 'Z')))],
    ['list.encoding', (c) => (c.credentialSubject.encodedList = 'AAAA')],
    ['list.encoding', (c) => (c.credentialSubject.encodedList = `u${b64url(gzipSync(Buffer.alloc(100)))}`)],
    ['list.encoding', (c) => (c.credentialSubject.encodedList = `u${b64url(Buffer.from('not gzip'))}`)],
  ];
  it.each(bitstringCases)('refuses a Bitstring Status List with a wrong part: %s', async (rule, mutate) => {
    const w = world();
    w.gateway.createAgent({ label: 'sl bitstring cases' });
    const l = await lists(w);
    const bad = await forged(w.gateway, l.bsl, (c) => mutate(c as never, w.gateway.now()));
    refused(decodeBitstringStatusList(bad, await l.ctx('bsl')), rule);
    accepted(decodeBitstringStatusList(await forged(w.gateway, l.bsl, () => undefined), await l.ctx('bsl')));
  });

  it('a list whose signature does not verify, a text that is no JWS, and a list for the other format are refused', async () => {
    const w = world();
    w.gateway.createAgent({ label: 'sl signature' });
    const l = await lists(w);
    const [h, p] = l.tsl.split('.');
    refused(decodeTokenStatusList(`${h}.${p}.${b64url(Buffer.alloc(64))}`, await l.ctx('tsl')), 'list.signature');
    refused(decodeTokenStatusList('garbage', await l.ctx('tsl')), 'list.malformed');
    refused(decodeTokenStatusList(l.bsl, await l.ctx('tsl')), 'list.typ');
    refused(decodeBitstringStatusList(l.tsl, await l.ctx('bsl')), 'list.typ');
    refused(decodeTokenStatusList(l.tsl, { ...(await l.ctx('tsl')), url: `${w.gateway.baseUrl}/status/tsl/1` }), 'list.subject');
  });

  it('the time of a list: it is over after the hour and the leeway, not before', async () => {
    const w = world();
    w.gateway.createAgent({ label: 'sl time' });
    const l = await lists(w);
    const at = async (ms: number) => ({ ...(await l.ctx('tsl')), nowMs: w.gateway.now() + ms });
    accepted(decodeTokenStatusList(l.tsl, await at(3_600_000 + 29_000)));
    refused(decodeTokenStatusList(l.tsl, await at(3_600_000 + 31_000)), 'list.expired');
    accepted(decodeTokenStatusList(l.tsl, await at(-29_000)));
    refused(decodeTokenStatusList(l.tsl, await at(-31_000)), 'list.time');
  });
});

// ── the X.509-SVID ──

/** A leaf certificate that the key of the stub gateway signs under the CA of the bundle, with the parts that a test changes. */
async function leaf(gateway: StubGateway, options: { keyUsage?: number | null; uris?: string[]; ca?: boolean; notBefore?: number; notAfter?: number; carries?: string } = {}): Promise<string> {
  const bundle = await bundleOf(gateway);
  const caFields = children(children(decode(Buffer.from(bundle.authorities[0]!.raw)))[0]!);
  const agentId = identifier('x509 leaf agent');
  const now = gateway.now();
  const key = p256Key();
  const extension = (id: string, critical: boolean, value: Buffer) => sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
  const usage = options.keyUsage === undefined ? 0x80 : options.keyUsage;
  const unused = usage === null || usage === 0 ? 0 : Math.min(7, Math.clz32(usage & -usage) ^ 31);
  const tbs = sequence(
    explicit(0, unsignedInteger(Uint8Array.of(2))),
    unsignedInteger(Buffer.concat([Buffer.from([1]), randomBytes(7)])),
    sequence(oid('1.2.840.10045.4.3.2')),
    caFields[5]!.bytes,
    sequence(time(options.notBefore ?? now - 60_000), time(options.notAfter ?? now + 3_540_000)),
    sequence(),
    Buffer.from(key.publicKey.export({ format: 'der', type: 'spki' })),
    explicit(
      3,
      sequence(
        extension('2.5.29.19', true, options.ca ? sequence(boolean(true)) : sequence()),
        ...(usage === null ? [] : [extension('2.5.29.15', true, bitString(Uint8Array.of(usage), unused))]),
        extension('2.5.29.17', true, sequence(...(options.uris ?? [`spiffe://${gateway.trustDomain}/agent/${agentId}`]).map((u) => implicitPrimitive(6, Buffer.from(u, 'ascii'))))),
        ...(options.carries === undefined ? [] : [extension('1.3.6.1.4.1.99999.1', false, utf8String(options.carries))]),
      ),
    ),
  );
  const der = sequence(tbs, sequence(oid('1.2.840.10045.4.3.2')), bitString(ecdsaSignatureDer(await signer(gateway).sign(tbs))));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

describe('verifyX509Svid', () => {
  const contextOf = async (gateway: StubGateway, nowMs = gateway.now()) => ({ bundle: await bundleOf(gateway), trustDomain: gateway.trustDomain, nowMs, leewaySeconds: 30 });

  it('accepts the X.509-SVID that the gateway issued, as PEM, as base64 of its DER and as DER bytes, with the SPIFFE ID, the agent and the times', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'x509 verify' });
    const issued = await client.x509Svid({ agent: { did: agent.did, key: agent.authentication.privateKey } });
    if (!issued.ok) throw new Error(issued.detail);
    const certificate = new X509Certificate(issued.value.certificate);
    const ctx = await contextOf(gateway);
    const verified = accepted(verifyX509Svid(issued.value.certificate, ctx));
    expect(verified).toMatchObject({ spiffeId: `spiffe://${gateway.trustDomain}/agent/${agent.id}`, trustDomain: gateway.trustDomain, agentId: agent.id, did: agent.did, fingerprint256: certificate.fingerprint256 });
    expect(verified.notAfter - verified.notBefore).toBe(3_600_000);
    expect(accepted(verifyX509Svid(Buffer.from(certificate.raw).toString('base64'), ctx))).toStrictEqual(verified);
    expect(accepted(verifyX509Svid(certificate.raw, ctx))).toStrictEqual(verified);
  });

  it('the certificate that the test writes by hand is accepted when it is right (the twin of each refusal below)', async () => {
    const { gateway } = world();
    expect(accepted(verifyX509Svid(await leaf(gateway), await contextOf(gateway))).trustDomain).toBe(gateway.trustDomain);
  });

  it.each<[string, Parameters<typeof leaf>[1]]>([
    ['x509.key_usage', { keyUsage: 0x84 }],
    ['x509.key_usage', { keyUsage: 0x82 }],
    ['x509.key_usage', { keyUsage: 0x40 }],
    ['x509.key_usage', { keyUsage: 0x20 }],
    ['x509.key_usage', { keyUsage: null }],
    ['x509.ca', { ca: true }],
    ['x509.san', { uris: [] }],
    ['x509.san', { uris: ['spiffe://id.vector.apexfusion.org/agent/' + 'a'.repeat(64), 'spiffe://id.vector.apexfusion.org/agent/' + 'b'.repeat(64)] }],
    ['x509.spiffe_id', { uris: ['https://id.vector.apexfusion.org/agent/' + 'a'.repeat(64)] }],
    ['x509.spiffe_id', { uris: ['spiffe://id.vector.apexfusion.org/other/' + 'a'.repeat(64)] }],
    ['x509.spiffe_id', { uris: ['spiffe://id.vector.apexfusion.org/agent/abc'] }],
    ['x509.trust_domain', { uris: ['spiffe://other.example/agent/' + 'a'.repeat(64)] }],
  ])('refuses a certificate with a wrong part: %s', async (rule, options) => {
    const { gateway } = world();
    refused(verifyX509Svid(await leaf(gateway, options), await contextOf(gateway)), rule);
  });

  it('the validity of the certificate: not yet valid, and over; the leeway of 30 seconds counts for the start only', async () => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    const now = gateway.now();
    refused(verifyX509Svid(await leaf(gateway, { notBefore: now + 600_000, notAfter: now + 4_200_000 }), ctx), 'x509.not_yet_valid');
    accepted(verifyX509Svid(await leaf(gateway, { notBefore: now + 29_000, notAfter: now + 3_600_000 }), ctx));
    refused(verifyX509Svid(await leaf(gateway, { notBefore: now + 31_000, notAfter: now + 3_600_000 }), ctx), 'x509.not_yet_valid');
    refused(verifyX509Svid(await leaf(gateway, { notBefore: now - 7_200_000, notAfter: now - 3_600_000 }), ctx), 'x509.expired');
    refused(verifyX509Svid(await leaf(gateway, { notBefore: now - 7_200_000, notAfter: now }), ctx), 'x509.expired');
  });

  it('a certificate that is not an X.509 certificate, and a certificate that the gateway did not sign, are refused: x509.malformed and x509.untrusted', async () => {
    const w = world();
    const ctx = await contextOf(w.gateway);
    refused(verifyX509Svid('not a certificate', ctx), 'x509.malformed');
    refused(verifyX509Svid(new Uint8Array([1, 2, 3]), ctx), 'x509.malformed');
    const otherClient = world({ baseUrl: 'https://id.other.example' });
    const foreignAgent = otherClient.gateway.createAgent({ label: 'x509 foreign' });
    const issued = await otherClient.client.x509Svid({ agent: { did: foreignAgent.did, key: foreignAgent.authentication.privateKey } });
    if (!issued.ok) throw new Error(issued.detail);
    refused(verifyX509Svid(issued.value.certificate, ctx), 'x509.untrusted');
    // The same certificate, with the authority of its own trust domain in the bundle too: the trust domain is then what refuses it (a federation of two bundles).
    const merged = accepted(parseBundle({ keys: [...JSON.parse(await get(w.gateway, '/spiffe/bundle')).keys, ...JSON.parse(await get(otherClient.gateway, '/spiffe/bundle')).keys.filter((k: { use: string }) => k.use === 'x509-svid')] }));
    refused(verifyX509Svid(issued.value.certificate, { ...ctx, bundle: merged }), 'x509.trust_domain');
    accepted(verifyX509Svid(issued.value.certificate, { ...ctx, bundle: merged, trustDomain: 'id.other.example' }));
  });

  it('a bundle with no authority, or with an authority that is not valid now, gives x509.bundle; the CA certificate itself is no SVID: x509.ca', async () => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    refused(verifyX509Svid(await leaf(gateway), { ...ctx, bundle: { ...ctx.bundle, authorities: [] } }), 'x509.bundle');
    refused(verifyX509Svid(await leaf(gateway), { ...ctx, nowMs: gateway.now() - 600_000 }), 'x509.bundle');
    refused(verifyX509Svid(ctx.bundle.authorities[0]!.raw, ctx), 'x509.ca');
  });

  it('a certificate whose signature was changed is refused: the key of the authority must verify the signature (x509.untrusted)', async () => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    const der = Buffer.from(new X509Certificate(await leaf(gateway)).raw);
    accepted(verifyX509Svid(der, ctx));
    const changed = Buffer.from(der);
    changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 0x01, changed.length - 1);
    refused(verifyX509Svid(changed, ctx), 'x509.untrusted');
  });

  it('an authority that is no CA does not count: a certificate with the name and the key of the CA and no CA flag gives x509.bundle', async () => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    const caFields = children(children(decode(Buffer.from(ctx.bundle.authorities[0]!.raw)))[0]!);
    const now = gateway.now();
    const tbs = sequence(
      explicit(0, unsignedInteger(Uint8Array.of(2))),
      unsignedInteger(Uint8Array.of(7)),
      sequence(oid('1.2.840.10045.4.3.2')),
      caFields[5]!.bytes,
      sequence(time(now - 60_000), time(now + 3_540_000)),
      caFields[5]!.bytes,
      caFields[6]!.bytes,
      explicit(3, sequence(sequence(oid('2.5.29.19'), boolean(true), octetString(sequence())))),
    );
    const plain = new X509Certificate(sequence(tbs, sequence(oid('1.2.840.10045.4.3.2')), bitString(ecdsaSignatureDer(await signer(gateway).sign(tbs)))));
    expect(plain.ca).toBe(false);
    refused(verifyX509Svid(await leaf(gateway), { ...ctx, bundle: { ...ctx.bundle, authorities: [plain] } }), 'x509.bundle');
    accepted(verifyX509Svid(await leaf(gateway), ctx));
  });

  // The input is exactly one certificate. `X509Certificate` reads the first certificate that it finds and drops the rest, so each input of the refusals below passed for its first certificate.

  const derOf = (pem: string): Buffer => Buffer.from(new X509Certificate(pem).raw);

  interface Pieces {
    readonly pem: string;
    readonly otherPem: string;
    readonly der: Buffer;
    readonly otherDer: Buffer;
    /** The DER of a long certificate: its content is more than 65,535 bytes, so the length of its outer SEQUENCE takes 3 bytes, and its BER form with an indefinite length is one byte shorter. */
    readonly longDer: Buffer;
    /** The DER of the CA certificate of the bundle. */
    readonly ca: Buffer;
    readonly base64: string;
    readonly otherBase64: string;
  }

  /** Two certificates that the gateway signed, a long one, and the CA. The DER of the first has a length that is no multiple of 3, so its base64 text ends with a padding. */
  async function pieces(gateway: StubGateway): Promise<Pieces> {
    let pem = await leaf(gateway);
    for (let tries = 0; derOf(pem).length % 3 === 0 && tries < 40; tries++) pem = await leaf(gateway);
    const otherPem = await leaf(gateway, { uris: [`spiffe://${gateway.trustDomain}/agent/${identifier('x509 other agent')}`] });
    const der = derOf(pem);
    if (der.length % 3 === 0) throw new Error('no certificate with a padded base64 text');
    const otherDer = derOf(otherPem);
    const longDer = derOf(await leaf(gateway, { carries: 'A'.repeat(70_000) }));
    const ca = Buffer.from((await bundleOf(gateway)).authorities[0]!.raw);
    return { pem, otherPem, der, otherDer, longDer, ca, base64: der.toString('base64'), otherBase64: otherDer.toString('base64') };
  }

  /** The certificate with the indefinite length of BER on its outer SEQUENCE (`30 80 … 00 00`) in place of the definite length of DER. */
  const indefinite = (der: Buffer): Buffer => {
    const header = der[1]! & 0x80 ? 2 + (der[1]! & 0x7f) : 2;
    return Buffer.concat([Buffer.from([0x30, 0x80]), der.subarray(header), Buffer.from([0, 0])]);
  };
  const pemOf = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

  it('one certificate is accepted in each of its forms: a PEM block, base64 of the DER, DER bytes', async () => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    const p = await pieces(gateway);
    const verified = accepted(verifyX509Svid(p.pem, ctx));
    const forms: Array<[string, string | Uint8Array]> = [
      ['PEM with no line feed at the end', p.pem.trim()],
      ['PEM with blank lines around it', `\n\n${p.pem}\n\n`],
      ['PEM with CRLF line ends', p.pem.replace(/\n/g, '\r\n')],
      ['base64', p.base64],
      ['base64 with white space around it', ` ${p.base64}\n`],
      ['base64 in lines of 64 characters', p.base64.match(/.{1,64}/g)!.join('\n')],
      ['DER bytes (a Buffer)', p.der],
      ['DER bytes (a Uint8Array)', new Uint8Array(p.der)],
    ];
    for (const [name, input] of forms) expect(verifyX509Svid(input, ctx), name).toStrictEqual({ ok: true, value: verified });
  });

  it('nothing but white space may stand around the one PEM block: spaces and tabs before and after it are accepted', async () => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    const p = await pieces(gateway);
    const verified = accepted(verifyX509Svid(p.pem, ctx));
    expect(verifyX509Svid(`  \t${p.pem.trim()} \t \n`, ctx)).toStrictEqual({ ok: true, value: verified });
    refused(verifyX509Svid(`x ${p.pem.trim()}`, ctx), 'x509.malformed');
    refused(verifyX509Svid(`${p.pem.trim()} x`, ctx), 'x509.malformed');
  });

  it('Node reads a certificate with an indefinite outer length (30 80 … 00 00) and gives back its DER form: a short certificate is as long in BER as in DER, and a long one is one byte shorter (the premise of the BER rows below)', async () => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    const p = await pieces(gateway);
    const short = indefinite(p.der);
    const long = indefinite(p.longDer);
    expect(short.length, 'a short certificate: the BER form is as long as the DER form').toBe(p.der.length);
    expect(long.length + 1, 'a long certificate: the BER form is one byte shorter than the DER form').toBe(p.longDer.length);
    expect(new X509Certificate(short).raw.equals(p.der), 'Node reads the BER form of the short certificate and gives back its DER form').toBe(true);
    expect(new X509Certificate(long).raw.equals(p.longDer), 'Node reads the BER form of the long certificate and gives back its DER form').toBe(true);
    // The twin: the DER forms are accepted.
    accepted(verifyX509Svid(p.der, ctx));
    accepted(verifyX509Svid(p.longDer, ctx));
  });

  const notOne: Array<[string, (p: Pieces) => string | Uint8Array]> = [
    ['DER bytes and one more byte', (p) => Buffer.concat([p.der, Buffer.from([0])])],
    ['DER bytes and then a line feed', (p) => Buffer.concat([p.der, Buffer.from('\n')])],
    ['the DER bytes of two certificates one after the other', (p) => Buffer.concat([p.der, p.otherDer])],
    ['the DER bytes of a certificate and then of the CA that signed it', (p) => Buffer.concat([p.der, p.ca])],
    ['DER bytes with a byte before the certificate', (p) => Buffer.concat([Buffer.from([0]), p.der])],
    ['bytes that hold a PEM block after other bytes (the PEM reader of the runtime skips what comes before it)', (p) => Buffer.concat([Buffer.from('other bytes\n'), Buffer.from(p.pem)])],
    ['base64 of the DER bytes of two certificates', (p) => Buffer.concat([p.der, p.otherDer]).toString('base64')],
    ['the base64 text of a certificate and then the base64 text of another (the padding of the first ends what the decoder of the runtime reads)', (p) => p.base64 + p.otherBase64],
    ['base64 of a certificate and then characters that are no base64', (p) => `${p.base64}!!!!`],
    ['two PEM blocks', (p) => p.pem + p.otherPem],
    ['a PEM block and then text', (p) => `${p.pem}the rest of a file\n`],
    ['text and then a PEM block', (p) => `Bag Attributes\n${p.pem}`],
    ['a PEM block and then base64 of a certificate', (p) => `${p.pem}${p.otherBase64}`],
    ['one PEM block that holds the DER bytes of two certificates', (p) => pemOf(Buffer.concat([p.der, p.otherDer]))],
    ['a certificate with an indefinite outer length (30 80 … 00 00), as long as its DER form: DER bytes', (p) => indefinite(p.der)],
    ['a certificate with an indefinite outer length, as long as its DER form: base64', (p) => indefinite(p.der).toString('base64')],
    ['a certificate with an indefinite outer length, as long as its DER form: a PEM block', (p) => pemOf(indefinite(p.der))],
    ['a certificate with an indefinite outer length and one more byte', (p) => Buffer.concat([indefinite(p.der), Buffer.from([0x41])])],
    ['a long certificate with an indefinite outer length (one byte shorter than its DER form), alone', (p) => indefinite(p.longDer)],
    ['a long certificate with an indefinite outer length and one more byte, as long as its DER form: DER bytes', (p) => Buffer.concat([indefinite(p.longDer), Buffer.from([0x41])])],
    ['a long certificate with an indefinite outer length and one more byte, as long as its DER form: base64', (p) => Buffer.concat([indefinite(p.longDer), Buffer.from([0x41])]).toString('base64')],
    ['a long certificate with an indefinite outer length and one more byte, as long as its DER form: a PEM block', (p) => pemOf(Buffer.concat([indefinite(p.longDer), Buffer.from([0x41])]))],
  ];
  it.each(notOne)('refuses an input that is not exactly one certificate: %s (x509.malformed)', async (_name, make) => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    const p = await pieces(gateway);
    const result = verifyX509Svid(make(p), ctx);
    refused(result, 'x509.malformed');
    // The detail holds no part of the certificates.
    if (!result.ok) for (const held of [p.pem, p.base64, p.otherBase64]) expect(repeatsCredential(result.detail, held)).toBe(false);
    // The twin: the first certificate alone is accepted, so the refusal is for what comes with it.
    accepted(verifyX509Svid(p.pem, ctx));
  });

  it('a certificate that holds the PEM text of another certificate is refused: the PEM reader of the runtime reads the certificate in the text, so the bytes that it checks are not the bytes that came', async () => {
    const { gateway } = world();
    const ctx = await contextOf(gateway);
    const carried = await leaf(gateway, { uris: [`spiffe://${gateway.trustDomain}/agent/${identifier('x509 carried agent')}`] });
    const carrier = derOf(await leaf(gateway, { carries: `\n${carried}` }));
    // The twin: a certificate of the same kind that carries nothing is accepted.
    accepted(verifyX509Svid(await leaf(gateway), ctx));
    refused(verifyX509Svid(carrier, ctx), 'x509.malformed');
    refused(verifyX509Svid(carrier.toString('base64'), ctx), 'x509.malformed');
  });

  it('the verifier gives the same answers: verifier.x509Svid refuses two certificates in each form, and accepts the first one alone', async () => {
    const w = world();
    const verifier = createVerifier({ baseUrl: w.gateway.baseUrl, fetch: w.gateway.fetch, now: w.gateway.now });
    const p = await pieces(w.gateway);
    accepted(await verifier.x509Svid(p.pem));
    accepted(await verifier.x509Svid(p.base64));
    accepted(await verifier.x509Svid(p.der));
    refused(await verifier.x509Svid(p.pem + p.otherPem), 'x509.malformed');
    refused(await verifier.x509Svid(p.base64 + p.otherBase64), 'x509.malformed');
    refused(await verifier.x509Svid(Buffer.concat([p.der, p.otherDer])), 'x509.malformed');
  });
});

// ── the JWT-SVID ──

describe('verifyJwtSvid', () => {
  const AUD = 'https://mp-mock.example';
  async function setup() {
    const w = world();
    const agent = w.gateway.createAgent({ label: 'jwt svid verify' });
    const issued = await w.client.jwtSvid({ agent: { did: agent.did, key: agent.authentication.privateKey }, audience: AUD });
    if (!issued.ok) throw new Error(issued.detail);
    const ctx = { bundle: await bundleOf(w.gateway), trustDomain: w.gateway.trustDomain, nowMs: w.gateway.now(), leewaySeconds: 30, audience: AUD };
    return { ...w, agent, svid: issued.value.svid, ctx };
  }
  const cases: Array<[string, (c: Record<string, unknown>, now: number, td: string) => void, Record<string, unknown>?]> = [
    ['jwt_svid.alg', () => undefined, { alg: 'HS256' }],
    ['jwt_svid.alg', () => undefined, { alg: 'none' }],
    ['jwt_svid.typ', () => undefined, { typ: 'at+jwt' }],
    ['jwt_svid.kid', () => undefined, { kid: 'unknown' }],
    ['jwt_svid.claims', (c) => delete c.sub],
    ['jwt_svid.claims', (c) => delete c.jti],
    ['jwt_svid.claims', (c) => delete c.iat],
    ['jwt_svid.subject', (c) => (c.sub = 'https://id.vector.apexfusion.org/agent/x')],
    ['jwt_svid.trust_domain', (c) => (c.sub = `spiffe://other.example/agent/${'a'.repeat(64)}`)],
    ['jwt_svid.audience', (c) => (c.aud = 'https://other.example')],
    ['jwt_svid.audience', (c) => (c.aud = [])],
    ['jwt_svid.lifetime', (c) => (c.exp = Number(c.iat) + 301)],
    ['jwt_svid.expired', (c, now) => ((c.iat = now / 1000 - 400), (c.exp = now / 1000 - 100))],
    ['jwt_svid.not_yet_valid', (c, now) => ((c.iat = now / 1000 + 100), (c.exp = now / 1000 + 300))],
  ];
  it('accepts the JWT-SVID that the gateway issued: the SPIFFE ID, the agent, the audience and the times', async () => {
    const s = await setup();
    const verified = accepted(verifyJwtSvid(s.svid, s.ctx));
    expect(verified).toMatchObject({ spiffeId: `spiffe://${s.gateway.trustDomain}/agent/${s.agent.id}`, agentId: s.agent.id, did: s.agent.did, audience: [AUD], issuedAt: s.gateway.now(), expiresAt: s.gateway.now() + 300_000 });
  });
  it.each(cases)('refuses a JWT-SVID with a wrong part: %s', async (rule, mutate, header) => {
    const s = await setup();
    const bad = await forged(s.gateway, s.svid, (c) => mutate(c, s.gateway.now(), s.gateway.trustDomain), header);
    refused(verifyJwtSvid(bad, s.ctx), rule);
    accepted(verifyJwtSvid(await forged(s.gateway, s.svid, () => undefined), s.ctx));
  });
  it('refuses text that is no JWS, a JWT-SVID whose signature does not verify, and a token of another kind; it ends 30 seconds late at most', async () => {
    const s = await setup();
    refused(verifyJwtSvid('garbage', s.ctx), 'jwt_svid.malformed');
    const [h, p] = s.svid.split('.');
    refused(verifyJwtSvid(`${h}.${p}.${b64url(Buffer.alloc(64))}`, s.ctx), 'jwt_svid.signature');
    refused(verifyJwtSvid(await get(s.gateway, '/status/tsl/0'), s.ctx), 'jwt_svid.typ');
    accepted(verifyJwtSvid(s.svid, { ...s.ctx, nowMs: s.gateway.now() + 300_000 + 29_000 }));
    refused(verifyJwtSvid(s.svid, { ...s.ctx, nowMs: s.gateway.now() + 300_000 + 31_000 }), 'jwt_svid.expired');
  });
});

// ── the credential ──

describe('credentials', () => {
  async function setup(verifier: Partial<Parameters<typeof createVerifier>[0]> = {}) {
    const w = world();
    const agent = w.gateway.createAgent({ label: 'credential verify' });
    const issued = await w.client.credential(agent.did);
    if (!issued.ok) throw new Error(issued.detail);
    const ctx = { keys: await keysOf(w.gateway), issuer: w.gateway.baseUrl, nowMs: w.gateway.now(), leewaySeconds: 30, subject: null };
    return { ...w, agent, jwt: issued.value, ctx, verifier: createVerifier({ baseUrl: w.gateway.baseUrl, fetch: w.gateway.fetch, now: w.gateway.now, ...verifier }) };
  }

  it('accepts the credential that the gateway issued: the subject, the issuer, the times and the position of the agent in the list', async () => {
    const s = await setup();
    const verified = accepted(checkCredential(s.jwt, s.ctx));
    expect(verified).toMatchObject({ did: s.agent.did, agentId: s.agent.id, issuer: s.gateway.gatewayDid, validFrom: s.gateway.now(), validUntil: s.gateway.now() + 86_400_000, origin: 'registered', parent: null, status: { list: `${s.gateway.baseUrl}/status/bsl/0`, position: s.agent.index } });
    expect(accepted(checkCredential(s.jwt, { ...s.ctx, subject: s.agent.did })).did).toBe(s.agent.did);
  });

  const changes: Array<[string, (c: Record<string, any>, now: number) => void, Record<string, unknown>?]> = [
    ['credential.alg', () => undefined, { alg: 'HS256' }],
    ['credential.alg', () => undefined, { alg: 'none' }],
    ['credential.typ', () => undefined, { typ: 'at+jwt' }],
    ['credential.typ', () => undefined, { cty: 'other' }],
    ['credential.kid', () => undefined, { kid: 'unknown' }],
    ['credential.context', (c) => (c['@context'] = ['https://example.org'])],
    ['credential.type', (c) => (c.type = ['VerifiableCredential'])],
    ['credential.issuer', (c) => (c.issuer = `did:vector:${'a'.repeat(64)}`)],
    ['credential.malformed', (c) => (c.validUntil = '2026-13-45T00:00:00Z')],
    ['credential.not_yet_valid', (c, now) => (c.validFrom = new Date(now + 3_600_000).toISOString().replace('.000Z', 'Z'))],
    ['credential.expired', (c, now) => (c.validUntil = new Date(now - 3_600_000).toISOString().replace('.000Z', 'Z'))],
    ['credential.subject', (c) => (c.credentialSubject.id = 'did:vector:xyz')],
    ['credential.subject', (c) => (c.credentialSubject.parent = 'not a did')],
    ['credential.status_entries', (c) => (c.credentialStatus = [])],
    ['credential.status_entries', (c) => c.credentialStatus.pop()],
    ['credential.status_entries', (c) => (c.credentialStatus[1].statusListIndex = String(Number(c.credentialStatus[1].statusListIndex) + 1))],
    ['credential.status_entries', (c) => (c.credentialStatus[0].statusPurpose = 'suspension')],
    ['credential.status_entries', (c) => (c.credentialStatus[0].statusListCredential = 'https://evil.example/status/bsl/0')],
    ['credential.status_entries', (c) => ((c.credentialStatus[0].statusListCredential = 'https://evil.example/status/bsl/0'), (c.credentialStatus[1].statusListCredential = 'https://evil.example/status/bsl/0'))],
    ['credential.status_entries', (c) => (c.credentialStatus[1].statusListCredential = `https://id.vector.apexfusion.org/status/bsl/1`)],
    ['credential.status_entries', (c) => (c.credentialStatus[0].statusListIndex = '1.5')],
    ['credential.status_entries', (c) => (c.credentialStatus[0].type = 'Other')],
  ];
  it.each(changes)('refuses a credential with a wrong part: %s', async (rule, mutate, header) => {
    const s = await setup();
    refused(checkCredential(await forged(s.gateway, s.jwt, (c) => mutate(c as never, s.gateway.now()), header), s.ctx), rule);
    accepted(checkCredential(await forged(s.gateway, s.jwt, () => undefined), s.ctx));
  });

  it('a credential that anybody changed fails the check of its signature, and so does text that is no JWS; the credential of another agent than the one that was asked for is refused', async () => {
    const s = await setup();
    const [h, p, signature] = s.jwt.split('.');
    const claims = decodeJwt(s.jwt).payload as { credentialSubject: Record<string, unknown> };
    const changed = `${h}.${b64url(JSON.stringify({ ...claims, credentialSubject: { ...claims.credentialSubject, id: `did:vector:${identifier('somebody else')}` } }))}.${signature}`;
    refused(checkCredential(changed, s.ctx), 'credential.signature');
    refused(checkCredential(`${h}.${p}.${b64url(Buffer.alloc(64))}`, s.ctx), 'credential.signature');
    refused(checkCredential('garbage', s.ctx), 'credential.malformed');
    refused(checkCredential(s.jwt, { ...s.ctx, subject: `did:vector:${identifier('somebody else')}` }), 'credential.subject');
  });

  it('the time of a credential: it is over after its day and the leeway', async () => {
    const s = await setup();
    accepted(checkCredential(s.jwt, { ...s.ctx, nowMs: s.gateway.now() + 86_400_000 + 29_000 }));
    refused(checkCredential(s.jwt, { ...s.ctx, nowMs: s.gateway.now() + 86_400_000 + 31_000 }), 'credential.expired');
  });

  it('the verifier reads the Bitstring Status List: a credential is accepted while both bits are clear, and refused with credential.revoked or credential.suspended when a bit is set', async () => {
    const s = await setup({ listCacheSeconds: 0 });
    const verified = accepted(await s.verifier.credential(s.jwt, { subject: s.agent.did }));
    expect(verified.listStatus).toStrictEqual({ read: true, list: `${s.gateway.baseUrl}/status/bsl/0`, fetchedAt: s.gateway.now(), issuedAt: s.gateway.now() });
    s.gateway.setStatus(s.agent, 'suspended', 'hold');
    refused(await s.verifier.credential(s.jwt), 'credential.suspended');
    s.gateway.setStatus(s.agent, 'revoked');
    refused(await s.verifier.credential(s.jwt), 'credential.revoked');
    s.gateway.setStatus(s.agent, 'active');
    accepted(await s.verifier.credential(s.jwt));
  });

  it('a list that cannot be read refuses the credential (credential.status_unknown): it is a public document that stays valid for a day, so it is not accepted on a guess', async () => {
    const s = await setup();
    s.gateway.setStatus(s.agent, 'revoked');
    s.gateway.fault('/status/bsl/0', LISTS_UNAVAILABLE);
    refused(await s.verifier.credential(s.jwt), 'credential.status_unknown');
    s.gateway.fault('/status/bsl/0', 'network');
    s.gateway.advance(6_000);
    refused(await s.verifier.credential(s.jwt), 'credential.status_unknown');
    // The twin: the list is readable and the agent is active.
    s.gateway.fault('/status/bsl/0', null);
    s.gateway.setStatus(s.agent, 'active');
    s.gateway.advance(6_000);
    accepted(await s.verifier.credential(s.jwt));
  });

  it('a copy of the list that read revoked is no way round: while the new read fails the copy still refuses, and when the copy is over the credential is refused for credential.status_unknown', async () => {
    const s = await setup();
    s.gateway.setStatus(s.agent, 'revoked');
    refused(await s.verifier.credential(s.jwt), 'credential.revoked');
    s.gateway.advance(61_000);
    s.gateway.fault('/status/bsl/0', LISTS_UNAVAILABLE);
    refused(await s.verifier.credential(s.jwt), 'credential.revoked');
    s.gateway.advance(61 * 60_000);
    refused(await s.verifier.credential(s.jwt), 'credential.status_unknown');
    // The twin: the gateway answers again and the agent is active.
    s.gateway.fault('/status/bsl/0', null);
    s.gateway.setStatus(s.agent, 'active');
    s.gateway.advance(6_000);
    accepted(await s.verifier.credential(s.jwt));
  });

  it('an older copy after a failed refresh is not a read: credential.status_unknown, and the same credential is accepted when the list is read again', async () => {
    const s = await setup();
    accepted(await s.verifier.credential(s.jwt));
    s.gateway.advance(61_000);
    s.gateway.fault('/status/bsl/0', LISTS_UNAVAILABLE);
    refused(await s.verifier.credential(s.jwt), 'credential.status_unknown');
    s.gateway.fault('/status/bsl/0', null);
    s.gateway.advance(6_000);
    accepted(await s.verifier.credential(s.jwt));
  });

  it('a list that is over refuses the credential (credential.status_unknown), and a list that is read and is wrong refuses it with credential.status_list', async () => {
    const old = await setup({ listCacheSeconds: 0, maxCredentialListAgeSeconds: 3_600 });
    old.gateway.lists.freeze();
    old.gateway.advance(59 * 60_000);
    const credential = await old.client.credential(old.agent.did);
    if (!credential.ok) throw new Error(credential.detail);
    accepted(await old.verifier.credential(credential.value));
    old.gateway.advance(2 * 60_000);
    refused(await old.verifier.credential(credential.value), 'credential.status_unknown');
    const s = await setup({ listCacheSeconds: 0 });
    const [h, p] = (await get(s.gateway, '/status/bsl/0')).split('.');
    s.gateway.fault('/status/bsl/0', { status: 200, body: `${h}.${p}.${b64url(Buffer.alloc(64))}`, headers: { 'content-type': 'application/vc+jwt' } });
    refused(await s.verifier.credential(s.jwt), 'credential.status_list');
    refused(await s.verifier.credential(s.jwt), 'credential.status_list');
  });

  it('a credential of the agent at the last position (131,071) is accepted, and refused when its suspension bit, the last bit of the list, is set', async () => {
    const w = world();
    const agent = w.gateway.createAgent({ label: 'credential last position', statusIndex: LIST_SIZE - 1 });
    const issued = await w.client.credential(agent.did);
    if (!issued.ok) throw new Error(issued.detail);
    const verifier = createVerifier({ baseUrl: w.gateway.baseUrl, fetch: w.gateway.fetch, now: w.gateway.now, listCacheSeconds: 0 });
    expect(accepted(await verifier.credential(issued.value)).status.position).toBe(LIST_SIZE - 1);
    w.gateway.setStatus(agent, 'suspended');
    refused(await verifier.credential(issued.value), 'credential.suspended');
  });

  it('a list that the gateway serves while it cannot build a new one is old: a credential is refused when the list was built more than 1,200 seconds ago, although the verifier has just read it', async () => {
    const s = await setup({ listCacheSeconds: 0 });
    const built = s.gateway.now();
    expect(accepted(await s.verifier.credential(s.jwt)).listStatus.issuedAt).toBe(built);
    s.gateway.lists.freeze();
    s.gateway.setStatus(s.agent, 'revoked');
    s.gateway.advance(1_200_000);
    expect(accepted(await s.verifier.credential(s.jwt)).listStatus).toMatchObject({ issuedAt: built, fetchedAt: built + 1_200_000 });
    s.gateway.advance(1_000);
    refused(await s.verifier.credential(s.jwt), 'credential.status_unknown');
    // The twin: a verifier with a larger limit accepts the same list. The gateway built no new list, so the list shows no revocation.
    const lenient = await setup({ listCacheSeconds: 0, maxCredentialListAgeSeconds: 3_600 });
    accepted(await lenient.verifier.credential(lenient.jwt));
    lenient.gateway.lists.freeze();
    lenient.gateway.setStatus(lenient.agent, 'revoked');
    lenient.gateway.advance(1_300_000);
    accepted(await lenient.verifier.credential(lenient.jwt));
  });

  it('the limit for the age of a list has a lower bound and a shape: a value below the ttl of the list (60 seconds here) throws at the first credential check, and the ttl itself is accepted; a value that is no number of seconds, 1 or more, throws when the verifier is made', async () => {
    const low = await setup({ maxCredentialListAgeSeconds: 59 });
    await expect(low.verifier.credential(low.jwt)).rejects.toThrow(TypeError);
    const equal = await setup({ maxCredentialListAgeSeconds: 60 });
    accepted(await equal.verifier.credential(equal.jwt));
    for (const bad of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '1200', null]) {
      expect(() => createVerifier({ baseUrl: equal.gateway.baseUrl, fetch: equal.gateway.fetch, now: equal.gateway.now, maxCredentialListAgeSeconds: bad as never })).toThrow(TypeError);
    }
  });

  it('a verifier that cannot read the key set refuses with keys.unavailable', async () => {
    const s = await setup();
    s.gateway.fault('/.well-known/jwks.json', 'network');
    refused(await s.verifier.credential(s.jwt), 'keys.unavailable');
  });
});

describe('a refusal never repeats a credential', () => {
  const MARKER = 'marker-3f9a51';
  const AUD = 'https://mp-mock.example';

  it('whatever credential is in the wrong place, no detail holds it or a part of it: a JWT-SVID, an identity credential, a status list and a certificate', async () => {
    const w = world();
    const agent = w.gateway.createAgent({ label: 'detail agent' });
    const svid = await w.client.jwtSvid({ agent: { did: agent.did, key: agent.authentication.privateKey }, audience: AUD });
    const credential = await w.client.credential(agent.did);
    if (!svid.ok || !credential.ok) throw new Error('the stub gateway gave no JWT-SVID or no credential');
    const list = await get(w.gateway, '/status/tsl/0');
    const pem = await leaf(w.gateway);
    const credentials = [svid.value.svid, credential.value, list, pem, new X509Certificate(pem).raw.toString('base64')];
    const svidCtx = { bundle: await bundleOf(w.gateway), trustDomain: w.gateway.trustDomain, nowMs: w.gateway.now(), leewaySeconds: 30 };
    const credentialCtx = { keys: await keysOf(w.gateway), issuer: w.gateway.baseUrl, nowMs: w.gateway.now(), leewaySeconds: 30, subject: null };
    const wrong: Array<[string, Check<unknown>]> = [
      ['an identity credential as a JWT-SVID', verifyJwtSvid(credential.value, { ...svidCtx, audience: AUD })],
      ['a status list as a JWT-SVID', verifyJwtSvid(list, { ...svidCtx, audience: AUD })],
      ['a certificate as a JWT-SVID', verifyJwtSvid(pem, { ...svidCtx, audience: AUD })],
      ['a JWT-SVID for another audience', verifyJwtSvid(svid.value.svid, { ...svidCtx, audience: 'https://other.example' })],
      ['a JWT-SVID as an identity credential', checkCredential(svid.value.svid, credentialCtx)],
      ['a status list as an identity credential', checkCredential(list, credentialCtx)],
      ['a certificate as an identity credential', checkCredential(pem, credentialCtx)],
      ['a JWT-SVID as a certificate', verifyX509Svid(svid.value.svid, svidCtx)],
      ['an identity credential as a certificate', verifyX509Svid(credential.value, svidCtx)],
      ['a status list as a certificate', verifyX509Svid(list, svidCtx)],
    ];
    for (const [name, result] of wrong) {
      expect(result.ok, name).toBe(false);
      if (!result.ok) for (const held of credentials) expect(repeatsCredential(result.detail, held), `${name}: ${held.substring(0, 16)}`).toBe(false);
    }
    // The twin: each credential in its own place is accepted.
    accepted(verifyJwtSvid(svid.value.svid, { ...svidCtx, audience: AUD }));
    accepted(checkCredential(credential.value, credentialCtx));
    accepted(verifyX509Svid(pem, svidCtx));
  });

  it.each<[string, 'jwt-svid' | 'credential', Record<string, unknown>]>([
    ['jwt_svid.alg', 'jwt-svid', { alg: MARKER }],
    ['jwt_svid.typ', 'jwt-svid', { typ: MARKER }],
    ['jwt_svid.kid', 'jwt-svid', { kid: MARKER }],
    ['credential.alg', 'credential', { alg: MARKER }],
    ['credential.typ', 'credential', { typ: MARKER }],
    ['credential.typ', 'credential', { cty: MARKER }],
    ['credential.kid', 'credential', { kid: MARKER }],
  ])('a refusal for %s does not repeat the free-form value that the header holds before its signature is checked (%s, %j)', async (rule, kind, header) => {
    const w = world();
    const agent = w.gateway.createAgent({ label: 'marker agent' });
    const credential = await w.client.credential(agent.did);
    const svid = await w.client.jwtSvid({ agent: { did: agent.did, key: agent.authentication.privateKey }, audience: AUD });
    if (!credential.ok || !svid.ok) throw new Error('the stub gateway gave no credential or no JWT-SVID');
    const check: (jwt: string) => Promise<Check<unknown>> =
      kind === 'jwt-svid'
        ? async (jwt) => verifyJwtSvid(jwt, { bundle: await bundleOf(w.gateway), trustDomain: w.gateway.trustDomain, nowMs: w.gateway.now(), leewaySeconds: 30, audience: AUD })
        : async (jwt) => checkCredential(jwt, { keys: await keysOf(w.gateway), issuer: w.gateway.baseUrl, nowMs: w.gateway.now(), leewaySeconds: 30, subject: null });
    const original = kind === 'jwt-svid' ? svid.value.svid : credential.value;
    const result = await check(await forged(w.gateway, original, () => undefined, header));
    refused(result, rule);
    if (!result.ok) expect(result.detail).not.toContain(MARKER);
    // The twin: the same document with its own header is accepted.
    accepted(await check(await forged(w.gateway, original, () => undefined)));
  });
});

describe('the rules of the documents', () => {
  it('each rule of the key set, the bundle, the lists, the SVIDs and the credential has a refusal in this file', () => {
    const rules = [...KEY_SET_RULES, ...BUNDLE_RULES, ...STATUS_LIST_RULES, ...X509_SVID_RULES, ...JWT_SVID_RULES, ...CREDENTIAL_RULES, ...CREDENTIAL_CALL_RULES];
    expect(rules.filter((rule) => !seen.has(rule))).toStrictEqual([]);
  });
});
