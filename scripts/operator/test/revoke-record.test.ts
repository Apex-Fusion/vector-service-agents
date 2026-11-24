import { describe, expect, it } from 'vitest';
import { buildReclaim, buildRevoke } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { tombstone } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { DAY, WINDOW, recordUtxo } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import type { IdentityDatum, Party } from '../../../packages/vector-read/src/identity-codec.ts';
import { iso } from '../../checks/lib/format.ts';
import revokeRecord from '../tasks/revoke-record.ts';
import bids from '../usecases/bid-evaluation.ts';
import { spendWorld, TOOLS } from './support/record-spend-builds.ts';
import type { SpendWorld, SpendWorldOptions } from './support/record-spend-builds.ts';
import { NOW } from './support/task-world.ts';

const NAME = 'bid-desk-charlie';
const BY = 'accountable-charlie';
const INVALID_FROM = NOW - DAY;
const ARGS = ['run', '--agent', NAME, '--by', BY, '--reason', '9', '--invalid-from', iso(INVALID_FROM), '--submit'];
const CLEANUP = ['cleanup', '--agent', NAME, '--submit'];

async function setup(over: Partial<SpendWorldOptions> = {}) {
  const f = await spendWorld({ use: bids, agent: NAME, ...over });
  f.showRunning(f.agent.adverts.map(({ runtimeContainer }) => runtimeContainer));
  f.w.writeGo({ tasks: ['revoke-record'], irreversible: ['record-revoke'] });
  return f;
}

async function prepareRevocation(f: SpendWorld, reason = 9, invalidFrom: number | null = INVALID_FROM) {
  const built = await buildRevoke(await f.context(), {
    changeAddress: f.fee, id: f.id, nowMs: f.w.clock.now(), reason, invalidFrom: invalidFrom ?? undefined,
    actor: { type: 'party', role: 'Accountable', signer: { type: 'KeyHash', hash: f.accountableHash } },
  });
  f.prepare(TOOLS.revoke, built);
  return built;
}

async function replaceRecord(f: SpendWorld, record: IdentityDatum): Promise<void> {
  const { utxo } = await f.record();
  f.w.world.chain.held = f.w.world.chain.held.filter((other) => other !== utxo).concat(recordUtxo(f.id, record, utxo.assets.lovelace));
}

describe('revoke-record', () => {
  it('revokes with the Accountable and fee keys and verifies the exact tombstone', async () => {
    const f = await setup();
    const built = await prepareRevocation(f);
    expect(await f.run(revokeRecord, ...ARGS)).toBe(0);
    expect(f.hosted.calls).toEqual([
      { name: TOOLS.revoke, args: { changeAddress: f.fee, did: f.did, actor: { role: 'Accountable', signer: f.accountableHash }, reason: 9, invalid_from: INVALID_FROM } },
      { name: TOOLS.resolve, args: { did: f.did } },
    ]);
    expect(f.signed.sort()).toEqual([BY, 'fee']);
    const revoked = tombstone(f.parent, { type: 'Revoked', by: { type: 'KeyHash', hash: f.accountableHash }, reason: 9, at: WINDOW.lo, invalidFrom: INVALID_FROM, successor: null });
    expect((await f.record()).record).toEqual(revoked);
    expect(f.w.facts().revocations[NAME]).toEqual({ tx: built.txHash, reason: 9, invalidFrom: iso(INVALID_FROM), revokedAt: iso(WINDOW.lo) });
    expect(f.w.evidence('revoke-record').find(({ status }) => status === 'verified')).toMatchObject({ shows: {
      before: { effective: 'Active' }, after: { effective: 'Revoked' }, reason: 9, invalidFrom: iso(INVALID_FROM), resolver: { read: 'ok', effective: 'Revoked' },
    } });
    expect(await f.run(revokeRecord, ...ARGS)).toBe(2);
    expect(await f.run(revokeRecord, ...ARGS, '--run', 'again')).toBe(2);
    expect(f.w.node.submitted).toHaveLength(1);
  });

  it('allows a non-compromise reason with no invalid-from time', async () => {
    const f = await setup();
    await prepareRevocation(f, 9, null);
    expect(await f.run(revokeRecord, 'run', '--agent', NAME, '--by', BY, '--reason', '9', '--submit')).toBe(0);
    expect(f.hosted.calls[0]?.args).not.toHaveProperty('invalid_from');
    expect(f.w.facts().revocations[NAME]?.invalidFrom).toBeNull();
  });

  it('does not revoke a tombstone even when the facts have no revocation', async () => {
    const f = await setup();
    await replaceRecord(f, tombstone(f.parent, { type: 'Retired', at: WINDOW.lo, successor: null }));
    expect(await f.run(revokeRecord, ...ARGS)).toBe(2);
    expect(f.w.screen.errorText).toContain('The record has ended.');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });

  it.each<[string[], string]>([
    [['--by', 'controller', '--reason', '9'], 'Accountable key'],
    [['--by', BY], '--reason'],
    [['--by', BY, '--reason', '64'], '--reason'],
    [['--by', BY, '--reason', '1'], 'needs --invalid-from'],
    [['--by', BY, '--reason', '9', '--invalid-from', '2026-11-31T00:00:00Z'], 'ISO 8601'],
    [['--by', BY, '--reason', '9', '--invalid-from', iso(NOW + 1)], 'validity window'],
    [['--by', BY, '--reason', '9', '--invalid-from', iso(NOW)], 'validity window'],
    [['--by', BY, '--reason', '9', '--invalid-from', iso(NOW - 31 * DAY)], 'validity window'],
  ])('refuses bad arguments before it asks for a build: %s', async (flags, problem) => {
    const f = await setup();
    expect(await f.run(revokeRecord, 'run', '--agent', NAME, '--submit', ...flags)).toBe(2);
    expect(f.w.screen.errorText).toContain(problem);
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });

  it.each([{ rights: 1 }, { notAfter: NOW - 1 }, { notAfter: NOW + 1 }, { notBefore: NOW }])('requires the on-chain party to have the revoke right for the full validity window: %o', async (change: Partial<Party>) => {
    const f = await setup();
    await replaceRecord(f, { ...f.parent, parties: [{ ...f.defaultParty, ...change }, f.moduleParty] });
    expect(await f.run(revokeRecord, ...ARGS)).toBe(2);
    expect(f.w.screen.errorText).toContain('revoke right for the validity window');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });

  it('refuses an otherwise valid build with the wrong reason', async () => {
    const f = await setup();
    await prepareRevocation(f, 5);
    expect(await f.run(revokeRecord, ...ARGS)).toBe(2);
    expect(f.w.screen.errorText).toContain('requested revocation');
    expect(f.signed).toEqual([]);
    expect(f.w.facts().revocations).toEqual({});
  });

  it('does not sign with an extra key, even if it is in the registry', async () => {
    const f = await setup();
    const built = await prepareRevocation(f);
    f.prepare(TOOLS.revoke, { ...built, requiredSigners: [...built.requiredSigners, { keyHash: f.registry.hashOf('controller'), roles: ['controller'] }] });
    expect(await f.run(revokeRecord, ...ARGS)).toBe(2);
    expect(f.w.screen.errorText).toContain('extra');
    expect(f.signed).toEqual([]);
  });

  it('refuses a missing tag or a working runtime before it asks the tool', async () => {
    const f = await setup();
    f.w.writeGo({ tasks: ['revoke-record'], irreversible: [] });
    expect(await f.run(revokeRecord, ...ARGS)).toBe(2);
    expect(f.w.screen.errorText).toContain('irreversible tag record-revoke');
    f.w.writeGo({ tasks: ['revoke-record'], irreversible: ['record-revoke'] });
    f.setRuntime('working');
    expect(await f.run(revokeRecord, ...ARGS)).toBe(2);
    expect(f.w.screen.errorText).toContain('says working');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });
});

describe('reclaim', () => {
  it('returns the surplus of the verified tombstone to fee with only the controller and fee signatures', async () => {
    const f = await setup();
    await prepareRevocation(f);
    expect(await f.run(revokeRecord, ...ARGS)).toBe(0);
    const before = await f.record();
    const start = await f.feeBalance();
    f.signed.length = 0;
    f.w.writeGo({ tasks: ['revoke-record'], irreversible: [] });
    const built = await buildReclaim(await f.context(), { changeAddress: f.fee, id: f.id, nowMs: f.w.clock.now() });
    f.prepare(TOOLS.reclaim, built);
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(0);
    expect(f.signed.sort()).toEqual(['controller', 'fee']);
    expect(f.hosted.calls).toContainEqual({ name: TOOLS.reclaim, args: { changeAddress: f.fee, did: f.did } });
    expect(await f.feeBalance()).toBe(start + built.returnedLovelace - BigInt(built.fee));
    const after = await f.record();
    expect(after.record).toEqual(before.record);
    expect(after.utxo.assets.lovelace).toBe(built.outputLovelace);
    expect(f.w.state('revoke-record').notes[`part.reclaim:${NAME}`]).toMatchObject({ tx_hash: built.txHash, verified_at: expect.any(String) });
    expect(await f.run(revokeRecord, ...CLEANUP, '--run', 'again')).toBe(2);
    expect(f.w.screen.errorText).toContain('no deposit above the ledger minimum');
    expect(f.hosted.calls.filter(({ name }) => name === TOOLS.reclaim)).toHaveLength(1);
  });

  it('refuses a live record and a tombstone without a matching fact', async () => {
    const f = await setup();
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(2);
    expect(f.w.screen.errorText).toContain('not Revoked or Retired');
    await replaceRecord(f, tombstone(f.parent, { type: 'Revoked', by: { type: 'KeyHash', hash: f.accountableHash }, reason: 9, at: WINDOW.lo, invalidFrom: null, successor: null }));
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(2);
    expect(f.w.screen.errorText).toContain('no matching revocation fact');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });
});
