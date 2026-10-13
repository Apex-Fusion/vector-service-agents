// packages/vector-read/test/koios.test.ts
import { describe, test, expect } from 'vitest';
import { koios, indexer, recordingFetch, replayFetch, KOIOS_URL, INDEXER_URL, REGISTRY_POLICY, REGISTRY_ADDRESS } from '../src/index.ts';
describe('clients', () => {
  test('utxoInfo posts _utxo_refs and replays through the fixture store', async () => {
    const store: Record<string, { status: number; body: string }> = {};
    const fake = (async (_u: any, init: any) => new Response(JSON.stringify([{ tx_hash: 'a'.repeat(64), tx_index: 0, value: '1', is_spent: true }]), { status: 200 })) as typeof fetch;
    const rec = recordingFetch(fake, store);
    const first = await koios.utxoInfo(['a'.repeat(64) + '#0'], rec);
    expect(first[0].is_spent).toBe(true);
    const again = await koios.utxoInfo(['a'.repeat(64) + '#0'], replayFetch(store));
    expect(again).toEqual(first);
    expect(Object.keys(store)[0]).toContain('utxo_info');
  });
  test('indexer.escrows builds the query string', async () => {
    let seen = '';
    const fake = (async (u: any) => { seen = String(u); return new Response('[]', { status: 200 }); }) as typeof fetch;
    await indexer.escrows({ supplier: 'ab' }, fake);
    expect(seen).toBe(`${INDEXER_URL}/escrows?supplier=ab`);
  });
  test('indexer.escrows leaves undefined filters out of the query string', async () => {
    let seen = '';
    const fake = (async (u: any) => { seen = String(u); return new Response('[]', { status: 200 }); }) as typeof fetch;
    await indexer.escrows({ supplier: undefined, buyer: 'ab' }, fake);
    expect(seen).toBe(`${INDEXER_URL}/escrows?buyer=ab`);
  });
  test('indexer.escrows with no filters sends no query string at all', async () => {
    let seen = '';
    const fake = (async (u: any) => { seen = String(u); return new Response('[]', { status: 200 }); }) as typeof fetch;
    await indexer.escrows({}, fake);
    expect(seen).toBe(`${INDEXER_URL}/escrows`);
  });
  test('addressUtxos pages through a query-string offset, and no offset leaves the path as it was', async () => {
    const seen: string[] = [];
    const fake = (async (u: any) => { seen.push(String(u)); return new Response('[]', { status: 200 }); }) as typeof fetch;
    await koios.addressUtxos([REGISTRY_ADDRESS], fake);
    await koios.addressUtxos([REGISTRY_ADDRESS], fake, 1000);
    expect(seen).toEqual([`${KOIOS_URL}/address_utxos`, `${KOIOS_URL}/address_utxos?offset=1000`]);
  });
});

// Downstream fixtures (agent-history and later agents) are hand-written against these exact keys,
// so the key format and the error shapes are part of the package contract.
describe('fixture store and error contract', () => {
  test('store keys are METHOD url body, with the exact JSON bodies the clients send', async () => {
    const store: Record<string, { status: number; body: string }> = {};
    const rec = recordingFetch((async () => new Response('[]', { status: 200 })) as typeof fetch, store);
    const asset = 'ab'.repeat(32);
    const tx = 'cd'.repeat(32);
    await koios.assetUtxos(REGISTRY_POLICY, asset, rec);
    await koios.addressUtxos([REGISTRY_ADDRESS], rec);
    await koios.assetHistory(REGISTRY_POLICY, asset, rec);
    await koios.assetTxs(REGISTRY_POLICY, asset, rec);
    await koios.txInfo([tx], rec);
    await koios.utxoInfo([`${tx}#0`], rec);
    await koios.tip(rec);
    await indexer.suppliers(rec);
    expect(Object.keys(store)).toEqual([
      `POST ${KOIOS_URL}/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, asset]], _extended: true })}`,
      `POST ${KOIOS_URL}/address_utxos ${JSON.stringify({ _addresses: [REGISTRY_ADDRESS], _extended: true })}`,
      `POST ${KOIOS_URL}/asset_history ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: asset })}`,
      `POST ${KOIOS_URL}/asset_txs ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: asset, _history: true })}`,
      `POST ${KOIOS_URL}/tx_info ${JSON.stringify({ _tx_hashes: [tx], _inputs: true, _assets: true })}`,
      `POST ${KOIOS_URL}/utxo_info ${JSON.stringify({ _utxo_refs: [`${tx}#0`], _extended: true })}`,
      `GET ${KOIOS_URL}/tip `,
      `GET ${INDEXER_URL}/suppliers `,
    ]);
  });
  test('a non-OK answer throws with the path and status', async () => {
    const down = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;
    await expect(koios.tip(down)).rejects.toThrow('Koios tip answered 502');
    await expect(koios.post('tx_info', {}, down)).rejects.toThrow('Koios tx_info answered 502');
    await expect(indexer.suppliers(down)).rejects.toThrow('indexer /suppliers answered 502');
  });
  test('replayFetch refuses a call that was never recorded', async () => {
    await expect(koios.tip(replayFetch({}))).rejects.toThrow(/fixture miss/);
  });
});
