import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DAYS_7_MS } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { claimUtxo, CLAIM_TOKEN } from '../../../packages/buyer-core/test/fixtures/jury-world.ts';
import { plutusAddressToBech32 } from '../../../packages/vector-read/src/index.ts';
import { iso } from '../../checks/lib/format.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { SYSTEM_START_MS } from '../../checks/test/support/chain-view.ts';
import { blake2b256Hex } from '../lib/platform.ts';
import { FIRST, GUARDIAN, SECOND, TARGET, TOOLS, lifecycleWorld, refOf } from './support/lifecycle-world.ts';
import { liveBuildAnswer } from './support/pack-hosted.ts';
import { hashOf } from './support/task-world.ts';

type World = Awaited<ReturnType<typeof lifecycleWorld>>;
const names = ['change-controller', 'recovery-start', 'recovery-wait', 'recovery-complete', 'retire', 'set-successor', 'reclaim'];
const submits = (f: World) => f.w.node.submitted.length;
const asked = (f: World, name: string) => f.calls.filter((call) => call.name === name);
const expectOnly = (f: World, index: number, keys: string[]) => expect(factsOf(f.w.node.submitted[index]!).witnesses.sort()).toEqual(keys.map((name) => f.registry.hashOf(name)).sort());

async function firstSession(f: World): Promise<number> {
  expect(await f.run('--all', '--submit'), f.w.screen.errorText).toBe(4);
  return (await f.record()).record.pendingRecovery!.effectiveAfter;
}

function openSecond(f: World, due: number): void {
  f.w.clock.t = due + 60_000;
  f.go('second');
}

async function complete(f: World): Promise<void> {
  openSecond(f, await firstSession(f));
  expect(await f.run('--submit'), f.w.screen.errorText).toBe(0); // Record the wait, with no transaction.
  expect(await f.run('--submit'), f.w.screen.errorText).toBe(0); // Complete recovery.
  expect(submits(f)).toBe(3);
}

function clearScreen(f: World): void {
  f.w.screen.lines.length = 0;
  f.w.screen.errors.length = 0;
}

describe('the lifecycle run', () => {
  it('uses one state stream and takes no other option to choose a target', async () => {
    const f = await lifecycleWorld();
    for (const args of [[], ['--run', 'l2', '--submit'], ['status', '--run=clean'], ['cleanup', '--run', 'other'], ['--run', 'l1', '--agent', TARGET]]) {
      expect(await f.runBare(...args)).toBe(2);
    }
    expect(f.w.node.networkReads).toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.signed).toEqual([]);
    for (const suffix of ['', '.l2', '.clean', '.other', '.l1']) expect(existsSync(join(f.w.stateDir, `lifecycle${suffix}.state.json`))).toBe(false);
    expect(await f.run(), f.w.screen.errorText).toBe(0);
    expect(f.w.machine().outcome).toBe('dry');
    expect(f.calls).toEqual([]);
    expect(submits(f)).toBe(0);
    expect(f.state().steps).toEqual({});
    expect(await f.run('cleanup')).toBe(0);
    expect(f.w.screen.text).toContain('There is nothing to take back.');
  });

  it('runs two sessions, waits without sleeping, and keeps the exact controller, epoch, successor and repayment', async () => {
    const f = await lifecycleWorld();
    const due = await firstSession(f);
    const { record: pending } = await f.record();
    expect(pending.subagentEpoch).toBe(f.bravo.subagentEpoch + 1);
    expect(pending.controller).toBe(f.registry.publicKeyOf(FIRST));
    expect(pending.pendingRecovery).toEqual({ newController: f.registry.publicKeyOf(SECOND), effectiveAfter: f.builds[TOOLS.start]!.validTo + DAYS_7_MS });
    expect(f.w.machine()).toMatchObject({ task: 'lifecycle', outcome: 'wait', step: 'recovery-wait', exit: 4 });
    expect(f.w.screen.text).toContain(iso(due));
    expect(submits(f)).toBe(2);
    expectOnly(f, 0, ['controller', FIRST, 'fee']);
    expectOnly(f, 1, [GUARDIAN, 'controller', SECOND, 'fee']);
    expect(f.w.facts().lifecycle['recovery-start']).toEqual({ tx: f.builds[TOOLS.start]!.txHash, at: iso(due) });
    expect(f.w.facts().lifecycle['recovery-wait']).toBeUndefined();
    expect(f.evidence().filter(({ status }) => status === 'tool_refused')).toMatchObject([
      { step: 'recovery-wait', expected: true, tool: TOOLS.complete, message: `The build tool refused recovery completion before ${iso(due)}. No transaction was signed.` },
    ]);
    const sleep = vi.spyOn(f.w.clock, 'sleep');
    expect(await f.run('status'), f.w.screen.errorText).toBe(0);
    expect(f.w.screen.text).toContain(`Recovery opens at ${iso(due)}`);
    expect(await f.run('--all', '--submit')).toBe(4);
    expect(asked(f, TOOLS.complete)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();

    openSecond(f, due);
    f.w.node.tipSlot = (due - SYSTEM_START_MS) / 1_000 - 1;
    expect(await f.run('--all', '--submit')).toBe(4);
    expect(f.state().steps['recovery-wait']).toBeUndefined();
    expect(asked(f, TOOLS.complete)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    sleep.mockRestore();
    f.w.node.tipSlot = null;
    const beforeReclaim = await f.feeBalance();
    expect(await f.run('--all', '--submit'), f.w.screen.errorText).toBe(0);
    expect(f.w.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
    expect(submits(f)).toBe(6);
    expectOnly(f, 2, ['fee']);
    expectOnly(f, 3, [SECOND, 'fee']);
    expectOnly(f, 4, [SECOND, 'controller', 'fee']);
    expectOnly(f, 5, [SECOND, 'fee']);
    expect(asked(f, TOOLS.retire)[0]?.args).toEqual({ did: f.did, changeAddress: f.fee });
    expect(asked(f, TOOLS.successor)[0]?.args).toEqual({ did: f.did, changeAddress: f.fee, successor: f.successorDid });
    const final = await f.record();
    expect(final.record).toMatchObject({ controller: f.registry.publicKeyOf(SECOND), pendingRecovery: null, subagentEpoch: f.bravo.subagentEpoch + 2,
      status: { type: 'Retired', successor: f.successorId }, keys: [], parties: [] });
    const state = f.state();
    expect(Object.keys(state.steps)).toEqual(names);
    expect(state.steps['recovery-wait']).toMatchObject({ tx_hash: null, refs: { recoveryStart: f.builds[TOOLS.start]!.txHash }, facts: { effectiveAfter: due } });
    expect(f.w.facts().lifecycle['recovery-wait']).toEqual({ tx: f.builds[TOOLS.start]!.txHash, at: iso(due) });
    for (let index = 0; index < names.length; index += 1) {
      const step = state.steps[names[index]!]!;
      expect(step.verified_at).toEqual(expect.any(String));
      if (index > 0) expect(step.refs.recordBefore).toBe(state.steps[names[index - 1]!]!.refs.recordAfter);
      if (step.tx_hash !== null) expect(f.w.facts().lifecycle[names[index]!]?.tx).toBe(step.tx_hash);
    }
    const kept = final.utxo.assets.lovelace;
    const released = f.parentOutput.assets.lovelace - kept;
    const fees = f.w.node.submitted.slice(2).map((hex) => factsOf(hex).feeLovelace);
    expect(kept).toBe(f.builds[TOOLS.reclaim]!.outputLovelace);
    expect(await f.feeBalance()).toBe(beforeReclaim + released - fees.reduce((sum, fee) => sum + fee, 0n));
    expect(f.evidence()).toContainEqual(expect.objectContaining({ step: 'reclaim', status: 'verified', shows: expect.objectContaining({
      receivedBy: 'fee', releasedLovelace: String(released), feeWalletCreditLovelace: String(released - fees[3]!), valueSource: 'confirmed tx_info',
    }) }));
    expect(f.evidence()).toContainEqual(expect.objectContaining({ step: 'set-successor', status: 'verified', shows: expect.objectContaining({
      successor: f.successorDid, successorResolver: { read: 'ok', effective: 'Active', deactivated: false },
    }) }));
    expect(JSON.stringify(f.evidence())).not.toContain(f.registry.publicKeyOf(SECOND));
    expect(await f.run('--all', '--submit'), f.w.screen.errorText).toBe(0);
    expect(submits(f)).toBe(6);
  });

  it('requires each irreversible tag in the session that takes the action', async () => {
    const f = await lifecycleWorld();
    f.go('first', []);
    expect(await f.run('--all', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('controller-change');
    expect(f.calls).toEqual([]);
    f.go('first');
    openSecond(f, await firstSession(f));
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0); // Record the wait before testing the completion tag.
    for (const [count, tag, tool, granted] of [
      [2, 'recovery-complete', TOOLS.complete, []],
      [3, 'retire', TOOLS.retire, ['recovery-complete']],
      [4, 'successor', TOOLS.successor, ['recovery-complete', 'retire']],
    ] as const) {
      clearScreen(f);
      f.go('second', [...granted]);
      expect(await f.run('--submit'), f.w.screen.errorText).toBe(2);
      expect(f.w.screen.errorText).toContain(tag);
      expect(submits(f)).toBe(count);
      expect(asked(f, tool)).toHaveLength(tool === TOOLS.complete ? 1 : 0);
      f.go('second');
      expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
      expect(submits(f)).toBe(count + 1);
    }
    f.go('second');
    expect(await f.run('--all', '--submit'), f.w.screen.errorText).toBe(0);
    expect(submits(f)).toBe(6);
  });
});

describe('recovery authority and the wait', () => {
  it('does not use a different output or a changed datum after an interrupted run', async () => {
    const f = await lifecycleWorld();
    f.w.node.neverConfirm = true;
    expect(await f.run('--submit')).toBe(1);
    expect(f.state().in_flight?.step).toBe('change-controller');
    expect(submits(f)).toBe(1);
    f.w.node.neverConfirm = false;
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect(f.state().steps['change-controller']?.verified_at).toBeTruthy();
    const afterStart = (await f.record()).record;
    expect(submits(f)).toBe(2);
    await f.replace((record) => ({ ...record, pendingRecovery: { ...record.pendingRecovery!, effectiveAfter: record.pendingRecovery!.effectiveAfter - 1_000 } }));
    expect(await f.run('--all', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('does not match the verified output of recovery-start');
    expect(asked(f, TOOLS.complete)).toHaveLength(0);
    await f.replace(() => afterStart);
    expect(await f.run('--all', '--submit'), f.w.screen.errorText).toBe(4);
    await f.replace((record) => record, f.id, true);
    expect(await f.run('--all', '--submit')).toBe(2);
    expect(asked(f, TOOLS.complete)).toHaveLength(1);
    expect(submits(f)).toBe(2);
  });

  it('resends the stored bytes only for the matching action under a valid GO and free runtime', async () => {
    const f = await lifecycleWorld();
    f.w.node.submitError = new Error('The node did not answer the submit call.');
    expect(await f.run('--submit')).toBe(1);
    const flight = f.state().in_flight!;
    const reserve = f.w.exposure('first');
    expect(flight.step).toBe('change-controller');
    expect(reserve.map(({ tx_hash }) => tx_hash)).toEqual([flight.tx_hash]);
    expect(submits(f)).toBe(0);
    f.w.node.submitError = null;

    const checkpoint = () => {
      expect(f.state().in_flight).toEqual(flight);
      expect(f.w.exposure('first')).toEqual(reserve);
      expect(f.w.facts().lifecycle).toEqual({});
      expect(submits(f)).toBe(0);
    };
    rmSync(f.w.goPath);
    expect(await f.run('--submit')).toBe(2);
    checkpoint();
    f.go('first', ['retire']);
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('controller-change');
    checkpoint();
    f.go('first');
    const state = StateFile.open(join(f.w.stateDir, 'lifecycle.l1.state.json'), { check: 'lifecycle', network: 'vector-mainnet', record: `${f.w.use.name}:l1` });
    state.clearInFlight();
    state.setInFlight({ ...flight, step: 'retire' });
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('is not the next checked spend');
    expect(f.state().in_flight).toEqual({ ...flight, step: 'retire' });
    expect(f.w.exposure('first')).toEqual(reserve);
    expect(submits(f)).toBe(0);
    state.clearInFlight();
    state.setInFlight(flight);
    expect(await f.run('cleanup', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('Only lifecycle run can resend');
    checkpoint();
    f.showRunning([f.agent.adverts[0]!.runtimeContainer]);
    f.setRuntime('working');
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('says working');
    checkpoint();

    f.setRuntime('free');
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect(f.w.node.submitted[0]).toBe(flight.signed_cbor);
    expect(asked(f, TOOLS.change)).toHaveLength(1);
    expect(f.state().steps['change-controller']?.tx_hash).toBe(flight.tx_hash);
    expect(f.state().steps['change-controller']?.verified_at).toBeTruthy();
    expect(f.state().in_flight).toBeNull();
  });

  it('requires the enrolled key guardians throughout the actual validity window', async () => {
    const f = await lifecycleWorld();
    await f.replace((record) => ({ ...record, parties: record.parties.map((party) => party.role === 'Guardian' && party.signer.type === 'KeyHash' && party.signer.hash === f.registry.hashOf(GUARDIAN)
      ? { ...party, notAfter: f.w.clock.now() + 35 * 60_000 } : party) }));
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    f.w.clock.t += 10 * 60_000;
    f.go('first');
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('enrolled guardians');
    expect(asked(f, TOOLS.start)).toHaveLength(0);
    expect(submits(f)).toBe(1);
  });

  it.each(['missing', 'extra'])('does not sign a hosted recovery build with a %s signer', async (kind) => {
    const f = await lifecycleWorld();
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    f.override[TOOLS.start] = async (args) => {
      const build = await f.build(TOOLS.start, { ...args });
      const requiredSigners = kind === 'extra' ? [...build.requiredSigners, { keyHash: f.registry.hashOf('provider'), roles: ['extra'] }] : build.requiredSigners.slice(1);
      return liveBuildAnswer('Recovery start', { ...build, requiredSigners });
    };
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('signers');
    expect(submits(f)).toBe(1);
    delete f.override[TOOLS.start];
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expectOnly(f, 1, [GUARDIAN, 'controller', SECOND, 'fee']);
  });

  it.each(['unrelated refusal', 'early unsigned build'])('fails closed and does not request a second early build after %s', async (answer) => {
    const f = await lifecycleWorld();
    f.override[TOOLS.complete] = async (args) => {
      if (answer === 'unrelated refusal') return { text: 'Failed to build recovery completion: The fee wallet has no collateral.' };
      const due = (await f.record()).record.pendingRecovery!.effectiveAfter;
      return liveBuildAnswer('Recovery completion', await f.build(TOOLS.complete, { ...args }, due + 60_000));
    };
    expect(await f.run('--all', '--submit'), f.w.screen.errorText).toBe(1);
    expect(f.w.screen.errorText).toContain('did not give the expected early recovery refusal');
    expect(f.evidence().some(({ status }) => status === 'tool_refused')).toBe(false);
    expect(submits(f)).toBe(2);
    delete f.override[TOOLS.complete];
    expect(await f.run('--all', '--submit')).toBe(2);
    expect(asked(f, TOOLS.complete)).toHaveLength(1);
    expect(f.state().steps['recovery-wait']).toBeUndefined();
    expect(submits(f)).toBe(2);
  });
});

describe('retirement and return', () => {
  it('requires an authentic spent advert, no replacement, and all known and live claims closed', async () => {
    const f = await lifecycleWorld();
    await complete(f);
    const advertRef = refOf(f.posted);
    f.history.set(advertRef, { out: f.advert(f.posted.txHash, { agent_id: hashOf('another advert agent') }), spent: true });
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('does not match the recorded advert');
    f.history.set(advertRef, { out: f.posted, spent: true });
    for (const status of ['Active', 'Retired'] as const) {
      const live = f.advert(hashOf(`${status} replacement advert`), { model: 'another-model', status });
      f.w.world.chain.held.push(live);
      expect(await f.run('--submit')).toBe(2);
      expect(f.w.screen.errorText).toContain('still has an unspent advert');
      f.w.world.chain.held = f.w.world.chain.held.filter((out) => refOf(out) !== refOf(live));
    }
    const original = f.w.facts().claims.clean![TARGET]!;
    f.store.put('claims', ['clean', TARGET], { ...original, withdrawTx: null }, { replace: true });
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('no valid closeout fact');
    f.store.put('claims', ['clean', TARGET], original, { replace: true });
    const moved = { ...claimUtxo(CLAIM_TOKEN, { claimerDid: f.id, state: 'Challenged' }), txHash: hashOf('moved claim') };
    f.w.world.chain.held.push(moved);
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('still has a live or moved claim');
    expect(asked(f, TOOLS.retire)).toHaveLength(0);
    expect(submits(f)).toBe(3);
    f.w.world.chain.held = f.w.world.chain.held.filter((out) => refOf(out) !== refOf(moved));
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect((await f.record()).record.status).toMatchObject({ type: 'Retired', successor: null });
    expectOnly(f, 3, [SECOND, 'fee']);
  });

  it('checks the advert script at other stake addresses and ignores a spent indexer candidate', async () => {
    const f = await lifecycleWorld();
    await complete(f);
    const { address: deployed, hash } = f.w.chain.deployment.advert;
    const address = plutusAddressToBech32({ paymentCredential: { type: 'Script', hash },
      stakeCredential: { type: 'Inline', credential: { type: 'VerificationKey', hash: f.accountableHash } } }, 1);
    expect(address).not.toBe(deployed);
    const output = { ...f.advert(hashOf('advert at another stake address'), { status: 'Retired' }), address };
    const ref = refOf(output);
    f.indexedAdverts.set(ref, output);
    f.w.world.chain.held.push(output);

    f.w.node.inputReads.length = 0;
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('still has an unspent advert');
    expect(f.w.node.inputReads).toContainEqual([ref]);
    expect(asked(f, TOOLS.retire)).toHaveLength(0);
    expect(submits(f)).toBe(3);

    f.w.world.chain.held = f.w.world.chain.held.filter((out) => refOf(out) !== ref);
    f.w.node.inputReads.length = 0;
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect(f.w.node.inputReads).toContainEqual([ref]);
    expect(submits(f)).toBe(4);
  });

  it('requires a verified RetireAdvert receipt and actual supplier credit', async () => {
    const f = await lifecycleWorld();
    await complete(f);
    const actual = f.closeouts.get(f.advertTx)!;
    f.setAdvertReceipt(false);
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('no matching verified retirement receipt');
    f.setAdvertReceipt(true);
    f.closeouts.set(f.advertTx, { ...actual, plutus_contracts: actual.plutus_contracts.map((entry) => ({
      ...entry, input: { redeemer: { purpose: 'spend', datum: { bytes: 'd87a80', value: { constructor: 1, fields: [] } } } },
    })) });
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('RetireAdvert spend and its supplier credit could not be verified');
    f.closeouts.set(f.advertTx, { ...actual, outputs: actual.outputs.map((row) => ({ ...row, payment_addr: { bech32: f.fee } })) });
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('RetireAdvert spend and its supplier credit could not be verified');
    expect(asked(f, TOOLS.retire)).toHaveLength(0);
    expect(submits(f)).toBe(3);
    f.closeouts.set(f.advertTx, actual);
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect(submits(f)).toBe(4);
  });

  it('closes the record only after the per-agent advert task proves the exact refund', async () => {
    const f = await lifecycleWorld({ activeAdvert: true });
    await complete(f);
    const advertRef = refOf(f.posted);
    const { held } = f.w.world.chain;
    f.w.world.chain.held = held.filter((out) => refOf(out) !== advertRef);
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('Retire the recorded adverts with advert cleanup');
    expect(asked(f, TOOLS.retire)).toHaveLength(0);
    f.w.world.chain.held = held;

    const supplyBalance = async () => (await f.w.chain.provider.getUtxos(f.supplier))
      .reduce((sum, out) => sum + out.assets.lovelace, 0n);
    const before = await supplyBalance();
    expect(await f.retireAdvert(), f.w.screen.errorText).toBe(0);
    const { txHash, inputs, feeLovelace } = factsOf(f.w.node.submitted[3]!);
    const { model, supplierKey, depositLovelace } = f.agent.adverts[0]!;
    const step = `retire:${TARGET}:${model}`;
    const creditLovelace = String(depositLovelace - feeLovelace);
    expect(inputs).toContain(advertRef);
    expect(await supplyBalance() - before).toBe(BigInt(creditLovelace));
    expectOnly(f, 3, [supplierKey]);
    expect(f.w.machine()).toMatchObject({ result: { agent: TARGET, model, tx: txHash, retire: advertRef, creditLovelace, refundVerified: true } });
    expect(f.w.state('advert').notes[`part.${step}`]).toMatchObject({
      tx_hash: txHash, verified_at: expect.any(String), refs: { retiredRef: advertRef },
      facts: { supplierPkh: f.registry.hashOf(supplierKey), supplierAddress: f.supplier, creditLovelace, approvalSession: 'close-advert' },
    });
    expect(f.w.evidence('advert')).toContainEqual(expect.objectContaining({
      step, status: 'info', shows: expect.objectContaining({ tx: txHash, retiredRef: advertRef, refundVerified: true }),
    }));
    expect(f.w.world.chain.find(advertRef)).toBeUndefined();

    f.go('second');
    const other = hashOf('unrelated retired advert');
    const alter: (typeof f.advertHosted.rewriteRetirement)[] = [
      () => null,
      (row) => ({ ...row, outputs: row.outputs.map((out) => ({ ...out, payment_addr: { bech32: f.fee } })) }),
      (row) => ({ ...row, outputs: row.outputs.map((out, i) => i === 0 ? { ...out, value: String(BigInt(out.value) + 1n) } : out) }),
      (row) => ({ ...row, inputs: row.inputs.map((input) => input.tx_hash === f.posted.txHash ? { ...input, tx_hash: other } : input),
        plutus_contracts: row.plutus_contracts.map((script) => ({ ...script, spends_input: { ...script.spends_input, tx_hash: other } })) }),
    ];
    const signed = [...f.signed];
    for (const rewrite of alter) {
      f.advertHosted.rewriteRetirement = rewrite;
      expect(await f.run('--submit')).toBe(2);
      expect(f.w.screen.errorText).toContain('RetireAdvert spend and its supplier credit could not be verified');
    }
    expect(f.signed).toEqual(signed);
    expect(asked(f, TOOLS.retire)).toHaveLength(0);
    expect(submits(f)).toBe(4);

    f.advertHosted.rewriteRetirement = (row) => row;
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect((await f.record()).record.status).toMatchObject({ type: 'Retired', successor: null });
    expectOnly(f, 4, [SECOND, 'fee']);
    expect(submits(f)).toBe(5);
  });

  it('rejects a wrong withdrawal hash or a missing burn, and leaves a proved end unattributed', async () => {
    const f = await lifecycleWorld();
    await complete(f);
    const original = f.w.facts().claims.clean![TARGET]!;
    f.store.put('claims', ['clean', TARGET], { ...original, withdrawTx: f.advertTx }, { replace: true });
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('named claim withdrawal is not its confirmed terminal spend');
    f.store.put('claims', ['clean', TARGET], { ...original, withdrawTx: 'not open' }, { replace: true });
    f.setClaimBurn(false);
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('does not prove one mint and one burn');
    f.setClaimBurn(true);
    const actual = f.closeouts.get(f.claimTx)!;
    f.closeouts.set(f.claimTx, { ...actual, plutus_contracts: actual.plutus_contracts.map((entry) => ({ ...entry, script_hash: f.w.chain.deployment.advert.hash })) });
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('terminal spend does not consume the matching claim');
    expect(asked(f, TOOLS.retire)).toHaveLength(0);
    expect(submits(f)).toBe(3);
    f.closeMovedClaim();
    f.store.put('claims', ['clean', TARGET], original, { replace: true });
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('does not show WithdrawClaim on the matching input');
    expect(asked(f, TOOLS.retire)).toHaveLength(0);
    f.store.put('claims', ['clean', TARGET], { ...original, withdrawTx: 'not open' }, { replace: true });
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect(f.w.facts().claims.clean![TARGET]?.withdrawTx).toBe('not open');
    expect(submits(f)).toBe(4);
  });

  it('requires the WithdrawClaim action from every returned representation of the matching redeemer', async () => {
    const f = await lifecycleWorld();
    await complete(f);
    const confirmed = f.closeouts.get(f.claimTx)!;
    const action = confirmed.plutus_contracts[0]!;
    const { datum } = action.input.redeemer;
    const report = (evidence: typeof datum) => f.closeouts.set(f.claimTx, { ...confirmed, plutus_contracts: [{ ...action,
      input: { redeemer: { purpose: 'spend', datum: evidence } },
    }] });
    const incorrect: (typeof datum)[] = [
      { ...datum, value: { constructor: 3, fields: [] } },
      { value: datum.value, hash: blake2b256Hex(Buffer.from('d87c80', 'hex')) },
    ];
    for (const evidence of incorrect) {
      report(evidence);
      expect(await f.run('--submit')).toBe(2);
      expect(f.w.screen.errorText).toContain('does not show WithdrawClaim on the matching input');
    }
    expect(asked(f, TOOLS.retire)).toHaveLength(0);
    report({ value: datum.value, hash: blake2b256Hex(Buffer.from(datum.bytes!, 'hex')) });
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect(submits(f)).toBe(4);
  });

  it('binds the successor to an Active root, the original controller and the exact checked reference', async () => {
    const f = await lifecycleWorld();
    await complete(f);
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    await f.replace((record) => ({ ...record, status: { type: 'Retired', at: f.w.clock.now(), successor: null } }), f.successorId);
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('not an Active root');
    await f.replace(() => ({ ...f.successor, controller: f.registry.publicKeyOf(FIRST) }), f.successorId);
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('does not match controller');
    expect(asked(f, TOOLS.successor)).toHaveLength(0);
    await f.replace(() => f.successor, f.successorId);
    f.override[TOOLS.successor] = async (args) => {
      await f.replace((record) => record, f.successorId, true);
      return liveBuildAnswer('Successor', await f.build(TOOLS.successor, { ...args }));
    };
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('does not reference the verified Active successor');
    expect(submits(f)).toBe(4);
    delete f.override[TOOLS.successor];
    expect(await f.run('--submit'), f.w.screen.errorText).toBe(0);
    expect((await f.record()).record.status).toMatchObject({ type: 'Retired', successor: f.successorId });
    expectOnly(f, 4, [SECOND, 'controller', 'fee']);
  });

  it('does not record a reclaim without positive ledger credit and does not sign it again on resume', async () => {
    const f = await lifecycleWorld();
    openSecond(f, await firstSession(f));
    f.setCredit(false);
    expect(await f.run('--all', '--submit')).toBe(1);
    expect(f.w.screen.errorText).toContain('does not confirm the exact spend');
    const state = f.state().steps.reclaim;
    expect(state).toMatchObject({ verified_at: null, tx_hash: f.builds[TOOLS.reclaim]!.txHash });
    expect(f.w.facts().lifecycle.reclaim).toBeUndefined();
    expect(f.evidence().some(({ step, status }) => step === 'reclaim' && status === 'verified')).toBe(false);
    const signed = [...f.signed];
    f.setCredit(true);
    expect(await f.run('--all', '--submit'), f.w.screen.errorText).toBe(0);
    expect(f.signed).toEqual(signed);
    expect(submits(f)).toBe(6);
    expect(f.w.facts().lifecycle.reclaim?.tx).toBe(state?.tx_hash);
  });
});
