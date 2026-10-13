import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, didFor, KOIOS_URL, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES, M6_ADDRESSES } from '@vsa/vector-read';
import { reputationSection, disputeSection, selfImprovementSection } from '../src/modules.ts';
import type { ModuleScan } from '../src/modules.ts';
import type { Subject } from '../src/subject.ts';
const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
const CHANDRA = '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
const OWNER = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
// One recorded key owns eight stakes on the ledger: the agents below are two of them.
const BUSY_OWNER = '151cadb75179beb35c094c4d05aed5cf9ac1ef5295e5161ac4141de4';
const AGENT = '0b53d9ed96bf8ab033248afb128f2de4fc44a8da72a1208a0be474599b764330';
const subject = (kind: Subject['kind'], asset: string | null, pkh: string | null): Subject => ({ kind, asset_name: asset, did: asset ? didFor(asset) : null, controller_pkh: pkh, candidates: [] });
const addressKey = (address: string) => `POST ${KOIOS_URL}/address_utxos ${JSON.stringify({ _addresses: [address], _extended: true })}`;

describe('Module-3 stakes follow the kind of subject', () => {
  const SIBLING = 'cc'.repeat(32), OTHER_OWNER = '99'.repeat(28);
  const stakeDatum = (asset: string, owner: string, amount: bigint) => Data.to(new Constr(0, [asset, new Constr(0, [owner]), amount, [fromText('x.y.v1')], 1_700_000_000_000n, 0n]));
  const txOf = (n: number) => n.toString(16).padStart(64, 'e');
  const row = (n: number, datum: string) => ({ tx_hash: txOf(n), tx_index: 0, address: M3_REPUTATION_ADDRESS, value: '2000000', block_height: 9_000_000 + n, inline_datum: { bytes: datum }, asset_list: [] });
  // The recorded stakes plus two synthetic ones: a sibling (same owner, other asset) and a rotated one (same asset, other owner).
  const withSynthetic = () => {
    const key = addressKey(M3_REPUTATION_ADDRESS);
    const rows = JSON.parse(fx.store[key].body);
    rows.push(row(1, stakeDatum(SIBLING, OWNER, 5_000_000n)), row(2, stakeDatum(CHANDRA, OTHER_OWNER, 7_000_000n)));
    return { ...fx.store, [key]: { status: 200, body: JSON.stringify(rows) } };
  };
  const refs = (r: { stakes: Array<{ utxo: string }> }) => r.stakes.map((s) => s.utxo);
  const RECORDED = '05563e751a32ce766aaf7aa015140912563f559394b5ecea77226d2c90bd6d4f#0';
  test('a subject given as an asset keeps only the stakes whose datum names that asset', async () => {
    const r = await reputationSection(subject('asset', CHANDRA, OWNER), replayFetch(withSynthetic()));
    expect(refs(r)).toEqual([RECORDED, `${txOf(2)}#0`]); // the sibling stake is out; the stake of another owner on this asset is in
  });
  test('a subject given as a key hash keeps the stakes that key owns, whatever the asset', async () => {
    const r = await reputationSection(subject('pkh', CHANDRA, OWNER), replayFetch(withSynthetic()));
    expect(refs(r)).toEqual([RECORDED, `${txOf(1)}#0`]);
    expect(r.stakes.map((s) => s.agent_asset_name)).toEqual([CHANDRA, SIBLING]);
  });
  test('on the recorded ledger data, one agent of a key with eight stakes gets exactly its own', async () => {
    const asAsset = await reputationSection(subject('asset', AGENT, BUSY_OWNER), replayFetch(fx.store));
    expect(asAsset.stakes).toHaveLength(1);
    expect(asAsset.stakes[0]).toMatchObject({ agent_asset_name: AGENT, owner_pkh: BUSY_OWNER, stake_lovelace: '50000000' });
    const asKey = await reputationSection(subject('pkh', null, BUSY_OWNER), replayFetch(fx.store));
    expect(asKey.stakes).toHaveLength(8);
  });
});

describe('Module-3 endorsements', () => {
  test('an endorsement datum recorded from the ledger is found by the asset name it names', async () => {
    const r = await reputationSection(subject('asset', AGENT, null), replayFetch(fx.store));
    expect(r.endorsements).toHaveLength(4);
    expect(r.endorsements).toContainEqual({
      utxo: 'd067d343132869f0c065a1ec88273cb83d41540b73a7bcdaebfe324302506d54#0', block: 4938952,
      fields: ['efeda5bbbebd452dcd532744213a98addb8f85525833ee83f0b40dee417195d1', AGENT],
    });
  });
  test('an agent that no recorded endorsement names has none', async () => {
    const r = await reputationSection(subject('asset', CHANDRA, OWNER), replayFetch(fx.store));
    expect(r.endorsements).toEqual([]);
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
  // A Module-1 claim recorded from the v15-sim claim address (13 rows then). Its first field is the asset name of a registered agent, its second a key hash.
  const RECORDED_CLAIM = {
    utxo: '643c70cb36256a932762572310090bf161a6be99fa5fa14e597e8fc60f256e4d#1', block: 4955306,
    fields: ['601f42f37be71a51cd3a655f4b774d30c8a9565b1a92ea5244fb7d479d788726', '8052f1fcdc94518c30ca16b027e7409232329c4ffb9f45602c43cf2a', '107e05ea123c081f285964fc9c6bdebc7cd60fde2165c0dfd76f19dd95bc94f5',
      '646174615f696e646578696e67', '697066733a2f2f73696d2f6c6966656379636c655f736d6f6b655f31373736383230343838'],
  };
  test('a v15-sim claim recorded from the ledger is found by the asset name it names, and nothing is found at the v14 addresses', async () => {
    const r = await disputeSection(subject('asset', RECORDED_CLAIM.fields[0], null), replayFetch(fx.store));
    expect(r).toEqual({ claim: [], challenge: [], jury_pool: [], claim_v15_sim: [RECORDED_CLAIM], challenge_v15_sim: [], jury_pool_v15_sim: [] });
  });
  test('the same recorded claim is found by the key hash it carries, for a subject given as a key hash', async () => {
    const r = await disputeSection(subject('pkh', null, RECORDED_CLAIM.fields[1]), replayFetch(fx.store));
    expect(r.claim_v15_sim).toEqual([RECORDED_CLAIM]);
  });
});

describe('module scans', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ tx_hash: (i + 1).toString(16).padStart(64, '0'), tx_index: 0, value: '1', inline_datum: null, asset_list: [] }));
  const page = (n: number) => ({ status: 200, body: JSON.stringify(rows(n)) });
  test('a Module-3 page of exactly 1,000 rows marks the scan as possibly truncated; 999 rows does not', async () => {
    for (const [n, expected] of [[1_000, true], [999, false]] as const) {
      for (const address of [M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS]) {
        const scan: ModuleScan = { truncated: false };
        await reputationSection(subject('asset', CHANDRA, OWNER), replayFetch({ ...fx.store, [addressKey(address)]: page(n) }), scan);
        expect(scan.truncated, `${n} rows at ${address}`).toBe(expected);
      }
    }
  });
  test('the Module-1 section marks it too, and a scan object is optional', async () => {
    const store = { ...fx.store, [addressKey(M1_ADDRESSES.claim)]: page(1_000) };
    const scan: ModuleScan = { truncated: false };
    await disputeSection(subject('asset', CHANDRA, OWNER), replayFetch(store), scan);
    expect(scan.truncated).toBe(true);
    await expect(disputeSection(subject('asset', CHANDRA, OWNER), replayFetch(store))).resolves.toEqual({ claim: [], challenge: [], jury_pool: [], claim_v15_sim: [], challenge_v15_sim: [], jury_pool_v15_sim: [] });
  });
});
