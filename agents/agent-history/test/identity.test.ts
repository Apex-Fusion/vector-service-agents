import { describe, test, expect } from 'vitest';
import { didFor, encodeLegacyDatum, keyHash, koios, utf8ToHex } from '@vsa/vector-read';
import type { Fetch, IdentityDatum, Key, KoiosTxInfo, Party } from '@vsa/vector-read';
import { identitySection, identityTimeline } from '../src/identity.ts';
import type { Subject } from '../src/subject.ts';
import { koiosLedger, token, txHash as H, identityHex, TEST_IDENTITY, WITH_IDENTITY, LEGACY, CONTROLLER } from './support.ts';
import type { LedgerTx } from './support.ts';

const ID = 'ab'.repeat(32), A = 'cd'.repeat(28), B = 'ef'.repeat(28), WALLET = 'addr1v' + 'q'.repeat(50);
const subject: Subject = { kind: 'asset', pkh: null, asset_name: ID, did: didFor(ID), registry: null, controller_pkh: null, candidates: [] };
const legacyHex = (owner: string, name = 'A') => encodeLegacyDatum({ owner: { type: 'VerificationKey', hash: owner }, name: utf8ToHex(name), description: utf8ToHex('d'), capabilities: [utf8ToHex('x.y.v1')], framework: utf8ToHex('fw'), endpoint: '', registeredAt: 1n });
// Mainnet shape (the Koios of Vector mainnet, checked on 2026-11-03): tx_info shows a datum_hash and no bytes for the record output of either
// registry, as the call sets neither _scripts nor _bytecode; the bytes come from utxo_info (extended) on the output ref.
const legacyOut = (owner: string, name?: string) => ({ address: LEGACY.address, assets: [token(LEGACY, ID)], datum: legacyHex(owner, name) });
const idOut = (over: Partial<IdentityDatum> = {}, value?: string) => ({ address: TEST_IDENTITY.address, assets: [token(TEST_IDENTITY, ID)], datum: identityHex(over), value });
const spend = (n: number) => [`${H(n)}#0`];
// registered to A, rotated to B, then deregistered: the token is burned
const legacyLife: LedgerTx[] = [
  { hash: H(1), block: 100, time: 1000, outputs: [legacyOut(A)], mint: [token(LEGACY, ID)] },
  { hash: H(2), block: 200, time: 2000, spends: spend(1), outputs: [legacyOut(B)] },
  { hash: H(3), block: 300, time: 3000, spends: spend(2), outputs: [{ address: WALLET }], mint: [token(LEGACY, ID, '-1')] },
];
// A fetch that fails the test if anything reaches it.
const noCall = (async () => { throw new Error('no Koios call expected'); }) as unknown as Fetch;
// The answers of `inner`, with the rows of one endpoint changed.
const altered = (inner: Fetch, endpoint: string, change: (rows: any[]) => unknown): Fetch => (async (u: any, i?: RequestInit) => {
  const res = await inner(u, i);
  return String(u).endsWith(`/${endpoint}`) ? new Response(JSON.stringify(change(await res.json())), { status: 200 }) : res;
}) as Fetch;

describe('the legacy registry: registration, updates and deregistration', () => {
  test('registration, controller rotation and deregistration are three versions of one timeline', async () => {
    const id = await identitySection(subject, koiosLedger(legacyLife));
    expect(id).toMatchObject({ origin: 'legacy', registered: { tx: H(1), block: 100, time: 1000, registry: 'legacy' }, adopted: null, deregistered: { tx: H(3), block: 300, time: 3000 }, record: null });
    expect(id.timeline.map((e) => [e.registry, e.event, e.version, e.lovelace])).toEqual([['legacy', 'registration', 0, '10000000'], ['legacy', 'update', 1, '10000000'], ['legacy', 'deregistration', 2, null]]);
    expect(id.timeline[1].changes).toEqual({ controller: { from: A, to: B } });
    // The end of a legacy record: the record is retired at the block time of that transaction (Part 1, section 8.2).
    expect(id.timeline[2].changes).toEqual({ status: { from: 'active', to: 'retired', at: 3_000_000, successor: null } });
  });
  test('the registration lists everything the first version sets', async () => {
    const id = await identitySection(subject, koiosLedger(legacyLife.slice(0, 1)));
    expect(id.timeline[0].changes).toEqual({
      controller: { from: null, to: A }, name: { from: null, to: 'A' }, description: { from: null, to: 'd' }, framework: { from: null, to: 'fw' },
      registered_at: { from: null, to: 1 }, capabilities: { added: ['x.y.v1'], removed: [] }, status: { from: null, to: 'active' },
    });
    expect(id.record).toEqual({ registry: 'legacy', controller_pkh: A, name: 'A', description: 'd', capabilities: ['x.y.v1'], framework: 'fw', endpoint: '', registered_at: 1 });
  });
  test('a registration and an update in the same block are read registration first, whatever order asset_txs lists them in', async () => {
    const sameBlock = [{ ...legacyLife[0], block: 100, index: 0 }, { ...legacyLife[1], block: 100, index: 1 }];
    const id = await identitySection(subject, koiosLedger(sameBlock)); // the ledger lists them newest first
    expect(id.timeline.map((e) => [e.tx, e.event])).toEqual([[H(1), 'registration'], [H(2), 'update']]);
    expect(id.record?.controller_pkh).toBe(B);
  });
  test('the same datum posted again is a change of value and no version; a changed profile field is an update', async () => {
    const repost = await identitySection(subject, koiosLedger([legacyLife[0], { hash: H(2), block: 200, spends: spend(1), outputs: [{ ...legacyOut(A), value: '12000000' }] }]));
    expect(repost.timeline.map((e) => [e.event, e.version, e.lovelace, e.changes])).toEqual([['registration', 0, '10000000', expect.any(Object)], ['value_change', null, '12000000', {}]]);
    const renamed = await identitySection(subject, koiosLedger([legacyLife[0], { hash: H(2), block: 200, spends: spend(1), outputs: [legacyOut(A, 'B')] }]));
    expect(renamed.timeline[1]).toMatchObject({ event: 'update', version: 1, changes: { name: { from: 'A', to: 'B' } } });
    expect(Object.keys(renamed.timeline[1].changes)).toEqual(['name']);
  });
  test('a subject without an identifier has no registry history and makes no Koios call', async () => {
    const id = await identitySection({ ...subject, kind: 'pkh', pkh: A, asset_name: null, did: null }, noCall);
    expect(id).toEqual({ origin: null, registered: null, adopted: null, deregistered: null, record: null, timeline: [] });
  });
  test('an identifier no registry minted has an empty section', async () => {
    expect(await identitySection(subject, koiosLedger([]))).toEqual({ origin: null, registered: null, adopted: null, deregistered: null, record: null, timeline: [] });
  });
  test('a transaction that asset_txs lists but tx_info does not return is an error, not a gap in the timeline', async () => {
    await expect(identitySection(subject, altered(koiosLedger(legacyLife.slice(0, 2)), 'tx_info', (rows) => rows.filter((r: any) => r.tx_hash !== H(2)))))
      .rejects.toThrow(`tx ${H(2)} listed by asset_txs but not returned by tx_info`);
  });
  test('an empty bytes string counts as a missing datum and is read through utxo_info like null', async () => {
    const empty = altered(koiosLedger(legacyLife.slice(0, 1)), 'tx_info', (rows) => rows.map((r: any) => ({ ...r, outputs: r.outputs.map((o: any) => (o.inline_datum ? { ...o, inline_datum: { bytes: '' } } : o)) })));
    expect((await identitySection(subject, empty)).record?.controller_pkh).toBe(A);
  });
  test('a datum that cannot be read is an error, not a deregistration', async () => {
    await expect(identitySection(subject, altered(koiosLedger(legacyLife.slice(0, 1)), 'utxo_info', () => []))).rejects.toThrow(`registry datum at ${H(1)}#0 could not be read`);
  });
  test('a token that leaves the registry for an output that is not a record, and comes back, leaves and returns in the timeline', async () => {
    const moved: LedgerTx[] = [
      legacyLife[0],
      { hash: H(2), block: 200, spends: spend(1), outputs: [{ address: WALLET, assets: [token(LEGACY, ID)] }] },
      { hash: H(3), block: 300, spends: spend(2), outputs: [legacyOut(A)] }, // the same datum as before it left
      { hash: H(4), block: 400, spends: spend(3), outputs: [{ address: LEGACY.address, assets: [token(LEGACY, ID), token(LEGACY, 'cd'.repeat(32))], datum: legacyHex(A) }] },
    ];
    const away = await identitySection(subject, koiosLedger(moved.slice(0, 2)));
    expect(away.timeline.map((e) => [e.event, e.version])).toEqual([['registration', 0], ['token_left', null]]);
    expect(away.record).toBeNull();
    const back = await identitySection(subject, koiosLedger(moved.slice(0, 3)));
    expect(back.timeline.map((e) => [e.event, e.version])).toEqual([['registration', 0], ['token_left', null], ['token_returned', null]]);
    expect(back.record?.controller_pkh).toBe(A);
    // Two tokens of the registry in one output (Part 2, section 9.4): not an authentic record, so the record is outside its registry again.
    const locked = await identitySection(subject, koiosLedger(moved));
    expect(locked.timeline.at(-1)).toMatchObject({ event: 'token_left', version: null });
    expect(locked.record).toBeNull();
  });
});

// The keys the marketplace falls back on when no live record names one: those of the last version that named a marketplace key.
describe('identityTimeline: the last marketplace keys', () => {
  test('after a rotation and a deregistration they are the key rotated to; the section is the one identitySection gives', async () => {
    const t = await identityTimeline(subject, koiosLedger(legacyLife));
    expect(t.last_marketplace_pkhs).toEqual([B]);
    expect(t.section).toEqual(await identitySection(subject, koiosLedger(legacyLife)));
  });
  test('registered and deregistered with no update in between they are the owner at registration', async () => {
    const t = await identityTimeline(subject, koiosLedger([legacyLife[0], { ...legacyLife[2], spends: spend(1) }]));
    expect(t.section).toMatchObject({ registered: { block: 100 }, deregistered: { block: 300 }, record: null });
    expect(t.last_marketplace_pkhs).toEqual([A]);
  });
  test('with a live record they are its owner; a subject never registered, or without an identifier, has none', async () => {
    expect((await identityTimeline(subject, koiosLedger(legacyLife.slice(0, 2)))).last_marketplace_pkhs).toEqual([B]);
    expect((await identityTimeline(subject, koiosLedger([]))).last_marketplace_pkhs).toEqual([]);
    expect((await identityTimeline({ ...subject, kind: 'pkh', pkh: A, asset_name: null, did: null }, noCall)).last_marketplace_pkhs).toEqual([]);
  });
});

const ED = '22'.repeat(32), NEW = '33'.repeat(32), GUARDIAN = '44'.repeat(28), SUCCESSOR = '55'.repeat(32), P256 = `02${'66'.repeat(32)}`;
const edKey = (purposes: number): Key => ({ keyType: 'Ed25519', key: ED, purposes, pop: null });
const ACCOUNTABLE: Party = { role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notBefore: 0, notAfter: null, rights: 3, removalAfter: null };
const GUARDIAN_PARTY: Party = { role: 'Guardian', signer: { type: 'KeyHash', hash: GUARDIAN }, organisation: null, notBefore: 0, notAfter: null, rights: 4, removalAfter: null };
const DAY = 86_400_000, T = 1_800_000_000_000;

describe('the identity registry: one record from registration to tombstone', () => {
  // Every state of the record, each written by its own transaction (Part 1, section 6).
  const v0: Partial<IdentityDatum> = { keys: [edKey(1 + 8), { keyType: 'P256', key: P256, purposes: 2, pop: '77'.repeat(64) }] };
  const v1 = { ...v0, parties: [ACCOUNTABLE, GUARDIAN_PARTY], guardianThreshold: 1, endpoint: utf8ToHex('https://new.example'), capabilities: [utf8ToHex('z.v1')] };
  const hold = { by: { type: 'ControllerSet' as const }, reason: 6, since: T, until: T + 30 * DAY };
  const v2 = { ...v1, status: { type: 'Suspended' as const, holds: [hold] } };
  const v3 = { ...v1, status: { type: 'Suspended' as const, holds: [{ ...hold, until: T + 31 * DAY }] } };
  const v4 = v1;
  const v5 = { ...v1, pendingRecovery: { newController: NEW, effectiveAfter: T + 7 * DAY } };
  const v6 = { ...v1, controller: NEW, subagentEpoch: 1 };
  const tombstone = { controller: NEW, keys: [], parties: [], guardianThreshold: 0, subagentEpoch: 1, description: '', framework: '', endpoint: '', capabilities: [] };
  const v7 = { ...tombstone, status: { type: 'Revoked' as const, by: { type: 'ControllerSet' as const }, reason: 1, at: T + 40 * DAY, invalidFrom: T + 39 * DAY, successor: null } };
  const v8 = { ...tombstone, status: { ...v7.status, successor: SUCCESSOR } };
  const states = [v0, v1, v2, v3, v4, v5, v6, v7, v8];
  const life: LedgerTx[] = [
    { hash: H(1), block: 100, outputs: [idOut(v0)], mint: [token(TEST_IDENTITY, ID)] },
    ...states.slice(1).map((s, i) => ({ hash: H(i + 2), block: 200 + i * 100, spends: spend(i + 1), outputs: [idOut(s)] })),
    { hash: H(10), block: 1100, spends: spend(9), outputs: [idOut(v8, '2000000')] }, // Reclaim: the deposit above the ledger minimum goes back
  ];
  const read = () => identityTimeline(subject, koiosLedger(life), WITH_IDENTITY.registries);
  test('a native record: registered in the identity registry, every state a version, the reclaim a change of value only', async () => {
    const { section } = await read();
    expect(section).toMatchObject({ origin: 'native', registered: { tx: H(1), block: 100, registry: 'identity' }, adopted: null, deregistered: null });
    expect(section.timeline.map((e) => [e.event, e.version])).toEqual([...states.map((_, i) => [i === 0 ? 'registration' : 'update', i]), ['value_change', null]]);
    expect(section.timeline.every((e) => e.registry === 'identity')).toBe(true);
    expect(section.timeline.at(-1)).toMatchObject({ lovelace: '2000000', changes: {} });
  });
  test('the registration lists the keys, the party, the profile, the creation time and the status', async () => {
    const [registration] = (await read()).section.timeline;
    expect(registration.changes).toEqual({
      controller: { from: null, to: keyHash(CONTROLLER) },
      keys: { added: [{ key_hash: keyHash(ED), type: 'Ed25519', purposes: ['authentication', 'transaction'] }, { key_hash: keyHash(P256), type: 'P-256', purposes: ['assertion'] }], removed: [] },
      parties: { added: [{ role: 'accountable', signer: 'controller', organisation: null, rights: ['suspend', 'revoke'], not_before: 0, not_after: null, removal_after: null }], removed: [], changed: [] },
      created_at: { from: null, to: T }, name: { from: null, to: 'Agent' }, description: { from: null, to: 'A test agent.' }, framework: { from: null, to: 'fw' },
      endpoint: { from: null, to: 'https://agent.example' }, capabilities: { added: ['x.y.v1'], removed: [] }, status: { from: null, to: 'active' },
    });
  });
  test('parties, guardian threshold, profile, holds, statuses, recovery, controller and successor each show as the change they are', async () => {
    const changes = (await read()).section.timeline.map((e) => e.changes);
    expect(changes[1]).toEqual({
      parties: { added: [{ role: 'guardian', signer: GUARDIAN, organisation: null, rights: ['recover'], not_before: 0, not_after: null, removal_after: null }], removed: [], changed: [] },
      guardian_threshold: { from: 0, to: 1 }, endpoint: { from: 'https://agent.example', to: 'https://new.example' }, capabilities: { added: ['z.v1'], removed: ['x.y.v1'] },
    });
    const held = { by: 'controller', reason: 'hold', since: T, until: T + 30 * DAY };
    expect(changes[2]).toEqual({ status: { from: 'active', to: 'suspended' }, holds: { added: [held], renewed: [], removed: [] } });
    expect(changes[3]).toEqual({ holds: { added: [], renewed: [{ ...held, until: T + 31 * DAY }], removed: [] } });
    expect(changes[4]).toEqual({ status: { from: 'suspended', to: 'active' }, holds: { added: [], renewed: [], removed: [{ ...held, until: T + 31 * DAY }] } });
    expect(changes[5]).toEqual({ recovery: { event: 'started', new_controller: keyHash(NEW), effective_after: T + 7 * DAY } });
    expect(changes[6]).toEqual({ controller: { from: keyHash(CONTROLLER), to: keyHash(NEW) }, recovery: { event: 'completed', new_controller: keyHash(NEW), effective_after: T + 7 * DAY }, subagent_epoch: { from: 0, to: 1 } });
    expect(changes[7]).toMatchObject({
      keys: { added: [], removed: [expect.objectContaining({ key_hash: keyHash(ED) }), expect.objectContaining({ key_hash: keyHash(P256) })] },
      parties: { added: [], removed: [expect.objectContaining({ role: 'accountable' }), expect.objectContaining({ role: 'guardian' })], changed: [] },
      guardian_threshold: { from: 1, to: 0 }, description: { from: 'A test agent.', to: '' }, framework: { from: 'fw', to: '' }, endpoint: { from: 'https://new.example', to: '' },
      capabilities: { added: [], removed: ['z.v1'] },
      status: { from: 'active', to: 'revoked', by: 'controller', reason: 'keyCompromise', at: T + 40 * DAY, invalid_from: T + 39 * DAY, successor: null },
    });
    expect(changes[8]).toEqual({ successor: { from: null, to: didFor(SUCCESSOR) } });
  });
  test('the record is the tombstone, and the last marketplace keys are those of the last version that listed a transaction key', async () => {
    const t = await read();
    expect(t.section.record).toMatchObject({ registry: 'identity', controller_pkh: keyHash(NEW), keys: [], parties: [], status: { status: 'revoked', reason: 'keyCompromise', successor: didFor(SUCCESSOR) } });
    expect(t.last_marketplace_pkhs).toEqual([keyHash(ED)]); // the P-256 key cannot act in a transaction
  });
  test('without the identity registry configured, the native record is not read', async () => {
    expect((await identityTimeline(subject, koiosLedger(life))).section).toMatchObject({ origin: null, timeline: [] });
  });
  test('a cancelled recovery and a recovery ended by a controller change are cancelled, not completed', async () => {
    const pending = { ...v1, pendingRecovery: { newController: NEW, effectiveAfter: T + 7 * DAY } };
    const cancelled = await identityTimeline(subject, koiosLedger([
      { hash: H(1), block: 100, outputs: [idOut(pending)], mint: [token(TEST_IDENTITY, ID)] },
      { hash: H(2), block: 200, spends: spend(1), outputs: [idOut(v1)] },
      { hash: H(3), block: 300, spends: spend(2), outputs: [idOut(pending)] },
      { hash: H(4), block: 400, spends: spend(3), outputs: [idOut({ ...v1, controller: '88'.repeat(32), subagentEpoch: 1 })] },
    ]), WITH_IDENTITY.registries);
    const recovery = cancelled.section.timeline.map((e) => e.changes.recovery?.event ?? null);
    expect(recovery).toEqual(['started', 'cancelled', 'started', 'cancelled']);
  });
  test('an identity token that is burned is an error: the identity registry never burns', async () => {
    const burned = [life[0], { hash: H(2), block: 200, spends: spend(1), outputs: [{ address: WALLET }], mint: [token(TEST_IDENTITY, ID, '-1')] }];
    await expect(identityTimeline(subject, koiosLedger(burned), WITH_IDENTITY.registries)).rejects.toThrow(/identity token was burned/);
  });
  // The answer of the Koios of Vector mainnet (checked on 2026-11-03 on the 11 transactions of a live identity record): tx_info gives the bytes of a
  // record output only when the call sets both _scripts and _bytecode, and that answer also carries the bytecode of every script (773 kB, not 46 kB).
  test('the fixture answers as Vector Koios does: tx_info gives the datum bytes only with _scripts and _bytecode', async () => {
    const f = koiosLedger(life);
    const [plain] = await koios.txInfo([H(1)], f);
    expect(plain.outputs[0].inline_datum).toEqual({ bytes: null, value: null });
    const [bytecodeOnly] = await koios.post<KoiosTxInfo[]>('tx_info', { _tx_hashes: [H(1)], _inputs: true, _assets: true, _bytecode: true }, f);
    expect(bytecodeOnly.outputs[0].inline_datum).toEqual({ bytes: null, value: null });
    const [full] = await koios.post<KoiosTxInfo[]>('tx_info', { _tx_hashes: [H(1)], _inputs: true, _assets: true, _scripts: true, _bytecode: true }, f);
    expect(full.outputs[0].inline_datum?.bytes).toBe(identityHex(v0));
  });
  test('the datums of the identity record are read through one utxo_info call, as tx_info gives none of them', async () => {
    const calls: Array<{ endpoint: string; body: unknown }> = [];
    const inner = koiosLedger(life);
    const watched: Fetch = async (u, i) => {
      calls.push({ endpoint: String(u).split('/').pop()!, body: JSON.parse(String(i?.body ?? 'null')) });
      return inner(u, i);
    };
    const { section } = await identityTimeline(subject, watched, WITH_IDENTITY.registries);
    expect(section.record).toMatchObject({ registry: 'identity', controller_pkh: keyHash(NEW), status: { status: 'revoked' } });
    expect(section.timeline).toHaveLength(life.length);
    expect(calls.filter((c) => c.endpoint === 'utxo_info')).toEqual([{ endpoint: 'utxo_info', body: { _utxo_refs: life.map((tx) => `${tx.hash}#0`), _extended: true } }]);
  });
  test('an identity record datum that utxo_info cannot give either is an error that names the output', async () => {
    await expect(identityTimeline(subject, altered(koiosLedger(life.slice(0, 1)), 'utxo_info', () => []), WITH_IDENTITY.registries))
      .rejects.toThrow(`identity record datum at ${H(1)}#0 could not be read`);
  });
});

describe('adoption: one timeline across both registries', () => {
  const adopted = { keys: [edKey(1 + 8)] };
  const adoption: LedgerTx[] = [
    { hash: H(1), block: 100, time: 1000, outputs: [legacyOut(A)], mint: [token(LEGACY, ID)] },
    { hash: H(2), block: 200, time: 2000, spends: spend(1), outputs: [idOut(adopted), { address: WALLET, value: '10000000' }], mint: [token(LEGACY, ID, '-1'), token(TEST_IDENTITY, ID)] },
    { hash: H(3), block: 300, time: 3000, spends: spend(2), outputs: [idOut({ ...adopted, name: utf8ToHex('Renamed') })] },
  ];
  test('the legacy versions come first, the adoption is the next version, and the identity versions follow', async () => {
    const t = await identityTimeline(subject, koiosLedger(adoption), WITH_IDENTITY.registries);
    expect(t.section).toMatchObject({ origin: 'adopted', registered: { tx: H(1), block: 100, time: 1000, registry: 'legacy' }, adopted: { tx: H(2), block: 200, time: 2000 }, deregistered: null });
    expect(t.section.timeline.map((e) => [e.registry, e.event, e.version])).toEqual([['legacy', 'registration', 0], ['identity', 'adoption', 1], ['identity', 'update', 2]]);
    expect(t.section.timeline[2].changes).toEqual({ name: { from: 'Agent', to: 'Renamed' } });
    expect(t.section.record).toMatchObject({ registry: 'identity', name: 'Renamed', keys: [{ key_hash: keyHash(ED) }] });
    expect(t.last_marketplace_pkhs).toEqual([keyHash(ED)]);
  });
  test('the adoption shows what changed against the legacy record: the controller key, the keys and parties, the profile', async () => {
    const t = await identityTimeline(subject, koiosLedger(adoption), WITH_IDENTITY.registries);
    expect(t.section.timeline[1].changes).toEqual({
      controller: { from: A, to: keyHash(CONTROLLER) },
      keys: { added: [{ key_hash: keyHash(ED), type: 'Ed25519', purposes: ['authentication', 'transaction'] }], removed: [] },
      parties: { added: [expect.objectContaining({ role: 'accountable', signer: 'controller' })], removed: [], changed: [] },
      created_at: { from: null, to: T }, name: { from: 'A', to: 'Agent' }, description: { from: 'd', to: 'A test agent.' }, endpoint: { from: '', to: 'https://agent.example' },
      registered_at: { from: 1, to: null },
    });
  });
  test('without the identity registry configured, the adoption reads as the end of the legacy record', async () => {
    const t = await identityTimeline(subject, koiosLedger(adoption));
    expect(t.section).toMatchObject({ origin: 'legacy', deregistered: { tx: H(2) }, record: null });
    expect(t.section.timeline.map((e) => e.event)).toEqual(['registration', 'deregistration']);
  });
});
