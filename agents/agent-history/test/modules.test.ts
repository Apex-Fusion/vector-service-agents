import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, didFor, KOIOS_URL, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES } from '@vsa/vector-read';
import { reputationSection, disputeSection } from '../src/modules.ts';
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
    await expect(disputeSection(subject('asset', CHANDRA, OWNER), replayFetch(store))).resolves.toEqual({ claim: [], challenge: [], jury_pool: [] });
  });
});
