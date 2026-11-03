import { describe, test, expect } from 'vitest';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, keyHash, didFor, legacyVectorDid, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import { resolveSubject } from '../src/subject.ts';
import { BadRequest } from '../src/request.ts';
import { koiosLedger, token, txHash as H, identityHex, TEST_IDENTITY, WITH_IDENTITY, LEGACY, CONTROLLER } from './support.ts';
const ASSET = 'ab'.repeat(32), OTHER = 'ff'.repeat(32), OWNER = 'cd'.repeat(28), K = 'https://v2.koios.vector.mainnet.apexfusion.org/api/v1';
const datum = Data.to(new Constr(0, [new Constr(0, [OWNER]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
const utxo = { tx_hash: 'ee'.repeat(32), tx_index: 0, address: REGISTRY_ADDRESS, value: '10000000', inline_datum: { bytes: datum }, asset_list: [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '1' }] };
const second = { ...utxo, tx_index: 1, asset_list: [{ policy_id: REGISTRY_POLICY, asset_name: OTHER, quantity: '1' }] };
const assetUtxosKey = (asset: string, policy = REGISTRY_POLICY) => `POST ${K}/asset_utxos ${JSON.stringify({ _asset_list: [[policy, asset]], _extended: true })}`;
const addressUtxosKey = (offset = 0, address = REGISTRY_ADDRESS) => `POST ${K}/address_utxos${offset ? `?offset=${offset}` : ''} ${JSON.stringify({ _addresses: [address], _extended: true })}`;
const ok = (rows: unknown[]) => ({ status: 200, body: JSON.stringify(rows) });
// The scan reads on until a page comes back empty, so a store of one short page also holds the empty page after it (offset = rows read).
const store = { [assetUtxosKey(ASSET)]: ok([utxo]), [addressUtxosKey()]: ok([utxo, second]), [addressUtxosKey(2)]: ok([]) };
// A row that is not a registry record at all (no datum): the scan has to read past it.
const filler = (i: number) => ({ tx_hash: i.toString(16).padStart(64, '0'), tx_index: 0, address: REGISTRY_ADDRESS, value: '1', inline_datum: null, asset_list: [] });
const page = (from: number) => Array.from({ length: 1_000 }, (_, i) => filler(from + i));
// A fetch that fails the test if anything reaches it, and remembers what did.
const noNetwork = () => { const calls: string[] = []; return { calls, f: (async (u: any) => { calls.push(String(u)); throw new Error('no Koios call expected'); }) as typeof fetch }; };
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection'); }, (e) => e as Error & { status?: number });

describe('resolveSubject: both DID forms', () => {
  test('the canonical DID and the legacy DID name the same identifier, and give the same subject and record', async () => {
    const canonical = await resolveSubject(`did:vector:${ASSET}`, replayFetch(store));
    const legacy = await resolveSubject(legacyVectorDid(REGISTRY_POLICY, ASSET), replayFetch(store));
    expect(canonical.subject).toEqual({ kind: 'asset', pkh: null, asset_name: ASSET, did: `did:vector:${ASSET}`, registry: 'legacy', controller_pkh: OWNER, candidates: [] });
    expect(legacy).toEqual(canonical);
    expect(canonical.record?.registry).toBe('legacy');
  });
  test('a bare identifier names it too, in any case; an unknown one resolves with no record, not an error', async () => {
    expect((await resolveSubject(ASSET.toUpperCase(), replayFetch(store))).subject).toMatchObject({ asset_name: ASSET, did: didFor(ASSET), controller_pkh: OWNER });
    const miss = await resolveSubject('11'.repeat(32), replayFetch({ [assetUtxosKey('11'.repeat(32))]: ok([]) }));
    expect(miss).toEqual({ subject: { kind: 'asset', pkh: null, asset_name: '11'.repeat(32), did: didFor('11'.repeat(32)), registry: null, controller_pkh: null, candidates: [] }, record: null });
  });
  test('with the identity registry configured, the record it holds is found under either DID form', async () => {
    const ledger = koiosLedger([{ hash: H(1), block: 100, outputs: [{ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, ASSET)], datum: identityHex() }], mint: [token(TEST_IDENTITY, ASSET)] }]);
    for (const subject of [`did:vector:${ASSET}`, legacyVectorDid(REGISTRY_POLICY, ASSET), ASSET]) {
      const r = await resolveSubject(subject, ledger, WITH_IDENTITY.registries);
      expect(r.subject, subject).toEqual({ kind: 'asset', pkh: null, asset_name: ASSET, did: didFor(ASSET), registry: 'identity', controller_pkh: keyHash(CONTROLLER), candidates: [] });
      expect(r.record?.registry).toBe('identity');
    }
  });
});

describe('resolveSubject strictness', () => {
  test('a DID under another policy, a testnet DID and a DID that breaks the syntax are each a 400 and cost no Koios call', async () => {
    const { f, calls } = noNetwork();
    const cases: Array<[string, RegExp]> = [
      [`did:vector:agent:${'11'.repeat(28)}:${ASSET}`, /^DID policy is not the legacy Vector agent registry$/],
      [`did:vector:agent:${TEST_IDENTITY.policy}:${ASSET}`, /^DID policy is not the legacy Vector agent registry$/], // the legacy form names the legacy registry only
      [`did:vector:testnet:${ASSET}`, /testnet DIDs are not supported/],
      // Part 1, section 3: every character of a DID is lowercase.
      [`did:vector:${ASSET.toUpperCase()}`, /all in lowercase/],
      [`did:vector:agent:${REGISTRY_POLICY.toUpperCase()}:${ASSET}`, /all in lowercase/],
      [`did:vector:${ASSET}#key`, /all in lowercase/],
      [`did:web:example.org`, /must be did:vector/],
    ];
    for (const [bad, message] of cases) {
      const e = await rejection(resolveSubject(bad, f, WITH_IDENTITY.registries));
      expect(e, bad).toBeInstanceOf(BadRequest);
      expect(e.status, bad).toBe(400);
      expect(e.message, bad).toMatch(message);
    }
    expect(calls).toEqual([]);
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
  test('a registry token that is not held at the registry address gives no record', async () => {
    const elsewhere = { ...utxo, address: 'addr1v' + 'q'.repeat(50) };
    const r = await resolveSubject(ASSET, replayFetch({ [assetUtxosKey(ASSET)]: ok([elsewhere]) }));
    expect(r).toMatchObject({ subject: { kind: 'asset', asset_name: ASSET, registry: null, controller_pkh: null }, record: null });
  });
  test('an output that holds two tokens of the registry is not an authentic record', async () => {
    const two = { ...utxo, asset_list: [...utxo.asset_list, { policy_id: REGISTRY_POLICY, asset_name: OTHER, quantity: '1' }] };
    expect((await resolveSubject(ASSET, replayFetch({ [assetUtxosKey(ASSET)]: ok([two]) }))).record).toBeNull();
  });
  test('a registry datum that cannot be decoded gives no record, not a failed report', async () => {
    const broken = { ...utxo, inline_datum: { bytes: 'd87980' } }; // Constr 0 with no fields
    expect(await resolveSubject(ASSET, replayFetch({ [assetUtxosKey(ASSET)]: ok([broken]) }))).toMatchObject({ subject: { asset_name: ASSET, controller_pkh: null }, record: null });
  });
});

describe('resolveSubject: a key hash names every record it acts for', () => {
  test('in the legacy registry, the records it owns; the first by identifier is the one the report is about', async () => {
    const r = await resolveSubject(OWNER, replayFetch(store));
    expect(r.subject).toMatchObject({ kind: 'pkh', pkh: OWNER, asset_name: ASSET, did: didFor(ASSET), registry: 'legacy', controller_pkh: OWNER });
    expect(r.subject.candidates).toEqual([
      { asset_name: ASSET, did: didFor(ASSET), name: 'A', registry: 'legacy', controller: true, purposes: [] },
      { asset_name: OTHER, did: didFor(OTHER), name: 'A', registry: 'legacy', controller: true, purposes: [] },
    ]);
  });
  test('in the identity registry too: the records whose controller it is, and those that list it, with the purposes they list it for', async () => {
    const ED = '22'.repeat(32), SUPPLIER = keyHash(ED);
    const listing = identityHex({ keys: [{ keyType: 'Ed25519', key: ED, purposes: 1 + 8, pop: null }] });
    const controlled = identityHex({ controller: ED });
    const ledger = koiosLedger([
      { hash: H(1), block: 100, outputs: [{ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, OTHER)], datum: listing }], mint: [token(TEST_IDENTITY, OTHER)] },
      { hash: H(2), block: 200, outputs: [{ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, ASSET)], datum: controlled }], mint: [token(TEST_IDENTITY, ASSET)] },
      { hash: H(3), block: 300, outputs: [{ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, '12'.repeat(32))], datum: identityHex() }], mint: [token(TEST_IDENTITY, '12'.repeat(32))] }, // neither
      { hash: H(4), block: 400, outputs: [{ address: LEGACY.address, assets: [token(LEGACY, '13'.repeat(32))], datum: datum.replace(OWNER, SUPPLIER) }], mint: [token(LEGACY, '13'.repeat(32))] },
    ]);
    const r = await resolveSubject(SUPPLIER, ledger, WITH_IDENTITY.registries);
    expect(r.subject.candidates).toEqual([
      { asset_name: '13'.repeat(32), did: didFor('13'.repeat(32)), name: 'A', registry: 'legacy', controller: true, purposes: [] },
      { asset_name: ASSET, did: didFor(ASSET), name: 'Agent', registry: 'identity', controller: true, purposes: [] },
      { asset_name: OTHER, did: didFor(OTHER), name: 'Agent', registry: 'identity', controller: false, purposes: ['authentication', 'transaction'] },
    ]);
    expect(r.subject).toMatchObject({ kind: 'pkh', pkh: SUPPLIER, asset_name: '13'.repeat(32), registry: 'legacy', controller_pkh: SUPPLIER });
  });
  test('a key that a record lists is the subject, and the controller is the record\'s own key', async () => {
    const ED = '22'.repeat(32);
    const ledger = koiosLedger([{ hash: H(1), block: 100, outputs: [{ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, ASSET)], datum: identityHex({ keys: [{ keyType: 'Ed25519', key: ED, purposes: 8, pop: null }] }) }], mint: [token(TEST_IDENTITY, ASSET)] }]);
    const r = await resolveSubject(keyHash(ED), ledger, WITH_IDENTITY.registries);
    expect(r.subject).toMatchObject({ kind: 'pkh', pkh: keyHash(ED), asset_name: ASSET, registry: 'identity', controller_pkh: keyHash(CONTROLLER) });
    expect(r.record?.registry).toBe('identity');
  });
  test('the candidate that is reported does not depend on the order Koios lists the UTxOs in', async () => {
    const forward = await resolveSubject(OWNER, replayFetch({ [addressUtxosKey()]: ok([utxo, second]), [addressUtxosKey(2)]: ok([]) }));
    const reverse = await resolveSubject(OWNER, replayFetch({ [addressUtxosKey()]: ok([second, utxo]), [addressUtxosKey(2)]: ok([]) }));
    expect(forward.subject.candidates.map((c) => c.asset_name)).toEqual([ASSET, OTHER]);
    expect(reverse).toEqual(forward);
  });
  test('a key hash that owns no record has no candidate and no record', async () => {
    const r = await resolveSubject('99'.repeat(28), replayFetch({ [addressUtxosKey()]: ok([]) }));
    expect(r).toEqual({ subject: { kind: 'pkh', pkh: '99'.repeat(28), asset_name: null, did: null, registry: null, controller_pkh: null, candidates: [] }, record: null });
  });
});

describe('resolveSubject key-hash scan paging', () => {
  test('reads on until a page comes back empty, including after a page shorter than 1,000', async () => {
    const urls: string[] = [];
    // a request at any other offset would be an unrecorded key, hence a fixture miss
    const replay = replayFetch({ [addressUtxosKey()]: ok(page(1)), [addressUtxosKey(1_000)]: ok([utxo]), [addressUtxosKey(1_001)]: ok([]) });
    const r = await resolveSubject(OWNER, (async (u: any, i?: RequestInit) => { urls.push(String(u)); return replay(u, i); }) as typeof fetch);
    expect(r.subject.candidates.map((c) => c.asset_name)).toEqual([ASSET]);
    expect(urls.map((u) => u.split('?')[1] ?? '')).toEqual(['', 'offset=1000', 'offset=1001']);
  });
  test('a short page does not end the scan: the next page starts after the rows actually read', async () => {
    const r = await resolveSubject(OWNER, replayFetch({ [addressUtxosKey()]: ok(page(1).slice(0, 600)), [addressUtxosKey(600)]: ok([utxo]), [addressUtxosKey(601)]: ok([]) }));
    expect(r.subject.candidates.map((c) => c.asset_name)).toEqual([ASSET]);
  });
  test('an empty first page ends the scan with no candidates after exactly one call', async () => {
    const urls: string[] = [];
    const replay = replayFetch({ [addressUtxosKey()]: ok([]) });
    const r = await resolveSubject(OWNER, (async (u: any, i?: RequestInit) => { urls.push(String(u)); return replay(u, i); }) as typeof fetch);
    expect(r.subject).toMatchObject({ kind: 'pkh', asset_name: null, candidates: [] });
    expect(urls).toHaveLength(1);
  });
  test('with the identity registry configured both addresses are scanned, each to its own empty page', async () => {
    const bodies: string[] = [];
    const replay = replayFetch({ [addressUtxosKey()]: ok([utxo]), [addressUtxosKey(1)]: ok([]), [addressUtxosKey(0, TEST_IDENTITY.address)]: ok([]) });
    const r = await resolveSubject(OWNER, (async (u: any, i?: RequestInit) => { bodies.push(`${String(u).split('?')[1] ?? ''} ${String(i?.body)}`); return replay(u, i); }) as typeof fetch, WITH_IDENTITY.registries);
    expect(r.subject.candidates.map((c) => [c.asset_name, c.registry])).toEqual([[ASSET, 'legacy']]);
    expect(bodies.sort()).toEqual([` ${JSON.stringify({ _addresses: [REGISTRY_ADDRESS], _extended: true })}`, ` ${JSON.stringify({ _addresses: [TEST_IDENTITY.address], _extended: true })}`, `offset=1 ${JSON.stringify({ _addresses: [REGISTRY_ADDRESS], _extended: true })}`].sort());
  });
  test('a scan that never ends is an error, not an endless loop', async () => {
    let calls = 0;
    const endless = (async () => { calls++; return new Response(JSON.stringify(page(1)), { status: 200 }); }) as typeof fetch;
    await expect(resolveSubject(OWNER, endless)).rejects.toThrow(/did not end within 20 pages/);
    expect(calls).toBe(20);
  });
});
