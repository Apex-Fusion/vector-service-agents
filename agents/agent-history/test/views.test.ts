import { describe, test, expect } from 'vitest';
import { keyHash, didFor, utf8ToHex } from '@vsa/vector-read';
import type { IdentityDatum, LegacyDatum, Key } from '@vsa/vector-read';
import { recordText, signerName, recordView, marketplaceKeys, changesBetween, activePurposes, controllerPkh, endpointOf } from '../src/views.ts';
import type { RecordContent } from '../src/views.ts';
import { identityDatum, CONTROLLER } from './support.ts';

const identity = (over: Partial<IdentityDatum> = {}): RecordContent => ({ registry: 'identity', datum: identityDatum(over) });
const legacy = (over: Partial<LegacyDatum> = {}): RecordContent => ({ registry: 'legacy', datum: { owner: { type: 'VerificationKey', hash: 'aa'.repeat(28) }, name: utf8ToHex('Old'), description: '', capabilities: [], framework: '', endpoint: utf8ToHex('https://old.example'), registeredAt: 5n, ...over } });
const ED = '22'.repeat(32), ED2 = '23'.repeat(32), P256 = `03${'44'.repeat(32)}`;
const ed = (key: string, purposes: number): Key => ({ keyType: 'Ed25519', key, purposes, pop: null });

describe('text of a record (did:vector Part 1, section 8.2)', () => {
  test('valid UTF-8 is shown; bytes that are not valid UTF-8, and text that holds a noncharacter, are not', () => {
    expect(recordText(utf8ToHex('Agent ünïcode €'))).toBe('Agent ünïcode €');
    expect(recordText('')).toBe('');
    expect(recordText('ff')).toBeNull(); // not UTF-8
    expect(recordText('eda080')).toBeNull(); // an encoded surrogate
    expect(recordText(utf8ToHex('a\uFFFEb'))).toBeNull(); // a noncharacter
    expect(recordText(utf8ToHex('x\u{10FFFF}'))).toBeNull();
    expect(recordText(`efbbbf${utf8ToHex('bom')}`)).toBe('\uFEFFbom'); // a leading BOM is ordinary text
  });
  test('a capability that is not text is left out of the record view', () => {
    const v = recordView(identity({ capabilities: [utf8ToHex('ok.v1'), 'ff'] }));
    expect(v.capabilities).toEqual(['ok.v1']);
  });
});

describe('how a record is shown', () => {
  test('signers are a key hash, script:<hash> or controller; a reason without a name in Appendix A is a decimal string', () => {
    expect([signerName({ type: 'KeyHash', hash: 'ab'.repeat(28) }), signerName({ type: 'Script', hash: 'cd'.repeat(28) }), signerName({ type: 'ControllerSet' })]).toEqual(['ab'.repeat(28), `script:${'cd'.repeat(28)}`, 'controller']);
    const v = recordView(identity({ status: { type: 'Suspended', holds: [{ by: { type: 'Script', hash: 'cd'.repeat(28) }, reason: 64, since: 1, until: 2 }, { by: { type: 'KeyHash', hash: 'ab'.repeat(28) }, reason: 99, since: 3, until: 4 }] } }));
    expect(v.registry === 'identity' && v.status).toEqual({ status: 'suspended', holds: [{ by: `script:${'cd'.repeat(28)}`, reason: 'disputeVerdict', since: 1, until: 2 }, { by: 'ab'.repeat(28), reason: '99', since: 3, until: 4 }] });
  });
  test('a subagent names its parent by its canonical DID; a retired tombstone names its successor so', () => {
    const v = recordView(identity({ lineage: { type: 'Subagent', parent: 'ee'.repeat(32), parentEpoch: 2, depth: 1 }, status: { type: 'Retired', at: 10, successor: 'ff'.repeat(32) } }));
    expect(v).toMatchObject({ lineage: { type: 'subagent', parent: didFor('ee'.repeat(32)), parent_epoch: 2, depth: 1 }, status: { status: 'retired', at: 10, successor: didFor('ff'.repeat(32)) } });
  });
  test('a legacy record shows its owner key hash as its controller and its registration time as a number while it is exact', () => {
    expect(recordView(legacy())).toEqual({ registry: 'legacy', controller_pkh: 'aa'.repeat(28), name: 'Old', description: '', capabilities: [], framework: '', endpoint: 'https://old.example', registered_at: 5 });
    expect(recordView(legacy({ registeredAt: 2n ** 70n })).registry === 'legacy' && (recordView(legacy({ registeredAt: 2n ** 70n })) as any).registered_at).toBe((2n ** 70n).toString());
    expect(controllerPkh(legacy())).toBe('aa'.repeat(28));
    expect(controllerPkh(identity())).toBe(keyHash(CONTROLLER));
    expect(endpointOf(legacy())).toBe('https://old.example');
    expect(endpointOf(identity({ endpoint: '' }))).toBeNull();
  });
});

describe('marketplace keys: who acts for the record in the marketplace', () => {
  test('a legacy record: its owner key', () => {
    expect(marketplaceKeys(legacy())).toEqual(['aa'.repeat(28)]);
  });
  test('an identity registry record: each listed Ed25519 key with the transaction purpose, in datum order; never a P-256 key or the controller', () => {
    const c = identity({ keys: [ed(ED2, 1 + 8), { keyType: 'P256', key: P256, purposes: 2, pop: '55'.repeat(64) }, ed(ED, 1), ed(CONTROLLER.replace(/1/g, '9'), 8 + 16)] });
    expect(marketplaceKeys(c)).toEqual([keyHash(ED2), keyHash(CONTROLLER.replace(/1/g, '9'))]);
    expect(activePurposes(c.datum as IdentityDatum, keyHash(ED2))).toEqual(['authentication', 'transaction']);
    expect(activePurposes(c.datum as IdentityDatum, keyHash(P256))).toEqual(['assertion']);
    expect(activePurposes(c.datum as IdentityDatum, keyHash(CONTROLLER))).toEqual([]);
  });
  test('a tombstone lists no key, so it has none', () => {
    expect(marketplaceKeys(identity({ keys: [], status: { type: 'Retired', at: 1, successor: null } }))).toEqual([]);
  });
});

describe('changes between two versions', () => {
  const party = { role: 'Provider' as const, signer: { type: 'KeyHash' as const, hash: 'bb'.repeat(28) }, organisation: utf8ToHex('example.org'), notBefore: 0, notAfter: null, rights: 1, removalAfter: null };
  test('a removal notice changes a party; the party is matched by role and signer', () => {
    const before = identity({ parties: [party] }), after = identity({ parties: [{ ...party, removalAfter: 99 }] });
    expect(changesBetween(before, after)).toEqual({ parties: { added: [], removed: [], changed: [{ role: 'provider', signer: 'bb'.repeat(28), organisation: 'example.org', rights: ['suspend'], not_before: 0, not_after: null, removal_after: 99 }] } });
    // Another role with the same signer is another party.
    expect(changesBetween(before, identity({ parties: [{ ...party, role: 'Distributor', rights: 0 }] }))).toMatchObject({ parties: { added: [expect.objectContaining({ role: 'distributor' })], removed: [expect.objectContaining({ role: 'provider' })], changed: [] } });
  });
  test('a key whose purposes differ is removed and added, matched as a whole', () => {
    expect(changesBetween(identity({ keys: [ed(ED, 1)] }), identity({ keys: [ed(ED, 1 + 8)] }))).toEqual({ keys: { added: [{ key_hash: keyHash(ED), type: 'Ed25519', purposes: ['authentication', 'transaction'] }], removed: [{ key_hash: keyHash(ED), type: 'Ed25519', purposes: ['authentication'] }] } });
  });
  test('the same datum changes nothing, and a retirement carries its time and successor', () => {
    expect(changesBetween(identity(), identity())).toEqual({});
    expect(changesBetween(identity(), identity({ status: { type: 'Retired', at: 7, successor: null } }))).toEqual({ status: { from: 'active', to: 'retired', at: 7, successor: null } });
  });
  test('the first version of a subagent shows its parent; the first of a root shows no lineage', () => {
    expect(changesBetween(null, identity({ lineage: { type: 'Subagent', parent: 'ee'.repeat(32), parentEpoch: 0, depth: 1 } })).lineage).toEqual({ from: null, to: { type: 'subagent', parent: didFor('ee'.repeat(32)), parent_epoch: 0, depth: 1 } });
    expect(changesBetween(null, identity()).lineage).toBeUndefined();
  });
});
