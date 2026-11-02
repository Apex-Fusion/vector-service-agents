// The identity registry helpers: the vendored codecs against the bytes the Aiken types serialise, the DID strings and test vectors of
// did:vector Part 1 section 3, the two registries of section 4, and active_key of Part 2 section 3.10.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decodeIdentityDatum, encodeIdentityDatum, decodeLegacyDatum, encodeLegacyDatum, decodePlutusDataHex, encodePlutusDataHex,
  vectorIdFromSeed, dnsSafe, keyHash, vectorDid, legacyVectorDid, parseVectorDid, utf8FromHex, utf8ToHex,
  scriptAddress, identityRegistryOf, isAuthenticRecord, activeKey, LEGACY_REGISTRY,
  PURPOSE_AUTHENTICATION, PURPOSE_ASSERTION, PURPOSE_TRANSACTION, PURPOSE_DELEGATION,
  didFor, blake2b224Hex, REGISTRY_POLICY, REGISTRY_ADDRESS,
} from '../src/index.ts';
import type { IdentityDatum, Key } from '../src/index.ts';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/identity-cbor-fixtures.json', import.meta.url), 'utf8')).fixtures as Record<string, { type: string; cbor: string }>;

describe('the vendored record codecs read and write the bytes of the Aiken types', () => {
  const RECORDS = ['identity_datum_full', 'identity_datum_revoked_tombstone', 'identity_datum_retired_tombstone'];
  test.each(RECORDS)('%s decodes and encodes again byte for byte', (name) => {
    expect(fixtures[name].type).toBe('vector_identity/types.IdentityDatum');
    expect(encodeIdentityDatum(decodeIdentityDatum(fixtures[name].cbor))).toBe(fixtures[name].cbor);
  });
  test('the legacy record decodes and encodes again byte for byte', () => {
    expect(fixtures.legacy_datum.type).toBe('vector_identity/types.LegacyDatum');
    const d = decodeLegacyDatum(fixtures.legacy_datum.cbor);
    expect(d.owner).toEqual({ type: 'VerificationKey', hash: 'aa'.repeat(28) });
    expect(utf8FromHex(d.name)).toBe('Legacy Agent');
    expect(encodeLegacyDatum(d)).toBe(fixtures.legacy_datum.cbor);
  });
  test('the full record holds what Part 1 section 5 names, field by field', () => {
    const d = decodeIdentityDatum(fixtures.identity_datum_full.cbor);
    expect(d.controller).toBe('11'.repeat(32));
    expect(d.keys.map((k) => [k.keyType, k.purposes, k.pop === null])).toEqual([['Ed25519', 9, true], ['P256', 2, false]]);
    expect(d.parties[0]).toMatchObject({ role: 'Accountable', signer: { type: 'KeyHash', hash: '55'.repeat(28) }, organisation: utf8ToHex('did:web:example.org') });
    expect(d.status.type).toBe('Suspended');
  });
  test('the revoked tombstone keeps its controller and name and names its successor', () => {
    const d = decodeIdentityDatum(fixtures.identity_datum_revoked_tombstone.cbor);
    expect([d.keys, d.parties, utf8FromHex(d.name)]).toEqual([[], [], 'revoked-agent']);
    expect(d.status).toEqual({ type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: 1794441600000, invalidFrom: 1794355200000, successor: '99'.repeat(32) });
  });
  test('the legacy record of ChandraOCR, as the ledger holds it (fee14e5f...#0, 2026-10-13), decodes with the vendored codec', () => {
    const hex = 'd8799fd8799f581c401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9ff4a4368616e6472614f43525f5840486973746f726963616c20616e642068616e647772697474656e20646f63756d656e742065787472616374696f6e2e20426f6e6465642d657363726f77207375584070706c696572206f6e2074686520776f726b206d61726b6574706c6163653b207369676e65642072656365697074207065722064656c69766572656420706167581e652e2046697273742d70617274792c2048414c382d6f706572617465642eff9f58216f63722e706167652e657874726163742e6368616e6472612d6f63722d322e763153646f63756d656e742d65787472616374696f6e581968616e6477726974696e672d7472616e736372697074696f6e486172636869766573ff526167656e74732d6d61726b6574706c616365582468747470733a2f2f6d702d737570706c696572732d6368616e6472612e68616c382e61691b0000019fdb67441fff';
    const d = decodeLegacyDatum(hex);
    expect(d.owner).toEqual({ type: 'VerificationKey', hash: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9' });
    expect([utf8FromHex(d.name), utf8FromHex(d.framework), utf8FromHex(d.endpoint), d.registeredAt]).toEqual(['ChandraOCR', 'agents-marketplace', 'https://mp-suppliers-chandra.hal8.ai', 1786092405791n]);
    expect(d.capabilities.map(utf8FromHex)).toEqual(['ocr.page.extract.chandra-ocr-2.v1', 'document-extraction', 'handwriting-transcription', 'archives']);
    // The ledger chunks the long description; the canonical encoder writes the same chunks, so the bytes come back unchanged.
    expect(encodeLegacyDatum(d)).toBe(hex);
  });
  test('two encodings of one Plutus Data value encode canonically to the same bytes', () => {
    const compact = 'd8799f4161ff'; // Constr 0 [h'61'] with an indefinite field list
    const definite = 'd879814161'; // the same value with a definite field list
    expect(encodePlutusDataHex(decodePlutusDataHex(definite))).toBe(encodePlutusDataHex(decodePlutusDataHex(compact)));
  });
  test('a record that breaks the layout is refused with the field named', () => {
    expect(() => decodeIdentityDatum('d87980')).toThrow(/decodeIdentityDatum: expected 14 fields, got 0/);
    expect(() => decodeLegacyDatum(fixtures.identity_datum_full.cbor)).toThrow(/decodeLegacyDatum/);
  });
});

describe('identifiers and DID strings (Part 1 section 3)', () => {
  test('the identifier test vectors of section 3.1 and the DNS-safe forms of section 3.2', () => {
    expect(vectorIdFromSeed('00'.repeat(32), 0)).toBe('a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9');
    expect(vectorIdFromSeed('ab'.repeat(32), 24)).toBe('3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b');
    expect(dnsSafe('a2e5e227858e84f1a8f9b0c1246e6cbc9336d707d43ba43d0e1cb7c51c45f4c9')).toBe('uls6ej4fr2cpdkhzwdasi3tmxsjtnvyh2q52ipiods34khcf6teq');
    expect(dnsSafe('3ddd07517205dd8a745887c33a09da0e4a5d63dca1f151ceeedaeeda0551c52b')).toBe('hxoqoulsaxoyu5cyq7btuco2bzff2y64uhyvdtxo3lxnubkryuvq');
  });
  test('didFor gives the canonical form, and the legacy form names the same identifier under the legacy policy', () => {
    const id = '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
    expect(didFor(id)).toBe(`did:vector:${id}`);
    expect(didFor(id)).toBe(vectorDid(id));
    expect(legacyVectorDid(REGISTRY_POLICY, id)).toBe(`did:vector:agent:${REGISTRY_POLICY}:${id}`);
    expect(parseVectorDid(didFor(id))).toEqual({ form: 'canonical', vectorId: id });
    expect(parseVectorDid(legacyVectorDid(REGISTRY_POLICY, id))).toEqual({ form: 'legacy', policyId: REGISTRY_POLICY, vectorId: id });
    expect(parseVectorDid(`did:vector:testnet:${id}`)).toEqual({ form: 'network', network: 'testnet', vectorId: id });
  });
  test('every character of a DID is lowercase: an uppercase one, a short identifier or another method is not a did:vector DID', () => {
    const id = 'ab'.repeat(32);
    for (const bad of [`did:vector:${id.toUpperCase()}`, `DID:vector:${id}`, `did:vector:agent:${REGISTRY_POLICY.toUpperCase()}:${id}`, `did:vector:${id.slice(2)}`, `did:web:${id}`, `did:vector:${id}#key`]) expect(parseVectorDid(bad), bad).toBeNull();
    expect(() => didFor(id.toUpperCase())).toThrow(/64 lowercase hexadecimal/);
  });
  test('the key hash is blake2b-224 of the public key', () => {
    expect(keyHash('22'.repeat(32))).toBe(blake2b224Hex('22'.repeat(32)));
    expect(keyHash(`02${'33'.repeat(32)}`)).toBe(blake2b224Hex(`02${'33'.repeat(32)}`));
  });
});

describe('the registries (Part 1 section 4)', () => {
  const POLICY = blake2b224Hex(utf8ToHex('a test identity registry'));
  test('a registry address is the script as payment credential with no stake credential: the legacy address is that of its policy', () => {
    expect(scriptAddress(REGISTRY_POLICY)).toBe(REGISTRY_ADDRESS);
    expect(LEGACY_REGISTRY).toEqual({ policy: REGISTRY_POLICY, address: REGISTRY_ADDRESS });
    expect(scriptAddress(POLICY)).toMatch(/^addr1w/);
  });
  test('the identity registry comes from its policy; the address may be left out, and when given it must be the address of the policy', () => {
    expect(identityRegistryOf(POLICY, undefined)).toEqual({ policy: POLICY, address: scriptAddress(POLICY) });
    expect(identityRegistryOf(` ${POLICY} `, scriptAddress(POLICY))).toEqual({ policy: POLICY, address: scriptAddress(POLICY) });
    expect(() => identityRegistryOf(POLICY, REGISTRY_ADDRESS)).toThrow(/IDENTITY_ADDRESS .* is not the address of IDENTITY_POLICY_ID/);
  });
  test('no policy means no identity registry yet; an address without a policy, a malformed policy or the legacy policy is refused', () => {
    for (const none of [undefined, '', '  ']) expect(identityRegistryOf(none, undefined)).toBeNull();
    expect(() => identityRegistryOf('', REGISTRY_ADDRESS)).toThrow(/IDENTITY_ADDRESS is set but IDENTITY_POLICY_ID is not/);
    for (const bad of [POLICY.toUpperCase(), POLICY.slice(2), `${POLICY}00`, 'not hex']) expect(() => identityRegistryOf(bad, undefined), bad).toThrow(/IDENTITY_POLICY_ID must be 56 lowercase hex/);
    expect(() => identityRegistryOf(REGISTRY_POLICY, undefined)).toThrow(/legacy registry/);
  });
  test('a record output is authentic only at the exact address with exactly one token of the policy, named by the identifier', () => {
    const id = 'ab'.repeat(32), other = 'cd'.repeat(32);
    const token = (name: string, quantity = '1') => ({ policy_id: REGISTRY_POLICY, asset_name: name, quantity });
    expect(isAuthenticRecord(REGISTRY_ADDRESS, [token(id)], LEGACY_REGISTRY, id)).toBe(true);
    expect(isAuthenticRecord(REGISTRY_ADDRESS, [token(id), { policy_id: 'ee'.repeat(28), asset_name: '', quantity: '5' }], LEGACY_REGISTRY, id)).toBe(true); // another policy does not matter
    expect(isAuthenticRecord('addr1v' + 'q'.repeat(50), [token(id)], LEGACY_REGISTRY, id)).toBe(false); // another address
    expect(isAuthenticRecord(REGISTRY_ADDRESS, [token(id), token(other)], LEGACY_REGISTRY, id)).toBe(false); // two tokens of the policy in one output
    expect(isAuthenticRecord(REGISTRY_ADDRESS, [token(other)], LEGACY_REGISTRY, id)).toBe(false);
    expect(isAuthenticRecord(REGISTRY_ADDRESS, [token(id, '2')], LEGACY_REGISTRY, id)).toBe(false);
    expect(isAuthenticRecord(REGISTRY_ADDRESS, null, LEGACY_REGISTRY, id)).toBe(false);
  });
});

describe('activeKey: active_key of the vector_identity library', () => {
  const ED = '22'.repeat(32), P256 = `02${'33'.repeat(32)}`, CONTROLLER = '11'.repeat(32);
  const ed = (purposes: number): Key => ({ keyType: 'Ed25519', key: ED, purposes, pop: null });
  const p256 = (purposes: number): Key => ({ keyType: 'P256', key: P256, purposes, pop: '44'.repeat(64) });
  const record = (keys: Key[]): Pick<IdentityDatum, 'keys'> => ({ keys });
  test('a listed Ed25519 key with the transaction purpose is active for it, by its key hash', () => {
    expect(activeKey(record([ed(PURPOSE_AUTHENTICATION + PURPOSE_TRANSACTION)]), keyHash(ED), PURPOSE_TRANSACTION)).toBe(true);
    expect(activeKey(record([ed(PURPOSE_AUTHENTICATION + PURPOSE_TRANSACTION)]), keyHash(ED), PURPOSE_AUTHENTICATION)).toBe(true);
    expect(activeKey(record([ed(PURPOSE_AUTHENTICATION + PURPOSE_TRANSACTION)]), keyHash(ED), PURPOSE_ASSERTION)).toBe(false);
  });
  test('a key without the purpose, another key hash, or the controller key that is not listed is not active', () => {
    expect(activeKey(record([ed(PURPOSE_AUTHENTICATION + PURPOSE_ASSERTION)]), keyHash(ED), PURPOSE_TRANSACTION)).toBe(false);
    expect(activeKey(record([ed(27)]), keyHash(CONTROLLER), PURPOSE_TRANSACTION)).toBe(false);
    expect(activeKey(record([]), keyHash(ED), PURPOSE_TRANSACTION)).toBe(false);
  });
  test('transaction and delegation count only for an Ed25519 key; a value that is not a purpose counts for none', () => {
    expect(activeKey(record([p256(PURPOSE_AUTHENTICATION + PURPOSE_TRANSACTION + PURPOSE_DELEGATION)]), keyHash(P256), PURPOSE_TRANSACTION)).toBe(false);
    expect(activeKey(record([p256(PURPOSE_AUTHENTICATION + PURPOSE_TRANSACTION + PURPOSE_DELEGATION)]), keyHash(P256), PURPOSE_DELEGATION)).toBe(false);
    expect(activeKey(record([p256(PURPOSE_AUTHENTICATION)]), keyHash(P256), PURPOSE_AUTHENTICATION)).toBe(true);
    expect(activeKey(record([ed(31)]), keyHash(ED), 4)).toBe(false);
    expect(activeKey(record([ed(27)]), keyHash(ED), 3)).toBe(false);
  });
  test('the purposes are read as bits: a high purpose bit does not leak into a lower one', () => {
    expect(activeKey(record([ed(PURPOSE_DELEGATION)]), keyHash(ED), PURPOSE_TRANSACTION)).toBe(false);
    expect(activeKey(record([ed(PURPOSE_DELEGATION + PURPOSE_TRANSACTION)]), keyHash(ED), PURPOSE_DELEGATION)).toBe(true);
    expect(activeKey(record([ed(2 ** 52 + PURPOSE_TRANSACTION)]), keyHash(ED), PURPOSE_TRANSACTION)).toBe(true);
  });
  test('the full fixture record lists its Ed25519 key for authentication and transaction, and its P-256 key for assertion', () => {
    const d = decodeIdentityDatum(fixtures.identity_datum_full.cbor);
    const [first, second] = d.keys;
    expect(activeKey(d, keyHash(first.key), PURPOSE_TRANSACTION)).toBe(true);
    expect(activeKey(d, keyHash(first.key), PURPOSE_ASSERTION)).toBe(false);
    expect(activeKey(d, keyHash(second.key), PURPOSE_ASSERTION)).toBe(true);
    expect(activeKey(d, keyHash(d.controller), PURPOSE_TRANSACTION)).toBe(false);
  });
});
