// Vitest port of packages/builder/test/marketplace-datum.test.ts @ 4a7b223 (Apex-Fusion/mcp-server,
// branch feat/marketplace-read-tools). node:assert/strict calls became expect() equivalents with the
// same meaning (deepEqual -> toStrictEqual, equal -> toBe, throws -> toThrow, ok(cond) -> a comparison
// matcher). The 'registry and stake datums' block below is local to this repo.
import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import {
  decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum, canonicalize,
  requestSpecHash, wirePayloadFor, promptHashForPayload, escrowLockFloor, parseOutRef, formatOutRef,
  decodeRegistryDatum, decodeStakeDatum, topLevelBytes, blake2b224Hex,
} from '../src/datum.ts';
import {
  ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_OPEN_DATUM_HEX, ESCROW_EXPECTED, ESCROW_LOCKED_LOVELACE, ESCROW_REF,
} from './fixtures/marketplace.fixture.ts';

describe('advert datum', () => {
  test('decodes the live ChandraOCR advert field by field', () => {
    expect(decodeAdvertDatum(ADVERT_DATUM_HEX)).toStrictEqual(ADVERT_EXPECTED);
  });
  test('request_spec_hash of that advert matches the live escrow datum', () => {
    expect(requestSpecHash(decodeAdvertDatum(ADVERT_DATUM_HEX))).toBe(ESCROW_EXPECTED.request_spec_hash);
  });
});

describe('escrow datum', () => {
  test('decodes the live Open escrow field by field', () => {
    expect(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX)).toStrictEqual(ESCROW_EXPECTED);
  });
  test('re-encoding reproduces the on-chain bytes exactly', () => {
    expect(encodeEscrowDatum(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX))).toBe(ESCROW_OPEN_DATUM_HEX);
    // the case of hex input never leaks into the output
    expect(encodeEscrowDatum({ ...ESCROW_EXPECTED, buyer_pkh: ESCROW_EXPECTED.buyer_pkh.toUpperCase() })).toBe(ESCROW_OPEN_DATUM_HEX);
  });
  test('re-encoding is semantically identical to the on-chain bytes', () => {
    const ours = encodeEscrowDatum(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX));
    expect(Data.from(ours)).toStrictEqual(Data.from(ESCROW_OPEN_DATUM_HEX));
  });
  test('round-trips Submitted state with both options present', () => {
    const d = { ...ESCROW_EXPECTED, submitted_at: 1786530100000, result_receipt_hash: 'ab'.repeat(32), state: 'Submitted' as const };
    expect(decodeEscrowDatum(encodeEscrowDatum(d))).toStrictEqual(d);
  });
  test('encodes Option Some fields and the Submitted tag byte-for-byte', () => {
    const submittedAt = 1786530100000;
    const receipt = 'ab'.repeat(32);
    const tail = 'd87a80d87a80d87980'; // submitted_at None, result_receipt_hash None, state Open
    expect(ESCROW_OPEN_DATUM_HEX.endsWith(tail)).toBe(true);
    const expected = ESCROW_OPEN_DATUM_HEX.slice(0, -tail.length)
      + 'd87981' + '1b' + submittedAt.toString(16).padStart(16, '0') // Some(submitted_at)
      + 'd87981' + '5820' + receipt // Some(result_receipt_hash)
      + 'd87b80'; // Submitted
    const d = { ...ESCROW_EXPECTED, submitted_at: submittedAt, result_receipt_hash: receipt, state: 'Submitted' as const };
    expect(encodeEscrowDatum(d)).toBe(expected);
  });
  test('bytestring headers use the shortest definite form across the 24 / 256 boundaries', () => {
    const capHex = '5821' + Buffer.from(ESCROW_EXPECTED.capability_id, 'utf8').toString('hex');
    const at = ESCROW_OPEN_DATUM_HEX.indexOf(capHex);
    expect(at).toBeGreaterThan(0);
    const head = ESCROW_OPEN_DATUM_HEX.slice(0, at);
    const tail = ESCROW_OPEN_DATUM_HEX.slice(at + capHex.length);
    for (const [len, header] of [[0, '40'], [23, '57'], [24, '5818'], [255, '58ff'], [256, '590100']] as const) {
      const d = { ...ESCROW_EXPECTED, capability_id: 'a'.repeat(len) };
      expect(encodeEscrowDatum(d), `${len}-byte capability_id`).toBe(head + header + '61'.repeat(len) + tail);
    }
  });
  test('refuses values it cannot frame instead of emitting a corrupt datum', () => {
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, payment_lovelace: -1n })).toThrow(/uint64/);
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, payment_lovelace: 2n ** 64n })).toThrow(/uint64/);
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, prompt_hash: 'abc' })).toThrow(/even-length hex/);
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, state: 'Bogus' as never })).toThrow(/unknown state/);
  });
  test('lock floor never goes below the economic total and covers the live lock', () => {
    const open = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
    const economic = open.payment_lovelace + open.buyer_bond_lovelace + open.supplier_bond_lovelace;
    const floor = escrowLockFloor(open, economic);
    expect(floor).toBeGreaterThanOrEqual(economic);
    expect(floor, 'the floor must equal the lovelace the marketplace actually locked for this datum').toBe(ESCROW_LOCKED_LOVELACE);
    expect(floor, `floor ${floor} is far below the live lock ${ESCROW_LOCKED_LOVELACE}`).toBeGreaterThanOrEqual(ESCROW_LOCKED_LOVELACE - 100_000n);
    expect(floor, `floor ${floor} over-locks against the live lock ${ESCROW_LOCKED_LOVELACE}`).toBeLessThanOrEqual(ESCROW_LOCKED_LOVELACE + 200_000n);
  });
});

describe('hashing', () => {
  test('canonicalize sorts keys and drops undefined', () => {
    expect(canonicalize({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
  });
  test('wire payload is the one-element message array and prompt hash is sha256 of it', () => {
    expect(wirePayloadFor('hello')).toBe('[{"content":"hello","role":"user"}]');
    const expected = createHash('sha256').update('[{"content":"hello","role":"user"}]', 'utf8').digest('hex');
    expect(promptHashForPayload('hello')).toBe(expected);
  });
  test('out refs parse and format', () => {
    expect(parseOutRef(ESCROW_REF)).toStrictEqual({ txHash: ESCROW_REF.slice(0, 64), outputIndex: 0 });
    expect(formatOutRef(ESCROW_REF.slice(0, 64), 0)).toBe(ESCROW_REF);
    expect(() => parseOutRef('nope#1')).toThrow(/out ref/);
  });
});

describe('registry and stake datums', () => {
  // Module-3 stake datum of ChandraOCR (05563e75…#0), captured 2026-10-13.
  const STAKE_FIELDS = { asset: '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', owner: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9', amount: 10_000_000n, caps: ['ocr.page.extract.chandra-ocr-2.v1', 'document-extraction'], last_updated: 1786092804000, history_points: 0n };
  test('stake datum round-trips through the known shape', () => {
    const hex = Data.to(new Constr(0, [STAKE_FIELDS.asset, new Constr(0, [STAKE_FIELDS.owner]), STAKE_FIELDS.amount, STAKE_FIELDS.caps.map(fromText), BigInt(STAKE_FIELDS.last_updated), STAKE_FIELDS.history_points]));
    expect(decodeStakeDatum(hex)).toEqual({ agent_asset_name: STAKE_FIELDS.asset, owner_pkh: STAKE_FIELDS.owner, stake_lovelace: STAKE_FIELDS.amount, capabilities: STAKE_FIELDS.caps, last_updated: STAKE_FIELDS.last_updated, history_points: 0 });
  });
  test('registry datum decodes the seven fields', () => {
    const hex = Data.to(new Constr(0, [new Constr(0, ['ab'.repeat(28)]), fromText('Name'), fromText('Desc'), [fromText('a.b.v1')], fromText('fw'), fromText('https://e.example'), 1786092405791n]));
    expect(decodeRegistryDatum(hex)).toEqual({ owner_pkh: 'ab'.repeat(28), name: 'Name', description: 'Desc', capabilities: ['a.b.v1'], framework: 'fw', endpoint: 'https://e.example', registered_at: 1786092405791 });
  });
  test('topLevelBytes lists bytes fields of an unknown constructor', () => {
    const hex = Data.to(new Constr(0, ['aa'.repeat(32), new Constr(0, ['bb'.repeat(28)]), 5n]));
    expect(topLevelBytes(hex)).toEqual(['aa'.repeat(32), 'bb'.repeat(28)]);
  });
});

describe('blake2b224Hex', () => {
  // Known answers from Python hashlib.blake2b(digest_size=28): an implementation independent of @noble/hashes.
  test('hashes hex input to a 28-byte digest', () => {
    expect(blake2b224Hex('')).toBe('836cc68931c2e4e3e838602eca1902591d216837bafddfe6f0c8cb07');
    expect(blake2b224Hex('616263')).toBe('9bd237b02a29e43bdd6738afa5b53ff0eee178d6210b618e4511aec8');
    expect(blake2b224Hex('00'.repeat(32))).toBe('f9dca21a6c826ec8acb4cf395cbc24351937bfe6560b2683ab8b415f');
  });
});
