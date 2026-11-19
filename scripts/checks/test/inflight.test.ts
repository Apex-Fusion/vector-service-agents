// A transaction that was signed and not seen confirmed is settled before any step is built again: no step is built twice, and no confirmed step is run again.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KeyRing } from '../lib/keys.ts';
import { NetworkGate, landTransaction } from '../lib/land.ts';
import type { LandIo, LandRequest } from '../lib/land.ts';
import { recordLanded, settleInFlight } from '../lib/inflight.ts';
import { TxNotConfirmedError } from '../lib/platform.ts';
import { VECTOR_MAINNET } from '../lib/settings.ts';
import { StateFile } from '../lib/state.ts';
import { factsOf } from '../lib/txfacts.ts';
import { FakeClock, FakeNode, MemoryOutput } from './support/fakes.ts';
import { AGENT_N, MEMBER_N, NOW, World, keyOf } from './support/world.ts';

const root = mkdtempSync(join(tmpdir(), 'checks-inflight-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const member = keyOf(MEMBER_N);
const agent = keyOf(AGENT_N);

/** A state file with a transaction in flight: the transaction was landed by the real code against a node that never confirmed it. */
async function inFlight(step: string, refs: Record<string, string> = { output: 'ref' }) {
  n += 1;
  const world = await World.create([{ n: MEMBER_N }, { n: AGENT_N }]);
  const ring = new KeyRing([member, agent]);
  const node = new FakeNode(world);
  node.neverConfirm = true;
  const clock = new FakeClock(NOW);
  const state = StateFile.open(join(root, `s-${n}.json`), { check: 'toy', network: 'vector-mainnet', record: 'did:vector:abc' });
  const payment = await world.simplePayment(member.address, 3_000_000n, agent.address);
  const request: LandRequest = {
    step,
    built: { unsignedCbor: payment.unsignedCbor, txHash: payment.txHash, feeLovelace: factsOf(payment.unsignedCbor).feeLovelace, validTo: NOW + 30 * 60_000 },
    plan: { maxFeeLovelace: 2_000_000n, maxOutflow: { [member.keyHash]: 4_000_000n }, maxCollateralLossLovelace: 5_000_000n, explained: new Set(), destinations: new Set(), mint: {} },
    refs, facts: { amount: '3000000' },
  };
  const io: LandIo = {
    mode: 'submit', node, signer: ring, ring, network: new NetworkGate(node, VECTOR_MAINNET), out: () => undefined, clock, awaitMs: 10_000, pollMs: 5_000,
    inFlight: { set: (record) => { state.setInFlight(record); }, clear: () => { state.clearInFlight(); } },
  };
  await expect(landTransaction(request, io)).rejects.toBeInstanceOf(TxNotConfirmedError);
  node.neverConfirm = false;
  const screen = new MemoryOutput();
  const settle = (mode: 'dry' | 'submit') => settleInFlight({ state, node, clock, out: (line) => screen.out(line), mode, awaitMs: 10_000, pollMs: 5_000 });
  return { world, node, clock, state, screen, payment, settle };
}

describe('settleInFlight', () => {
  it('does nothing when no transaction is in flight', async () => {
    const t = await inFlight('delegate');
    t.state.clearInFlight();
    expect(await t.settle('submit')).toEqual({ kind: 'none' });
  });

  it('records the step of a transaction that the indexer now shows confirmed, with the references that its step kept, and lets the transaction go', async () => {
    const t = await inFlight('delegate', { delegation_output: 'abc#0' });
    const result = await t.settle('dry');
    expect(result).toMatchObject({ kind: 'recorded', step: 'delegate', txHash: t.payment.txHash });
    expect(t.state.snapshot().in_flight).toBeNull();
    expect(t.state.step('delegate')).toMatchObject({ tx_hash: t.payment.txHash, refs: { delegation_output: 'abc#0' }, facts: { amount: '3000000' }, verified_at: null });
  });

  it('keeps the transaction of a part of a step as a note of the state, not as a step', async () => {
    const t = await inFlight('hire:pay', { escrow_ref: 'e#0' });
    await t.settle('dry');
    expect(t.state.confirmed('hire:pay')).toBe(false);
    expect(t.state.note('part.hire:pay')).toMatchObject({ tx_hash: t.payment.txHash, refs: { escrow_ref: 'e#0' } });
    expect(t.state.snapshot().in_flight).toBeNull();
  });

  it('only clears the transaction when its step is recorded already, as after a stop between the two writes', async () => {
    const t = await inFlight('delegate');
    t.state.recordStep('delegate', { confirmed_at: 'x', tx_hash: t.payment.txHash, refs: {}, facts: {} });
    expect(await t.settle('dry')).toMatchObject({ kind: 'recorded' });
    expect(t.state.step('delegate')?.confirmed_at).toBe('x');
    expect(t.state.snapshot().in_flight).toBeNull();
  });

  it('lets a transaction go whose validity has ended and that the indexer does not know: it cannot land, and the step can be built again', async () => {
    const t = await inFlight('delegate');
    t.node.neverConfirm = true;
    t.clock.t = NOW + 30 * 60_000 + 61_000;
    const result = await t.settle('submit');
    expect(result).toMatchObject({ kind: 'cleared', step: 'delegate' });
    expect(t.state.snapshot().in_flight).toBeNull();
    expect(t.state.confirmed('delegate')).toBe(false);
    expect(t.screen.text).toContain('cannot land');
  });

  it('waits for a transaction that may still land, and in dry mode asks the node nothing but its status', async () => {
    const t = await inFlight('delegate');
    t.node.neverConfirm = true;
    const submitted = t.node.submitted.length;
    const result = await t.settle('dry');
    expect(result).toMatchObject({ kind: 'wait', step: 'delegate', untilMs: NOW + 30 * 60_000 + 60_000 });
    expect(t.node.submitted).toHaveLength(submitted);
    expect(t.state.snapshot().in_flight).not.toBeNull();
  });

  it('submits the signed bytes again in submit mode, which is harmless, and records the step when it is confirmed', async () => {
    const t = await inFlight('delegate');
    t.node.confirmAfterPolls = 100; // the first reads say that the transaction is not known
    const before = t.node.polls.get(t.payment.txHash) ?? 0;
    t.node.polls.set(t.payment.txHash, before);
    const settling = t.settle('submit');
    t.node.confirmAfterPolls = before + 2;
    const result = await settling;
    expect(result.kind).toBe('recorded');
    expect(t.state.confirmed('delegate')).toBe(true);
  });

  it('keeps the transaction in flight when it is not confirmed in the time of the step, and says until when it may land', async () => {
    const t = await inFlight('delegate');
    t.node.neverConfirm = true;
    const result = await t.settle('submit');
    expect(result).toMatchObject({ kind: 'wait', step: 'delegate' });
    expect(t.state.snapshot().in_flight).not.toBeNull();
  });
});

describe('recordLanded', () => {
  it('records a step, or a part as a note, and clears the transaction in flight', () => {
    n += 1;
    const state = StateFile.open(join(root, `r-${n}.json`), { check: 'toy', network: 'vector-mainnet', record: 'did:vector:abc' });
    state.setInFlight({ step: 'vault_open', tx_hash: 'ab'.repeat(32), signed_cbor: '84', valid_to: 1, signed_at: 1, refs: { vault_ref: 'v#0' }, facts: {} });
    recordLanded(state, { step: 'vault_open', tx_hash: 'ab'.repeat(32), refs: { vault_ref: 'v#0' }, facts: { a: 1 } }, NOW);
    expect(state.step('vault_open')).toMatchObject({ confirmed_at: new Date(NOW).toISOString(), refs: { vault_ref: 'v#0' }, facts: { a: 1 } });
    expect(state.snapshot().in_flight).toBeNull();
    recordLanded(state, { step: 'hire:accept', tx_hash: 'cd'.repeat(32), refs: {}, facts: {} }, NOW);
    expect(state.note('part.hire:accept')).toMatchObject({ tx_hash: 'cd'.repeat(32) });
  });
});
