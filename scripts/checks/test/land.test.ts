// The landing of one transaction: the guards, the summary, the signature, the proof that the signed body is the built body, the submit and the wait for the confirmation.
// The dry mode signs nothing and submits nothing: the tests give it a signer and a node that fail when they are asked.
import { describe, expect, it } from 'vitest';
import { KeyRing } from '../lib/keys.ts';
import { GuardRefusal, LandRefused, NetworkGate, landTransaction } from '../lib/land.ts';
import type { BuiltTransaction, LandIo, LandRequest } from '../lib/land.ts';
import type { StepPlan } from '../lib/guards.ts';
import { TxNotConfirmedError, decodeTransaction, lucidForAddress } from '../lib/platform.ts';
import { VECTOR_MAINNET } from '../lib/settings.ts';
import type { InFlight } from '../lib/state.ts';
import { factsOf } from '../lib/txfacts.ts';
import type { Signer } from '../lib/ports.ts';
import { FakeClock, FakeNode, MemoryOutput, ThrowingSigner } from './support/fakes.ts';
import { AGENT_N, MEMBER_N, NOW, World, keyOf } from './support/world.ts';

const member = keyOf(MEMBER_N);
const agent = keyOf(AGENT_N);

async function setup(over: { mode?: 'dry' | 'submit'; signer?: Signer; plan?: Partial<StepPlan>; payment?: bigint } = {}) {
  const world = await World.create([{ n: MEMBER_N }, { n: AGENT_N }]);
  const ring = new KeyRing([member, agent]);
  const node = new FakeNode(world);
  const clock = new FakeClock(NOW);
  const screen = new MemoryOutput();
  const payment = await world.simplePayment(member.address, over.payment ?? 3_000_000n, agent.address);
  const built: BuiltTransaction = { unsignedCbor: payment.unsignedCbor, txHash: payment.txHash, feeLovelace: factsOf(payment.unsignedCbor).feeLovelace, validTo: NOW + 30 * 60_000 };
  const events: string[] = [];
  const inFlight: InFlight[] = [];
  const plan: StepPlan = {
    maxFeeLovelace: 2_000_000n, maxOutflow: { [member.keyHash]: 4_000_000n }, maxCollateralLossLovelace: 5_000_000n, explained: new Set(), destinations: new Set(), mint: {},
    labels: {}, ...over.plan,
  };
  const io: LandIo = {
    mode: over.mode ?? 'submit', node, signer: over.signer ?? ring, ring, network: new NetworkGate(node, VECTOR_MAINNET), out: (line) => screen.out(line), clock, awaitMs: 30_000, pollMs: 5_000,
    inFlight: { set: (record) => { events.push('in_flight'); inFlight.push(record); }, clear: () => { events.push('clear'); } },
  };
  const request: LandRequest = { step: 'pay', built, plan, refs: { payment: `${built.txHash}#0` }, facts: { amount: '3000000' } };
  const submit = node.submit.bind(node);
  node.submit = async (cbor) => { events.push('submit'); return submit(cbor); };
  return { world, ring, node, clock, screen, built, io, request, events, inFlight, plan };
}
const refusal = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => { throw new Error('the call did not refuse'); }, (err: unknown) => err);

describe('the dry mode', () => {
  it('builds and checks, prints what it would sign, and signs and submits nothing', async () => {
    const signer = new ThrowingSigner();
    const t = await setup({ mode: 'dry', signer });
    t.node.submit = async () => { throw new Error('a submit was asked for'); };
    const result = await landTransaction(t.request, t.io);
    expect(result.kind).toBe('dry');
    expect(signer.calls).toBe(0);
    expect(t.node.submitted).toEqual([]);
    expect(t.world.chain.applied).toEqual([]);
    expect(t.inFlight).toEqual([]);
    const text = t.screen.text;
    expect(text).toContain(t.built.txHash);
    expect(text).toContain(`fee: ${(Number(t.built.feeLovelace) / 1e6).toFixed(6)} units`);
    expect(text).toMatch(/3\.000000 units to the agent wallet/);
    expect(text).toContain(`member key ${member.keyHash}`);
    expect(text).toContain('nothing is signed');
    for (const name of ['network', 'body', 'fee', 'signers', 'inputs', 'destinations', 'outflow', 'collateral', 'mint', 'nothing_else', 'vault']) expect(text, name).toMatch(new RegExp(`ok +${name}\\b`));
  });
  it('refuses a transaction that breaks a guard, as the submit mode does, and says which one', async () => {
    const t = await setup({ mode: 'dry', plan: { maxOutflow: { [member.keyHash]: 3_000_000n } } });
    const err = await refusal(landTransaction(t.request, t.io));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect((err as GuardRefusal).failures.map((g) => g.guard)).toEqual(['outflow']);
    expect(t.screen.text).toMatch(/FAIL +outflow/);
  });
});

describe('the submit mode', () => {
  it('signs with the keys that the transaction needs, keeps the body, records it in flight before the submit, and waits for the confirmation', async () => {
    const t = await setup();
    t.node.confirmAfterPolls = 2;
    const result = await landTransaction(t.request, t.io);
    expect(result.kind).toBe('landed');
    if (result.kind !== 'landed') throw new Error('unreachable');
    expect(result.txHash).toBe(t.built.txHash);
    expect(result.confirmations).toBe(1);
    expect(t.events).toEqual(['in_flight', 'submit']);
    expect(t.inFlight).toHaveLength(1);
    expect(t.inFlight[0]).toMatchObject({ step: 'pay', tx_hash: t.built.txHash, valid_to: t.built.validTo, signed_at: NOW, refs: { payment: `${t.built.txHash}#0` }, facts: { amount: '3000000' } });
    const signed = decodeTransaction(t.node.submitted[0]!);
    expect(signed.body().to_cbor_hex()).toBe(decodeTransaction(t.built.unsignedCbor).body().to_cbor_hex());
    expect(factsOf(t.node.submitted[0]!).witnesses).toEqual([member.keyHash]);
    expect(t.inFlight[0]!.signed_cbor).toBe(t.node.submitted[0]);
    expect(t.clock.slept).toEqual([5_000, 5_000]);
    expect(t.screen.text).toContain('confirmed');
  });
  it('signs for each key that it needs, and for no other', async () => {
    const world = await World.create([{ n: MEMBER_N }, { n: AGENT_N }]);
    const ring = new KeyRing([member, agent]);
    // A payment that spends an output of each wallet.
    const lucid = await lucidForAddress(world.chain, member.address);
    const agentUtxos = await world.chain.getUtxos(agent.address);
    const memberUtxos = await world.chain.getUtxos(member.address);
    const built = await lucid.newTx().collectFrom([agentUtxos[0]!, memberUtxos[1]!]).pay.ToAddress(member.address, { lovelace: 50_000_000n }).complete();
    const claims = { unsignedCbor: built.toCBOR(), txHash: built.toHash(), feeLovelace: factsOf(built.toCBOR()).feeLovelace, validTo: NOW + 60_000 };
    const node = new FakeNode(world);
    const io: LandIo = {
      mode: 'submit', node, signer: ring, ring, network: new NetworkGate(node, VECTOR_MAINNET), out: () => undefined, clock: new FakeClock(NOW), awaitMs: 30_000, pollMs: 5_000, inFlight: { set: () => undefined, clear: () => undefined },
    };
    const plan: StepPlan = { maxFeeLovelace: 2_000_000n, maxOutflow: { [agent.keyHash]: 1_000_000_000n, [member.keyHash]: 1_000_000_000n }, maxCollateralLossLovelace: 5_000_000n, explained: new Set(), destinations: new Set(), mint: {} };
    await landTransaction({ step: 'two', built: claims, plan }, io);
    expect(factsOf(node.submitted[0]!).witnesses.sort()).toEqual([member.keyHash, agent.keyHash].sort());
  });
  it('refuses before it signs when a guard fails: nothing is signed, recorded or submitted', async () => {
    const signer = new ThrowingSigner();
    const t = await setup({ signer, plan: { maxOutflow: { [member.keyHash]: 2_000_000n } } });
    const err = await refusal(landTransaction(t.request, t.io));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(signer.calls).toBe(0);
    expect(t.events).toEqual([]);
    expect(t.node.submitted).toEqual([]);
  });
  it('refuses when the transaction needs a key that the operator did not give', async () => {
    const t = await setup();
    const outsider = new KeyRing([agent]);
    const err = await refusal(landTransaction(t.request, { ...t.io, ring: outsider, signer: outsider }));
    expect((err as GuardRefusal).failures.map((g) => g.guard)).toContain('signers');
    expect(t.node.submitted).toEqual([]);
  });
});

describe('the network', () => {
  it('is checked before anything: a node of another network refuses the step, and the same node of the right network does not', async () => {
    const signer = new ThrowingSigner();
    const t = await setup({ signer });
    t.node.facts = { magic: 42, systemStartMs: VECTOR_MAINNET.systemStartMs };
    const err = await refusal(landTransaction(t.request, t.io));
    expect((err as GuardRefusal).failures.map((g) => g.guard)).toEqual(['network']);
    expect((err as GuardRefusal).failures[0]!.message).toContain('42');
    expect(signer.calls).toBe(0);
    t.node.facts = { magic: VECTOR_MAINNET.magic, systemStartMs: VECTOR_MAINNET.systemStartMs! + 1 };
    expect(await refusal(landTransaction(t.request, { ...t.io, network: new NetworkGate(t.node, VECTOR_MAINNET) }))).toBeInstanceOf(GuardRefusal);
  });
  it('compares the magic only when a test network names no start, and says when the node cannot be read', async () => {
    const world = await World.create([{ n: MEMBER_N }]);
    const node = new FakeNode(world);
    node.facts = { magic: 42, systemStartMs: 5 };
    expect((await new NetworkGate(node, { name: 'vector-test', magic: 42, systemStartMs: null }).guard()).ok).toBe(true);
    expect((await new NetworkGate(node, { name: 'vector-test', magic: 43, systemStartMs: null }).guard()).ok).toBe(false);
    node.networkFacts = async () => { throw new Error('the node did not answer'); };
    const unread = await new NetworkGate(node, VECTOR_MAINNET).guard();
    expect(unread.ok).toBe(false);
    expect(unread.message).toContain('could not be read');
  });
  it('reads the node once', async () => {
    const world = await World.create([{ n: MEMBER_N }]);
    const node = new FakeNode(world);
    let reads = 0;
    const read = node.networkFacts.bind(node);
    node.networkFacts = async () => { reads += 1; return read(); };
    const gate = new NetworkGate(node, VECTOR_MAINNET);
    await gate.guard();
    await gate.guard();
    expect(reads).toBe(1);
  });
});

describe('the body that is signed', () => {
  it('is the body that was built: a signer that signs another transaction is refused before the submit', async () => {
    const t = await setup();
    const other = await t.world.simplePayment(member.address, 2_500_000n, agent.address);
    const swapping: Signer = { has: () => true, sign: (keyHash) => t.ring.sign(keyHash, other.unsignedCbor) };
    const err = await refusal(landTransaction(t.request, { ...t.io, signer: swapping }));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect((err as GuardRefusal).failures.map((g) => g.guard)).toEqual(['signed_body']);
    expect(t.node.submitted).toEqual([]);
    expect(t.inFlight).toEqual([]);
  });
  it('carries a witness of each key that is needed: a signer that adds none is refused', async () => {
    const t = await setup();
    const lazy: Signer = { has: () => true, sign: (_keyHash, cbor) => cbor };
    const err = await refusal(landTransaction(t.request, { ...t.io, signer: lazy }));
    expect((err as GuardRefusal).failures.map((g) => g.guard)).toEqual(['signed_body']);
    expect(t.node.submitted).toEqual([]);
  });
});

describe('what goes wrong after the signature', () => {
  it('is a refusal of the ledger when the submit API answers with a 4xx: its error and its body are kept, and the transaction cannot land', async () => {
    const t = await setup();
    t.node.submitError = new Error('Transaction submission rejected (400 Bad Request): BadInputsUTxO');
    const err = await refusal(landTransaction(t.request, t.io));
    expect(err).toBeInstanceOf(LandRefused);
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    const refused = err as LandRefused;
    expect(refused.mayLand).toBe(false);
    expect(refused.evaluationError).toContain('BadInputsUTxO');
    expect(refused.transactionBody).toBe(factsOf(t.built.unsignedCbor).bodyHex);
    expect(refused.txHash).toBe(t.built.txHash);
  });
  it('is a transaction that may still land when the submit fails in another way, and it stays in flight', async () => {
    const t = await setup();
    t.node.submitError = new Error('Submit API: network error');
    const err = await refusal(landTransaction(t.request, t.io));
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    expect(err).not.toBeInstanceOf(LandRefused);
    expect((err as TxNotConfirmedError).mayLand).toBe(true);
    expect((err as TxNotConfirmedError).validTo).toBe(t.built.validTo);
    expect(t.inFlight).toHaveLength(1);
  });
  it('is a transaction that is not seen confirmed in time: it may still land, and the wait is the budget of the step', async () => {
    const t = await setup();
    t.node.neverConfirm = true;
    const err = await refusal(landTransaction(t.request, t.io));
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    expect((err as TxNotConfirmedError).mayLand).toBe(true);
    expect(t.clock.t - NOW).toBeGreaterThanOrEqual(30_000);
    expect(t.clock.t - NOW).toBeLessThanOrEqual(35_000);
  });
  it('is a status that cannot be read: the same, and the message says so', async () => {
    const t = await setup();
    t.node.statusError = new Error('Koios: network error');
    const err = await refusal(landTransaction(t.request, t.io));
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    expect((err as TxNotConfirmedError).message).toContain('could not be read');
  });
  it('names the escrow that the transaction made or spent, for the janitor of the kit', async () => {
    const t = await setup();
    t.node.submitError = new Error('Submit API: network error');
    const err = await refusal(landTransaction({ ...t.request, escrow: { ref: `${t.built.txHash}#0`, deliverBy: NOW + 480_000 } }, t.io));
    expect((err as TxNotConfirmedError).escrowRef).toBe(`${t.built.txHash}#0`);
    expect((err as TxNotConfirmedError).deliverBy).toBe(NOW + 480_000);
  });
});
