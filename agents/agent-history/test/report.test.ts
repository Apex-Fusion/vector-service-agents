import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, KOIOS_URL, INDEXER_URL, REGISTRY_POLICY, REGISTRY_ADDRESS, M1_ADDRESSES } from '@vsa/vector-read';
import type { Fetch } from '@vsa/vector-read';
import { buildReport, degradedReasons, BLIND_SPOTS } from '../src/report.ts';
import { manifestFromEnv } from '../src/server.ts';
import { TEST_ENV } from './support.ts';
const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
const DID = 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
const PKH = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
const ALL = ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] as const;
// The recorded /capability answer is replayed; the host lookup is stubbed so no test depends on DNS.
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
const opts = { manifest: manifestFromEnv(TEST_ENV), lookup };
describe('ChandraOCR report (recorded fixtures)', () => {
  test('identity', async () => {
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(fx.store), opts);
    expect(r.subject.controller_pkh).toBe(PKH);
    expect(r.identity).toMatchObject({ registered: { tx: 'fee14e5f2bf46b45b16e339334977833140622aa4f0b46024fcafc587b0406e6', block: 7275113 }, updates: [], deregistered: null });
    expect((r.identity as any).record.name).toBe('ChandraOCR');
    expect((r.identity as any).record.registered_at).toBe(1786092405791);
  });
  test('marketplace and reputation', async () => {
    const r = await buildReport({ subject: DID, include: ['marketplace', 'reputation'] }, replayFetch(fx.store), opts);
    const m = r.marketplace as any;
    expect(m.as_supplier.adverts[0].capability_id).toBe('ocr.page.extract.chandra-ocr-2.v1');
    expect(m.as_supplier.escrows.total).toBeGreaterThan(3000);
    expect(m.as_supplier.escrows.latest_checked).toBe(50);
    const rep = r.reputation as any;
    expect(rep.stakes[0]).toMatchObject({ utxo: '05563e751a32ce766aaf7aa015140912563f559394b5ecea77226d2c90bd6d4f#0', stake_lovelace: '10000000' });
  });
  test('a failing section does not fail the report', async () => {
    const store = { ...fx.store };
    for (const k of Object.keys(store)) if (k.includes('/suppliers')) store[k] = { status: 503, body: '{}' };
    const r = await buildReport({ subject: DID, include: ['identity', 'marketplace'] }, replayFetch(store), opts);
    expect((r.marketplace as any).error).toMatch(/503/);
    expect((r.identity as any).registered.block).toBe(7275113);
  });
});

describe('report assembly against the recording', () => {
  test('replaying the recording reproduces the recorded live report exactly: every section, the sources and the blind spots', async () => {
    const r = JSON.parse(JSON.stringify(await buildReport({ subject: DID, include: [...ALL] }, replayFetch(fx.store), opts)));
    const { sources, blind_spots, ...data } = r;
    const { sources: recordedSources, blind_spots: recordedBlindSpots, ...recordedData } = fx.report;
    expect(data).toEqual(recordedData);
    expect(sources).toEqual(recordedSources); // the same URLs in the same (sorted) order
    expect(blind_spots).toEqual(recordedBlindSpots);
    expect(blind_spots).toEqual(BLIND_SPOTS); // nothing was missing or truncated for this subject, so only the fixed lines
  });
  test('the Module-3 stake is a real recorded datum, decoded field by field', async () => {
    const r = await buildReport({ subject: DID, include: ['reputation'] }, replayFetch(fx.store), opts);
    const rep = r.reputation as any;
    expect(rep.stakes).toHaveLength(1);
    expect(rep.stakes[0]).toEqual({
      utxo: '05563e751a32ce766aaf7aa015140912563f559394b5ecea77226d2c90bd6d4f#0',
      agent_asset_name: '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', owner_pkh: PKH,
      stake_lovelace: '10000000', capabilities: ['ocr.page.extract.chandra-ocr-2.v1', 'document-extraction'],
      last_updated: 1786092804000, history_points: 0,
    });
    expect(rep.endorsements).toEqual([]);
  });
  test('the dispute and self-improvement sections list their module addresses and find nothing for this agent', async () => {
    const r = await buildReport({ subject: DID, include: ['dispute', 'self_improvement'] }, replayFetch(fx.store), opts);
    expect(r.dispute).toEqual({ claim: [], challenge: [], jury_pool: [], claim_v15_sim: [], challenge_v15_sim: [], jury_pool_v15_sim: [] });
    expect(r.self_improvement).toEqual({ proposal: [], critique: [], endorsement: [] });
  });
  test('key roles: the capability key hashes to the controller', async () => {
    const r = await buildReport({ subject: DID, include: ['identity', 'marketplace'] }, replayFetch(fx.store), opts);
    expect(r.key_roles).toEqual({ controller_pkh: PKH, advert_count: 1, capability_key_matches_controller: true, capability_endpoint: 'https://mp-suppliers-chandra.hal8.ai' });
  });
  test('key roles: an unreachable endpoint stays unknown, and an unread marketplace section is not counted as zero adverts', async () => {
    const store = { ...fx.store };
    delete store['GET https://mp-suppliers-chandra.hal8.ai/capability '];
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(store), opts);
    expect(r.key_roles).toEqual({ controller_pkh: PKH, advert_count: null, capability_key_matches_controller: 'unknown', capability_endpoint: 'https://mp-suppliers-chandra.hal8.ai' });
  });
  test('key roles: a capability key that does not hash to the controller is reported false', async () => {
    const store = { ...fx.store, 'GET https://mp-suppliers-chandra.hal8.ai/capability ': { status: 200, body: JSON.stringify({ pub_key_hex: 'ab'.repeat(32) }) } };
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(store), opts);
    expect(r.key_roles.capability_key_matches_controller).toBe(false);
  });
  test('as_of is the recorded tip, and a tip that cannot be read leaves the rest of the report intact', async () => {
    const tipKey = `GET ${KOIOS_URL}/tip `;
    const tip = JSON.parse(fx.store[tipKey].body)[0];
    const ok = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(fx.store), opts);
    expect(ok.as_of).toEqual({ block: tip.block_no, slot: tip.abs_slot, time: tip.block_time });
    const store = { ...fx.store }; delete store[tipKey];
    const noTip = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(store), opts);
    expect(noTip.as_of).toBeNull();
    expect((noTip.identity as any).registered.block).toBe(7275113);
  });
  test('sources lists every URL read once, sorted whatever order the concurrent sections asked in, and nothing else', async () => {
    const r = await buildReport({ subject: DID, include: ['identity', 'marketplace'] }, replayFetch(fx.store), opts);
    expect(r.sources).toEqual([
      `${INDEXER_URL}/escrows?buyer=${PKH}`, `${INDEXER_URL}/escrows?supplier=${PKH}`, `${INDEXER_URL}/suppliers`,
      'https://mp-suppliers-chandra.hal8.ai/capability',
      `${KOIOS_URL}/asset_txs`, `${KOIOS_URL}/asset_utxos`, `${KOIOS_URL}/tip`, `${KOIOS_URL}/tx_info`, `${KOIOS_URL}/utxo_info`,
    ]);
  });
  test('the blind spots say what the live indexer rows are and which module datums are skipped', async () => {
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(fx.store), opts);
    expect(r.blind_spots).toEqual(BLIND_SPOTS);
    expect(r.blind_spots).toHaveLength(5);
    expect(r.blind_spots[1]).toMatch(/one per escrow UTxO version/);
    expect(r.blind_spots.some((b) => /Module-3/.test(b))).toBe(true);
  });
});

describe('subjects without a registry record', () => {
  const OTHER = '99'.repeat(28);
  const empty = { status: 200, body: '[]' };
  const store = {
    [`GET ${KOIOS_URL}/tip `]: fx.store[`GET ${KOIOS_URL}/tip `],
    [`POST ${KOIOS_URL}/address_utxos ${JSON.stringify({ _addresses: ['addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42'], _extended: true })}`]: empty,
    [`GET ${INDEXER_URL}/suppliers `]: empty,
    [`GET ${INDEXER_URL}/escrows?supplier=${OTHER} `]: empty,
    [`GET ${INDEXER_URL}/escrows?buyer=${OTHER} `]: empty,
  };
  test('a key hash that owns no record still gets its marketplace section, and the missing record is stated', async () => {
    const r = await buildReport({ subject: OTHER, include: ['identity', 'marketplace'] }, replayFetch(store), opts);
    expect(r.subject).toEqual({ kind: 'pkh', asset_name: null, did: null, controller_pkh: OTHER, candidates: [] });
    expect(r.identity).toEqual({ registered: null, record: null, updates: [], deregistered: null });
    expect(r.marketplace).toMatchObject({ as_supplier: { adverts: [], escrows: { total: 0, first: null, last: null } }, as_buyer: { escrows: { total: 0 } } });
    expect(r.blind_spots[0]).toMatch(/No registry record found/);
  });
  test('a DID under another policy is rejected before anything is read, the tip included', async () => {
    const calls: string[] = [];
    const spy = (async (u: any) => { calls.push(String(u)); throw new Error('no network expected'); }) as typeof fetch;
    await expect(buildReport({ subject: `did:vector:agent:${'11'.repeat(28)}:${'ab'.repeat(32)}`, include: ['identity'] }, spy, opts)).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
});

describe('concurrent sections', () => {
  test('every requested section has started before any of them is answered', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started: string[] = [];
    const replay = replayFetch(fx.store);
    // The subject lookup and the tip answer at once; every other call waits for the gate.
    const f = (async (u: any, i?: RequestInit) => {
      const url = String(u);
      started.push(url);
      if (!url.endsWith('/asset_utxos') && !url.endsWith('/tip')) await gate;
      return replay(u, i);
    }) as Fetch;
    const run = buildReport({ subject: DID, include: ['identity', 'marketplace', 'reputation'] }, f, opts);
    const expected = [`${KOIOS_URL}/asset_txs`, `${INDEXER_URL}/suppliers`, `${INDEXER_URL}/escrows?supplier=${PKH}`, `${INDEXER_URL}/escrows?buyer=${PKH}`, `${KOIOS_URL}/address_utxos`];
    for (let i = 0; i < 100 && expected.some((u) => !started.includes(u)); i++) await new Promise((r) => setTimeout(r, 10));
    const whileWaiting = [...started];
    release();
    await run;
    for (const u of expected) expect(whileWaiting).toContain(u);
    expect(whileWaiting.filter((u) => u === `${KOIOS_URL}/address_utxos`)).toHaveLength(2); // both Module-3 addresses
  });
});

describe('module scan truncation', () => {
  const claimKey = `POST ${KOIOS_URL}/address_utxos ${JSON.stringify({ _addresses: [M1_ADDRESSES.claim], _extended: true })}`;
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ tx_hash: (i + 1).toString(16).padStart(64, '0'), tx_index: 0, value: '1', inline_datum: null, asset_list: [] }));
  const LINE = 'module scan may be truncated at 1,000 rows';
  test('a module page of exactly 1,000 rows adds the line, once, at the end; 999 rows does not', async () => {
    const full = await buildReport({ subject: DID, include: ['dispute'] }, replayFetch({ ...fx.store, [claimKey]: { status: 200, body: JSON.stringify(rows(1_000)) } }), opts);
    expect(full.blind_spots).toEqual([...BLIND_SPOTS, LINE]);
    const short = await buildReport({ subject: DID, include: ['dispute'] }, replayFetch({ ...fx.store, [claimKey]: { status: 200, body: JSON.stringify(rows(999)) } }), opts);
    expect(short.blind_spots).toEqual(BLIND_SPOTS);
  });
});

describe('a subject whose registry record is gone', () => {
  const GONE = 'ab'.repeat(32), A = 'cd'.repeat(28), B = 'ef'.repeat(28);
  const NO_LIVE_RECORD = 'marketplace and key_roles were not read: the subject has no live registry record';
  const reg = (owner: string) => Data.to(new Constr(0, [new Constr(0, [owner]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
  const tok = [{ policy_id: REGISTRY_POLICY, asset_name: GONE, quantity: '1' }];
  const out = (datum: string | null, atRegistry = true) => ({ tx_index: 0, payment_addr: { cred: 'x', bech32: atRegistry ? REGISTRY_ADDRESS : 'addr1v' + 'q'.repeat(50) }, value: '10000000', inline_datum: datum ? { bytes: datum } : null, asset_list: atRegistry ? tok : [] });
  const spent = (hash: string) => ({ tx_hash: hash, tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '1', asset_list: tok });
  // registered to A, rotated to B, then the token leaves the registry: nothing is left at the registry address
  const txs = [
    { tx_hash: '11'.repeat(32), block_height: 100, tx_block_index: 0, tx_timestamp: 1000, inputs: [], outputs: [out(reg(A))] },
    { tx_hash: '22'.repeat(32), block_height: 200, tx_block_index: 0, tx_timestamp: 2000, inputs: [spent('11'.repeat(32))], outputs: [out(reg(B))] },
    { tx_hash: '33'.repeat(32), block_height: 300, tx_block_index: 0, tx_timestamp: 3000, inputs: [spent('22'.repeat(32))], outputs: [out(null, false)] },
  ];
  const tipKey = `GET ${KOIOS_URL}/tip `;
  const storeFor = (asset: string, listed: typeof txs) => ({
    [tipKey]: fx.store[tipKey],
    [`POST ${KOIOS_URL}/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, asset]], _extended: true })}`]: { status: 200, body: '[]' },
    [`POST ${KOIOS_URL}/asset_txs ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: asset, _history: true })}`]: { status: 200, body: JSON.stringify(listed.map((t) => ({ tx_hash: t.tx_hash, block_height: t.block_height, block_time: t.tx_timestamp }))) },
    ...(listed.length ? { [`POST ${KOIOS_URL}/tx_info ${JSON.stringify({ _tx_hashes: listed.map((t) => t.tx_hash), _inputs: true, _assets: true })}`]: { status: 200, body: JSON.stringify(listed) } } : {}),
  });
  test('a deregistered subject has a null marketplace and a blind-spot line that says why', async () => {
    const r = await buildReport({ subject: GONE, include: ['identity', 'marketplace'] }, replayFetch(storeFor(GONE, txs)), opts);
    expect(r.subject).toMatchObject({ kind: 'asset', asset_name: GONE, controller_pkh: null });
    expect(r.identity).toMatchObject({ registered: { block: 100 }, deregistered: { block: 300 }, record: null });
    expect(r.identity).toHaveProperty('updates', [expect.objectContaining({ kind: 'controller_rotation', from_pkh: A, to_pkh: B })]);
    expect(r.marketplace).toBeNull();
    expect(r.key_roles).toEqual({ controller_pkh: null, advert_count: null, capability_key_matches_controller: 'unknown', capability_endpoint: null });
    expect(r.blind_spots).toEqual([NO_LIVE_RECORD, ...BLIND_SPOTS]);
  });
  test('a subject that was never registered gets the no-record line only', async () => {
    const NEVER = '12'.repeat(32);
    const r = await buildReport({ subject: NEVER, include: ['identity', 'marketplace'] }, replayFetch(storeFor(NEVER, [])), opts);
    expect(r.marketplace).toBeNull();
    expect(r.blind_spots).toEqual(['No registry record found for this subject.', ...BLIND_SPOTS]);
  });
});

describe('degradedReasons', () => {
  test('a complete report has none', async () => {
    const r = await buildReport({ subject: DID, include: [...ALL] }, replayFetch(fx.store), opts);
    expect(degradedReasons(r)).toEqual([]);
  });
  test('a failed section and a missing chain tip are each named', async () => {
    const store = { ...fx.store };
    for (const k of Object.keys(store)) if (k.includes('/suppliers')) store[k] = { status: 503, body: '{}' };
    delete store[`GET ${KOIOS_URL}/tip `];
    const r = await buildReport({ subject: DID, include: ['identity', 'marketplace'] }, replayFetch(store), opts);
    expect(degradedReasons(r)).toEqual([expect.stringMatching(/^marketplace: .*503/), expect.stringMatching(/^as_of/)]);
  });
});
