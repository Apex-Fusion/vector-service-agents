// The CBOR check at the places where this package decodes a datum, a transaction or metadata that it did not build: the three wrappers of src/guarded-decode.ts,
// each datum decoder of the marketplace datum module, the identity codecs, the stake codec, and the three plain TypeScript decoders that src/identity.ts wraps.
// The rule: CBOR that is nested deeper than 64 levels is refused before it is decoded. For each place the tests show three things. A value of 65 levels, and one
// of 5,000 levels, are refused and never reach the decoder library. A value of 64 levels goes through to the library. A normal call in the same process works
// after the refusals.
//
// A library decoder is replaced by a watch for the length of a test (fixtures/decoder-watch.ts). The watch counts each call and throws a marked Error for a value
// that nests past the limit, so no deep value reaches the real library, and a missing check shows as a failed test and not as a library that fails.
import { afterEach, describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CML, Data } from '@lucid-evolution/lucid';
import { CborGuardError, MAX_CBOR_DEPTH } from '../src/cbor-depth.ts';
import { assertPlutusDataHex, decodeMetadatum, decodePlutusData, decodeTransaction } from '../src/guarded-decode.ts';
import {
  advertTextFieldsRoundTrip, decodeAdvertDatum, decodeAnyAdvertDatum, decodeAnyEscrowDatum, decodeEscrowDatum, decodeIdentityAdvertDatum, decodeIdentityEscrowDatum,
  encodeIdentityAdvertDatum, encodeIdentityEscrowDatum, identityEscrowDatumToData, topLevelBytes,
} from '../src/datum.ts';
import type { IdentityEscrowDatum } from '../src/datum.ts';
import { decodeDelegationDatum, decodeIdentityDatum as decodeRecordDatum, decodeLegacyDatum as decodeLegacyRecordDatum } from '../src/identity-codec.ts';
import { decodeCrossRefs, decodeStakeDatum, decodeStakeParams, encodeStakeDatum } from '../src/reputation-datum.ts';
import { decodeIdentityDatum, decodeLegacyDatum, decodePlutusDataHex } from '../src/identity.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_EXPECTED, ESCROW_OPEN_DATUM_HEX } from './fixtures/marketplace.fixture.ts';
import { watchDecoder } from './fixtures/decoder-watch.ts';

const IDENTITY_FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/identity-cbor-fixtures.json', import.meta.url), 'utf8')).fixtures as Record<string, { cbor: string }>;
const AGENT_ID = 'ae'.repeat(32);

/** CBOR hex of an array nested `levels` levels deep, with the integer 0 inside: valid Plutus data, and valid metadata. */
const nested = (levels: number): string => `${'81'.repeat(levels)}00`;
/** A value that is far past the limit. */
const DEEP = nested(5000);
/** The head of a byte string of `hex.length / 2` bytes, and the bytes. */
function bytesOf(hex: string): string {
  const length = hex.length / 2;
  const head = length < 24 ? (0x40 + length).toString(16).padStart(2, '0') : length < 256 ? `58${length.toString(16).padStart(2, '0')}` : `59${length.toString(16).padStart(4, '0')}`;
  return `${head}${hex}`;
}
/** A transaction with one output that holds `datum` inline: [body, witness set, is valid, no auxiliary data]. */
function transactionWithDatum(datum: string): string {
  const input = `825820${'22'.repeat(32)}00`;
  const output = `a300581d61${'11'.repeat(28)}011a001e8480028201d818${bytesOf(datum)}`;
  return `84a30081${input}0181${output}0200a0f5f6`;
}
// The levels around the datum of an output: the transaction, the body, the outputs, the output, the datum option and the tag.
const DATUM_LEVELS_AT_LIMIT = MAX_CBOR_DEPTH - 6;
const tooDeep = (what: string): string => `${what} is nested deeper than 64 levels.`;

afterEach(() => { vi.restoreAllMocks(); });

describe('the wrappers of guarded-decode.ts', () => {
  test('Plutus data: 64 levels are decoded, more are refused before Data.from, and Data.from works after', () => {
    const watch = watchDecoder(Data, 'from');
    expect(decodePlutusData(nested(64))).toBeInstanceOf(Array);
    expect(() => decodePlutusData(nested(65))).toThrow(tooDeep('The datum'));
    expect(() => decodePlutusData(DEEP)).toThrow(tooDeep('The datum'));
    expect(() => decodePlutusData(DEEP, 'The value')).toThrow(tooDeep('The value'));
    expect(() => assertPlutusDataHex(DEEP)).toThrow(tooDeep('The datum'));
    expect(watch.reached()).toBe(0);
    expect(watch.calls()).toBe(1);
    expect(decodePlutusData('d87980').constructor.name).toBe('Constr');
    expect(decodePlutusData('9f0102ff')).toStrictEqual([1n, 2n]);
  });

  test('Plutus data: hex that is not whole bytes, CBOR that is not well-formed, and a float or a simple value are refused', () => {
    const watch = watchDecoder(Data, 'from');
    for (const hex of ['abc', 'zz', '', 'ff', '9f00', 'fb0000000000000000', '81f6']) {
      expect(() => decodePlutusData(hex), hex).toThrow(CborGuardError);
    }
    expect(watch.calls()).toBe(0);
  });

  test('a transaction: 64 levels are decoded, more are refused before CML, and CML works after', () => {
    const watch = watchDecoder(CML.Transaction, 'from_cbor_hex');
    expect(decodeTransaction(transactionWithDatum(nested(DATUM_LEVELS_AT_LIMIT))).body().fee()).toBe(0n);
    expect(() => decodeTransaction(transactionWithDatum(nested(DATUM_LEVELS_AT_LIMIT + 1)))).toThrow(tooDeep('The transaction'));
    expect(() => decodeTransaction(transactionWithDatum(DEEP))).toThrow(tooDeep('The transaction'));
    expect(() => decodeTransaction(transactionWithDatum(DEEP), 'txCbor')).toThrow(tooDeep('txCbor'));
    expect(watch.reached()).toBe(0);
    expect(watch.calls()).toBe(1);
    expect(decodeTransaction(transactionWithDatum('d87980')).body().outputs().len()).toBe(1);
  });

  test('metadata: 64 levels are decoded, more are refused before CML, and CML works after', () => {
    const watch = watchDecoder(CML.TransactionMetadatum, 'from_cbor_bytes');
    expect(decodeMetadatum(Buffer.from(nested(64), 'hex'))).toBeDefined();
    expect(() => decodeMetadatum(Buffer.from(nested(65), 'hex'))).toThrow(tooDeep('The metadata'));
    expect(() => decodeMetadatum(Buffer.from(DEEP, 'hex'), 'The label')).toThrow(tooDeep('The label'));
    expect(watch.reached()).toBe(0);
    expect(watch.calls()).toBe(1);
    expect(decodeMetadatum(Buffer.from('a1010a', 'hex'))).toBeDefined();
  });
});

/** A decoder of this package that reads a datum with Lucid, with a datum that it accepts. */
interface Site { name: string; read: (hex: string) => unknown; valid: string }
const ADVERT = { ...ADVERT_EXPECTED, status: 'Active' as const, agent_id: AGENT_ID };
const ESCROW: IdentityEscrowDatum = { ...ESCROW_EXPECTED, state: 'Open', agent_id: AGENT_ID, refund: null };
const STAKE_HEX = encodeStakeDatum({
  agent_did: AGENT_ID, owner_pkh: 'cd'.repeat(28), stake_amount: 10_000_000n, staked_capabilities: [Buffer.from('ocr.page.extract.v1').toString('hex')], last_updated: 1_794_745_920_000,
  history_points: 0n, challenge_locks: [], stake_id: { txHash: 'ab'.repeat(32), outputIndex: 1 },
});
const LUCID_SITES: Site[] = [
  { name: 'decodeAdvertDatum', read: decodeAdvertDatum, valid: ADVERT_DATUM_HEX },
  { name: 'decodeIdentityAdvertDatum', read: decodeIdentityAdvertDatum, valid: encodeIdentityAdvertDatum(ADVERT) },
  { name: 'decodeAnyAdvertDatum', read: decodeAnyAdvertDatum, valid: ADVERT_DATUM_HEX },
  { name: 'decodeEscrowDatum', read: decodeEscrowDatum, valid: ESCROW_OPEN_DATUM_HEX },
  { name: 'decodeIdentityEscrowDatum', read: decodeIdentityEscrowDatum, valid: encodeIdentityEscrowDatum(ESCROW) },
  { name: 'decodeAnyEscrowDatum', read: decodeAnyEscrowDatum, valid: ESCROW_OPEN_DATUM_HEX },
  { name: 'topLevelBytes', read: topLevelBytes, valid: ADVERT_DATUM_HEX },
  { name: 'decodeStakeDatum', read: decodeStakeDatum, valid: STAKE_HEX },
  { name: 'decodeStakeParams', read: decodeStakeParams, valid: '' },
  { name: 'decodeCrossRefs', read: decodeCrossRefs, valid: '' },
  { name: 'identity-codec decodeIdentityDatum', read: decodeRecordDatum, valid: IDENTITY_FIXTURES.identity_datum_full.cbor },
  { name: 'identity-codec decodeLegacyDatum', read: decodeLegacyRecordDatum, valid: IDENTITY_FIXTURES.legacy_datum.cbor },
  { name: 'identity-codec decodeDelegationDatum', read: decodeDelegationDatum, valid: IDENTITY_FIXTURES.delegation_datum.cbor },
];

describe('each datum decoder that reads Lucid', () => {
  test.each(LUCID_SITES)('$name refuses 65 levels and 5,000 levels before Data.from, and passes 64 levels to it', ({ read, valid }) => {
    const watch = watchDecoder(Data, 'from');
    for (const hex of [nested(65), DEEP]) expect(() => read(hex), hex.slice(0, 8)).toThrow();
    expect(watch.calls()).toBe(0);
    expect(watch.reached()).toBe(0);
    // At the limit the check lets the value through, and the decoder refuses it for its own reason or reads it: Data.from is called once or more.
    try { read(nested(64)); } catch { /* not a datum of this type */ }
    expect(watch.calls()).toBeGreaterThan(0);
    expect(watch.reached()).toBe(0);
    // A datum that the decoder reads is still read after the refusals.
    if (valid !== '') expect(() => read(valid)).not.toThrow();
  });

  test('each refusal is an ordinary Error that a caller can catch, and its text does not repeat the datum', () => {
    for (const site of LUCID_SITES) {
      let refusal: unknown;
      try { site.read(nested(65)); } catch (err) { refusal = err; }
      expect(refusal, site.name).toBeInstanceOf(Error);
      expect((refusal as Error).message, site.name).not.toContain('8181818181');
    }
  });

  test('advertTextFieldsRoundTrip answers false for a datum that nests too deep, and Data.from does not run', () => {
    const watch = watchDecoder(Data, 'from');
    expect(advertTextFieldsRoundTrip(nested(65))).toBe(false);
    expect(advertTextFieldsRoundTrip(DEEP)).toBe(false);
    expect(watch.calls()).toBe(0);
    expect(advertTextFieldsRoundTrip(ADVERT_DATUM_HEX)).toBe(true);
    expect(watch.calls()).toBeGreaterThan(0);
  });

  test('identityEscrowDatumToData reads the datum of a refund through the check', () => {
    const watch = watchDecoder(Data, 'from');
    const refund = (datum: string) => ({ ...ESCROW, refund: { address: { paymentCredential: { type: 'VerificationKey' as const, hash: ESCROW_EXPECTED.buyer_pkh }, stakeCredential: null }, datum } });
    expect(() => identityEscrowDatumToData(refund(nested(65)))).toThrow(tooDeep('The datum'));
    expect(() => identityEscrowDatumToData(refund(DEEP))).toThrow(tooDeep('The datum'));
    expect(watch.calls()).toBe(0);
    expect(() => identityEscrowDatumToData(refund('d87980'))).not.toThrow();
    expect(watch.calls()).toBe(1);
    expect(watch.reached()).toBe(0);
  });

  test('topLevelBytes passes 64 levels and refuses 65 with the refusal of the check', () => {
    expect(topLevelBytes(nested(64))).toStrictEqual([]);
    expect(() => topLevelBytes(nested(65))).toThrow(tooDeep('The datum'));
  });

  test('the stake codec keeps its own refusal texts: a datum that is refused by the check is "not Plutus data" there', () => {
    expect(() => decodeStakeDatum(nested(65))).toThrow('not a stake datum (not Plutus data)');
    expect(() => decodeStakeParams(nested(65))).toThrow('not the module parameters datum (not Plutus data)');
    expect(() => decodeCrossRefs(nested(65))).toThrow('not the cross-validator references datum (not Plutus data)');
  });
});

describe('the plain TypeScript decoders of the records (src/identity.ts)', () => {
  // These decoders read in plain TypeScript, with a limit of their own at 1,000 levels. A value of 65 levels decodes without the check, so a refusal at 65 levels
  // can only come from the check that src/identity.ts puts before them.
  test('decodePlutusDataHex reads 64 levels, and refuses 65 levels and 5,000 levels with the refusal of the check', () => {
    expect(decodePlutusDataHex(nested(64))).toMatchObject({ kind: 'list' });
    expect(() => decodePlutusDataHex(nested(65))).toThrow(tooDeep('The datum'));
    expect(() => decodePlutusDataHex(DEEP)).toThrow(tooDeep('The datum'));
    expect(decodePlutusDataHex('d87980')).toMatchObject({ kind: 'constr', index: 0n });
  });

  test('decodeIdentityDatum and decodeLegacyDatum refuse a datum that nests too deep as a datum that does not decode, and read the fixtures', () => {
    for (const read of [decodeIdentityDatum, decodeLegacyDatum]) {
      expect(() => read(nested(65))).toThrow(tooDeep('The record datum'));
      expect(() => read(DEEP)).toThrow(tooDeep('The record datum'));
    }
    expect(decodeIdentityDatum(IDENTITY_FIXTURES.identity_datum_full.cbor)).toBeDefined();
    expect(decodeLegacyDatum(IDENTITY_FIXTURES.legacy_datum.cbor)).toBeDefined();
  });

  test('a datum that does not nest deeply but is not a record is refused by the decoder as before', () => {
    expect(() => decodeIdentityDatum('d87980')).toThrow();
    expect(() => decodeLegacyDatum('00')).toThrow();
    expect(() => decodePlutusDataHex('')).toThrow();
  });
});
