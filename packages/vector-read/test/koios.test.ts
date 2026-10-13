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
    expect(seen).toBe('https://mp-indexer.vector.apexfusion.org/escrows?supplier=ab');
  });
});

// Downstream fixtures (agent-history and later agents) are hand-written against these exact keys,
// so the key format and the error shapes are part of the package contract.
describe('fixture store and error contract', () => {
  test('store keys are METHOD url body, with the exact JSON bodies the clients send', async () => {
    const store: Record<string, { status: number; body: string }> = {};
    const rec = recordingFetch((async () => new Response('[]', { status: 200 })) as typeof fetch, store);
    const asset = 'ab'.repeat(32);
    await koios.assetUtxos(REGISTRY_POLICY, asset, rec);
    await koios.addressUtxos([REGISTRY_ADDRESS], rec);
    await koios.tip(rec);
    await indexer.suppliers(rec);
    expect(Object.keys(store)).toEqual([
      `POST ${KOIOS_URL}/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, asset]], _extended: true })}`,
      `POST ${KOIOS_URL}/address_utxos ${JSON.stringify({ _addresses: [REGISTRY_ADDRESS], _extended: true })}`,
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
