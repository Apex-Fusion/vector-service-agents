import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, didFor, topLevelBytes, encodeStakeDatum, SEED_STAKE_ID, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES, M6_ADDRESSES } from '@vsa/vector-read';
import type { StakeDatum } from '@vsa/vector-read';
import { reputationSection, disputeSection, selfImprovementSection, matchesSubject } from '../src/modules.ts';
import { DEFAULT_MODULES } from '../src/config.ts';
import type { ModuleScan } from '../src/modules.ts';
import type { Subject } from '../src/subject.ts';
import { RECORDED_STAKE, RECORDED_STAKE_HEX, RECORDED_STAKE_ROW, addressKey, stakeRow, stakeToken, txHash, withStakeRows } from './support.ts';
import type { Asset, StakeRow } from './support.ts';
const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
const CHANDRA = '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
const OWNER = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
// The Module-3 deployment before the identity registry, as the fixture recorded it on 2026-10-13. The fixture still holds its outputs: the stake datums
// have 6 fields, and the default settings do not read that address. One recorded key owns eight stakes there: the agents below are two of them.
const EARLIER = { ...DEFAULT_MODULES, m3: { reputation: 'addr1w9gk3cv8rn7mre2urrhpwwkteh8qjgzy5j9u9c3l8w34pyc76uluq', endorsement: 'addr1w9m3j6ld07uy2asssqxvwfqu73ykuqxhjqw7jpulkqera0cjm7mmz' } };
const BUSY_OWNER = '151cadb75179beb35c094c4d05aed5cf9ac1ef5295e5161ac4141de4';
const AGENT = '0b53d9ed96bf8ab033248afb128f2de4fc44a8da72a1208a0be474599b764330';
// The recorded stake of the identity deployment (test/support.ts): the agent that its datum names, and the key that owns it.
const STAKED = RECORDED_STAKE.agent_did;
const STAKE_OWNER = RECORDED_STAKE.owner_pkh;
// A subject given as an identifier carries the owner key as its controller; a subject given as a key hash carries the key it was given as.
const subject = (kind: Subject['kind'], asset: string | null, pkh: string | null): Subject => ({ kind, pkh: kind === 'pkh' ? pkh : null, asset_name: asset, did: asset ? didFor(asset) : null, registry: asset ? 'legacy' : null, controller_pkh: pkh, candidates: [] });

describe('Module-3 stakes of the deployment on the identity registry follow the kind of subject', () => {
  const SIBLING = 'cc'.repeat(32), OTHER_OWNER = '99'.repeat(28);
  // A stake output with its token, for the recorded datum with the fields in `over` changed.
  const row = (n: number, over: Partial<StakeDatum> = {}) => {
    const d = { ...RECORDED_STAKE, ...over };
    return stakeRow(n, encodeStakeDatum(d), [stakeToken(d.agent_did)]);
  };
  const ref = (n: number) => `${txHash(n)}#0`;
  // A sibling (same owner, other asset), the recorded stake, and a rotated one (same asset, other owner).
  const store = withStakeRows(fx.store, [row(1, { agent_did: SIBLING }), row(2), row(3, { owner_pkh: OTHER_OWNER })]);
  test('a subject given as an asset keeps only the stakes whose datum names that asset', async () => {
    const r = await reputationSection(subject('asset', STAKED, STAKE_OWNER), replayFetch(store));
    expect(r.stakes.map((s) => s.utxo)).toEqual([ref(2), ref(3)]); // the sibling stake is out; the stake of another owner on this asset is in
  });
  test('a subject given as a key hash keeps the stakes that key owns, whatever the asset', async () => {
    const r = await reputationSection(subject('pkh', STAKED, STAKE_OWNER), replayFetch(store));
    expect(r.stakes.map((s) => s.utxo)).toEqual([ref(1), ref(2)]);
    expect(r.stakes.map((s) => s.agent_asset_name)).toEqual([SIBLING, STAKED]);
  });
  test('a subject with no stake gets the same answer as before: no stakes, whatever else the address holds', async () => {
    expect(await reputationSection(subject('asset', 'dd'.repeat(32), '88'.repeat(28)), replayFetch(store))).toMatchObject({ stakes: [] });
    expect(await reputationSection(subject('pkh', null, '88'.repeat(28)), replayFetch(store))).toMatchObject({ stakes: [] });
    expect(await reputationSection(subject('asset', CHANDRA, OWNER), replayFetch(fx.store))).toEqual({ stakes: [], endorsements: [] }); // the recorded ledger data: nothing at the stake address
  });
});

describe('a stake of the identity deployment, read from its recorded datum', () => {
  // RECORDED_STAKE is the inline datum of a stake output on Vector mainnet (test/support.ts names the place to change when the layout of the datum changes).
  test('the recorded datum bytes are the fields of RECORDED_STAKE', () => {
    expect(encodeStakeDatum(RECORDED_STAKE)).toBe(RECORDED_STAKE_HEX);
  });
  test('the recorded stake output, as Koios holds it, gives an entry with each field of the datum and the output that holds it: 11 units and two capabilities', async () => {
    // Nothing of the output is built here: its reference, value and token are those of the chain, so the name that the codec derives for the agent has to be the recorded one.
    const r = await reputationSection(subject('asset', STAKED, STAKE_OWNER), replayFetch(withStakeRows(fx.store, [RECORDED_STAKE_ROW])));
    expect(r.stakes).toEqual([{
      utxo: '48d4ce7bbd9141a0e5787af08a2cb14aa6c75b64134f874fa64bc8a4155eb6ad#0', agent_asset_name: STAKED, owner_pkh: STAKE_OWNER, stake_lovelace: '11000000',
      capabilities: ['smoke.stake-check.a.v1', 'smoke.stake-check.b.v1'], last_updated: 1_795_425_911_000, history_points: 0, challenge_locks: [],
      stake_id: 'c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c#0',
    }]);
    expect(Object.keys(r.stakes[0])).toEqual(['utxo', 'agent_asset_name', 'owner_pkh', 'stake_lovelace', 'capabilities', 'last_updated', 'history_points', 'challenge_locks', 'stake_id']);
  });
  test('an entry shows the open challenges, and a capability that is not UTF-8 as 0x and its hex', async () => {
    const lock = '72636c5f' + '01'.repeat(24);
    const d: StakeDatum = { ...RECORDED_STAKE, challenge_locks: [lock], staked_capabilities: ['61', 'c3a9', 'ff', ''] };
    const r = await reputationSection(subject('asset', STAKED, STAKE_OWNER), replayFetch(withStakeRows(fx.store, [stakeRow(2, encodeStakeDatum(d), [stakeToken(STAKED)])])));
    expect(r.stakes[0]).toMatchObject({ challenge_locks: [lock], capabilities: ['a', 'é', '0xff', ''] });
  });
  test('the amount and the history points are exact: a JSON number up to 2^53 - 1, a decimal string beyond', async () => {
    const shown = async (over: Partial<StakeDatum>) => {
      const r = await reputationSection(subject('asset', STAKED, STAKE_OWNER), replayFetch(withStakeRows(fx.store, [stakeRow(2, encodeStakeDatum({ ...RECORDED_STAKE, ...over }), [stakeToken(STAKED)])])));
      return [r.stakes[0].stake_lovelace, r.stakes[0].history_points];
    };
    expect(await shown({ stake_amount: 2n ** 70n, history_points: 2n ** 53n })).toEqual(['1180591620717411303424', '9007199254740992']);
    expect(await shown({ stake_amount: 1n, history_points: 2n ** 53n - 1n })).toEqual(['1', 9_007_199_254_740_991]);
  });

  // What is no stake. Each output below differs in one thing from the stake output of the recorded datum, and that output (the twin of all of them) is a stake.
  const rows: Array<[what: string, output: StakeRow]> = [
    ['an output with the datum and no token, the opening output of a stake', stakeRow(2, encodeStakeDatum({ ...RECORDED_STAKE, stake_id: SEED_STAKE_ID }), [])],
    ['an output whose asset list is null', stakeRow(2, RECORDED_STAKE_HEX, null)],
    ['an output with a token of another policy', stakeRow(2, RECORDED_STAKE_HEX, [{ ...stakeToken(STAKED), policy_id: '11'.repeat(28) }])],
    ['an output with the stake token of another agent', stakeRow(2, RECORDED_STAKE_HEX, [stakeToken('cc'.repeat(32))])],
    ['an output with a history bonus token of the policy', stakeRow(2, RECORDED_STAKE_HEX, [{ ...stakeToken(STAKED), asset_name: Buffer.from('hbonus_' + 'x'.repeat(10)).toString('hex') }])],
    ['an output with 2 of the stake token', stakeRow(2, RECORDED_STAKE_HEX, [stakeToken(STAKED, '2')])],
    ['an output with the stake token and a datum that is not Plutus data', stakeRow(2, 'zz', [stakeToken(STAKED)])],
    ['an output with the stake token and the 6 fields of the earlier deployment', stakeRow(2, Data.to(new Constr(0, [STAKED, new Constr(0, [STAKE_OWNER]), 10_000_000n, [fromText('x.y.v1')], 1_700_000_000_000n, 0n])), [stakeToken(STAKED)])],
    ['an output with the stake token and no datum', stakeRow(2, null, [stakeToken(STAKED)])],
  ];
  test.each(rows)('%s is no stake', async (_what, output) => {
    const r = await reputationSection(subject('asset', STAKED, STAKE_OWNER), replayFetch(withStakeRows(fx.store, [output])));
    expect(r.stakes).toEqual([]);
  });
  test('the twin of each: the recorded datum with its own token is a stake', async () => {
    const r = await reputationSection(subject('asset', STAKED, STAKE_OWNER), replayFetch(withStakeRows(fx.store, [stakeRow(2, RECORDED_STAKE_HEX, [stakeToken(STAKED)])])));
    expect(r.stakes).toHaveLength(1);
  });
  test('the policy of the token is the hash in the configured stake address: the token of another validator is no stake there, and the token of its own validator is', async () => {
    // The Module-1 claim validator stands for another deployment. Its address holds the output, and the stake address setting names that address.
    const other = M1_ADDRESSES.claim, otherHash = 'a9d22e8b01d282be8007b8d9e3e8af548aaa56f1c3e433c0eddd8760';
    const modules = { ...DEFAULT_MODULES, m3: { ...DEFAULT_MODULES.m3, reputation: other } };
    const at = (assets: Asset[]) => replayFetch({ ...fx.store, [addressKey(other)]: { status: 200, body: JSON.stringify([stakeRow(2, RECORDED_STAKE_HEX, assets)]) } });
    expect((await reputationSection(subject('asset', STAKED, STAKE_OWNER), at([stakeToken(STAKED)]), modules)).stakes).toEqual([]); // the token of the identity deployment's validator
    expect((await reputationSection(subject('asset', STAKED, STAKE_OWNER), at([{ ...stakeToken(STAKED), policy_id: otherHash }]), modules)).stakes).toHaveLength(1);
  });
});

describe('the earlier Module-3 deployment', () => {
  const earlier = JSON.parse(fx.store[addressKey(EARLIER.m3.reputation)].body) as Array<{ inline_datum: { bytes: string } }>;
  test('the fixture holds its recorded stakes: real datums of 6 fields, which the default settings do not read', async () => {
    expect(earlier.filter((u) => (Data.from(u.inline_datum.bytes) as Constr<Data>).fields.length === 6).length).toBeGreaterThanOrEqual(9); // nine when recorded
    expect(addressKey(EARLIER.m3.reputation)).not.toBe(addressKey(M3_REPUTATION_ADDRESS));
    expect(addressKey(EARLIER.m3.endorsement)).not.toBe(addressKey(M3_ENDORSEMENT_ADDRESS));
  });
  test('set as the stake address, it gives no stake: a real 6-field datum with its real token is not a stake of the 8-field layout', async () => {
    for (const s of [subject('asset', CHANDRA, OWNER), subject('asset', AGENT, BUSY_OWNER), subject('pkh', null, BUSY_OWNER)]) {
      expect((await reputationSection(s, replayFetch(fx.store), EARLIER)).stakes, JSON.stringify(s.asset_name ?? s.pkh)).toEqual([]);
    }
  });
});

describe('Module-3 endorsements', () => {
  // The recorded endorsement datums are those of the earlier deployment: the matching is by bytes fields, whatever the layout.
  test('endorsement datums recorded from the ledger are found by the asset name they name', async () => {
    const r = await reputationSection(subject('asset', AGENT, null), replayFetch(fx.store), EARLIER);
    expect(r.endorsements.length).toBeGreaterThanOrEqual(4); // four when recorded
    for (const e of r.endorsements) expect(e).toEqual({ utxo: expect.stringMatching(/^[0-9a-f]{64}#\d+$/), block: expect.any(Number), fields: expect.arrayContaining([AGENT]) });
  });
  test('an agent that no recorded endorsement names has none', async () => {
    const r = await reputationSection(subject('asset', CHANDRA, OWNER), replayFetch(fx.store), EARLIER);
    expect(r.endorsements).toEqual([]);
  });
  test('the endorsement address of the default settings is the one of the identity deployment: the recorded endorsements of the earlier deployment are not read', async () => {
    expect((await reputationSection(subject('asset', AGENT, null), replayFetch(fx.store))).endorsements).toEqual([]);
  });
});

describe('module datums are matched by the identifier the subject was given as', () => {
  // The rule reputation already follows: a subject given as a DID or asset name is found by its asset name only, a subject given as a
  // key hash by the key hash only. A sibling agent (same owner key, other asset) must not appear in the other's report.
  const SIBLING = 'cc'.repeat(32), STRANGER = '77'.repeat(28);
  const empty = { status: 200, body: '[]' };
  const txOf = (n: number) => n.toString(16).padStart(64, 'd');
  const row = (n: number, address: string, fields: [string, string]) => ({ tx_hash: txOf(n), tx_index: 0, address, value: '2000000', block_height: 9_100_000 + n, inline_datum: { bytes: Data.to(new Constr(0, [fields[0], new Constr(0, [fields[1]])])) }, asset_list: [] });
  // At each address in `where`: one entry that names Chandra (under a stranger's key) and one that names its sibling and carries Chandra's owner key.
  const storeWith = (where: string[]) => {
    const store: Record<string, { status: number; body: string }> = { ...fx.store };
    for (const a of [M3_ENDORSEMENT_ADDRESS, ...Object.values(M1_ADDRESSES), ...Object.values(M6_ADDRESSES)]) {
      store[addressKey(a)] = where.includes(a) ? { status: 200, body: JSON.stringify([row(1, a, [CHANDRA, STRANGER]), row(2, a, [SIBLING, OWNER])]) } : empty;
    }
    return store;
  };
  const where = [M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES.claim, M1_ADDRESSES.jury_pool_v15_sim, M6_ADDRESSES.proposal];
  const refs = (rows: Array<{ utxo: string }>) => rows.map((r) => r.utxo);
  const sections = async (s: Subject) => {
    const f = replayFetch(storeWith(where));
    return { endorsements: refs((await reputationSection(s, f)).endorsements), dispute: await disputeSection(s, f), improvement: await selfImprovementSection(s, f) };
  };
  test('a subject given as an asset: the sibling entry is excluded in Module-3 endorsements, Module-1 and Module-6', async () => {
    const r = await sections(subject('asset', CHANDRA, OWNER));
    expect(r.endorsements).toEqual([`${txOf(1)}#0`]);
    expect(refs(r.dispute.claim)).toEqual([`${txOf(1)}#0`]);
    expect(refs(r.improvement.proposal)).toEqual([`${txOf(1)}#0`]);
  });
  test('a subject given as a key hash: the entries that carry the key are found, the one that names only the asset is not', async () => {
    const r = await sections(subject('pkh', CHANDRA, OWNER)); // the asset name of the first record it owns is not a second way in
    expect(r.endorsements).toEqual([`${txOf(2)}#0`]);
    expect(refs(r.dispute.claim)).toEqual([`${txOf(2)}#0`]);
    expect(refs(r.improvement.proposal)).toEqual([`${txOf(2)}#0`]);
  });
  test('both Module-1 deployments are read: an entry at a v15-sim address is reported under its own label', async () => {
    const r = await sections(subject('asset', CHANDRA, OWNER));
    expect(Object.keys(r.dispute)).toEqual(['claim', 'challenge', 'jury_pool', 'claim_v15_sim', 'challenge_v15_sim', 'jury_pool_v15_sim']);
    expect(refs(r.dispute.jury_pool_v15_sim)).toEqual([`${txOf(1)}#0`]);
    expect(r.dispute.claim_v15_sim).toEqual([]);
    expect(r.dispute.jury_pool).toEqual([]);
  });
  // A Module-1 claim read from the recording itself: the first recorded row at the v15-sim claim address whose first bytes field is an asset name and whose
  // second is a key hash (13 rows when recorded). It belongs to another agent, so nothing about it is typed in here: a later recording has other rows.
  const claimRow = (() => {
    const rows: Array<{ tx_hash: string; tx_index: number; block_height?: number; inline_datum: { bytes: string } | null }> = JSON.parse(fx.store[addressKey(M1_ADDRESSES.claim_v15_sim)].body);
    for (const u of rows) {
      const fields = u.inline_datum ? topLevelBytes(u.inline_datum.bytes) : [];
      if (fields.length >= 2 && fields[0].length === 64 && fields[1].length === 56) return { utxo: `${u.tx_hash}#${u.tx_index}`, block: u.block_height ?? null, fields };
    }
    throw new Error('the recording holds no v15-sim claim of the expected shape');
  })();
  test('a v15-sim claim recorded from the ledger is found by the asset name it names', async () => {
    const r = await disputeSection(subject('asset', claimRow.fields[0], null), replayFetch(fx.store));
    expect(r.claim_v15_sim.length).toBeGreaterThanOrEqual(1);
    expect(r.claim_v15_sim).toContainEqual(claimRow);
    for (const e of r.claim_v15_sim) expect(e.fields).toContain(claimRow.fields[0]);
  });
  test('the same recorded claim is found by the key hash it carries, for a subject given as a key hash', async () => {
    const r = await disputeSection(subject('pkh', null, claimRow.fields[1]), replayFetch(fx.store));
    expect(r.claim_v15_sim).toContainEqual(claimRow);
    for (const e of r.claim_v15_sim) expect(e.fields).toContain(claimRow.fields[1]);
  });
});

describe('Module-1 and Module-6 are read with all their addresses at once', () => {
  // A fetch that holds every address_utxos call until the gate opens, and notes which addresses were asked for in the meantime.
  const gated = () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const asked: string[] = [];
    const replay = replayFetch(fx.store);
    const f = (async (u: any, i?: RequestInit) => { asked.push(JSON.parse(String(i?.body))._addresses[0]); await gate; return replay(u, i); }) as typeof fetch;
    return { f, asked, open };
  };
  const settle = async (asked: string[], n: number) => { for (let i = 0; i < 100 && asked.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
  test('the six Module-1 addresses are all asked before any is answered, and the labels keep the order of the addresses', async () => {
    const { f, asked, open } = gated();
    const run = disputeSection(subject('asset', CHANDRA, OWNER), f);
    await settle(asked, 6);
    const whileWaiting = [...asked];
    open();
    const r = await run;
    expect(whileWaiting.sort()).toEqual(Object.values(M1_ADDRESSES).sort());
    expect(Object.keys(r)).toEqual(Object.keys(M1_ADDRESSES));
  });
  test('the three Module-6 addresses are all asked before any is answered', async () => {
    const { f, asked, open } = gated();
    const run = selfImprovementSection(subject('asset', CHANDRA, OWNER), f);
    await settle(asked, 3);
    const whileWaiting = [...asked];
    open();
    await run;
    expect(whileWaiting.sort()).toEqual(Object.values(M6_ADDRESSES).sort());
  });
});

describe('module scans', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ tx_hash: (i + 1).toString(16).padStart(64, '0'), tx_index: 0, value: '1', inline_datum: null, asset_list: [] }));
  const page = (n: number) => ({ status: 200, body: JSON.stringify(rows(n)) });
  test('a Module-3 page of exactly 1,000 rows marks the scan as possibly truncated; 999 rows does not', async () => {
    for (const [n, expected] of [[1_000, true], [999, false]] as const) {
      for (const address of [M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS]) {
        const scan: ModuleScan = { truncated: false };
        await reputationSection(subject('asset', CHANDRA, OWNER), replayFetch({ ...fx.store, [addressKey(address)]: page(n) }), DEFAULT_MODULES, scan);
        expect(scan.truncated, `${n} rows at ${address}`).toBe(expected);
      }
    }
  });
  test('the Module-1 section marks it too, and a scan object is optional', async () => {
    const store = { ...fx.store, [addressKey(M1_ADDRESSES.claim)]: page(1_000) };
    const scan: ModuleScan = { truncated: false };
    await disputeSection(subject('asset', CHANDRA, OWNER), replayFetch(store), DEFAULT_MODULES, scan);
    expect(scan.truncated).toBe(true);
    await expect(disputeSection(subject('asset', CHANDRA, OWNER), replayFetch(store))).resolves.toEqual({ claim: [], challenge: [], jury_pool: [], claim_v15_sim: [], challenge_v15_sim: [], jury_pool_v15_sim: [] });
  });
});

describe('the module addresses come from the configuration', () => {
  test('another set of addresses is read instead of the defaults, under the labels it gives', async () => {
    const asked: string[] = [];
    const replay = replayFetch(fx.store);
    const f = (async (u: any, i?: RequestInit) => { asked.push(JSON.parse(String(i?.body))._addresses[0]); return replay(u, i); }) as typeof fetch;
    const modules = { m3: { reputation: M3_REPUTATION_ADDRESS, endorsement: M3_ENDORSEMENT_ADDRESS }, m1: { claim_new: M1_ADDRESSES.claim_v15_sim }, m6: { critique_new: M6_ADDRESSES.critique } };
    expect(Object.keys(await disputeSection(subject('asset', CHANDRA, OWNER), f, modules))).toEqual(['claim_new']);
    expect(Object.keys(await selfImprovementSection(subject('asset', CHANDRA, OWNER), f, modules))).toEqual(['critique_new']);
    expect(asked).toEqual([M1_ADDRESSES.claim_v15_sim, M6_ADDRESSES.critique]);
  });
  test('a subject given as a key hash is matched by that key, not by the controller of its first record', () => {
    const s = { ...subject('pkh', CHANDRA, OWNER), controller_pkh: '99'.repeat(28) };
    expect(matchesSubject([OWNER], s)).toBe(true);
    expect(matchesSubject(['99'.repeat(28)], s)).toBe(false);
    expect(matchesSubject([CHANDRA], s)).toBe(false);
  });
});
