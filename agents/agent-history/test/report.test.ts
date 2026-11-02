import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, keyHash, utf8ToHex, legacyVectorDid, KOIOS_URL, INDEXER_URL, REGISTRY_POLICY, REGISTRY_ADDRESS, M1_ADDRESSES } from '@vsa/vector-read';
import type { Fetch, Key } from '@vsa/vector-read';
import { buildReport, degradedReasons, lastKnownKeysLine, BLIND_SPOTS, CURRENT_STATE_GAP, IDENTITY_VIEW_GAP, LEGACY_ONLY, REPORT_BUDGET_MS } from '../src/report.ts';
import { manifestFromEnv } from '../src/server.ts';
import { TEST_ENV, WITH_IDENTITY, TEST_IDENTITY, LEGACY, koiosLedger, token, txHash, identityHex } from './support.ts';
import type { LedgerTx } from './support.ts';
const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
const CHANDRA = '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
const DID = `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:${CHANDRA}`;
const CANONICAL = `did:vector:${CHANDRA}`;
const PKH = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
const ENDPOINT = 'https://mp-suppliers-chandra.hal8.ai';
const ALL = ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] as const;
// The recorded /capability answer is replayed; the host lookup is stubbed so no test depends on DNS.
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
const opts = { manifest: manifestFromEnv(TEST_ENV), lookup };
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
describe('ChandraOCR report (recorded fixtures)', () => {
  test('identity: one legacy registration, the record and the version it made', async () => {
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(fx.store), opts);
    expect(r.subject).toEqual({ kind: 'asset', pkh: null, asset_name: CHANDRA, did: CANONICAL, registry: 'legacy', controller_pkh: PKH, candidates: [] });
    expect(r.identity).toMatchObject({ origin: 'legacy', registered: { tx: 'fee14e5f2bf46b45b16e339334977833140622aa4f0b46024fcafc587b0406e6', block: 7275113, registry: 'legacy' }, adopted: null, deregistered: null });
    expect((r.identity as any).timeline.map((e: any) => [e.registry, e.event, e.version])).toEqual([['legacy', 'registration', 0]]);
    expect((r.identity as any).record).toMatchObject({ registry: 'legacy', controller_pkh: PKH, name: 'ChandraOCR', registered_at: 1786092405791 });
  });
  test('marketplace and reputation', async () => {
    const r = await buildReport({ subject: DID, include: ['marketplace', 'reputation'] }, replayFetch(fx.store), opts);
    const m = r.marketplace as any;
    expect(m.as_supplier.adverts[0]).toMatchObject({ capability_id: 'ocr.page.extract.chandra-ocr-2.v1', supplier_pkh: PKH, agent_id: null });
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

describe('ChandraOCR in both DID forms', () => {
  test('the legacy DID, the canonical DID and the bare identifier give the recorded report, byte for byte', async () => {
    for (const subject of [DID, CANONICAL, CHANDRA]) {
      const r = await buildReport({ subject, include: [...ALL] }, replayFetch(fx.store), opts);
      expect(JSON.stringify(r), subject).toBe(JSON.stringify(fx.report));
    }
  });
  test('with the identity registry configured and no identity record yet, both forms give the same report: the legacy history, and no line about the identity registry', async () => {
    const store = {
      ...fx.store,
      [`POST ${KOIOS_URL}/asset_utxos ${JSON.stringify({ _asset_list: [[TEST_IDENTITY.policy, CHANDRA]], _extended: true })}`]: { status: 200, body: '[]' },
      [`POST ${KOIOS_URL}/asset_txs ${JSON.stringify({ _asset_policy: TEST_IDENTITY.policy, _asset_name: CHANDRA, _history: true })}`]: { status: 200, body: '[]' },
    };
    const [legacy, canonical] = await Promise.all([DID, CANONICAL].map((subject) => buildReport({ subject, include: [...ALL] }, replayFetch(store), { ...opts, config: WITH_IDENTITY })));
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(legacy));
    const { blind_spots, ...rest } = json(legacy);
    const { blind_spots: recorded, ...recordedRest } = fx.report;
    expect(rest).toEqual(recordedRest);
    expect(recorded).toEqual([LEGACY_ONLY, ...BLIND_SPOTS]);
    expect(blind_spots).toEqual(BLIND_SPOTS);
  });

  // ChandraOCR adopts (Part 2, section 9.1): the recorded legacy registration, then an adoption transaction that burns the legacy token and mints the
  // identity token, with the Foundation key as controller and the supplier key listed. Every other call is the recording's.
  const OPERATOR = '0f'.repeat(32), CAPABILITY_KEY = '220dd63e34ffbd08b03795fbdaa949df0497e94f3aa2be18da8cd40e5a5ba651';
  const REG_TX = 'fee14e5f2bf46b45b16e339334977833140622aa4f0b46024fcafc587b0406e6', ADOPT_TX = txHash(0xad0), SUSPEND_TX = txHash(0xad1);
  const legacyDatum = JSON.parse(fx.store[`POST ${KOIOS_URL}/utxo_info ${JSON.stringify({ _utxo_refs: [`${REG_TX}#0`], _extended: true })}`].body)[0].inline_datum.bytes;
  const adopted = (keys: Key[]) => ({
    controller: OPERATOR, keys, name: utf8ToHex('ChandraOCR'), description: utf8ToHex('Historical and handwritten document extraction.'),
    framework: utf8ToHex('agents-marketplace'), endpoint: utf8ToHex(ENDPOINT), capabilities: [utf8ToHex('ocr.page.extract.chandra-ocr-2.v1')],
  });
  const chandraAdopts = (keys: Key[]): LedgerTx[] => [
    { hash: REG_TX, block: 7_275_113, time: 1_786_092_415, outputs: [{ address: LEGACY.address, assets: [token(LEGACY, CHANDRA)], datum: legacyDatum, byHash: true }], mint: [token(LEGACY, CHANDRA)] },
    { hash: ADOPT_TX, block: 9_000_000, time: 1_795_000_000, spends: [`${REG_TX}#0`], outputs: [{ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, CHANDRA)], datum: identityHex(adopted(keys)) }], mint: [token(LEGACY, CHANDRA, '-1'), token(TEST_IDENTITY, CHANDRA)] },
    { hash: SUSPEND_TX, block: 9_000_100, time: 1_795_000_100, spends: [`${ADOPT_TX}#0`], outputs: [{ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, CHANDRA)], datum: identityHex({ ...adopted(keys), status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 68, since: 1_795_000_000_000, until: 1_796_000_000_000 }] } }) }] },
  ];
  const supplierKey = (purposes: number): Key => ({ keyType: 'Ed25519', key: CAPABILITY_KEY, purposes, pop: null });
  const adoptedReport = (keys: Key[], subject: string) => buildReport({ subject, include: ['identity', 'marketplace'] }, koiosLedger(chandraAdopts(keys), replayFetch(fx.store)), { ...opts, config: WITH_IDENTITY });
  test('after the adoption both forms give one timeline across both registries, and the key check is active_key with the transaction purpose', async () => {
    const [legacy, canonical] = await Promise.all([DID, CANONICAL].map((s) => adoptedReport([supplierKey(1 + 8)], s)));
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(legacy));
    expect(legacy.subject).toEqual({ kind: 'asset', pkh: null, asset_name: CHANDRA, did: CANONICAL, registry: 'identity', controller_pkh: keyHash(OPERATOR), candidates: [] });
    const identity = legacy.identity as any;
    expect(identity).toMatchObject({ origin: 'adopted', registered: { tx: REG_TX, block: 7_275_113, registry: 'legacy' }, adopted: { tx: ADOPT_TX, block: 9_000_000 }, deregistered: null });
    expect(identity.timeline.map((e: any) => [e.registry, e.event, e.version])).toEqual([['legacy', 'registration', 0], ['identity', 'adoption', 1], ['identity', 'update', 2]]);
    expect(identity.timeline[1].changes.controller).toEqual({ from: PKH, to: keyHash(OPERATOR) });
    expect(identity.timeline[1].changes.keys.added).toEqual([{ key_hash: PKH, type: 'Ed25519', purposes: ['authentication', 'transaction'] }]);
    expect(identity.timeline[2].changes).toEqual({ status: { from: 'active', to: 'suspended' }, holds: { added: [{ by: 'controller', reason: 'securityInvestigation', since: 1_795_000_000_000, until: 1_796_000_000_000 }], renewed: [], removed: [] } });
    // The supplier key is listed for transactions: the marketplace is read with it, and the key the endpoint serves is active.
    expect(legacy.key_roles).toEqual({ controller_pkh: keyHash(OPERATOR), marketplace_pkhs: [PKH], advert_count: 1, capability_endpoint: ENDPOINT, capability_key_pkh: PKH, capability_key_active: true });
    expect((legacy.marketplace as any).as_supplier.escrows.total).toBe((fx.report.marketplace as any).as_supplier.escrows.total);
    expect(legacy.blind_spots).toEqual(BLIND_SPOTS);
    expect(degradedReasons(legacy)).toEqual([]);
  });
  test('a record that lists the supplier key without the transaction purpose: the key check is false, and the marketplace falls back to the last known keys', async () => {
    const r = await adoptedReport([supplierKey(1)], CANONICAL);
    expect(r.key_roles).toEqual({ controller_pkh: keyHash(OPERATOR), marketplace_pkhs: [PKH], advert_count: 1, capability_endpoint: ENDPOINT, capability_key_pkh: PKH, capability_key_active: false });
    expect(r.blind_spots).toEqual([lastKnownKeysLine([PKH]), ...BLIND_SPOTS]); // the owner key of the legacy version, the last version that named one
  });
});

describe('report assembly against the recording', () => {
  test('replaying the recording reproduces the stored report exactly: every section, the sources and the blind spots', async () => {
    const r = json(await buildReport({ subject: DID, include: [...ALL] }, replayFetch(fx.store), opts));
    const { sources, blind_spots, ...data } = r;
    const { sources: recordedSources, blind_spots: recordedBlindSpots, ...recordedData } = fx.report;
    expect(data).toEqual(recordedData);
    expect(sources).toEqual(recordedSources); // the same URLs in the same (sorted) order
    expect(blind_spots).toEqual(recordedBlindSpots);
    expect(blind_spots).toEqual([LEGACY_ONLY, ...BLIND_SPOTS]); // nothing was missing or truncated for this subject; the identity registry is not configured
  });
  test('the Module-3 stake is a real recorded datum, decoded field by field', async () => {
    const r = await buildReport({ subject: DID, include: ['reputation'] }, replayFetch(fx.store), opts);
    const rep = r.reputation as any;
    expect(rep.stakes).toHaveLength(1);
    expect(rep.stakes[0]).toEqual({
      utxo: '05563e751a32ce766aaf7aa015140912563f559394b5ecea77226d2c90bd6d4f#0',
      agent_asset_name: CHANDRA, owner_pkh: PKH,
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
  test('the module sections read the addresses of the configuration, under their labels', async () => {
    const modules = { ...WITH_IDENTITY.modules, m1: { claim_new: M1_ADDRESSES.claim_v15_sim }, m6: { proposal_new: 'addr1wxvtvyx9jkt7jprdhm0g6wxkl8pvvc63vlwumju8f5uatzgnjjjcr' } };
    const r = await buildReport({ subject: DID, include: ['dispute', 'self_improvement'] }, replayFetch(fx.store), { ...opts, config: { registries: { legacy: LEGACY, identity: null }, modules } });
    expect(r.dispute).toEqual({ claim_new: [] });
    expect(r.self_improvement).toEqual({ proposal_new: [] });
  });
  test('key roles: the capability key of a legacy record hashes to its owner key', async () => {
    const r = await buildReport({ subject: DID, include: ['identity', 'marketplace'] }, replayFetch(fx.store), opts);
    expect(r.key_roles).toEqual({ controller_pkh: PKH, marketplace_pkhs: [PKH], advert_count: 1, capability_endpoint: ENDPOINT, capability_key_pkh: PKH, capability_key_active: true });
  });
  test('key roles: an unreachable endpoint stays unknown, and an unread marketplace section is not counted as zero adverts', async () => {
    const store = { ...fx.store };
    delete store[`GET ${ENDPOINT}/capability `];
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(store), opts);
    expect(r.key_roles).toEqual({ controller_pkh: PKH, marketplace_pkhs: [PKH], advert_count: null, capability_endpoint: ENDPOINT, capability_key_pkh: null, capability_key_active: 'unknown' });
  });
  test('key roles: a capability key that does not hash to the owner is reported false, with its key hash', async () => {
    const store = { ...fx.store, [`GET ${ENDPOINT}/capability `]: { status: 200, body: JSON.stringify({ pub_key_hex: 'ab'.repeat(32) }) } };
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(store), opts);
    expect(r.key_roles).toMatchObject({ capability_key_pkh: keyHash('ab'.repeat(32)), capability_key_active: false });
  });
  test('key roles: without the identity section the endpoint is not asked', async () => {
    const r = await buildReport({ subject: DID, include: ['marketplace'] }, replayFetch(fx.store), opts);
    expect(r.key_roles).toEqual({ controller_pkh: PKH, marketplace_pkhs: [PKH], advert_count: 1, capability_endpoint: null, capability_key_pkh: null, capability_key_active: 'unknown' });
    expect(r.sources).not.toContain(`${ENDPOINT}/capability`);
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
      `${ENDPOINT}/capability`,
      `${KOIOS_URL}/asset_txs`, `${KOIOS_URL}/asset_utxos`, `${KOIOS_URL}/tip`, `${KOIOS_URL}/tx_info`, `${KOIOS_URL}/utxo_info`,
    ]);
  });
  test('the blind spots say what the live indexer rows are, which module datums are skipped, and what the identity section is not', async () => {
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(fx.store), opts);
    expect(r.blind_spots).toEqual([LEGACY_ONLY, ...BLIND_SPOTS]);
    expect(BLIND_SPOTS).toHaveLength(7);
    expect(BLIND_SPOTS[0]).toMatch(/agents that share a key show the same marketplace section/);
    expect(BLIND_SPOTS[0]).toMatch(/the listed keys with the transaction purpose/);
    expect(BLIND_SPOTS[1]).toMatch(/one per escrow UTxO version/);
    expect(BLIND_SPOTS[5]).toBe(CURRENT_STATE_GAP);
    expect(BLIND_SPOTS.at(-1)).toBe(IDENTITY_VIEW_GAP);
    expect(IDENTITY_VIEW_GAP).toMatch(/It is not a did:vector resolution/);
    expect(BLIND_SPOTS.some((b) => /Module-3/.test(b))).toBe(true);
  });
});

describe('subjects without a registry record', () => {
  const OTHER = '99'.repeat(28);
  const empty = { status: 200, body: '[]' };
  const store = {
    [`GET ${KOIOS_URL}/tip `]: fx.store[`GET ${KOIOS_URL}/tip `],
    [`POST ${KOIOS_URL}/address_utxos ${JSON.stringify({ _addresses: [REGISTRY_ADDRESS], _extended: true })}`]: empty,
    [`GET ${INDEXER_URL}/suppliers `]: empty,
    [`GET ${INDEXER_URL}/escrows?supplier=${OTHER} `]: empty,
    [`GET ${INDEXER_URL}/escrows?buyer=${OTHER} `]: empty,
  };
  test('a key hash that owns no record still gets its marketplace section, and the missing record is stated', async () => {
    const r = await buildReport({ subject: OTHER, include: ['identity', 'marketplace'] }, replayFetch(store), opts);
    expect(r.subject).toEqual({ kind: 'pkh', pkh: OTHER, asset_name: null, did: null, registry: null, controller_pkh: null, candidates: [] });
    expect(r.identity).toEqual({ origin: null, registered: null, adopted: null, deregistered: null, record: null, timeline: [] });
    expect(r.marketplace).toMatchObject({ as_supplier: { adverts: [], escrows: { total: 0, first: null, last: null } }, as_buyer: { escrows: { total: 0 } } });
    expect(r.key_roles).toMatchObject({ controller_pkh: null, marketplace_pkhs: [OTHER] });
    expect(r.blind_spots).toEqual([LEGACY_ONLY, 'No registry record found for this subject.', ...BLIND_SPOTS]);
  });
  test('a DID under another policy, or with an uppercase character, is rejected before anything is read, the tip included', async () => {
    for (const subject of [`did:vector:agent:${'11'.repeat(28)}:${'ab'.repeat(32)}`, CANONICAL.toUpperCase().replace('DID:VECTOR:', 'did:vector:')]) {
      const calls: string[] = [];
      const spy = (async (u: any) => { calls.push(String(u)); throw new Error('no network expected'); }) as typeof fetch;
      await expect(buildReport({ subject, include: ['identity'] }, spy, opts), subject).rejects.toMatchObject({ status: 400 });
      expect(calls).toEqual([]);
    }
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
  test('the nine Module-1 and Module-6 addresses are all asked before any of them is answered', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const asked: string[] = [];
    const replay = replayFetch(fx.store);
    const f = (async (u: any, i?: RequestInit) => {
      const url = String(u);
      if (url.endsWith('/address_utxos')) { asked.push(String(i?.body)); await gate; }
      return replay(u, i);
    }) as Fetch;
    const run = buildReport({ subject: DID, include: ['dispute', 'self_improvement'] }, f, opts);
    for (let i = 0; i < 100 && asked.length < 9; i++) await new Promise((r) => setTimeout(r, 10));
    const whileWaiting = [...asked];
    release();
    const r = await run;
    expect(whileWaiting).toHaveLength(9); // six Module-1 addresses and three Module-6 addresses, none of them waiting for another
    expect(new Set(whileWaiting).size).toBe(9);
    expect(Object.keys(r.dispute as object)).toEqual(['claim', 'challenge', 'jury_pool', 'claim_v15_sim', 'challenge_v15_sim', 'jury_pool_v15_sim']); // the order of the addresses
    expect(Object.keys(r.self_improvement as object)).toEqual(['proposal', 'critique', 'endorsement']);
  });
});

describe('module scan truncation', () => {
  const claimKey = `POST ${KOIOS_URL}/address_utxos ${JSON.stringify({ _addresses: [M1_ADDRESSES.claim], _extended: true })}`;
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ tx_hash: (i + 1).toString(16).padStart(64, '0'), tx_index: 0, value: '1', inline_datum: null, asset_list: [] }));
  const LINE = 'module scan may be truncated at 1,000 rows';
  test('a module page of exactly 1,000 rows adds the line, once, at the end; 999 rows does not', async () => {
    const full = await buildReport({ subject: DID, include: ['dispute'] }, replayFetch({ ...fx.store, [claimKey]: { status: 200, body: JSON.stringify(rows(1_000)) } }), opts);
    expect(full.blind_spots).toEqual([LEGACY_ONLY, ...BLIND_SPOTS, LINE]);
    const short = await buildReport({ subject: DID, include: ['dispute'] }, replayFetch({ ...fx.store, [claimKey]: { status: 200, body: JSON.stringify(rows(999)) } }), opts);
    expect(short.blind_spots).toEqual([LEGACY_ONLY, ...BLIND_SPOTS]);
  });
});

describe('a subject whose registry record is gone', () => {
  const GONE = 'ab'.repeat(32), A = 'cd'.repeat(28), B = 'ef'.repeat(28);
  const NO_MARKETPLACE_KEY = 'marketplace was not read: the subject has no live registry record that names a marketplace key (the owner key of a legacy record, or a listed key with the transaction purpose), and the identity timeline gave no earlier one.';
  const reg = (owner: string) => Data.to(new Constr(0, [new Constr(0, [owner]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
  const tok = [{ policy_id: REGISTRY_POLICY, asset_name: GONE, quantity: '1' }];
  const out = (datum: string | null, atRegistry = true) => ({ tx_index: 0, payment_addr: { cred: 'x', bech32: atRegistry ? REGISTRY_ADDRESS : 'addr1v' + 'q'.repeat(50) }, value: '10000000', inline_datum: datum ? { bytes: datum } : null, asset_list: atRegistry ? tok : [] });
  const spent = (hash: string) => ({ tx_hash: hash, tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '1', asset_list: tok });
  // registered to A, rotated to B, then deregistered: the token is burned and nothing is left at the registry address
  const txs = [
    { tx_hash: '11'.repeat(32), block_height: 100, tx_block_index: 0, tx_timestamp: 1000, inputs: [], outputs: [out(reg(A))], assets_minted: tok },
    { tx_hash: '22'.repeat(32), block_height: 200, tx_block_index: 0, tx_timestamp: 2000, inputs: [spent('11'.repeat(32))], outputs: [out(reg(B))] },
    { tx_hash: '33'.repeat(32), block_height: 300, tx_block_index: 0, tx_timestamp: 3000, inputs: [spent('22'.repeat(32))], outputs: [out(null, false)], assets_minted: [{ ...tok[0], quantity: '-1' }] },
  ];
  const tipKey = `GET ${KOIOS_URL}/tip `;
  const storeFor = (asset: string, listed: typeof txs) => ({
    [tipKey]: fx.store[tipKey],
    [`POST ${KOIOS_URL}/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, asset]], _extended: true })}`]: { status: 200, body: '[]' },
    [`POST ${KOIOS_URL}/asset_txs ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: asset, _history: true })}`]: { status: 200, body: JSON.stringify(listed.map((t) => ({ tx_hash: t.tx_hash, block_height: t.block_height, block_time: t.tx_timestamp }))) },
    ...(listed.length ? { [`POST ${KOIOS_URL}/tx_info ${JSON.stringify({ _tx_hashes: listed.map((t) => t.tx_hash), _inputs: true, _assets: true })}`]: { status: 200, body: JSON.stringify(listed) } } : {}),
  });
  // What the marketplace indexer holds for one key: an advert of that key and of a stranger, two escrow rows of that key (one spent on the ledger), no buyer rows.
  const R1 = `${'a1'.repeat(32)}#0`, R2 = `${'a2'.repeat(32)}#0`;
  const escrow = (ref: string, supplier: string, state: string, postedAt: number) => ({ utxo_ref: ref, buyer_pkh: '77'.repeat(28), supplier_pkh: supplier, advert_ref: `${'bb'.repeat(32)}#0`, capability_id: 'x.y.v1', payment_lovelace: '1000000', deliver_by: postedAt + 480_000, posted_at: postedAt, submitted_at: null, result_receipt_hash: null, state });
  const advert = (supplier: string, ref: string) => ({ utxo_ref: ref, supplier_pkh: supplier, capability_id: 'x.y.v1', model: 'm-v1', price_lovelace: '1000000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', max_processing_ms: 300000, endpoint_url: 'https://a.example', detail_uri: '', status: 'free', advert_status: 'Retired', last_seen_iso: null, advertised_at: 1 });
  const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
  const ADVERT_B = `${'cc'.repeat(32)}#0`;
  const marketFor = (pkh: string) => ({
    [`GET ${INDEXER_URL}/suppliers `]: ok([advert(pkh, ADVERT_B), advert('99'.repeat(28), `${'dd'.repeat(32)}#0`)]),
    [`GET ${INDEXER_URL}/escrows?supplier=${pkh} `]: ok([escrow(R1, pkh, 'Claimed', 5000), escrow(R2, pkh, 'Submitted', 6000)]),
    [`GET ${INDEXER_URL}/escrows?buyer=${pkh} `]: ok([]),
    [`POST ${KOIOS_URL}/utxo_info ${JSON.stringify({ _utxo_refs: [R1, R2], _extended: true })}`]: ok([{ tx_hash: 'a1'.repeat(32), tx_index: 0, value: '1', is_spent: true }, { tx_hash: 'a2'.repeat(32), tx_index: 0, value: '1', is_spent: false }]),
  });
  test('a deregistered subject is read with the last key the identity timeline saw, and the first line after the configuration line says which key and why', async () => {
    const r = await buildReport({ subject: GONE, include: ['identity', 'marketplace'] }, replayFetch({ ...storeFor(GONE, txs), ...marketFor(B) }), opts);
    expect(r.subject).toMatchObject({ kind: 'asset', asset_name: GONE, registry: null, controller_pkh: null }); // the subject itself has no live record
    expect(r.identity).toMatchObject({ origin: 'legacy', registered: { block: 100 }, deregistered: { block: 300 }, record: null });
    expect((r.identity as any).timeline.map((e: any) => [e.event, e.version])).toEqual([['registration', 0], ['update', 1], ['deregistration', 2]]);
    expect((r.identity as any).timeline[1].changes).toEqual({ controller: { from: A, to: B } });
    const m = r.marketplace as any;
    expect(m.as_supplier.adverts).toEqual([expect.objectContaining({ advert_ref: ADVERT_B, supplier_pkh: B, capability_id: 'x.y.v1', status: 'Retired' })]); // the advert of B, not of the stranger
    expect(m.as_supplier.escrows).toMatchObject({ total: 2, by_indexer_state: { Claimed: 1, Submitted: 1 }, latest_checked: 2, latest_spent: 1 });
    expect(m.as_buyer.escrows.total).toBe(0);
    expect(r.key_roles).toEqual({ controller_pkh: null, marketplace_pkhs: [B], advert_count: 1, capability_endpoint: null, capability_key_pkh: null, capability_key_active: 'unknown' });
    expect(r.blind_spots).toEqual([LEGACY_ONLY, lastKnownKeysLine([B]), ...BLIND_SPOTS]);
    expect(r.sources).toContain(`${INDEXER_URL}/escrows?supplier=${B}`);
    expect(r.sources).not.toContain(`${INDEXER_URL}/escrows?supplier=${A}`);
    expect(degradedReasons(r)).toEqual([]);
  });
  test('registered and deregistered with no update in between: the owner at registration is the key', async () => {
    const direct = [txs[0], { ...txs[2], inputs: [spent('11'.repeat(32))] }]; // the token is burned in the transaction after the registration
    const r = await buildReport({ subject: GONE, include: ['identity', 'marketplace'] }, replayFetch({ ...storeFor(GONE, direct), ...marketFor(A) }), opts);
    expect(r.identity).toMatchObject({ registered: { block: 100 }, deregistered: { block: 300 }, record: null });
    expect((r.marketplace as any).as_supplier.escrows.total).toBe(2);
    expect(r.key_roles.marketplace_pkhs).toEqual([A]);
    expect(r.blind_spots[1]).toBe(lastKnownKeysLine([A]));
  });
  test('marketplace asked and identity not: the timeline is read for the keys and is not part of the report', async () => {
    const r = await buildReport({ subject: GONE, include: ['marketplace'] }, replayFetch({ ...storeFor(GONE, txs), ...marketFor(B) }), opts);
    expect(json(r)).not.toHaveProperty('identity');
    expect((r.marketplace as any).as_supplier.escrows.total).toBe(2);
    expect(r.sources).toContain(`${KOIOS_URL}/asset_txs`); // read, so listed
    expect(r.blind_spots).toEqual([LEGACY_ONLY, lastKnownKeysLine([B]), ...BLIND_SPOTS]);
  });
  test('a subject with a live record reads no identity timeline for its marketplace', async () => {
    const r = await buildReport({ subject: DID, include: ['marketplace'] }, replayFetch(fx.store), opts);
    expect(r.sources.some((u) => /\/(asset_txs|tx_info)$/.test(u))).toBe(false);
    expect(r.blind_spots).toEqual([LEGACY_ONLY, ...BLIND_SPOTS]);
    expect(r.key_roles.marketplace_pkhs).toEqual([PKH]);
  });
  test('an identity timeline that cannot be read leaves no key: the marketplace carries an error that says so, and the report is degraded', async () => {
    const broken = Object.fromEntries(Object.entries(storeFor(GONE, txs)).filter(([k]) => !k.includes('/tx_info')));
    const r = await buildReport({ subject: GONE, include: ['identity', 'marketplace'] }, replayFetch(broken), opts);
    expect((r.identity as any).error).toMatch(/fixture miss/);
    expect((r.marketplace as any).error).toMatch(/^the last known marketplace keys could not be read: .*fixture miss/);
    expect(r.key_roles).toEqual({ controller_pkh: null, marketplace_pkhs: [], advert_count: null, capability_endpoint: null, capability_key_pkh: null, capability_key_active: 'unknown' });
    expect(r.blind_spots).toEqual([LEGACY_ONLY, NO_MARKETPLACE_KEY, ...BLIND_SPOTS]);
    expect(degradedReasons(r)).toEqual([expect.stringMatching(/^identity: /), expect.stringMatching(/^marketplace: the last known marketplace keys could not be read/)]);
  });
  test('a subject that was never registered gets the no-record line, whether or not identity is asked for', async () => {
    const NEVER = '12'.repeat(32);
    for (const include of [['identity', 'marketplace'], ['marketplace']] as const) {
      const r = await buildReport({ subject: NEVER, include: [...include] }, replayFetch(storeFor(NEVER, [])), opts);
      expect(r.marketplace, include.join()).toBeNull();
      expect(r.key_roles.controller_pkh).toBeNull();
      expect(r.blind_spots).toEqual([LEGACY_ONLY, 'No registry record found for this subject.', ...BLIND_SPOTS]);
    }
  });
  test('an identity registry record that lists no marketplace key, and never did: the marketplace is not read, and the line says why', async () => {
    const ledger: LedgerTx[] = [{ hash: txHash(1), block: 100, outputs: [{ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, GONE)], datum: identityHex() }], mint: [token(TEST_IDENTITY, GONE)] }];
    const r = await buildReport({ subject: GONE, include: ['identity', 'marketplace'] }, koiosLedger(ledger, replayFetch(storeFor(GONE, []))), { ...opts, config: WITH_IDENTITY });
    expect(r.subject).toMatchObject({ registry: 'identity' });
    expect(r.marketplace).toBeNull();
    expect(r.blind_spots).toEqual([NO_MARKETPLACE_KEY, ...BLIND_SPOTS]);
  });
  test('the line a report adds for last known keys is in the form the spec shows', () => {
    expect(lastKnownKeysLine(['<key hash>'])).toBe('marketplace uses the last known marketplace keys <key hash>, taken from the identity timeline, because the subject has no live registry record that names one. Those keys may no longer act for the subject, and the marketplace section shows what the keys did, not necessarily what the subject did.');
    expect(lastKnownKeysLine(['a', 'b'])).toContain('keys a, b, taken');
  });
});

describe('the manifest DID', () => {
  test('a report names its agent by the canonical DID, also when the setting holds the legacy form', async () => {
    const AH = '8a98c4b74f0e49a09ca4b3502e121c96a8e6992afd2cba64ef8128042fedd440';
    const manifest = manifestFromEnv({ ...TEST_ENV, AGENT_DID: legacyVectorDid(REGISTRY_POLICY, AH) });
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(fx.store), { ...opts, manifest });
    expect(r.generated_by).toEqual({ agent: 'Agent History', did: `did:vector:${AH}`, version: '0.2.0' });
    expect(r.schema).toBe('vector.agent-history.report.v2');
  });
});

describe('report time budget', () => {
  // The recorded store, except that every call whose URL matches never answers (and ignores its abort signal, as a stuck upstream does).
  const hanging = (matches: (url: string) => boolean): Fetch => {
    const replay = replayFetch(fx.store);
    return ((u: any, i?: RequestInit) => (matches(String(u)) ? new Promise<Response>(() => {}) : replay(u, i))) as Fetch;
  };
  const BUDGET = 300;
  const budgeted = { ...opts, budgetMs: BUDGET };
  const timed = async <T>(work: Promise<T>) => { const t0 = performance.now(); const value = await work; return { value, ms: performance.now() - t0 }; };
  test('the budget is 150 s, which leaves 30 s under the 180 s the runtime gives the service', () => {
    expect(REPORT_BUDGET_MS).toBe(150_000);
    expect(180_000 - REPORT_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
  });
  test('a section that never answers is a time budget error at the deadline; the other sections are answered and the report is degraded', async () => {
    const { value: r, ms } = await timed(buildReport({ subject: DID, include: [...ALL] }, hanging((u) => u.includes('/escrows?supplier=')), budgeted));
    expect(r.marketplace).toEqual({ error: 'time budget exceeded' });
    expect((r.identity as any).registered.block).toBe(7275113);
    expect((r.reputation as any).stakes).toHaveLength(1);
    expect(r.key_roles).toMatchObject({ controller_pkh: PKH, marketplace_pkhs: [PKH], advert_count: null, capability_key_active: true });
    expect(ms).toBeGreaterThanOrEqual(BUDGET - 50);
    expect(ms).toBeLessThan(BUDGET + 2_500);
    expect(degradedReasons(r)).toEqual(['marketplace: time budget exceeded']);
  });
  test('every section shares the one deadline: all three module sections are cut at it, not one after another', async () => {
    const { value: r, ms } = await timed(buildReport({ subject: DID, include: ['identity', 'reputation', 'dispute', 'self_improvement'] }, hanging((u) => u.endsWith('/address_utxos')), budgeted));
    for (const name of ['reputation', 'dispute', 'self_improvement'] as const) expect(r[name], name).toEqual({ error: 'time budget exceeded' });
    expect((r.identity as any).registered.block).toBe(7275113);
    expect(ms).toBeLessThan(BUDGET + 2_500);
    expect(degradedReasons(r)).toEqual(['reputation: time budget exceeded', 'dispute: time budget exceeded', 'self_improvement: time budget exceeded']);
  });
  test('a chain tip that never answers leaves as_of null at the deadline and the rest of the report intact', async () => {
    const { value: r, ms } = await timed(buildReport({ subject: DID, include: ['identity'] }, hanging((u) => u.endsWith('/tip')), budgeted));
    expect(r.as_of).toBeNull();
    expect((r.identity as any).registered.block).toBe(7275113);
    expect(ms).toBeLessThan(BUDGET + 2_500);
    expect(degradedReasons(r)).toEqual(['as_of: the chain tip could not be read']);
  });
  test('a key check that never answers is unknown at the deadline', async () => {
    const { value: r, ms } = await timed(buildReport({ subject: DID, include: ['identity', 'marketplace'] }, hanging((u) => u.endsWith('/capability')), budgeted));
    expect(r.key_roles).toEqual({ controller_pkh: PKH, marketplace_pkhs: [PKH], advert_count: 1, capability_endpoint: ENDPOINT, capability_key_pkh: null, capability_key_active: 'unknown' });
    expect(ms).toBeLessThan(BUDGET + 2_500);
    expect(degradedReasons(r)).toEqual([]); // unknown is a normal answer of the key check
  });
  test('a subject lookup that never answers fails with the budget named, instead of holding the job until the runtime gives up', async () => {
    const { value: error, ms } = await timed(buildReport({ subject: DID, include: ['identity'] }, hanging((u) => u.endsWith('/asset_utxos')), budgeted).then(() => null, (e: Error) => e));
    expect(error?.message).toBe('time budget exceeded while resolving the subject');
    expect(ms).toBeLessThan(BUDGET + 2_500);
  });
  test('a report that finishes inside the budget is the stored report, and the budget changes nothing in it', async () => {
    const r = json(await buildReport({ subject: DID, include: [...ALL] }, replayFetch(fx.store), { ...opts, budgetMs: 60_000 }));
    expect(r).toEqual(fx.report);
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
