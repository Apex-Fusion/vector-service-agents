import { describe, test, expect } from 'vitest';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import { identitySection, identityTimeline } from '../src/identity.ts';
const ASSET = 'ab'.repeat(32), A = 'cd'.repeat(28), B = 'ef'.repeat(28), K = 'https://v2.koios.vector.mainnet.apexfusion.org/api/v1';
const reg = (owner: string) => Data.to(new Constr(0, [new Constr(0, [owner]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
const tok = [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '1' }];
const out = (datum: string | null, withTok = true) => ({ tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '10000000', inline_datum: datum ? { bytes: datum } : null, asset_list: withTok ? tok : [] });
const txs = [
  { tx_hash: '11'.repeat(32), block_height: 100, tx_block_index: 0, tx_timestamp: 1000, inputs: [], outputs: [out(reg(A))], assets_minted: tok },
  { tx_hash: '22'.repeat(32), block_height: 200, tx_block_index: 0, tx_timestamp: 2000, inputs: [{ tx_hash: '11'.repeat(32), tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '1', asset_list: tok }], outputs: [out(reg(B))] },
  { tx_hash: '33'.repeat(32), block_height: 300, tx_block_index: 0, tx_timestamp: 3000, inputs: [{ tx_hash: '22'.repeat(32), tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '1', asset_list: tok }], outputs: [{ ...out(null, false), payment_addr: { cred: 'y', bech32: 'addr1v' + 'q'.repeat(50) } }], assets_minted: [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '-1' }] },
];
const store = {
  [`POST ${K}/asset_txs ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: ASSET, _history: true })}`]: { status: 200, body: JSON.stringify(txs.map((t) => ({ tx_hash: t.tx_hash, block_height: t.block_height, block_time: t.tx_timestamp }))) },
  [`POST ${K}/tx_info ${JSON.stringify({ _tx_hashes: txs.map((t) => t.tx_hash), _inputs: true, _assets: true })}`]: { status: 200, body: JSON.stringify(txs) },
};
describe('identitySection', () => {
  test('registration, controller rotation and deregistration are all reported', async () => {
    const id = await identitySection({ kind: 'asset', asset_name: ASSET, did: `did:vector:agent:${REGISTRY_POLICY}:${ASSET}`, controller_pkh: null, candidates: [] }, replayFetch(store));
    expect(id.registered).toMatchObject({ tx: '11'.repeat(32), block: 100 });
    expect(id.updates).toEqual([{ tx: '22'.repeat(32), block: 200, time: 2000, kind: 'controller_rotation', from_pkh: A, to_pkh: B }]);
    expect(id.deregistered).toMatchObject({ tx: '33'.repeat(32), block: 300 });
    expect(id.record).toBeNull();
  });
});

// A store for any listing of the txs above: asset_txs answers in the order given, tx_info with `returned` (default: the same txs).
const subject = { kind: 'asset' as const, asset_name: ASSET, did: `did:vector:agent:${REGISTRY_POLICY}:${ASSET}`, controller_pkh: null, candidates: [] };
const storeOf = (listed: typeof txs, returned: typeof txs = listed) => ({
  [`POST ${K}/asset_txs ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: ASSET, _history: true })}`]: { status: 200, body: JSON.stringify(listed.map((t) => ({ tx_hash: t.tx_hash, block_height: t.block_height, block_time: t.tx_timestamp }))) },
  [`POST ${K}/tx_info ${JSON.stringify({ _tx_hashes: listed.map((t) => t.tx_hash), _inputs: true, _assets: true })}`]: { status: 200, body: JSON.stringify(returned) },
});

describe('identitySection ordering and strictness', () => {
  test('a registration and an update in the same block are processed registration-first, whatever order asset_txs lists them in', async () => {
    const registration = { ...txs[0], block_height: 100, tx_block_index: 0 };
    const update = { ...txs[1], block_height: 100, tx_block_index: 1 }; // spends the registration output; owner A -> B
    const id = await identitySection(subject, replayFetch(storeOf([update, registration]))); // newest first
    expect(id.registered).toMatchObject({ tx: '11'.repeat(32), block: 100 });
    expect(id.updates).toEqual([{ tx: '22'.repeat(32), block: 100, time: 2000, kind: 'controller_rotation', from_pkh: A, to_pkh: B }]);
    expect(id.record?.owner_pkh).toBe(B);
  });
  test('the same owner posting the record again is an update, not a rotation', async () => {
    const repost = { ...txs[1], outputs: [out(reg(A))] };
    const id = await identitySection(subject, replayFetch(storeOf([txs[0], repost])));
    expect(id.registered).toMatchObject({ tx: '11'.repeat(32), block: 100 });
    expect(id.updates).toEqual([{ tx: '22'.repeat(32), block: 200, time: 2000, kind: 'update', from_pkh: A, to_pkh: A }]);
    expect(id.record?.owner_pkh).toBe(A);
    expect(id.deregistered).toBeNull();
  });
  test('a subject without an asset name has no registry history and makes no Koios call', async () => {
    // an empty store turns any call into a fixture miss
    const id = await identitySection({ kind: 'pkh', asset_name: null, did: null, controller_pkh: A, candidates: [] }, replayFetch({}));
    expect(id).toEqual({ registered: null, record: null, updates: [], deregistered: null });
  });
  test('a transaction that asset_txs lists but tx_info does not return is an error, not a gap in the timeline', async () => {
    await expect(identitySection(subject, replayFetch(storeOf(txs.slice(0, 2), txs.slice(0, 1)))))
      .rejects.toThrow(`tx ${'22'.repeat(32)} listed by asset_txs but not returned by tx_info`);
  });
});

// Mainnet shape (checked against the live ledger: 788 of 788 registry outputs): the registry datum is posted by hash,
// so tx_info shows a datum_hash and no inline bytes, and the bytes come from utxo_info (extended) on the output ref.
describe('identitySection with datums posted by hash', () => {
  const byHash = (t: (typeof txs)[number], bytes: string | null) => ({ ...t, outputs: t.outputs.map((o) => (o.inline_datum ? { ...o, inline_datum: { bytes, value: null }, datum_hash: 'dd'.repeat(32) } : o)) });
  const resolved = (tx: string, owner: string) => ({ tx_hash: tx, tx_index: 0, value: '10000000', inline_datum: { bytes: reg(owner) }, asset_list: tok, is_spent: false });
  const storeFor = (list: typeof txs, utxoInfo: unknown[], bytes: string | null = null) => ({
    [`POST ${K}/asset_txs ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: ASSET, _history: true })}`]: { status: 200, body: JSON.stringify(list.map((t) => ({ tx_hash: t.tx_hash, block_height: t.block_height, block_time: t.tx_timestamp }))) },
    [`POST ${K}/tx_info ${JSON.stringify({ _tx_hashes: list.map((t) => t.tx_hash), _inputs: true, _assets: true })}`]: { status: 200, body: JSON.stringify(list.map((t) => byHash(t, bytes))) },
    [`POST ${K}/utxo_info ${JSON.stringify({ _utxo_refs: list.filter((t) => t.outputs[0].inline_datum).map((t) => `${t.tx_hash}#0`), _extended: true })}`]: { status: 200, body: JSON.stringify(utxoInfo) },
  });
  test('the current record and the rotation are read through utxo_info', async () => {
    const id = await identitySection(subject, replayFetch(storeFor(txs.slice(0, 2), [resolved('11'.repeat(32), A), resolved('22'.repeat(32), B)])));
    expect(id.registered).toMatchObject({ tx: '11'.repeat(32), block: 100 });
    expect(id.updates).toEqual([{ tx: '22'.repeat(32), block: 200, time: 2000, kind: 'controller_rotation', from_pkh: A, to_pkh: B }]);
    expect(id.record?.owner_pkh).toBe(B);
    expect(id.deregistered).toBeNull();
  });
  test('an empty bytes string counts as a missing datum and is resolved through utxo_info like null', async () => {
    const id = await identitySection(subject, replayFetch(storeFor(txs.slice(0, 1), [resolved('11'.repeat(32), A)], '')));
    expect(id.registered).toMatchObject({ tx: '11'.repeat(32), block: 100 });
    expect(id.record?.owner_pkh).toBe(A);
  });
  test('a datum that cannot be read is an error, not a deregistration', async () => {
    await expect(identitySection(subject, replayFetch(storeFor(txs.slice(0, 1), [])))).rejects.toThrow(/could not be read/);
  });
});

// The key the report falls back on when the registry no longer holds the record: the last to_pkh of the updates, else the owner at registration.
describe('identityTimeline: the last controller key', () => {
  test('after a rotation and a deregistration it is the key rotated to; the section is the one identitySection gives', async () => {
    const t = await identityTimeline(subject, replayFetch(store));
    expect(t.last_controller_pkh).toBe(B);
    expect(t.section).toEqual(await identitySection(subject, replayFetch(store)));
    expect(t.section.record).toBeNull();
  });
  test('registered and deregistered with no update in between it is the owner at registration', async () => {
    const direct = [txs[0], { ...txs[2], inputs: txs[1].inputs }]; // the token leaves the registry in the transaction after the registration
    const t = await identityTimeline(subject, replayFetch(storeOf(direct)));
    expect(t.section).toMatchObject({ registered: { block: 100 }, deregistered: { block: 300 }, record: null, updates: [] });
    expect(t.last_controller_pkh).toBe(A);
  });
  test('with a live record it is the owner of that record', async () => {
    const t = await identityTimeline(subject, replayFetch(storeOf(txs.slice(0, 2))));
    expect(t.section.record?.owner_pkh).toBe(B);
    expect(t.last_controller_pkh).toBe(B);
  });
  test('a subject that was never registered, or has no asset name, has none', async () => {
    expect((await identityTimeline(subject, replayFetch(storeOf([])))).last_controller_pkh).toBeNull();
    expect((await identityTimeline({ kind: 'pkh', asset_name: null, did: null, controller_pkh: A, candidates: [] }, replayFetch({}))).last_controller_pkh).toBeNull();
  });
});
