import { describe, test, expect } from 'vitest';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import { identitySection } from '../src/identity.ts';
const ASSET = 'ab'.repeat(32), A = 'cd'.repeat(28), B = 'ef'.repeat(28), K = 'https://v2.koios.vector.mainnet.apexfusion.org/api/v1';
const reg = (owner: string) => Data.to(new Constr(0, [new Constr(0, [owner]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
const tok = [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '1' }];
const out = (datum: string | null, withTok = true) => ({ tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '10000000', inline_datum: datum ? { bytes: datum } : null, asset_list: withTok ? tok : [] });
const txs = [
  { tx_hash: '11'.repeat(32), block_height: 100, tx_timestamp: 1000, inputs: [], outputs: [out(reg(A))], assets_minted: tok },
  { tx_hash: '22'.repeat(32), block_height: 200, tx_timestamp: 2000, inputs: [{ tx_hash: '11'.repeat(32), tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '1', asset_list: tok }], outputs: [out(reg(B))] },
  { tx_hash: '33'.repeat(32), block_height: 300, tx_timestamp: 3000, inputs: [{ tx_hash: '22'.repeat(32), tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '1', asset_list: tok }], outputs: [{ ...out(null, false), payment_addr: { cred: 'y', bech32: 'addr1v' + 'q'.repeat(50) } }], assets_minted: [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '-1' }] },
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

// Mainnet shape (checked against the live ledger: 788 of 788 registry outputs): the registry datum is posted by hash,
// so tx_info shows a datum_hash and no inline bytes, and the bytes come from utxo_info (extended) on the output ref.
describe('identitySection with datums posted by hash', () => {
  const byHash = (t: (typeof txs)[number]) => ({ ...t, outputs: t.outputs.map((o) => (o.inline_datum ? { ...o, inline_datum: { bytes: null, value: null }, datum_hash: 'dd'.repeat(32) } : o)) });
  const resolved = (tx: string, owner: string) => ({ tx_hash: tx, tx_index: 0, value: '10000000', inline_datum: { bytes: reg(owner) }, asset_list: tok, is_spent: false });
  const storeFor = (list: typeof txs, utxoInfo: unknown[]) => ({
    [`POST ${K}/asset_txs ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: ASSET, _history: true })}`]: { status: 200, body: JSON.stringify(list.map((t) => ({ tx_hash: t.tx_hash, block_height: t.block_height, block_time: t.tx_timestamp }))) },
    [`POST ${K}/tx_info ${JSON.stringify({ _tx_hashes: list.map((t) => t.tx_hash), _inputs: true, _assets: true })}`]: { status: 200, body: JSON.stringify(list.map(byHash)) },
    [`POST ${K}/utxo_info ${JSON.stringify({ _utxo_refs: list.filter((t) => t.outputs[0].inline_datum).map((t) => `${t.tx_hash}#0`), _extended: true })}`]: { status: 200, body: JSON.stringify(utxoInfo) },
  });
  const subject = { kind: 'asset' as const, asset_name: ASSET, did: `did:vector:agent:${REGISTRY_POLICY}:${ASSET}`, controller_pkh: null, candidates: [] };
  test('the current record and the rotation are read through utxo_info', async () => {
    const id = await identitySection(subject, replayFetch(storeFor(txs.slice(0, 2), [resolved('11'.repeat(32), A), resolved('22'.repeat(32), B)])));
    expect(id.registered).toMatchObject({ tx: '11'.repeat(32), block: 100 });
    expect(id.updates).toEqual([{ tx: '22'.repeat(32), block: 200, time: 2000, kind: 'controller_rotation', from_pkh: A, to_pkh: B }]);
    expect(id.record?.owner_pkh).toBe(B);
    expect(id.deregistered).toBeNull();
  });
  test('a datum that cannot be read is an error, not a deregistration', async () => {
    await expect(identitySection(subject, replayFetch(storeFor(txs.slice(0, 1), [])))).rejects.toThrow(/could not be read/);
  });
});
