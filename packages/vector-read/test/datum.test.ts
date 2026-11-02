// Vitest port of packages/builder/test/marketplace-datum.test.ts at ef374f8 (Apex-Fusion/mcp-server, branch
// feat/identity-registry; first ported at 94b8f41, PR 2, and changed since only in one regex escape). node:assert/strict
// calls became expect() equivalents with the same meaning (deepEqual -> toStrictEqual, equal -> toBe, throws -> toThrow,
// ok(cond) -> a comparison matcher). The source tests the identity layouts in identity-codec.test.ts (ported to
// test/identity-codec.test.ts). Local to this repo: the 'identity layouts on the live terms' block, the sha256BytesHex
// known answers (moved from packages/buyer-core with the function), the 'stake datums' block and the blocks after it. Two
// tests of the 4a7b223 port that the source has since dropped as redundant are kept here (the semantic-equality test and
// the two lock-floor bounds).
import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import {
  decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum, canonicalize,
  requestSpecHash, wirePayloadFor, promptHashForPayload, escrowLockFloor, parseOutRef, formatOutRef,
  advertTextFieldsRoundTrip, decodeStakeDatum, topLevelBytes, blake2b224Hex, sha256Utf8Hex, sha256BytesHex,
  decodeIdentityAdvertDatum, encodeIdentityAdvertDatum, decodeAnyAdvertDatum, decodeIdentityEscrowDatum, encodeIdentityEscrowDatum,
  decodeAnyEscrowDatum, identityEscrowDatumToData, identityEscrowLockFloor,
} from '../src/datum.ts';
import type { IdentityAdvertDatum, IdentityEscrowDatum } from '../src/datum.ts';
import {
  ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_OPEN_DATUM_HEX, ESCROW_EXPECTED, ESCROW_LOCKED_LOVELACE, ESCROW_REF,
} from './fixtures/marketplace.fixture.ts';

describe('advert datum', () => {
  test('decodes the live ChandraOCR advert field by field', () => {
    expect(decodeAdvertDatum(ADVERT_DATUM_HEX)).toStrictEqual(ADVERT_EXPECTED);
  });
  test('decodes Lucid-compact framing too (third-party suppliers using Lucid or Mesh emit d8799f…ff)', () => {
    const compact = Data.to(Data.from(ADVERT_DATUM_HEX));
    expect(compact.startsWith('d8799f'), 'indefinite-length framing, not the on-chain definite one').toBe(true);
    expect(decodeAdvertDatum(compact)).toStrictEqual(ADVERT_EXPECTED);
  });
  test('request_spec_hash of that advert matches the live escrow datum', () => {
    expect(requestSpecHash(decodeAdvertDatum(ADVERT_DATUM_HEX))).toBe(ESCROW_EXPECTED.request_spec_hash);
  });
  // max_output_tokens and max_processing_ms become JS numbers that later code does arithmetic on (deliver_by = now + window).
  // Past 2^53 a Number silently rounds, so the decoder refuses instead of handing on a wrong duration.
  test('max_output_tokens and max_processing_ms must be safe integers, and the error names the field', () => {
    const withField = (index: number, value: bigint) => { const c = Data.from(ADVERT_DATUM_HEX) as Constr<Data>; c.fields[index] = value; return Data.to(c); };
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    for (const [index, name] of [[3, 'max_output_tokens'], [4, 'max_processing_ms']] as const) {
      expect(decodeAdvertDatum(withField(index, MAX_SAFE))[name], `${name}: 2^53 - 1 is fine`).toBe(Number.MAX_SAFE_INTEGER);
      expect(decodeAdvertDatum(withField(index, -MAX_SAFE))[name], `${name}: the decoder stays lenient about sign`).toBe(-Number.MAX_SAFE_INTEGER);
      for (const bad of [MAX_SAFE + 1n, MAX_SAFE + 2n, -MAX_SAFE - 1n, 2n ** 64n, 10n ** 40n]) {
        expect(() => decodeAdvertDatum(withField(index, bad)), `${name} = ${bad}`).toThrow(new RegExp(`advert\\.${name}: .*safe`));
      }
    }
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
  test('decodes Lucid-compact framing too (third-party suppliers using Lucid or Mesh emit d8799f…ff)', () => {
    const compact = Data.to(Data.from(ESCROW_OPEN_DATUM_HEX));
    expect(compact.startsWith('d8799f'), 'indefinite-length framing, not the on-chain definite one').toBe(true);
    expect(decodeEscrowDatum(compact)).toStrictEqual(ESCROW_EXPECTED);
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
  test('bytestring headers use the shortest definite form across the 24 / 256 / 65,536 boundaries', () => {
    const capHex = '5821' + Buffer.from(ESCROW_EXPECTED.capability_id, 'utf8').toString('hex');
    const at = ESCROW_OPEN_DATUM_HEX.indexOf(capHex);
    expect(at).toBeGreaterThan(0);
    const head = ESCROW_OPEN_DATUM_HEX.slice(0, at);
    const tail = ESCROW_OPEN_DATUM_HEX.slice(at + capHex.length);
    for (const [len, header] of [[0, '40'], [23, '57'], [24, '5818'], [255, '58ff'], [256, '590100'], [65_535, '59ffff']] as const) {
      const d = { ...ESCROW_EXPECTED, capability_id: 'a'.repeat(len) };
      expect(encodeEscrowDatum(d), `${len}-byte capability_id`).toBe(head + header + '61'.repeat(len) + tail);
    }
  });
  test('refuses values it cannot frame instead of emitting a corrupt datum', () => {
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, payment_lovelace: -1n })).toThrow(/uint64/);
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, payment_lovelace: 2n ** 64n })).toThrow(/uint64/);
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, prompt_hash: 'abc' })).toThrow(/even-length hex/);
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, state: 'Bogus' as never })).toThrow(/unknown state/);
    // the 64 KiB bytestring guard: 65,535 bytes is the last that fits the 59 xx xx header (covered above)
    expect(() => encodeEscrowDatum({ ...ESCROW_EXPECTED, capability_id: 'a'.repeat(65_536) })).toThrow(/too long/);
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
  // Local (moved from packages/buyer-core with the function): the source gained sha256BytesHex after 94b8f41 for the manifest a supplier serves.
  test('sha256BytesHex hashes bytes as they are, in lower-case hex', () => {
    expect(sha256BytesHex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256BytesHex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('sha256BytesHex is not the hash of the decoded text when the bytes are not valid UTF-8', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61]);
    expect(sha256BytesHex(bytes)).not.toBe(sha256Utf8Hex(new TextDecoder().decode(bytes)));
  });
});

// decodeAdvertDatum reads the four text fields with toText, which is lossy for bytes that are not UTF-8 (invalid
// sequences become U+FFFD, a leading BOM is dropped). Writing such an advert's capability id into an escrow datum
// would produce different bytes than the advert holds, so the Post builder checks the raw bytes first.
describe('advertTextFieldsRoundTrip', () => {
  const TEXT_FIELDS = { capability_id: 1, model: 2, endpoint_url: 8, detail_uri: 9 } as const;
  const withField = (index: number, value: unknown): string => {
    const c = Data.from(ADVERT_DATUM_HEX) as Constr<Data>;
    c.fields[index] = value as Data;
    return Data.to(c);
  };
  test('the live advert round-trips, empty detail_uri included', () => {
    expect(advertTextFieldsRoundTrip(ADVERT_DATUM_HEX)).toBe(true);
  });
  test('valid multi-byte UTF-8 round-trips in every text field', () => {
    const text = fromText('café ☕ 日本語 🚀');
    for (const [name, index] of Object.entries(TEXT_FIELDS)) expect(advertTextFieldsRoundTrip(withField(index, text)), name).toBe(true);
  });
  test('a long text field (chunked bytestring in Lucid-compact framing) round-trips', () => {
    const datum = withField(TEXT_FIELDS.endpoint_url, fromText('https://' + 'a'.repeat(200) + '.example'));
    expect(datum.startsWith('d8799f'), 'Lucid-compact framing').toBe(true);
    expect(advertTextFieldsRoundTrip(datum)).toBe(true);
  });
  test('a lone ff byte in any of the four text fields does not', () => {
    for (const [name, index] of Object.entries(TEXT_FIELDS)) expect(advertTextFieldsRoundTrip(withField(index, 'ff')), name).toBe(false);
  });
  test('other byte sequences toText cannot reproduce do not: truncated, overlong, surrogate, leading BOM, mid-string', () => {
    for (const hex of ['c3', 'c080', 'eda080', 'efbbbf61', '61ff62']) expect(advertTextFieldsRoundTrip(withField(TEXT_FIELDS.model, hex)), hex).toBe(false);
  });
  test('anything that is not a well-formed advert datum is false, not a throw', () => {
    for (const hex of [ESCROW_OPEN_DATUM_HEX, 'd87980', 'ff', 'zz', '']) expect(advertTextFieldsRoundTrip(hex), JSON.stringify(hex)).toBe(false);
    expect(advertTextFieldsRoundTrip(withField(TEXT_FIELDS.capability_id, 5n)), 'integer where bytes belong').toBe(false);
  });
});

describe('stake datums', () => {
  // Module-3 stake datum of ChandraOCR (05563e75…#0), captured 2026-10-13.
  const STAKE_FIELDS = { asset: '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', owner: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9', amount: 10_000_000n, caps: ['ocr.page.extract.chandra-ocr-2.v1', 'document-extraction'], last_updated: 1786092804000, history_points: 0n };
  test('stake datum round-trips through the known shape', () => {
    const hex = Data.to(new Constr(0, [STAKE_FIELDS.asset, new Constr(0, [STAKE_FIELDS.owner]), STAKE_FIELDS.amount, STAKE_FIELDS.caps.map(fromText), BigInt(STAKE_FIELDS.last_updated), STAKE_FIELDS.history_points]));
    expect(decodeStakeDatum(hex)).toEqual({ agent_asset_name: STAKE_FIELDS.asset, owner_pkh: STAKE_FIELDS.owner, stake_lovelace: STAKE_FIELDS.amount, capabilities: STAKE_FIELDS.caps, last_updated: STAKE_FIELDS.last_updated, history_points: 0 });
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

// Local to this repo. docs/HIRE.md section 3 says a lock is exactly price plus both bonds, because the ledger's minimum for the escrow
// output is between 2.2 and 2.3 units whatever the agent, and the smallest lock is 3. The minimum grows with the length of the capability id.
describe('escrow output minimum of the service agents', () => {
  test('is between 2.2 and 2.3 units for each agent, so its lock is exactly price plus both bonds', () => {
    const open = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
    const agents = [['identity.history.report.v1', 1n], ['audio.transcript.snippets.v1', 2n], ['research.advocate.onesided.v1', 3n], ['document.pipeline.ocr-summary.v1', 5n]] as const;
    for (const [capability_id, price] of agents) {
      const datum = { ...open, capability_id, payment_lovelace: price * 1_000_000n, buyer_bond_lovelace: 1_000_000n, supplier_bond_lovelace: 1_000_000n };
      const minimum = escrowLockFloor(datum, 1n);
      expect(minimum, `${capability_id}: ${minimum}`).toBeGreaterThanOrEqual(2_200_000n);
      expect(minimum, `${capability_id}: ${minimum}`).toBeLessThanOrEqual(2_300_000n);
      const economic = (price + 2n) * 1_000_000n;
      expect(escrowLockFloor(datum, economic), `${capability_id}: the lock`).toBe(economic);
    }
  });
});

// Local to this repo. The identity layouts of did:vector Part 2 sections 6.1 and 6.2 on the terms of the live escrow and advert: the
// legacy fields, then agent_id (and, for the escrow, the refund). The source tests them on the Aiken fixtures (test/identity-codec.test.ts).
describe('identity layouts on the live terms', () => {
  const AGENT_ID = 'ae'.repeat(32);
  const ADVERT: IdentityAdvertDatum = { ...ADVERT_EXPECTED, status: 'Active', agent_id: AGENT_ID };
  // The refund goes to the enterprise address of the buyer key, with an inline datum: both parts of a refund are written.
  const REFUND = { address: { paymentCredential: { type: 'VerificationKey' as const, hash: ESCROW_EXPECTED.buyer_pkh }, stakeCredential: null }, datum: Data.to(new Constr(0, [])) };
  const ESCROW: IdentityEscrowDatum = { ...ESCROW_EXPECTED, state: 'Open', agent_id: AGENT_ID, refund: REFUND };
  const ECONOMIC = ESCROW.payment_lovelace + ESCROW.buyer_bond_lovelace + ESCROW.supplier_bond_lovelace;

  test('the 14-field advert and the 16-field escrow decode to what was encoded, and encode back to the same bytes', () => {
    const advertHex = encodeIdentityAdvertDatum(ADVERT);
    expect((Data.from(advertHex) as Constr<Data>).fields).toHaveLength(14);
    expect(decodeIdentityAdvertDatum(advertHex)).toStrictEqual(ADVERT);
    expect(encodeIdentityAdvertDatum(decodeIdentityAdvertDatum(advertHex))).toBe(advertHex);
    for (const escrow of [ESCROW, { ...ESCROW, refund: null }, { ...ESCROW, refund: { ...REFUND, datum: null } }, { ...ESCROW, submitted_at: 1786530100000, result_receipt_hash: 'ab'.repeat(32), state: 'Submitted' as const }]) {
      const escrowHex = encodeIdentityEscrowDatum(escrow);
      expect((Data.from(escrowHex) as Constr<Data>).fields).toHaveLength(16);
      expect(decodeIdentityEscrowDatum(escrowHex)).toStrictEqual(escrow);
      expect(encodeIdentityEscrowDatum(decodeIdentityEscrowDatum(escrowHex))).toBe(escrowHex);
    }
  });
  test('each decoder refuses the other layout of its kind: 13 and 14 advert fields, 14 and 16 escrow fields', () => {
    expect(() => decodeAdvertDatum(encodeIdentityAdvertDatum(ADVERT))).toThrow('advert: expected Constr 0 with 13 fields, got 0/14');
    expect(() => decodeIdentityAdvertDatum(ADVERT_DATUM_HEX)).toThrow('advert: expected Constr 0 with 14 fields, got 0/13');
    expect(() => decodeEscrowDatum(encodeIdentityEscrowDatum(ESCROW))).toThrow('escrow: expected Constr 0 with 14 fields, got 0/16');
    expect(() => decodeIdentityEscrowDatum(ESCROW_OPEN_DATUM_HEX)).toThrow('escrow: expected Constr 0 with 16 fields, got 0/14');
  });
  test('decodeAnyAdvertDatum and decodeAnyEscrowDatum tell the layouts apart by field count and refuse any other count', () => {
    expect(decodeAnyAdvertDatum(ADVERT_DATUM_HEX)).toStrictEqual({ layout: 'legacy', datum: ADVERT_EXPECTED });
    expect(decodeAnyAdvertDatum(encodeIdentityAdvertDatum(ADVERT))).toStrictEqual({ layout: 'identity', datum: ADVERT });
    expect(decodeAnyEscrowDatum(ESCROW_OPEN_DATUM_HEX)).toStrictEqual({ layout: 'legacy', datum: ESCROW_EXPECTED });
    expect(decodeAnyEscrowDatum(encodeIdentityEscrowDatum(ESCROW))).toStrictEqual({ layout: 'identity', datum: ESCROW });
    const withFields = (n: number) => Data.to(new Constr(0, Array.from({ length: n }, () => 0n)));
    expect(() => decodeAnyAdvertDatum(withFields(15))).toThrow('advert: expected Constr 0 with 13 (legacy) or 14 (identity) fields, got 0/15');
    expect(() => decodeAnyEscrowDatum(withFields(15))).toThrow('escrow: expected Constr 0 with 14 (legacy) or 16 (identity) fields, got 0/15');
    expect(() => decodeAnyEscrowDatum(Data.to(new Constr(1, [])))).toThrow(/got 1\/0/);
  });
  test('the encoders refuse an agent_id that is not 32 bytes of lowercase hex', () => {
    for (const agent_id of ['AE'.repeat(32), 'ae'.repeat(31), '']) {
      expect(() => encodeIdentityAdvertDatum({ ...ADVERT, agent_id })).toThrow('advert.agent_id: expected 32 bytes of lowercase hex');
      expect(() => encodeIdentityEscrowDatum({ ...ESCROW, agent_id })).toThrow('escrow.agent_id: expected 32 bytes of lowercase hex');
    }
  });
  test('advertTextFieldsRoundTrip reads the 14-field advert as it reads the 13-field one', () => {
    expect(advertTextFieldsRoundTrip(encodeIdentityAdvertDatum(ADVERT))).toBe(true);
    const withModel = (hex: string) => { const c = Data.from(encodeIdentityAdvertDatum(ADVERT)) as Constr<Data>; c.fields[2] = hex; return Data.to(c); };
    expect(advertTextFieldsRoundTrip(withModel('ff'))).toBe(false);
    const fifteen = Data.from(encodeIdentityAdvertDatum(ADVERT)) as Constr<Data>;
    expect(advertTextFieldsRoundTrip(Data.to(new Constr(0, [...fifteen.fields, 0n]))), '15 fields').toBe(false);
  });
  test('identityEscrowLockFloor is at least the economic total and at least the legacy floor of the same terms', () => {
    const floor = identityEscrowLockFloor(ESCROW, ECONOMIC);
    expect(floor).toBeGreaterThanOrEqual(ECONOMIC);
    expect(floor).toBeGreaterThanOrEqual(escrowLockFloor(ESCROW_EXPECTED, ECONOMIC));
    // Below the floor, the identity escrow's larger Submitted datum needs more than the legacy one.
    expect(identityEscrowLockFloor(ESCROW, 0n)).toBeGreaterThan(escrowLockFloor(ESCROW_EXPECTED, 0n));
    // A total above the floor is the lock as it is.
    expect(identityEscrowLockFloor(ESCROW, 100_000_000n)).toBe(100_000_000n);
    // The Data the floor is sized from is the escrow's own.
    expect(Data.to(identityEscrowDatumToData(ESCROW))).toBe(encodeIdentityEscrowDatum(ESCROW));
  });
});
