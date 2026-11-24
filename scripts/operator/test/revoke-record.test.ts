import { describe, expect, it, vi } from 'vitest';
import { buildReclaim, buildRevoke } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { tombstone } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { DAY, WINDOW, recordUtxo } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import type { IdentityDatum, Party } from '../../../packages/vector-read/src/identity-codec.ts';
import { EvidenceError, EvidenceFile } from '../../checks/lib/evidence.ts';
import { iso } from '../../checks/lib/format.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { FactsFile } from '../lib/facts.ts';
import revokeRecord from '../tasks/revoke-record.ts';
import bids from '../usecases/bid-evaluation.ts';
import inventory from '../usecases/inventory-reorder.ts';
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
    expect(f.w.screen.errorText).toContain('take no --run label');
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

  it('does not let revocation or reclaim select the wrong closeout operation', async () => {
    const active = await setup({ use: inventory, agent: 'reorder-agent' });
    expect(await active.run(revokeRecord, 'run', '--agent', active.agent.id, '--by', active.organisation.accountableKey, '--reason', '9', '--submit')).toBe(2);
    expect(active.w.screen.errorText).toContain('does not mark the selected record for revocation');
    const retirement = await setup({ agent: 'bid-desk-bravo' });
    expect(await retirement.run(revokeRecord, 'cleanup', '--agent', retirement.agent.id, '--submit')).toBe(2);
    expect(retirement.w.screen.errorText).toContain('does not mark the selected record for revocation');
    for (const f of [active, retirement]) {
      expect(f.hosted.calls).toEqual([]);
      expect(f.signed).toEqual([]);
    }
  });

  it('writes verification evidence before the dependent fact and does not duplicate it on retry', async () => {
    const f = await setup();
    const built = await prepareRevocation(f);
    const original = EvidenceFile.prototype.add;
    const writeEvidence = vi.spyOn(EvidenceFile.prototype, 'add').mockImplementation(function (this: EvidenceFile, entry) {
      if (entry.status === 'verified') throw new EvidenceError('The verification evidence write failed.');
      original.call(this, entry);
    });
    try {
      expect(await f.run(revokeRecord, ...ARGS)).toBe(1);
      expect(f.w.facts().revocations[NAME]).toBeUndefined();
      expect(await f.run(revokeRecord, ...CLEANUP)).toBe(2);
      expect(f.hosted.calls.some(({ name }) => name === TOOLS.reclaim)).toBe(false);
    } finally {
      writeEvidence.mockRestore();
    }
    const writeFact = vi.spyOn(FactsFile.prototype, 'put').mockImplementationOnce(() => { throw new Error('The revocation fact write failed.'); });
    try {
      expect(await f.run(revokeRecord, ...ARGS)).toBe(1);
      expect(f.w.facts().revocations[NAME]).toBeUndefined();
      expect(f.w.evidence('revoke-record').filter(({ status }) => status === 'verified')).toMatchObject([{ shows: { txHash: built.txHash } }]);
      expect(f.w.state('revoke-record').steps.revoke?.verified_at).toBeNull();
    } finally {
      writeFact.mockRestore();
    }
    expect(await f.run(revokeRecord, ...ARGS)).toBe(0);
    expect(f.w.evidence('revoke-record').filter(({ status }) => status === 'verified')).toHaveLength(1);
    expect(f.w.facts().revocations[NAME]?.tx).toBe(built.txHash);
    expect(f.w.state('revoke-record').steps.revoke?.verified_at).toEqual(expect.any(String));
    expect(f.hosted.calls.filter(({ name }) => name === TOOLS.revoke)).toHaveLength(1);
    expect(f.w.node.submitted).toHaveLength(1);
    expect(f.signed.sort()).toEqual([BY, 'fee']);
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
    const fee = factsOf(f.w.node.submitted.at(-1)!).feeLovelace;
    const released = before.utxo.assets.lovelace - after.utxo.assets.lovelace;
    expect(f.w.evidence('revoke-record').find(({ step, status }) => step === `reclaim:${NAME}` && status === 'verified')).toMatchObject({ shows: {
      txHash: built.txHash, receivedBy: 'fee', releasedLovelace: String(released), feeLovelace: String(fee),
      feeWalletCreditLovelace: String(released - fee), valueSource: 'confirmed tx_info',
    } });
    expect(f.w.state('revoke-record').notes[`part.reclaim:${NAME}`]).toMatchObject({ tx_hash: built.txHash, verified_at: expect.any(String) });
    expect(await f.run(revokeRecord, ...CLEANUP, '--run', 'again')).toBe(2);
    expect(f.w.screen.errorText).toContain('take no --run label');
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(0);
    expect(f.hosted.calls.filter(({ name }) => name === TOOLS.reclaim)).toHaveLength(1);
  });

  it('resumes the submitted reclaim without signing again and reports only independently confirmed credit', async () => {
    const f = await setup();
    await prepareRevocation(f);
    expect(await f.run(revokeRecord, ...ARGS)).toBe(0);
    const built = await buildReclaim(await f.context(), { changeAddress: f.fee, id: f.id, nowMs: f.w.clock.now() });
    f.prepare(TOOLS.reclaim, built);
    f.w.node.neverConfirm = true;
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(1);
    const step = `reclaim:${NAME}`;
    expect(f.w.state('revoke-record').in_flight).toMatchObject({ step, tx_hash: built.txHash, facts: { reclaimSeal: expect.any(String) } });
    const archived = f.archive.get(built.txHash)!;
    f.archive.delete(built.txHash);
    f.w.node.neverConfirm = false;
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(1);
    expect(f.w.screen.errorText).toContain('does not confirm the exact record spend');
    const pending = f.w.state('revoke-record').notes[`part.${step}`];
    expect(pending).toMatchObject({ tx_hash: built.txHash });
    expect(pending).not.toHaveProperty('verified_at');
    f.archive.set(built.txHash, { ...archived, fee: String(BigInt(archived.fee) + 1n) });
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(1);
    expect(f.w.screen.errorText).toContain('inputs, outputs or fee differ from the checked transaction');
    expect(f.w.evidence('revoke-record').some((entry) => entry.step === step && entry.status === 'verified')).toBe(false);
    const wrongWallet = f.registry.addressOf('controller');
    f.archive.set(built.txHash, { ...archived, outputs: archived.outputs.map((output) => (
      output.payment_addr.bech32 === f.fee ? { ...output, payment_addr: { bech32: wrongWallet } } : output
    )) });
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(1);
    expect(f.w.evidence('revoke-record').some((entry) => entry.step === step && entry.status === 'verified')).toBe(false);
    f.archive.set(built.txHash, archived);
    // The archive still reports the payment when the fee change is no longer unspent.
    f.w.world.chain.held = f.w.world.chain.held.filter((output) => output.txHash !== built.txHash || output.address !== f.fee);
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(0);
    expect(f.w.evidence('revoke-record').filter((entry) => entry.step === step && entry.status === 'verified')).toMatchObject([{
      shows: { txHash: built.txHash, receivedBy: 'fee', feeWalletCreditLovelace: String(built.returnedLovelace - BigInt(archived.fee)) },
    }]);
    expect(f.hosted.calls.filter(({ name }) => name === TOOLS.reclaim)).toHaveLength(1);
    expect(f.w.node.submitted).toHaveLength(2);
    expect(f.signed.sort()).toEqual([BY, 'controller', 'fee', 'fee']);
  });

  it('refuses a live record and a tombstone without a matching fact', async () => {
    const f = await setup();
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(2);
    expect(f.w.screen.errorText).toContain('The record is not Revoked.');
    await replaceRecord(f, tombstone(f.parent, { type: 'Revoked', by: { type: 'KeyHash', hash: f.accountableHash }, reason: 9, at: WINDOW.lo, invalidFrom: null, successor: null }));
    expect(await f.run(revokeRecord, ...CLEANUP)).toBe(2);
    expect(f.w.screen.errorText).toContain('no matching revocation fact');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });
});
