import { describe, test, expect } from 'vitest';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import { resolveSubject } from '../src/subject.ts';
import { BadRequest } from '../src/request.ts';
const ASSET = 'ab'.repeat(32), OTHER = 'ff'.repeat(32), OWNER = 'cd'.repeat(28), K = 'https://v2.koios.vector.mainnet.apexfusion.org/api/v1';
const datum = Data.to(new Constr(0, [new Constr(0, [OWNER]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
const utxo = { tx_hash: 'ee'.repeat(32), tx_index: 0, address: REGISTRY_ADDRESS, value: '10000000', inline_datum: { bytes: datum }, asset_list: [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '1' }] };
const second = { ...utxo, tx_index: 1, asset_list: [{ policy_id: REGISTRY_POLICY, asset_name: OTHER, quantity: '1' }] };
const assetUtxosKey = (asset: string) => `POST ${K}/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, asset]], _extended: true })}`;
const addressUtxosKey = (offset = 0) => `POST ${K}/address_utxos${offset ? `?offset=${offset}` : ''} ${JSON.stringify({ _addresses: [REGISTRY_ADDRESS], _extended: true })}`;
const ok = (rows: unknown[]) => ({ status: 200, body: JSON.stringify(rows) });
const store = { [assetUtxosKey(ASSET)]: ok([utxo]), [addressUtxosKey()]: ok([utxo, second]) };
// A row that is not a registry record at all (no datum): the scan has to read past it.
const filler = (i: number) => ({ tx_hash: i.toString(16).padStart(64, '0'), tx_index: 0, address: REGISTRY_ADDRESS, value: '1', inline_datum: null, asset_list: [] });
const page = (from: number) => Array.from({ length: 1_000 }, (_, i) => filler(from + i));
// A fetch that fails the test if anything reaches it, and remembers what did.
const noNetwork = () => { const calls: string[] = []; return { calls, f: (async (u: any) => { calls.push(String(u)); throw new Error('no Koios call expected'); }) as typeof fetch }; };
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection'); }, (e) => e as Error & { status?: number });

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
    const miss = { ...store, [assetUtxosKey('11'.repeat(32))]: ok([]) };
    const s = await resolveSubject('11'.repeat(32), replayFetch(miss));
    expect(s.asset_name).toBe('11'.repeat(32)); expect(s.controller_pkh).toBeNull();
  });
});

describe('resolveSubject strictness', () => {
  test('a DID under another policy is a 400 and costs no Koios call', async () => {
    const { f, calls } = noNetwork();
    const e = await rejection(resolveSubject(`did:vector:agent:${'11'.repeat(28)}:${ASSET}`, f));
    expect(e).toBeInstanceOf(BadRequest);
    expect(e.status).toBe(400);
    expect(e.message).toBe('DID policy is not the Vector agent registry');
    expect(calls).toEqual([]);
  });
  test('the registry policy in a DID is matched case-insensitively', async () => {
    const s = await resolveSubject(`did:vector:agent:${REGISTRY_POLICY.toUpperCase()}:${ASSET.toUpperCase()}`, replayFetch(store));
    expect(s).toMatchObject({ kind: 'asset', asset_name: ASSET, controller_pkh: OWNER });
  });
  test('a malformed subject is a 400 and costs no Koios call', async () => {
    const { f, calls } = noNetwork();
    for (const bad of ['', 'not-a-subject', 'ab'.repeat(20), ASSET + 'zz', `did:vector:agent:${REGISTRY_POLICY}`, `did:other:agent:${REGISTRY_POLICY}:${ASSET}`]) {
      const e = await rejection(resolveSubject(bad, f));
      expect(e, bad).toBeInstanceOf(BadRequest);
      expect(e.status, bad).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  test('a registry token that is not held at the registry address gives no controller', async () => {
    const elsewhere = { ...utxo, address: 'addr1v' + 'q'.repeat(50) };
    const s = await resolveSubject(ASSET, replayFetch({ [assetUtxosKey(ASSET)]: ok([elsewhere]) }));
    expect(s).toMatchObject({ kind: 'asset', asset_name: ASSET, controller_pkh: null });
  });
  test('a registry datum that cannot be decoded gives a null controller, not a failed report', async () => {
    const broken = { ...utxo, inline_datum: { bytes: 'd87980' } }; // Constr 0 with no fields
    const s = await resolveSubject(ASSET, replayFetch({ [assetUtxosKey(ASSET)]: ok([broken]) }));
    expect(s).toMatchObject({ kind: 'asset', asset_name: ASSET, controller_pkh: null });
  });
  test('the candidate that is reported does not depend on the order Koios lists the UTxOs in', async () => {
    const forward = await resolveSubject(OWNER, replayFetch({ [addressUtxosKey()]: ok([utxo, second]) }));
    const reverse = await resolveSubject(OWNER, replayFetch({ [addressUtxosKey()]: ok([second, utxo]) }));
    expect(forward.candidates.map((c) => c.asset_name)).toEqual([ASSET, OTHER]);
    expect(reverse).toEqual(forward);
    expect(reverse.asset_name).toBe(ASSET);
  });
});

describe('resolveSubject key-hash scan paging', () => {
  test('reads the next page while pages come back full, and stops at the first short page', async () => {
    // a third request would be an unrecorded key, hence a fixture miss
    const s = await resolveSubject(OWNER, replayFetch({ [addressUtxosKey()]: ok(page(1)), [addressUtxosKey(1_000)]: ok([utxo]) }));
    expect(s.candidates.map((c) => c.asset_name)).toEqual([ASSET]);
  });
  test('a full page followed by an empty one ends the scan', async () => {
    const s = await resolveSubject(OWNER, replayFetch({ [addressUtxosKey()]: ok(page(1)), [addressUtxosKey(1_000)]: ok([]) }));
    expect(s).toMatchObject({ kind: 'pkh', asset_name: null, candidates: [] });
  });
  test('a scan that never ends is an error, not an endless loop', async () => {
    let calls = 0;
    const endless = (async () => { calls++; return new Response(JSON.stringify(page(1)), { status: 200 }); }) as typeof fetch;
    await expect(resolveSubject(OWNER, endless)).rejects.toThrow(/did not end within 20 pages/);
    expect(calls).toBe(20);
  });
});
