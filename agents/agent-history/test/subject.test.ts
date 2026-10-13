import { describe, test, expect } from 'vitest';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import { resolveSubject } from '../src/subject.ts';
const ASSET = 'ab'.repeat(32), OWNER = 'cd'.repeat(28);
const datum = Data.to(new Constr(0, [new Constr(0, [OWNER]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
const utxo = { tx_hash: 'ee'.repeat(32), tx_index: 0, address: REGISTRY_ADDRESS, value: '10000000', inline_datum: { bytes: datum }, asset_list: [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '1' }] };
const store = {
  [`POST https://v2.koios.vector.mainnet.apexfusion.org/api/v1/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, ASSET]], _extended: true })}`]: { status: 200, body: JSON.stringify([utxo]) },
  [`POST https://v2.koios.vector.mainnet.apexfusion.org/api/v1/address_utxos ${JSON.stringify({ _addresses: [REGISTRY_ADDRESS], _extended: true })}`]: { status: 200, body: JSON.stringify([utxo, { ...utxo, tx_index: 1, asset_list: [{ policy_id: REGISTRY_POLICY, asset_name: 'ff'.repeat(32), quantity: '1' }] }]) },
};
describe('resolveSubject', () => {
  test('a DID resolves to its asset and controller', async () => {
    const s = await resolveSubject(`did:vector:agent:${REGISTRY_POLICY}:${ASSET}`, replayFetch(store));
    expect(s).toMatchObject({ kind: 'asset', asset_name: ASSET, controller_pkh: OWNER });
  });
  test('a key hash lists every record it controls and picks the first', async () => {
    const s = await resolveSubject(OWNER, replayFetch(store));
    expect(s.kind).toBe('pkh'); expect(s.candidates.length).toBe(2); expect(s.asset_name).toBe(ASSET);
  });
  test('an unknown asset resolves with null identity, not an error', async () => {
    const miss = { ...store, [`POST https://v2.koios.vector.mainnet.apexfusion.org/api/v1/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, '11'.repeat(32)]], _extended: true })}`]: { status: 200, body: '[]' } };
    const s = await resolveSubject('11'.repeat(32), replayFetch(miss));
    expect(s.asset_name).toBe('11'.repeat(32)); expect(s.controller_pkh).toBeNull();
  });
});
