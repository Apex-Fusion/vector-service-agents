// Vitest port of packages/builder/test/identity-codec.test.ts at 94bd293 (Apex-Fusion/mcp-server, branch feat/identity-registry), the
// tests of src/identity-codec.ts and of the identity layouts of src/datum.ts. node:assert/strict calls became expect() equivalents with
// the same meaning (deepEqual -> toStrictEqual, equal -> toBe, throws -> toThrow, ok(cond) -> a comparison matcher). The fixture file is
// the same file as the source's (test/fixtures/identity-cbor-fixtures.json, see VENDORED-FROM.md): the agents-marketplace fixture at
// 4c95c3f, the same bytes as at b5d66a6, 1643583 and 67054f6. OWN_ADDRESS is the wallet address of the source's fixture provider
// (packages/builder/test/fixtures/fixture-provider.ts), written out here because this package has no copy of that provider.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Data, Constr } from '@lucid-evolution/lucid';
import {
  decodeIdentityDatum, encodeIdentityDatum, decodeLegacyDatum, encodeLegacyDatum, encodeIdentityMint, decodeIdentityMint,
  encodeIdentitySpend, decodeIdentitySpend, decodeAttestationDatum, encodeAttestationDatum, encodeAttestationMint, encodeAttestationSpend,
  decodeDelegationDatum, encodeDelegationDatum, encodeDelegationMint, decodeVaultDatum, encodeVaultDatum, encodeVaultSpend,
  plutusAddressFromBech32, plutusAddressToBech32, plutusAddressToData, plutusAddressOf, utf8Hex, textOf, sameSigner,
} from '../src/identity-codec.ts';
import type { IdentitySpend } from '../src/identity-codec.ts';
import {
  decodeIdentityEscrowDatum, encodeIdentityEscrowDatum, decodeAnyEscrowDatum, decodeIdentityAdvertDatum, encodeIdentityAdvertDatum,
  decodeAnyAdvertDatum, identityEscrowLockFloor, escrowLockFloor, plutusDataMaxBytes, advertTextFieldsRoundTrip,
} from '../src/datum.ts';

const OWN_ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/identity-cbor-fixtures.json', import.meta.url), 'utf8')).fixtures as Record<string, { type: string; cbor: string }>;
const cbor = (name: string): string => { const f = FIXTURES[name]; expect(f, `fixture ${name}`).toBeDefined(); return f.cbor; };

describe('datums decode and encode back to the bytes Aiken writes', () => {
  const roundTrips: Array<[string, (hex: string) => string]> = [
    ['identity_datum_full', (h) => encodeIdentityDatum(decodeIdentityDatum(h))],
    ['identity_datum_revoked_tombstone', (h) => encodeIdentityDatum(decodeIdentityDatum(h))],
    ['identity_datum_retired_tombstone', (h) => encodeIdentityDatum(decodeIdentityDatum(h))],
    ['legacy_datum', (h) => encodeLegacyDatum(decodeLegacyDatum(h))],
    ['attestation_datum_full', (h) => encodeAttestationDatum(decodeAttestationDatum(h))],
    ['attestation_datum_minimal', (h) => encodeAttestationDatum(decodeAttestationDatum(h))],
    ['delegation_datum', (h) => encodeDelegationDatum(decodeDelegationDatum(h))],
    ['vault_datum_live', (h) => encodeVaultDatum(decodeVaultDatum(h))],
    ['vault_datum_returned', (h) => encodeVaultDatum(decodeVaultDatum(h))],
    ['escrow_datum_with_refund', (h) => encodeIdentityEscrowDatum(decodeIdentityEscrowDatum(h))],
    ['escrow_datum_without_refund', (h) => encodeIdentityEscrowDatum(decodeIdentityEscrowDatum(h))],
    ['advert_datum', (h) => encodeIdentityAdvertDatum(decodeIdentityAdvertDatum(h))],
  ];
  for (const [name, roundTrip] of roundTrips) {
    test(name, () => expect(roundTrip(cbor(name))).toBe(cbor(name)));
  }

  test('every datum fixture is covered', () => {
    const datums = Object.keys(FIXTURES).filter((n) => n.includes('datum'));
    expect(datums.sort()).toStrictEqual(roundTrips.map(([n]) => n).sort());
  });

  test('the full record decodes to the Part 1 Section 5 shape', () => {
    const d = decodeIdentityDatum(cbor('identity_datum_full'));
    expect(d.controller.length).toBe(64);
    expect(d.keys.map((k) => k.keyType)).toStrictEqual(['Ed25519', 'P256']);
    expect(d.keys[1].pop?.length).toBe(128);
    expect(d.parties.length).toBeGreaterThanOrEqual(1);
    expect(d.parties.every((p) => typeof p.notBefore === 'number')).toBe(true);
    const tombstone = decodeIdentityDatum(cbor('identity_datum_revoked_tombstone'));
    expect(tombstone.status.type).toBe('Revoked');
  });

  test('both escrow layouts and both advert layouts are told apart by field count', () => {
    expect(decodeAnyEscrowDatum(cbor('escrow_datum_with_refund')).layout).toBe('identity');
    expect(decodeAnyAdvertDatum(cbor('advert_datum')).layout).toBe('identity');
    const withRefund = decodeIdentityEscrowDatum(cbor('escrow_datum_with_refund'));
    expect(withRefund.refund).not.toBeNull();
    expect(decodeIdentityEscrowDatum(cbor('escrow_datum_without_refund')).refund).toBeNull();
    expect(advertTextFieldsRoundTrip(cbor('advert_datum'))).toBe(true);
  });
});

describe('redeemers encode to the bytes Aiken writes', () => {
  const seed = (byte: string, index: number) => ({ txHash: byte.repeat(32), outputIndex: index });
  const spends: Array<[string, IdentitySpend]> = [
    ['identity_spend_update', { type: 'Update' }],
    ['identity_spend_change_controller', { type: 'ChangeController' }],
    ['identity_spend_suspend', { type: 'Suspend', actor: { type: 'ByController' } }],
    ['identity_spend_unsuspend', { type: 'Unsuspend', author: { type: 'Script', hash: '66'.repeat(28) } }],
    ['identity_spend_revoke', { type: 'Revoke', actor: { type: 'ByParty', index: 2 } }],
    ['identity_spend_retire', { type: 'Retire' }],
    ['identity_spend_reclaim', { type: 'Reclaim' }],
    ['identity_spend_set_successor', { type: 'SetSuccessor' }],
    ['identity_spend_bump_epoch', { type: 'BumpEpoch' }],
    ['identity_spend_recover_init', { type: 'RecoverInit', guardians: [0, 3] }],
    ['identity_spend_recover_cancel', { type: 'RecoverCancel', guardians: [1] }],
    ['identity_spend_recover_finalize', { type: 'RecoverFinalize' }],
  ];
  for (const [name, value] of spends) {
    test(name, () => {
      expect(encodeIdentitySpend(value)).toBe(cbor(name));
      expect(decodeIdentitySpend(cbor(name))).toStrictEqual(value);
    });
  }

  test('identity mint: Register and Adopt', () => {
    expect(encodeIdentityMint({ type: 'Register', seed: seed('f1', 24) })).toBe(cbor('identity_mint_register'));
    expect(encodeIdentityMint({ type: 'Adopt', proof: ['f2'.repeat(32), 'f3'.repeat(32)] })).toBe(cbor('identity_mint_adopt'));
    expect(decodeIdentityMint(cbor('identity_mint_register'))).toStrictEqual({ type: 'Register', seed: seed('f1', 24) });
  });

  test('attestation, delegation and vault redeemers', () => {
    expect(encodeAttestationMint({ type: 'Attest', seed: seed('f4', 0) })).toBe(cbor('attestation_mint_attest'));
    expect(encodeAttestationMint({ type: 'Burn' })).toBe(cbor('attestation_mint_burn'));
    expect(encodeAttestationSpend({ type: 'RevokeAtt', reason: 5 })).toBe(cbor('attestation_spend_revoke_att'));
    expect(encodeAttestationSpend({ type: 'Contest' })).toBe(cbor('attestation_spend_contest'));
    expect(encodeAttestationSpend({ type: 'Withdraw' })).toBe(cbor('attestation_spend_withdraw'));
    expect(encodeDelegationMint({ type: 'Delegate', seed: seed('f5', 300) })).toBe(cbor('delegation_mint_delegate'));
    expect(encodeDelegationMint({ type: 'Undelegate' })).toBe(cbor('delegation_mint_undelegate'));
    expect(encodeVaultSpend({ type: 'Pay' })).toBe(cbor('vault_spend_pay'));
    expect(encodeVaultSpend({ type: 'Close' })).toBe(cbor('vault_spend_close'));
  });

  test('escrow and advert redeemers: RefundRevoked is constructor 5', () => {
    const tags = ['claim', 'submit', 'accept', 'reclaim', 'release', 'refund_revoked'];
    tags.forEach((t, i) => {
      if (t === 'submit') return;
      expect(Data.to(new Constr(i, []))).toBe(cbor(`escrow_redeemer_${t}`));
    });
    expect(Data.to(new Constr(1, ['d6'.repeat(32)]))).toBe(cbor('escrow_redeemer_submit'));
    ['post', 'update', 'retire'].forEach((t, i) => expect(Data.to(new Constr(i, []))).toBe(cbor(`advert_redeemer_${t}`)));
  });
});

describe('decoders refuse what is not the layout', () => {
  test('a record with a wrong field count, constructor, byte length or integer range', () => {
    expect(() => decodeIdentityDatum(Data.to(new Constr(0, [])))).toThrow(/decodeIdentityDatum: record: expected 14 fields/);
    const d = Data.from(cbor('identity_datum_full')) as Constr<Data>;
    const withShortController = new Constr(0, ['ab', ...d.fields.slice(1)]);
    expect(() => decodeIdentityDatum(Data.to(withShortController))).toThrow(/record\.controller: expected 32 bytes/);
    const withNegativeEpoch = new Constr(0, [...d.fields.slice(0, 6), -1n, ...d.fields.slice(7)]);
    expect(() => decodeIdentityDatum(Data.to(withNegativeEpoch))).toThrow(/record\.subagent_epoch: integer -1 outside/);
    const withBadStatus = new Constr(0, [...d.fields.slice(0, 13), new Constr(4, [])]);
    expect(() => decodeIdentityDatum(Data.to(withBadStatus))).toThrow(/record\.status: unknown constructor 4/);
    expect(() => decodeIdentityDatum('zz')).toThrow(/expected hex/);
  });

  test('an escrow or advert with another field count', () => {
    expect(() => decodeAnyEscrowDatum(Data.to(new Constr(0, [1n])))).toThrow(/14 \(legacy\) or 16 \(identity\)/);
    expect(() => decodeAnyAdvertDatum(Data.to(new Constr(0, [1n])))).toThrow(/13 \(legacy\) or 14 \(identity\)/);
  });
});

describe('addresses, text and signers', () => {
  test('a base address goes to Plutus Data and back', () => {
    const a = plutusAddressFromBech32(OWN_ADDRESS);
    expect(a.paymentCredential.type).toBe('VerificationKey');
    expect(a.stakeCredential?.type).toBe('Inline');
    expect(plutusAddressToBech32(plutusAddressOf(plutusAddressToData(a)))).toBe(OWN_ADDRESS);
    expect(() => plutusAddressFromBech32('addr1nonsense')).toThrow(/not a valid address/);
  });

  test('text fields are kept as bytes; invalid UTF-8 has no text', () => {
    expect(utf8Hex('é')).toBe('c3a9');
    expect(textOf('c3a9')).toBe('é');
    expect(textOf('ff')).toBeNull();
  });

  test('signers compare by kind and hash', () => {
    expect(sameSigner({ type: 'ControllerSet' }, { type: 'ControllerSet' })).toBe(true);
    expect(sameSigner({ type: 'KeyHash', hash: 'aa'.repeat(28) }, { type: 'Script', hash: 'aa'.repeat(28) })).toBe(false);
    expect(sameSigner({ type: 'KeyHash', hash: 'aa'.repeat(28) }, { type: 'ControllerSet' })).toBe(false);
  });
});

describe('identity escrow lock floor', () => {
  test('is at least the legacy floor for the same terms, and at least the economic total', () => {
    const legacy = decodeIdentityEscrowDatum(cbor('escrow_datum_with_refund'));
    const economic = legacy.payment_lovelace + legacy.buyer_bond_lovelace + legacy.supplier_bond_lovelace;
    const floor = identityEscrowLockFloor({ ...legacy, state: 'Open', submitted_at: null, result_receipt_hash: null }, economic);
    const { agent_id: _a, refund: _r, ...fourteen } = legacy;
    expect(floor).toBeGreaterThanOrEqual(economic);
    expect(floor).toBeGreaterThan(escrowLockFloor({ ...fourteen, state: 'Open', submitted_at: null, result_receipt_hash: null }, 0n));
  });

  test('plutusDataMaxBytes bounds every encoding: never below the bytes Aiken writes', () => {
    for (const [name, f] of Object.entries(FIXTURES)) {
      expect(plutusDataMaxBytes(Data.from(f.cbor)), name).toBeGreaterThanOrEqual(f.cbor.length / 2);
    }
  });
});
