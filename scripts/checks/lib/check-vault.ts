// scripts/checks/lib/check-vault.ts - checks 2 and 3: a record pays an agent from a vault of a member.
//
// Check 2 (vault-escrow): the member delegates to the record with a value limit and the action of vault payments; the member opens a vault under that delegation; the hire kit pays the advert
// from the vault with the delegate key, sends the job, verifies the receipt and accepts; the member closes the vault and ends the delegation.
// Check 3 (vault-refund): the same, but the job is never sent. The escrow stays Open until its deliver_by. The janitor of the kit reclaims it, and the lock returns to the vault as a
// Returned output. The member closes the Live and the Returned output together and ends the delegation.
//
// Every step is one transaction of the member key or of the delegate key, or one call of the hire kit through a `HirePort`. The vault and the delegation are the member's; the record only
// holds the delegate key. Each check opens its own delegation, because a delegate key can have one live delegation at a time: run the checks one after the other.
import { iso, units } from './format.ts';
import { requireRecord } from './record.ts';
import { runSteps, verifyStep, waitFor } from './runner.ts';
import type { CheckDefinition, StepHandler } from './runner.ts';
import { commitStep, stepPlan } from './session.ts';
import type { Session, StepOutcome } from './session.ts';
import { EnvReader } from './settings.ts';
import type { Env } from './settings.ts';
import { HIRE_ACTION, buildDelegate, buildVaultClose, buildVaultOpen, escrowResource } from './platform.ts';
import { endDelegation, liveDelegation } from './check-delegation.ts';
import type { HirePort } from './hire-types.ts';
import { verifyWithTools } from './verify.ts';
import type { ToolCheck } from './verify.ts';

export type VaultKind = 'escrow' | 'refund';

export interface VaultSettings {
  /** How long the delegation lasts, in hours. */
  hours: number;
  /** The advert of the agent that is hired. */
  advertRef: string;
  /** What the vault locks, in lovelace. */
  vaultLovelace: bigint;
  /** The most that one payment, and all payments of the period, may lock: the value limit of the delegation. */
  limitLovelace: bigint;
  /** The text that the agent reads (check 2). */
  payload: string;
}

const UNIT = 1_000_000n;
/** The spending period of the delegation: one day. Each check makes one payment. */
export const PERIOD_MS = 86_400_000;
/** The time after deliver_by at which the check asks the kit to reclaim: it covers the difference between the clock of the machine and the time of the ledger. */
export const RECLAIM_AFTER_MS = 60_000;

export function parseVaultSettings(env: Env): VaultSettings {
  const reader = new EnvReader(env);
  const hours = Number(reader.whole('CHECKS_DELEGATION_HOURS', 1n, 720n, 24n));
  const advertRef = reader.text('CHECKS_ADVERT_REF', true) ?? '';
  if (advertRef !== '' && !/^[0-9a-f]{64}#[0-9]{1,4}$/.test(advertRef)) reader.problems.push('CHECKS_ADVERT_REF must be the reference of the advert: 64 lower case hex characters, #, and the output index');
  const vaultLovelace = reader.whole('CHECKS_VAULT_UNITS', 1n, 1000n, 6n) * UNIT;
  const limitLovelace = reader.whole('CHECKS_VAULT_LIMIT_UNITS', 1n, 1000n, 3n) * UNIT;
  if (limitLovelace > vaultLovelace) reader.problems.push('CHECKS_VAULT_LIMIT_UNITS must be at most CHECKS_VAULT_UNITS: a payment cannot be more than the vault holds');
  const payload = reader.text('CHECKS_HIRE_PAYLOAD', false) ?? 'Give the history report of the test record for the mainnet checks.';
  reader.done();
  return { hours, advertRef, vaultLovelace, limitLovelace, payload };
}

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const outputsOf = (answer: Record<string, unknown>): Array<Record<string, unknown>> => (Array.isArray(answer.outputs) ? answer.outputs.map(asRecord) : []);

type Step = StepHandler<VaultSettings>;
type Ses = Session<VaultSettings>;

const delegate: Step = {
  name: 'delegate',
  async run(session: Ses) {
    const record = await requireRecord(session, { delegationKey: true });
    const member = session.ring.get('member');
    const agent = session.ring.get('agent');
    const now = session.clock.now();
    const notAfter = now + session.extra.hours * 3_600_000;
    const deployment = session.chain.deployment;
    const resource = escrowResource(deployment.escrow.hash);
    const limit = session.extra.limitLovelace;
    const context = await session.chain.context(member.address);
    const built = await buildDelegate(context, {
      changeAddress: member.address, nowMs: now, delegator: { type: 'PrincipalKey', hash: member.keyHash }, delegate: record.id, delegateKey: agent.keyHash,
      actions: [HIRE_ACTION], resources: [resource], notAfter, remaining: 0, value: { perTx: limit, total: limit, periodMs: PERIOD_MS },
    });
    const unit = `${deployment.delegation.hash}${built.id}`;
    const facts = {
      delegation_id: built.id, delegator_key_hash: member.keyHash, delegate_id: record.id, delegate_key_hash: agent.keyHash, actions: [HIRE_ACTION], resources: [resource],
      not_after: notAfter, limit_lovelace: limit, period_ms: PERIOD_MS, output_lovelace: built.outputLovelace,
    };
    const request = {
      step: 'delegate', built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
      plan: stepPlan(session, { outflow: { member: built.outputLovelace + session.settings.maxFeeLovelace }, destinations: new Set([deployment.delegation.address]), mint: { [unit]: 1n }, labels: { [deployment.delegation.address]: 'the delegation script' } }),
      refs: { delegation_id: built.id, delegation_output: `${built.txHash}#${built.outputIndex}` }, facts,
      notes: [
        `the member key ${member.keyHash} delegates to the record ${record.did}, and the delegate key ${agent.keyHash} co-signs`,
        `grant: the action ${HIRE_ACTION} on the escrow script, with a limit of ${units(limit)} for each payment and ${units(limit)} for each period of ${PERIOD_MS / 3_600_000} hours, until ${iso(notAfter)}`,
        `deposit: the delegation output holds ${units(built.outputLovelace)}; the step undelegate returns it to the member wallet`,
      ],
    };
    const landed = await session.land(request);
    if (landed.kind === 'dry') return { kind: 'dry' };
    commitStep(session, request, landed, { delegation: built.id, ...facts });
    return { kind: 'done', message: `the delegation ${built.id} is confirmed in ${landed.txHash}` };
  },
  async verify(session: Ses, record) {
    await verifyWithTools(session, 'delegate', [liveDelegation(record.refs.delegation_id!, record.facts)], { delegation: record.refs.delegation_id, live: true });
  },
};

/** The Live output of the vault of the delegation must be the one that the step gave, with at least the units that it holds. */
const liveVault = (delegation: string, ref: string, atLeast: bigint): ToolCheck => ({
  tool: 'vector_get_vault', args: { delegation },
  problems: (answer) => {
    const live = outputsOf(answer).find((output) => output.vault_ref === ref);
    if (live === undefined) return [`the hosted tool shows no vault output ${ref} for the delegation ${delegation}`];
    const problems: string[] = [];
    if (live.kind !== 'Live') problems.push(`the vault output ${ref} is ${String(live.kind)}, not Live`);
    if (BigInt(String(live.lovelace ?? '0')) < atLeast) problems.push(`the vault output ${ref} holds less than ${units(atLeast)}`);
    return problems;
  },
});

const open: Step = {
  name: 'vault_open',
  async run(session: Ses) {
    const delegation = session.state.step('delegate')!.refs.delegation_id!;
    const member = session.ring.get('member');
    const context = await session.chain.context(member.address);
    const built = await buildVaultOpen(context, { changeAddress: member.address, nowMs: session.clock.now(), delegation, amountLovelace: session.extra.vaultLovelace });
    const deployment = session.chain.deployment;
    const request = {
      step: 'vault_open', built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
      plan: stepPlan(session, { outflow: { member: built.amountLovelace + session.settings.maxFeeLovelace }, destinations: new Set([deployment.vault.address]), labels: { [deployment.vault.address]: 'the vault script' } }),
      refs: { vault_ref: built.vaultRef, delegation_id: delegation }, facts: { amount_lovelace: built.amountLovelace },
      notes: [`the member key opens a vault with ${units(built.amountLovelace)} under the delegation ${delegation}; only the delegate key of the record can pay from it, within the limit`, `the step vault_close takes the units back to the member wallet`],
    };
    const landed = await session.land(request);
    if (landed.kind === 'dry') return { kind: 'dry' };
    commitStep(session, request, landed, { vault: built.vaultRef, amount_lovelace: built.amountLovelace });
    return { kind: 'done', message: `the vault ${built.vaultRef} is confirmed in ${landed.txHash}` };
  },
  async verify(session: Ses, record) {
    await verifyWithTools(session, 'vault_open', [liveVault(record.refs.delegation_id!, record.refs.vault_ref!, BigInt(String(record.facts.amount_lovelace)))], { vault: record.refs.vault_ref, kind: 'Live' });
  },
};

/** The vault ref now: the one that the last payment or the open gave. */
const vaultNow = (session: Ses): string => session.state.step('hire')?.refs.vault_ref ?? session.state.step('pay')?.refs.vault_ref ?? session.state.step('vault_open')!.refs.vault_ref!;

const hire = (makePort: (session: Ses) => HirePort): Step => ({
  name: 'hire',
  async run(session: Ses) {
    const port = makePort(session);
    session.out.out(`the kit would hire the advert ${session.extra.advertRef} and pay it from the vault ${vaultNow(session)}, send the job, verify the receipt and accept it with the delegate key`);
    if (session.mode === 'dry') {
      session.out.out('a dry run builds no payment: the kit makes it only with --submit');
      return { kind: 'dry' };
    }
    const done = await port.hire({ advertRef: session.extra.advertRef, payload: session.extra.payload, vaultRef: vaultNow(session) });
    session.state.recordStep('hire', {
      confirmed_at: iso(session.clock.now()), tx_hash: done.acceptTxHash, refs: { escrow_ref: done.escrowRef, vault_ref: done.vaultRef, pay_tx: done.payTxHash, accept_tx: done.acceptTxHash },
      facts: { lock_lovelace: done.lockLovelace, advert_ref: session.extra.advertRef, text_length: done.text.length },
    });
    session.evidence.add({ step: 'hire', status: 'confirmed', tx_hash: done.acceptTxHash, shows: { escrow_ref: done.escrowRef, pay_tx: done.payTxHash, accept_tx: done.acceptTxHash, lock_lovelace: done.lockLovelace, vault_ref: done.vaultRef } });
    return { kind: 'done', message: `the escrow ${done.escrowRef} was paid from the vault, delivered and accepted (${done.acceptTxHash})` };
  },
  async verify(session: Ses, record) {
    await verifyWithTools(session, 'hire', [liveVault(session.state.step('delegate')!.refs.delegation_id!, record.refs.vault_ref!, 0n)], { vault: record.refs.vault_ref, kind: 'Live', after: 'payment' });
  },
});

const pay = (makePort: (session: Ses) => HirePort): Step => ({
  name: 'pay',
  async run(session: Ses) {
    const port = makePort(session);
    session.out.out(`the kit would pay the advert ${session.extra.advertRef} from the vault ${vaultNow(session)} and send no job`);
    if (session.mode === 'dry') return { kind: 'dry' };
    const paid = await port.pay({ advertRef: session.extra.advertRef, vaultRef: vaultNow(session) });
    session.state.recordStep('pay', {
      confirmed_at: iso(session.clock.now()), tx_hash: paid.txHash, refs: { escrow_ref: paid.escrowRef, vault_ref: paid.vaultRef },
      facts: { lock_lovelace: paid.lockLovelace, deliver_by: paid.deliverBy, advert_ref: session.extra.advertRef },
    });
    session.evidence.add({ step: 'pay', status: 'confirmed', tx_hash: paid.txHash, shows: { escrow_ref: paid.escrowRef, vault_ref: paid.vaultRef, lock_lovelace: paid.lockLovelace, deliver_by: iso(paid.deliverBy) } });
    return { kind: 'done', message: `the escrow ${paid.escrowRef} is paid from the vault; nobody gets a job, and it can be reclaimed after ${iso(paid.deliverBy)}` };
  },
  async verify(session: Ses, record) {
    await verifyWithTools(session, 'pay', [liveVault(session.state.step('delegate')!.refs.delegation_id!, record.refs.vault_ref!, 0n)], { vault: record.refs.vault_ref, kind: 'Live', after: 'payment' });
  },
});

/** After the Reclaim the lock is a Returned output of the owner. The hosted tool names it by the owner key hash. */
const returned = (owner: string, ref: string, atLeast: bigint): ToolCheck => ({
  tool: 'vector_get_vault', args: { owner_key_hash: owner },
  problems: (answer) => {
    const output = outputsOf(answer).find((entry) => entry.vault_ref === ref);
    if (output === undefined) return [`the hosted tool shows no Returned output ${ref} for the owner ${owner}`];
    const problems: string[] = [];
    if (output.kind !== 'Returned') problems.push(`the output ${ref} is ${String(output.kind)}, not Returned`);
    if (BigInt(String(output.lovelace ?? '0')) < atLeast) problems.push(`the Returned output ${ref} holds less than the lock of ${units(atLeast)}`);
    return problems;
  },
});

const reclaim = (makePort: (session: Ses) => HirePort): Step => ({
  name: 'reclaim',
  async run(session: Ses) {
    const paid = session.state.step('pay')!;
    const deliverBy = Number(paid.facts.deliver_by);
    const from = deliverBy + RECLAIM_AFTER_MS;
    if (session.clock.now() < from) return waitFor(from, session.clock.now(), `the escrow ${paid.refs.escrow_ref} can be reclaimed after its deliver_by ${iso(deliverBy)}`);
    session.out.out(`the janitor of the kit would reclaim the escrow ${paid.refs.escrow_ref}; the lock returns to the vault of the member as a Returned output`);
    if (session.mode === 'dry') return { kind: 'dry' };
    const done = await makePort(session).reclaim(paid.refs.escrow_ref!);
    session.state.recordStep('reclaim', {
      confirmed_at: iso(session.clock.now()), tx_hash: done.txHash, refs: { returned_ref: done.returnedRef, escrow_ref: paid.refs.escrow_ref! }, facts: { lock_lovelace: paid.facts.lock_lovelace },
    });
    session.evidence.add({ step: 'reclaim', status: 'confirmed', tx_hash: done.txHash, shows: { returned_ref: done.returnedRef } });
    return { kind: 'done', message: `the escrow was reclaimed in ${done.txHash}; the Returned output is ${done.returnedRef}` };
  },
  async verify(session: Ses, record) {
    await verifyWithTools(session, 'reclaim', [returned(session.ring.get('member').keyHash, record.refs.returned_ref!, BigInt(String(record.facts.lock_lovelace)))], { returned_ref: record.refs.returned_ref, kind: 'Returned' });
  },
});

const close: Step = {
  name: 'vault_close',
  async run(session: Ses) {
    const refs = [vaultNow(session), ...(session.state.step('reclaim') === undefined ? [] : [session.state.step('reclaim')!.refs.returned_ref!])];
    const member = session.ring.get('member');
    const context = await session.chain.context(member.address);
    const built = await buildVaultClose(context, { changeAddress: member.address, nowMs: session.clock.now(), vaultRefs: refs });
    const request = {
      step: 'vault_close', built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
      plan: stepPlan(session, { outflow: { member: session.settings.maxFeeLovelace }, explained: new Set(refs) }),
      refs: { delegation_id: session.state.step('delegate')!.refs.delegation_id! }, facts: { closed: refs, total_lovelace: built.totalLovelace },
      notes: [`the member key closes ${refs.length === 1 ? 'the vault' : 'the Live and the Returned output'} ${refs.join(', ')}; ${units(built.totalLovelace)} return to the member wallet, less the fee`],
    };
    const landed = await session.land(request);
    if (landed.kind === 'dry') return { kind: 'dry' };
    commitStep(session, request, landed, { closed: refs, total_lovelace: built.totalLovelace });
    return { kind: 'done', message: `the vault is closed in ${landed.txHash}: ${units(built.totalLovelace)} are back in the member wallet` };
  },
  async verify(session: Ses, record) {
    const closed = (record.facts.closed as string[]) ?? [];
    await verifyWithTools(session, 'vault_close', [{
      tool: 'vector_get_vault', args: { delegation: record.refs.delegation_id! },
      problems: (answer) => outputsOf(answer).filter((output) => closed.includes(String(output.vault_ref))).map((output) => `the hosted tool still shows the vault output ${String(output.vault_ref)}`),
    }], { closed });
  },
};

const undelegate: Step = {
  name: 'undelegate',
  run: (session: Ses) => endDelegation(session),
  async verify(session: Ses, record) {
    await verifyWithTools(session, 'undelegate', [{
      tool: 'vector_get_delegation', args: { delegation: record.refs.delegation_id! },
      problems: (answer) => (answer.live === false ? [] : [`the hosted tool still shows the delegation ${record.refs.delegation_id!} as live`]),
    }], { delegation: record.refs.delegation_id, live: false });
  },
};

/** The unfinished work of a check, from the end: the vault and then the delegation. A refund that is not reclaimed is reclaimed first, when it is due. */
async function finish(session: Ses, steps: readonly Step[]): Promise<StepOutcome> {
  const state = session.state;
  const todo = (name: string, needs: string, ready: boolean): Step | null => (state.step(needs) !== undefined && state.step(name) === undefined && ready ? steps.find((s) => s.name === name)! : null);
  const owed: Array<Step | null> = [
    todo('reclaim', 'pay', steps.some((s) => s.name === 'reclaim')),
    todo('vault_close', 'vault_open', true),
    todo('undelegate', 'delegate', true),
  ];
  const run = owed.filter((step): step is Step => step !== null);
  if (run.length === 0) return { kind: 'done', message: 'nothing is left to take back: the vault is closed and the delegation has ended, or neither was made' };
  let outcome: StepOutcome = { kind: 'done', message: '' };
  for (const step of run) {
    outcome = await step.run(session, new Set());
    if (outcome.kind !== 'done') return outcome;
    session.out.out(outcome.message);
    await verifyStep(session, step, state.step(step.name)!);
  }
  return { kind: 'done', message: 'nothing stays locked: the vault is closed and the delegation has ended' };
}

export function vaultCheck(kind: VaultKind, makePort: (session: Ses) => HirePort): CheckDefinition<VaultSettings> {
  const steps: Step[] = kind === 'escrow' ? [delegate, open, hire(makePort), close, undelegate] : [delegate, open, pay(makePort), reclaim(makePort), close, undelegate];
  return {
    name: kind === 'escrow' ? 'vault-escrow' : 'vault-refund',
    title: kind === 'escrow' ? 'the record pays an agent from the vault of a member, the job is done and accepted' : 'the record pays an agent from the vault of a member, no job is sent, and the lock returns to the vault',
    needs: { keys: ['controller', 'agent', 'member'], chain: true, hosted: ['vector_get_delegation', 'vector_get_vault'] },
    steps: steps.map((step) => step.name),
    parse: (env) => parseVaultSettings(env),
    next: (session, flags) => runSteps(session, steps, flags),
    cleanup: (session) => finish(session, steps),
  };
}
