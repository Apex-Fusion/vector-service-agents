// Tests of src/reputation-datum.ts, the stake codec of the Module-3 deployment on the identity registry. The file is copied from Apex-Fusion/mcp-server at
// 06a9df1 (see VENDORED-FROM.md). The stake datum, stake token and encoder tests are those of packages/builder/test/reputation-datum.test.ts at that commit,
// ported from node:test to vitest. The other tests of that file read the deployment values of reputation-build.ts and captured chain data, which this package
// does not carry. Local: the table of refusals (one row for each rule of decodeStakeDatum, each with its accepted twin) and the tests of the two readers that
// the file also holds.
//
// The stake datum below is a recorded datum: the inline datum of the stake output 48d4ce7b…#0 on Vector mainnet, as Koios gave it on 2026-11-23 (utxo_info, extended).
// The output holds the stake of a test record of the Foundation. Its bytes pin the codec to what the chain holds. When the layout of the datum changes, take the inline
// datum of a stake of the new layout from Koios, and put it in RECORDED_STAKE_HEX and the fields that it decodes to in RECORDED_STAKE, here and in
// agents/agent-history/test/support.ts.
import { describe, test, expect } from 'vitest';
import { Constr, Data, credentialToAddress, getAddressDetails } from '@lucid-evolution/lucid';
import {
  REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, SEED_STAKE_ID, decodeCrossRefs, decodeStakeDatum, decodeStakeParams, encodeStakeDatum, outRefText, stakeTokenName, stakeTokenUnit,
} from '../src/reputation-datum.ts';
import type { StakeDatum } from '../src/reputation-datum.ts';

const ENDORSEMENT_SCRIPT_HASH = '21ac1502ba7bab74e98ef3ad256bba1622a1351934ac19d0432126fe';
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const RECORDED_STAKE: StakeDatum = {
  agent_did: '4e1272ee30e5bdf5ad75be55553563a7056ab228295c70ffda988892da4a8fe9', owner_pkh: '34267e928e17c77063ee4957b6932182b7d804ed1d3f77c3f4121682',
  stake_amount: 11_000_000n, staked_capabilities: [Buffer.from('smoke.stake-check.a.v1').toString('hex'), Buffer.from('smoke.stake-check.b.v1').toString('hex')],
  last_updated: 1_795_425_911_000, history_points: 0n, challenge_locks: [], stake_id: { txHash: 'c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c', outputIndex: 0 },
};
// Constr 0 [agent_did, VerificationKey(owner), stake_amount, [capability, capability], last_updated, history_points, [], OutputReference]. Each capability is 22 bytes
// (header 56). stake_amount 11000000 is 1a00a7d8c0, and last_updated 1795425911000 is 1b000001a207b940d8. The chain holds the empty challenge_locks as 80, as Lucid
// writes it, where the reference SDK writes 9fff: the same Plutus data, and the validator compares data, not bytes.
const RECORDED_STAKE_HEX = 'd8799f58204e1272ee30e5bdf5ad75be55553563a7056ab228295c70ffda988892da4a8fe9d8799f581c34267e928e17c77063ee4957b6932182b7d804ed1d3f77c3f4121682ff1a00a7d8c09f56736d6f6b652e7374616b652d636865636b2e612e763156736d6f6b652e7374616b652d636865636b2e622e7631ff1b000001a207b940d80080d8799f5820c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c00ffff';
// Values of the recorded stake that the rows below use as plain values.
const ID = RECORDED_STAKE.agent_did;
const OWNER = RECORDED_STAKE.owner_pkh;
const TX = RECORDED_STAKE.stake_id.txHash;

describe('the deployment values', () => {
  test('the reputation validator is the policy fad945ab…, and the stake address is its exact script address, with no stake credential', () => {
    expect(REPUTATION_SCRIPT_HASH).toBe('fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424');
    expect(REPUTATION_ADDRESS).toBe('addr1w8adj3dtyrmp5k8mma4r8285jxyeklw5zelmvssqhsrqgfqc9uavs');
    expect(credentialToAddress('Mainnet', { type: 'Script', hash: REPUTATION_SCRIPT_HASH })).toBe(REPUTATION_ADDRESS);
    expect(getAddressDetails(REPUTATION_ADDRESS).stakeCredential).toBeUndefined();
  });
});

describe('the stake datum', () => {
  test('the recorded datum decodes to its 8 fields, in the order of types.ak: two capabilities, no history points and no challenge lock', () => {
    expect(decodeStakeDatum(RECORDED_STAKE_HEX)).toStrictEqual(RECORDED_STAKE);
  });
  test('the encoder writes the recorded datum byte for byte, from the fields and from the fields that the decoder read', () => {
    expect(encodeStakeDatum(RECORDED_STAKE)).toBe(RECORDED_STAKE_HEX);
    expect(encodeStakeDatum(decodeStakeDatum(RECORDED_STAKE_HEX))).toBe(RECORDED_STAKE_HEX);
  });
  test('round trips with locks, history points and the opening placeholder', () => {
    const d: StakeDatum = { ...RECORDED_STAKE, history_points: 7n, challenge_locks: ['72636c5f' + '01'.repeat(24)], stake_id: SEED_STAKE_ID, staked_capabilities: ['61', '62'] };
    expect(decodeStakeDatum(encodeStakeDatum(d))).toStrictEqual(d);
    expect(SEED_STAKE_ID).toStrictEqual({ txHash: '00'.repeat(32), outputIndex: 0 });
    expect(outRefText({ txHash: TX, outputIndex: 1 })).toBe(`${TX}#1`);
  });

  // One row for each rule of decodeStakeDatum, and for each way that a rule can fail. The accepted twins below hold the values on the edge of each rule.
  const fields = () => (Data.from(encodeStakeDatum(RECORDED_STAKE)) as Constr<Data>).fields;
  const withField = (i: number, value: Data) => Data.to(new Constr(0, fields().map((f, j) => (j === i ? value : f))));
  const refused: Array<[what: string, datum: string, message: RegExp]> = [
    ['bytes that are not Plutus data', 'zz', /^not a stake datum \(not Plutus data\)$/],
    ['an integer, not a constructor', Data.to(5n), /expected constructor 0 with 8 fields/],
    ['a list, not a constructor', Data.to([ID]), /expected constructor 0 with 8 fields/],
    ['constructor 1 with the 8 fields', Data.to(new Constr(1, fields())), /expected constructor 0 with 8 fields/],
    ['the 6 fields of the earlier deployment', Data.to(new Constr(0, [ID, new Constr(0, [OWNER]), 1n, [], 2n, 0n])), /expected constructor 0 with 8 fields/],
    ['7 fields', Data.to(new Constr(0, fields().slice(0, 7))), /expected constructor 0 with 8 fields/],
    ['9 fields', Data.to(new Constr(0, [...fields(), 0n])), /expected constructor 0 with 8 fields/],

    ['agent_did of 2 bytes', withField(0, 'abcd'), /agent_did is not 32 bytes/],
    ['agent_did of 31 bytes', withField(0, 'ab'.repeat(31)), /agent_did is not 32 bytes/],
    ['agent_did of 33 bytes', withField(0, 'ab'.repeat(33)), /agent_did is not 32 bytes/],
    ['agent_did that is an integer', withField(0, 7n), /agent_did is not 32 bytes/],

    ['an owner that is bytes, not a credential', withField(1, OWNER), /owner is not a verification-key credential/],
    ['an owner that is a script credential', withField(1, new Constr(1, [OWNER])), /owner is not a verification-key credential/],
    ['an owner credential with no hash', withField(1, new Constr(0, [])), /owner is not a verification-key credential/],
    ['an owner credential with 2 fields', withField(1, new Constr(0, [OWNER, OWNER])), /owner is not a verification-key credential/],
    ['an owner hash of 27 bytes', withField(1, new Constr(0, ['ab'.repeat(27)])), /owner is not a verification-key credential/],
    ['an owner hash of 29 bytes', withField(1, new Constr(0, ['ab'.repeat(29)])), /owner is not a verification-key credential/],
    ['an owner hash that is an integer', withField(1, new Constr(0, [5n])), /owner is not a verification-key credential/],

    ['stake_amount that is bytes', withField(2, 'ab'), /an integer field is not an integer/],
    ['last_updated that is bytes', withField(4, 'ab'), /an integer field is not an integer/],
    ['history_points that is bytes', withField(5, 'ab'), /an integer field is not an integer/],

    ['last_updated below 0', withField(4, -1n), /last_updated is not a time/],
    ['last_updated above 2^53 - 1', withField(4, MAX_SAFE + 1n), /last_updated is not a time/],

    ['staked_capabilities that is bytes', withField(3, 'ab'), /staked_capabilities is not a list of bytes/],
    ['staked_capabilities that is a constructor', withField(3, new Constr(0, [])), /staked_capabilities is not a list of bytes/],
    ['a staked capability that is an integer', withField(3, [1n]), /staked_capabilities is not a list of bytes/],
    ['one staked capability that is an integer', withField(3, ['61', 5n]), /staked_capabilities is not a list of bytes/],

    ['challenge_locks that is bytes', withField(6, 'ab'), /challenge_locks is not a list of bytes/],
    ['challenge_locks that is a constructor', withField(6, new Constr(0, [])), /challenge_locks is not a list of bytes/],
    ['a challenge lock that is an integer', withField(6, [1n]), /challenge_locks is not a list of bytes/],
    ['one challenge lock that is an integer', withField(6, ['61', 5n]), /challenge_locks is not a list of bytes/],

    ['a stake_id that is bytes', withField(7, TX), /stake_id is not an output reference/],
    ['a stake_id of constructor 1', withField(7, new Constr(1, [TX, 0n])), /stake_id is not an output reference/],
    ['a stake_id with 1 field', withField(7, new Constr(0, [TX])), /stake_id is not an output reference/],
    ['a stake_id with 3 fields', withField(7, new Constr(0, [TX, 0n, 0n])), /stake_id is not an output reference/],
    ['a stake_id with a hash of 31 bytes', withField(7, new Constr(0, ['ab'.repeat(31), 0n])), /stake_id is not an output reference/],
    ['a stake_id with a hash of 33 bytes', withField(7, new Constr(0, ['ab'.repeat(33), 0n])), /stake_id is not an output reference/],
    ['a stake_id with an index that is bytes', withField(7, new Constr(0, [TX, 'ab'])), /stake_id is not an output reference/],
    ['a stake_id with an index below 0', withField(7, new Constr(0, [TX, -1n])), /stake_id is not an output reference/],
    ['a stake_id with an index above 2^53 - 1', withField(7, new Constr(0, [TX, MAX_SAFE + 1n])), /stake_id is not an output reference/],
  ];
  test.each(refused)('decodeStakeDatum refuses %s', (_what, datum, message) => {
    expect(() => decodeStakeDatum(datum)).toThrow(message);
  });

  const accepted: Array<[what: string, datum: StakeDatum]> = [
    ['the recorded vector', RECORDED_STAKE],
    ['last_updated 0', { ...RECORDED_STAKE, last_updated: 0 }],
    ['last_updated 2^53 - 1', { ...RECORDED_STAKE, last_updated: Number.MAX_SAFE_INTEGER }],
    ['integers beyond 2^53', { ...RECORDED_STAKE, stake_amount: 2n ** 70n, history_points: 2n ** 70n }],
    ['no staked capability', { ...RECORDED_STAKE, staked_capabilities: [] }],
    ['one staked capability', { ...RECORDED_STAKE, staked_capabilities: [RECORDED_STAKE.staked_capabilities[0]] }],
    ['two staked capabilities of one byte each', { ...RECORDED_STAKE, staked_capabilities: ['61', '62'] }],
    ['one challenge lock', { ...RECORDED_STAKE, challenge_locks: ['72636c5f' + '01'.repeat(24)] }],
    ['a stake_id with the output index 1', { ...RECORDED_STAKE, stake_id: { txHash: TX, outputIndex: 1 } }],
    ['a stake_id with the output index 2^53 - 1', { ...RECORDED_STAKE, stake_id: { txHash: TX, outputIndex: Number.MAX_SAFE_INTEGER } }],
    ['the opening placeholder as stake_id', { ...RECORDED_STAKE, stake_id: SEED_STAKE_ID }],
  ];
  test.each(accepted)('decodeStakeDatum accepts %s', (_what, datum) => {
    expect(decodeStakeDatum(encodeStakeDatum(datum))).toStrictEqual(datum);
  });

  test('encodeStakeDatum refuses fields that are not what the datum holds', () => {
    expect(() => encodeStakeDatum({ ...RECORDED_STAKE, agent_did: 'ab' })).toThrow(/agent_did must be 32 bytes/);
    expect(() => encodeStakeDatum({ ...RECORDED_STAKE, owner_pkh: 'ab' })).toThrow(/owner_pkh must be 28 bytes/);
    expect(() => encodeStakeDatum({ ...RECORDED_STAKE, staked_capabilities: ['xyz'] })).toThrow(/not lowercase hex/);
    expect(() => encodeStakeDatum({ ...RECORDED_STAKE, stake_id: { txHash: 'ab', outputIndex: 0 } })).toThrow(/stake_id is not an output reference/);
    expect(() => encodeStakeDatum({ ...RECORDED_STAKE, last_updated: 1.5 })).toThrow(/whole number of POSIX milliseconds/);
  });
});

describe('the stake token', () => {
  test('its name is "rstk_" and the first 27 bytes of blake2b-256 of the 32 identifier bytes, the name that the live stakes carry', () => {
    // The agent of the Agent History service and its stake token on the earlier deployment (Koios asset_utxos, 2026-11-18): the same name rule.
    expect(stakeTokenName('8a98c4b74f0e49a09ca4b3502e121c96a8e6992afd2cba64ef8128042fedd440')).toBe('7273746b5f59bf69e33704bdced209a605cedeec1c9c2439920829877ca45915');
    expect(stakeTokenName(ID)).toHaveLength(64); // 32 bytes, the longest asset name
    expect(stakeTokenUnit(ID)).toBe(REPUTATION_SCRIPT_HASH + stakeTokenName(ID));
  });
  test('the unit of the recorded agent is the asset that the recorded output holds: the policy fad945ab… and the name that Koios lists', () => {
    // Koios utxo_info, 2026-11-23: the output 48d4ce7b…#0 holds 1 of this asset. The name comes from the agent that the datum names, not from its stake_id.
    const recorded = { policy: 'fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424', name: '7273746b5f1b98065ee43002664ff55bc12bba527c45b233b80cd7a4517e1581' };
    expect(stakeTokenName(ID)).toBe(recorded.name);
    expect(stakeTokenUnit(ID)).toBe(recorded.policy + recorded.name);
  });
  test('an identifier is 32 bytes of lowercase hex', () => {
    expect(() => stakeTokenName('abcd')).toThrow(/32 bytes/);
    expect(() => stakeTokenName(ID.toUpperCase())).toThrow(/32 bytes/);
  });
});

describe('the readers of the module parameters and the cross references', () => {
  // The values of the deployment: min_self_stake 10 units (field 0) and stake_cooldown 24 hours in milliseconds (field 3), in a record of 22 fields.
  const params = (min: bigint | string, cooldown: bigint | string) => Data.to(new Constr(0, Array.from({ length: 22 }, (_, i) => (i === 0 ? min : i === 3 ? cooldown : BigInt(i)))));
  test('decodeStakeParams reads the 22-field record', () => {
    expect(decodeStakeParams(params(10_000_000n, 86_400_000n))).toStrictEqual({ minSelfStake: 10_000_000n, stakeCooldown: 86_400_000n });
    expect(decodeStakeParams(params(1n, 0n))).toStrictEqual({ minSelfStake: 1n, stakeCooldown: 0n });
  });
  test('decodeStakeParams refuses anything else', () => {
    expect(() => decodeStakeParams(Data.to(new Constr(0, [10_000_000n, 1n, 2n, 3n])))).toThrow(/expected constructor 0 with 22 fields/);
    expect(() => decodeStakeParams(Data.to(new Constr(1, Array.from({ length: 22 }, () => 1n))))).toThrow(/expected constructor 0 with 22 fields/);
    expect(() => decodeStakeParams(params(0n, 1n))).toThrow(/min_self_stake must be a positive integer/);
    expect(() => decodeStakeParams(params(1n, -1n))).toThrow(/stake_cooldown/);
    expect(() => decodeStakeParams(params(1n, 'ab'))).toThrow(/stake_cooldown/);
    expect(() => decodeStakeParams('zz')).toThrow(/not Plutus data/);
  });
  test('decodeCrossRefs reads two 28-byte hashes and refuses anything else', () => {
    expect(decodeCrossRefs(Data.to(new Constr(0, [REPUTATION_SCRIPT_HASH, ENDORSEMENT_SCRIPT_HASH])))).toStrictEqual({ reputation: REPUTATION_SCRIPT_HASH, endorsement: ENDORSEMENT_SCRIPT_HASH });
    expect(() => decodeCrossRefs(Data.to(new Constr(0, [REPUTATION_SCRIPT_HASH])))).toThrow(/not the cross-validator references datum/);
    expect(() => decodeCrossRefs(Data.to(new Constr(0, [REPUTATION_SCRIPT_HASH, 'ab'])))).toThrow(/not the cross-validator references datum/);
    expect(() => decodeCrossRefs('zz')).toThrow(/not Plutus data/);
  });
});
