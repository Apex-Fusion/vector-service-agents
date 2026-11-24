// agents/sourcing-agent/test/facts/stake.test.ts: the Module-3 stake of an agent, as a fact for the file of a bidder. The reader asks the port for the outputs that hold the stake token of the agent, and it counts
// an output only when it is a stake of that agent. The question: does a stake count that is not a Module-3 stake of that agent (a datum with no token, another agent, another address)? Is an unreadable source
// ever a number? Each refusal has its accepted twin: the recorded stake output, which counts.
import { describe, expect, it } from 'vitest';
import { REPUTATION_SCRIPT_HASH, decodeStakeDatum, encodeStakeDatum, stakeTokenName } from '@vsa/vector-read';
import type { KoiosUtxo } from '@vsa/vector-read';
import { FACT_READ_TIMEOUT_MS, readStake } from '../../src/facts/index.ts';
import type { StakeDeps, StakeFact } from '../../src/facts/index.ts';
import { AGENT_ID, ManualClock, OTHER_ID, SIX_FIELD_DATUM, STAKE, STAKE_HEX, TOKEN_NAME, datumOf, never, settle, stakeRow, tokenOf } from './support.ts';

interface Setup {
  readonly deps: StakeDeps;
  readonly clock: ManualClock;
  /** The policy and the name of each call of the port. */
  readonly calls: Array<[string, string]>;
}

/** The port of a test: it counts its calls, and answers with `answer`. */
function setup(answer: () => Promise<unknown>): Setup {
  const calls: Array<[string, string]> = [];
  const clock = new ManualClock();
  return { deps: { assetUtxos: (policy, name) => { calls.push([policy, name]); return answer() as Promise<readonly KoiosUtxo[]>; }, clock }, clock, calls };
}

/** A port that lists these rows. */
const listing = (...rows: unknown[]): Setup => setup(() => Promise.resolve(rows));

const stakeOf = (stake: bigint): StakeFact => ({ ok: true, stake_lovelace: stake });
const UNREAD: StakeFact = { ok: false };

describe('the recorded stake', () => {
  it('is the datum that the codec writes, for an agent whose token name is the one that the chain shows', () => {
    expect(encodeStakeDatum(STAKE)).toBe(STAKE_HEX);
    expect(decodeStakeDatum(STAKE_HEX)).toStrictEqual(STAKE);
    expect(stakeTokenName(AGENT_ID)).toBe(TOKEN_NAME);
    expect(stakeTokenName(OTHER_ID)).not.toBe(TOKEN_NAME);
    expect(decodeStakeDatum(datumOf({ agent_did: OTHER_ID })).agent_did).toBe(OTHER_ID);
  });

  it('has a six-field twin that the codec refuses, so a test with it skips a datum of the wrong layout and not a datum that is garbage', () => {
    expect(() => decodeStakeDatum(SIX_FIELD_DATUM)).toThrow(/expected constructor 0 with 8 fields/);
    expect(() => decodeStakeDatum('zz')).toThrow(/not Plutus data/);
  });
});

describe('the stake that counts', () => {
  it('is the amount of the datum, for an output at the stake address with the 8-field datum and the one token of the agent', async () => {
    const { deps } = listing(stakeRow());
    expect(await readStake(deps, AGENT_ID)).toStrictEqual(stakeOf(11_000_000n));
  });

  it('asks the port one time for the policy of the stake script and the token name of the agent, and gives the call the time of the fact reads', async () => {
    const { deps, calls, clock } = listing(stakeRow());
    await readStake(deps, AGENT_ID);
    expect(calls).toStrictEqual([[REPUTATION_SCRIPT_HASH, TOKEN_NAME]]);
    expect(FACT_READ_TIMEOUT_MS).toBe(20_000);
    expect(clock.asked).toStrictEqual([FACT_READ_TIMEOUT_MS]);
    expect(clock.open).toBe(0);
  });

  it('is 0 for a list with no output: an agent with no stake has a stake of 0, and that is a fact', async () => {
    const { deps } = listing();
    expect(await readStake(deps, AGENT_ID)).toStrictEqual(stakeOf(0n));
  });

  it('adds amounts beyond 2^53 exactly, and gives the sum as a bigint', async () => {
    const big = 2n ** 70n;
    const { deps } = listing(stakeRow(1, { inline_datum: { bytes: datumOf({ stake_amount: big }) } }), stakeRow(2, { inline_datum: { bytes: datumOf({ stake_amount: big + 1n }) } }));
    const result = await readStake(deps, AGENT_ID);
    expect(result).toStrictEqual(stakeOf(2n * big + 1n));
    if (!result.ok) throw new Error('the reader gave no stake');
    expect(typeof result.stake_lovelace).toBe('bigint');
  });

  it('is the sum of the stakes of two outputs that count', async () => {
    const five = datumOf({ stake_amount: 5_000_000n });
    const { deps } = listing(stakeRow(1), stakeRow(2, { inline_datum: { bytes: five } }));
    expect(await readStake(deps, AGENT_ID)).toStrictEqual(stakeOf(16_000_000n));
  });

  it('counts an output once when the list holds it twice, and counts two outputs of one transaction twice', async () => {
    expect(await readStake(listing(stakeRow(1), stakeRow(1)).deps, AGENT_ID)).toStrictEqual(stakeOf(11_000_000n));
    expect(await readStake(listing(stakeRow(1), stakeRow(2)).deps, AGENT_ID)).toStrictEqual(stakeOf(22_000_000n));
    expect(await readStake(listing(stakeRow(1, { tx_index: 0 }), stakeRow(1, { tx_index: 1 })).deps, AGENT_ID)).toStrictEqual(stakeOf(22_000_000n));
  });

  it('counts the output that counts and leaves the others out of the sum', async () => {
    const { deps } = listing(stakeRow(1, { address: 'addr1' + 'q'.repeat(50) }), stakeRow(2), stakeRow(3, { asset_list: null }), stakeRow(4, { inline_datum: { bytes: SIX_FIELD_DATUM } }));
    expect(await readStake(deps, AGENT_ID)).toStrictEqual(stakeOf(11_000_000n));
  });
});

describe('an output that is no stake of the agent', () => {
  // One row for each rule. The output differs from the recorded stake in one thing, and the recorded stake is the twin of each row: it counts.
  const NOT_STAKES: Array<[what: string, row: KoiosUtxo]> = [
    ['an output at another address', stakeRow(1, { address: 'addr1' + 'q'.repeat(50) })],
    ['an output with no address', stakeRow(1, { address: undefined })],
    ['an output with the datum and no token (the opening output of a stake)', stakeRow(1, { asset_list: null })],
    ['an output with an empty list of tokens', stakeRow(1, { asset_list: [] })],
    ['an output with the token name of the agent and another policy', stakeRow(1, { asset_list: [{ ...tokenOf(AGENT_ID), policy_id: 'ab'.repeat(28) }] })],
    ['an output with the token of another agent and the datum of this agent', stakeRow(1, { asset_list: [tokenOf(OTHER_ID)] })],
    ['an output with the token of this agent and the datum of another agent', stakeRow(1, { inline_datum: { bytes: datumOf({ agent_did: OTHER_ID }) } })],
    ['an output with the token and the datum of another agent', stakeRow(1, { inline_datum: { bytes: datumOf({ agent_did: OTHER_ID }) }, asset_list: [tokenOf(OTHER_ID)] })],
    ['an output with 2 tokens', stakeRow(1, { asset_list: [tokenOf(AGENT_ID, '2')] })],
    ['an output with 0 tokens', stakeRow(1, { asset_list: [tokenOf(AGENT_ID, '0')] })],
    ['an output with the token listed twice', stakeRow(1, { asset_list: [tokenOf(AGENT_ID), tokenOf(AGENT_ID)] })],
    ['an output with the quantity as a number', stakeRow(1, { asset_list: [{ ...tokenOf(AGENT_ID), quantity: 1 as unknown as string }] })],
    ['an output with a list of tokens that is no list', stakeRow(1, { asset_list: 'tokens' as unknown as null })],
    ['an output with no inline datum', stakeRow(1, { inline_datum: null })],
    ['an output with no datum member', stakeRow(1, { inline_datum: undefined })],
    ['an output with a datum that is no Plutus data', stakeRow(1, { inline_datum: { bytes: 'zz' } })],
    ['an output with the 6-field datum of the earlier deployment', stakeRow(1, { inline_datum: { bytes: SIX_FIELD_DATUM } })],
    ['an output that is spent', stakeRow(1, { is_spent: true })],
    ['an output with a stake below zero', stakeRow(1, { inline_datum: { bytes: datumOf({ stake_amount: -5n }) } })],
  ];

  it.each(NOT_STAKES)('is not counted: %s', async (_what, row) => {
    expect(await readStake(listing(stakeRow()).deps, AGENT_ID)).toStrictEqual(stakeOf(11_000_000n));
    expect(await readStake(listing(row).deps, AGENT_ID)).toStrictEqual(stakeOf(0n));
  });

  it('gives each agent the stake of its own output when the list holds the outputs of two agents', async () => {
    const other = stakeRow(2, { inline_datum: { bytes: datumOf({ agent_did: OTHER_ID, stake_amount: 9_000_000n }) }, asset_list: [tokenOf(OTHER_ID)] });
    expect(await readStake(listing(stakeRow(1), other).deps, AGENT_ID)).toStrictEqual(stakeOf(11_000_000n));
    expect(await readStake(listing(stakeRow(1), other).deps, OTHER_ID)).toStrictEqual(stakeOf(9_000_000n));
  });

  it('counts an output that holds other tokens next to the stake token, has another value and has no block', async () => {
    const extra = { policy_id: 'cd'.repeat(28), asset_name: '41', quantity: '7' };
    const row = stakeRow(1, { asset_list: [extra, tokenOf(AGENT_ID)], value: '13000000', block_height: undefined, block_time: undefined });
    expect(await readStake(listing(row).deps, AGENT_ID)).toStrictEqual(stakeOf(11_000_000n));
  });
});

describe('a source that cannot be read is no number', () => {
  const UNREADABLE: Array<[what: string, answer: () => Promise<unknown>]> = [
    ['a port that throws', () => Promise.reject(new Error('the node is down: secret words of the source'))],
    ['a port that throws a text', () => Promise.reject('secret words of the source')],
    ['a port that gives a text', () => Promise.resolve('[]')],
    ['a port that gives an object with the rows in it', () => Promise.resolve({ rows: [stakeRow()] })],
    ['a port that gives null', () => Promise.resolve(null)],
    ['a port that gives nothing', () => Promise.resolve(undefined)],
    ['a port that gives a number', () => Promise.resolve(1)],
    ['a list with a row that is null', () => Promise.resolve([stakeRow(1), null])],
    ['a list with a row that is a text', () => Promise.resolve([stakeRow(1), 'row'])],
    ['a list with a row that has no transaction hash', () => Promise.resolve([stakeRow(1), stakeRow(2, { tx_hash: undefined })])],
    ['a list with a row that has no output index', () => Promise.resolve([stakeRow(1), stakeRow(2, { tx_index: undefined })])],
    ['a list with a row that has an index below zero', () => Promise.resolve([stakeRow(1), stakeRow(2, { tx_index: -1 })])],
  ];

  it.each(UNREADABLE)('is { ok: false }: %s', async (_what, answer) => {
    const twin = setup(() => Promise.resolve([stakeRow(1), stakeRow(2)]));
    expect(await readStake(twin.deps, AGENT_ID)).toStrictEqual(stakeOf(22_000_000n));
    const { deps, calls } = setup(answer);
    expect(await readStake(deps, AGENT_ID)).toStrictEqual(UNREAD);
    expect(calls).toHaveLength(1);
  });

  it('holds no word of the source in the result when the port throws', async () => {
    const result = await readStake(setup(() => Promise.reject(new Error('secret words of the source'))).deps, AGENT_ID);
    expect(result).toStrictEqual(UNREAD);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('is { ok: false } for a port that throws before it returns a promise', async () => {
    const clock = new ManualClock();
    const deps: StakeDeps = { assetUtxos: () => { throw new Error('the port is broken'); }, clock };
    expect(await readStake(deps, AGENT_ID)).toStrictEqual(UNREAD);
    expect(clock.open).toBe(0);
  });

  it('is { ok: false } when the clock ends the wait before the port answers, and the result of the port that comes later changes nothing', async () => {
    const { deps, clock, calls } = setup(() => never());
    const result = readStake(deps, AGENT_ID);
    await settle();
    expect(clock.open).toBe(1);
    clock.fire();
    expect(await result).toStrictEqual(UNREAD);
    expect(calls).toHaveLength(1);
    expect(clock.asked).toStrictEqual([FACT_READ_TIMEOUT_MS]);
  });

  it('drops the failure of a port that comes after the timeout: the call that timed out is still { ok: false }, and nothing is raised later', async () => {
    let fail: (reason: Error) => void = () => undefined;
    const { deps, clock } = setup(() => new Promise<never>((_resolve, reject) => { fail = reject; }));
    const result = readStake(deps, AGENT_ID);
    await settle();
    clock.fire();
    expect(await result).toStrictEqual(UNREAD);
    fail(new Error('late failure'));
    await settle();
  });

  it('is its value when the port answers before the clock ends the wait, and it leaves no wait open', async () => {
    const { deps, clock } = setup(() => Promise.resolve([stakeRow()]));
    const result = readStake(deps, AGENT_ID);
    await settle();
    expect(await result).toStrictEqual(stakeOf(11_000_000n));
    expect(clock.open).toBe(0);
    clock.fire();
  });

  it('does not retry: a port that fails is called one time', async () => {
    const { deps, calls } = setup(() => Promise.reject(new Error('down')));
    await readStake(deps, AGENT_ID);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['an identifier of 63 characters', AGENT_ID.slice(1)],
    ['an identifier in upper case', AGENT_ID.toUpperCase()],
    ['a DID', `did:vector:${AGENT_ID}`],
    ['an empty text', ''],
    ['a number', 7 as unknown as string],
  ])('is { ok: false } for %s, and the port is not called', async (_what, id) => {
    const { deps, calls } = listing(stakeRow());
    expect(await readStake(deps, AGENT_ID)).toStrictEqual(stakeOf(11_000_000n));
    expect(calls).toHaveLength(1);
    expect(await readStake(deps, id)).toStrictEqual(UNREAD);
    expect(calls).toHaveLength(1);
  });
});
