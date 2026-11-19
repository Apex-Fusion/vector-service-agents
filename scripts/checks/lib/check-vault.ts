// scripts/checks/lib/check-vault.ts - checks 2 and 3: a record pays an agent from a vault of a member.
//
// Check 2 (vault-escrow): the member delegates to the record with a value limit and the action of vault payments; the member opens a vault under that delegation; the hire kit pays the advert
// from the vault with the delegate key, sends the job, verifies the receipt and accepts; the member closes the vault (its Live output and the Returned output that the Accept left) and ends
// the delegation.
// Check 3 (vault-refund): the same, but the job is never sent. The escrow stays Open until its deliver_by. The janitor of the kit reclaims it, and the lock returns to the vault as a
// Returned output. The member closes the Live and the Returned output together and ends the delegation.
//
// The buyer funds the price and both bonds, and the output of the escrow holds the ledger minimum on top. An Accept pays the supplier the price and the supplier bond, and the buyer bond
// returns to the vault as a Returned output. A Reclaim returns the whole lock to the vault.
// Every step is one transaction of the member key, or one call of the hire kit through a `HirePort`; the transactions of the kit are the delegate key's, and they go through the guards of
// the check (guarded-chain.ts). The vault and the delegation are the member's; the record only holds the delegate key. Each check opens its own delegation, because a delegate key can have
// one live delegation at a time: run the checks one after the other.
//
// A hire that stops after a Pay leaves an escrow that may be claimed. The state file keeps the escrow and the vault output that continues (the chain writes each transaction as a part of the
// step when it lands, and the error of the kit is kept too), the check never hires again, and the cleanup waits for deliver_by, reclaims, closes the vault and ends the delegation. A Pay that
// was sent and not seen confirmed leaves no vault reference: the next run settles the transaction in flight first, and the vault is read from the chain before any step uses a reference.
import { iso, units } from './format.ts';
import { requireRecord } from './record.ts';
import { runSteps, verifyStep, waitFor } from './runner.ts';
import type { CheckDefinition, StepHandler } from './runner.ts';
import { PreconditionError, commitStep, stepPlan } from './session.ts';
import type { Session, StepOutcome } from './session.ts';
import { EnvReader } from './settings.ts';
import type { Env } from './settings.ts';
import { HIRE_ACTION, buildDelegate, buildVaultClose, buildVaultOpen, escrowResource } from './platform.ts';
import { endDelegation, liveDelegation } from './check-delegation.ts';
import { DryStop, HireFailed } from './hire-types.ts';
import type { HirePort } from './hire-types.ts';
import type { StepRecord } from './state.ts';
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
  /** The value limit of the delegation: the most that one payment may lock, and the most that all payments of the period may lock. One payment locks the price, both bonds and the ledger minimum. */
  limitLovelace: bigint;
  totalLovelace: bigint;
  /** The most that the price, the supplier bond and the buyer bond of the advert may be. The kit refuses the hire above any of them. */
  maxPriceLovelace: bigint;
  maxSupplierBondLovelace: bigint;
  maxBuyerBondLovelace: bigint;
  /** The text that the agent reads (check 2). */
  payload: string;
}

const UNIT = 1_000_000n;
/** The spending period of the delegation: one day. */
export const PERIOD_MS = 86_400_000;
/** The time after deliver_by at which the check asks the kit to reclaim: it covers the difference between the clock of the machine and the time of the ledger. */
export const RECLAIM_AFTER_MS = 60_000;

export function parseVaultSettings(env: Env): VaultSettings {
  const reader = new EnvReader(env);
  const hours = Number(reader.whole('CHECKS_DELEGATION_HOURS', 1n, 720n, 24n));
  const advertRef = reader.text('CHECKS_ADVERT_REF', true) ?? '';
  if (advertRef !== '' && !/^[0-9a-f]{64}#[0-9]{1,4}$/.test(advertRef)) reader.problems.push('CHECKS_ADVERT_REF must be the reference of the advert: 64 lower case hex characters, #, and the output index');
  const vaultLovelace = reader.whole('CHECKS_VAULT_UNITS', 1n, 1000n, 8n) * UNIT;
  const limitLovelace = reader.whole('CHECKS_VAULT_LIMIT_UNITS', 1n, 1000n, 4n) * UNIT;
  const totalLovelace = reader.whole('CHECKS_VAULT_TOTAL_UNITS', 1n, 1000n, 8n) * UNIT;
  if (limitLovelace > totalLovelace) reader.problems.push('CHECKS_VAULT_LIMIT_UNITS must be at most CHECKS_VAULT_TOTAL_UNITS: the limit of one payment cannot be above the limit of the period');
  if (limitLovelace > vaultLovelace) reader.problems.push('CHECKS_VAULT_LIMIT_UNITS must be at most CHECKS_VAULT_UNITS: a payment cannot be more than the vault holds');
  const maxPriceLovelace = reader.whole('CHECKS_MAX_PRICE_UNITS', 0n, 1000n, 2n) * UNIT;
  const maxSupplierBondLovelace = reader.whole('CHECKS_MAX_SUPPLIER_BOND_UNITS', 0n, 1000n, 1n) * UNIT;
  const maxBuyerBondLovelace = reader.whole('CHECKS_MAX_BUYER_BOND_UNITS', 0n, 1000n, 1n) * UNIT;
  const payload = reader.text('CHECKS_HIRE_PAYLOAD', false) ?? 'Give the history report of the test record for the mainnet checks.';
  reader.done();
  return { hours, advertRef, vaultLovelace, limitLovelace, totalLovelace, maxPriceLovelace, maxSupplierBondLovelace, maxBuyerBondLovelace, payload };
}

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const outputsOf = (answer: Record<string, unknown>): Array<Record<string, unknown>> => (Array.isArray(answer.outputs) ? answer.outputs.map(asRecord) : []);

type Step = StepHandler<VaultSettings>;
type Ses = Session<VaultSettings>;

// ─── What the state file knows of the payment ─────────────────────────────────────────────────────────────────────────────────────

/** What a transaction of the chain leaves in the state file: a step, or the note `part.<name>` of a part of a step. */
type Recorded = Pick<StepRecord, 'tx_hash' | 'refs' | 'facts'>;
const partOf = (session: Ses, name: string): Recorded | undefined => session.state.note(`part.${name}`) as Recorded | undefined;

/** The error of a hire that stopped after a Pay, as the check keeps it. The vault reference is null for a Pay that was sent and not seen confirmed. */
interface AfterPayNote { escrow_ref: string; vault_ref: string | null; deliver_by: number | null; lock_lovelace: bigint | string | null; kind: string }
const afterPayOf = (session: Ses): AfterPayNote | undefined => session.state.note('after_pay') as AfterPayNote | undefined;

/** What the state file knows of the escrow that a Pay opened: from the step pay, from the part hire:pay, or from the error of a hire. Null when no Pay is known. */
interface Paid { escrowRef: string; vaultRef: string | null; deliverBy: number | null; lockLovelace: bigint | null }
function paidFacts(session: Ses): Paid | null {
  const landed: Recorded | undefined = session.state.step('pay') ?? partOf(session, 'hire:pay');
  if (landed !== undefined) {
    const { deliver_by: deliverBy, lock_lovelace: lock } = landed.facts;
    return { escrowRef: landed.refs.escrow_ref!, vaultRef: landed.refs.vault_ref ?? null, deliverBy: deliverBy === undefined ? null : Number(deliverBy), lockLovelace: lock === undefined ? null : BigInt(String(lock)) };
  }
  const note = afterPayOf(session);
  if (note === undefined) return null;
  return { escrowRef: note.escrow_ref, vaultRef: note.vault_ref, deliverBy: note.deliver_by, lockLovelace: note.lock_lovelace === null ? null : BigInt(String(note.lock_lovelace)) };
}

/** The vault reference that the state file holds now: after a hire or a Pay the output that continues, else the output of the open. It is read from the chain before it is used. */
const vaultNow = (session: Ses): string => (session.state.step('hire') ?? session.state.step('pay'))?.refs.vault_ref ?? paidFacts(session)?.vaultRef ?? session.state.step('vault_open')!.refs.vault_ref!;

/**
 * The vault output that a step may spend: the one of the state file when the node holds it, and otherwise the one Live output that the chain shows for the delegation (a Pay that landed
 * while the call was lost spent the old output). More than one or none is a precondition that fails: the vault is read by hand. Nothing reuses a reference blind.
 */
async function liveVaultRef(session: Ses): Promise<string> {
  const expected = vaultNow(session);
  if ((await session.node.resolveInputs([expected])).length === 1) return expected;
  const delegation = session.state.step('delegate')!.refs.delegation_id!;
  const live = await session.chain.liveVaultsOf(delegation, session.clock.now());
  if (live.length === 1) {
    session.out.out(`the vault output ${expected} of the state file is not on the node: the chain shows the vault output ${live[0]!.ref} for the delegation ${delegation}, and the step goes on with it`);
    return live[0]!.ref;
  }
  throw new PreconditionError(`the vault output ${expected} of the state file is not on the node, and the chain shows ${live.length} Live vault outputs for the delegation ${delegation}: read the vault by hand before any step`);
}

/** The Returned outputs that the vault holds from this check: the buyer bond that an Accept returned, and the lock that a Reclaim returned. */
function returnedRefs(session: Ses): string[] {
  const found = [session.state.step('hire')?.refs.returned_ref, partOf(session, 'hire:accept')?.refs.returned_ref, session.state.step('reclaim')?.refs.returned_ref];
  return [...new Set(found.filter((ref): ref is string => ref !== undefined))];
}

/** The escrow that nobody claimed: its ref, its deliver_by and its lock. Null when no Pay is known. */
function stranded(session: Ses): { escrowRef: string; deliverBy: number; lockLovelace: bigint } | null {
  const paid = paidFacts(session);
  if (paid === null) return null;
  if (paid.deliverBy === null || paid.lockLovelace === null) throw new PreconditionError(`the hire paid the escrow ${paid.escrowRef}, and its deliver_by or its lock is not known: read them on the ledger and reclaim by hand`);
  return { escrowRef: paid.escrowRef, deliverBy: paid.deliverBy, lockLovelace: paid.lockLovelace };
}

// ─── The steps ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

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
    const { limitLovelace: limit, totalLovelace: total } = session.extra;
    const context = await session.chain.context(member.address);
    const built = await buildDelegate(context, {
      changeAddress: member.address, nowMs: now, delegator: { type: 'PrincipalKey', hash: member.keyHash }, delegate: record.id, delegateKey: agent.keyHash,
      actions: [HIRE_ACTION], resources: [resource], notAfter, remaining: 0, value: { perTx: limit, total, periodMs: PERIOD_MS },
    });
    const unit = `${deployment.delegation.hash}${built.id}`;
    const facts = {
      delegation_id: built.id, delegator_key_hash: member.keyHash, delegate_id: record.id, delegate_key_hash: agent.keyHash, actions: [HIRE_ACTION], resources: [resource],
      not_after: notAfter, limit_lovelace: limit, total_lovelace: total, period_ms: PERIOD_MS, output_lovelace: built.outputLovelace,
    };
    const request = {
      step: 'delegate', built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
      plan: stepPlan(session, { outflow: { member: built.outputLovelace + session.settings.maxFeeLovelace }, destinations: new Set([deployment.delegation.address]), mint: { [unit]: 1n }, labels: { [deployment.delegation.address]: 'the delegation script' } }),
      refs: { delegation_id: built.id, delegation_output: `${built.txHash}#${built.outputIndex}` }, facts,
      notes: [
        `the member key ${member.keyHash} delegates to the record ${record.did}, and the delegate key ${agent.keyHash} co-signs`,
        `grant: the action ${HIRE_ACTION} on the escrow script, with a limit of ${units(limit)} for each payment and ${units(total)} for each period of ${PERIOD_MS / 3_600_000} hours, until ${iso(notAfter)}`,
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

/** After a Reclaim or an Accept the units are a Returned output of the owner. The hosted tool names it by the owner key hash. */
const returned = (owner: string, ref: string, atLeast: bigint): ToolCheck => ({
  tool: 'vector_get_vault', args: { owner_key_hash: owner },
  problems: (answer) => {
    const output = outputsOf(answer).find((entry) => entry.vault_ref === ref);
    if (output === undefined) return [`the hosted tool shows no Returned output ${ref} for the owner ${owner}`];
    const problems: string[] = [];
    if (output.kind !== 'Returned') problems.push(`the output ${ref} is ${String(output.kind)}, not Returned`);
    if (BigInt(String(output.lovelace ?? '0')) < atLeast) problems.push(`the Returned output ${ref} holds less than ${units(atLeast)}`);
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

type Kit<T> = { kind: 'dry' } | { kind: 'done'; value: T };

/**
 * Calls the kit. A hire is refused after a Pay: the escrow may be claimed, and the hire is never made again. A dry stop is the dry outcome. A hire that stopped after a Pay is kept in the
 * state file, with the vault output that continues when there is one. A hire that may have been claimed (`failed_after_claim`) says so in its message. A call that is not a hire (the
 * reclaim) is made after a Pay by its nature.
 */
async function callKit<T>(session: Ses, call: () => Promise<T>, options: { hiring: boolean }): Promise<Kit<T>> {
  if (options.hiring && paidFacts(session) !== null) throw new PreconditionError('a Pay from the vault is known already and its hire did not end: never hire again. Wait for its deliver_by, then run the cleanup');
  try {
    return { kind: 'done', value: await call() };
  } catch (err) {
    if (err instanceof DryStop) return { kind: 'dry' };
    if (err instanceof HireFailed && options.hiring) {
      const { after } = err;
      if (after !== null) session.state.setNote('after_pay', { escrow_ref: after.escrowRef, vault_ref: after.vaultRef, deliver_by: after.deliverBy, lock_lovelace: after.lockLovelace, kind: err.kind } satisfies AfterPayNote);
      if (err.kind === 'failed_after_claim') {
        throw new Error(`${err.message}. The agent may hold the job and the escrow ${after?.escrowRef ?? ''} may be claimed: do not hire again. Wait for its deliver_by, then run the cleanup: the janitor reclaims it`, { cause: err });
      }
    }
    throw err;
  }
}

/** A hire whose Pay and Accept both landed is recorded from its two parts, when the call that made them did not return: the step is done, and the kit is not called again. */
function hiredFromParts(session: Ses): { pay: Recorded; accept: Recorded } | null {
  const pay = partOf(session, 'hire:pay');
  const accept = partOf(session, 'hire:accept');
  return pay !== undefined && accept !== undefined && session.state.step('hire') === undefined ? { pay, accept } : null;
}

const hire = (makePort: (session: Ses, kind: VaultKind) => HirePort): Step => ({
  name: 'hire',
  async run(session: Ses) {
    const parts = hiredFromParts(session);
    if (parts !== null) {
      const { pay, accept } = parts;
      session.out.out(`the Pay ${pay.tx_hash} and the Accept ${accept.tx_hash} of the hire are confirmed, and the step is recorded from them: the kit is not called again`);
      if (session.mode === 'dry') return { kind: 'dry' };
      session.state.recordStep('hire', {
        confirmed_at: iso(session.clock.now()), tx_hash: accept.tx_hash,
        refs: { escrow_ref: pay.refs.escrow_ref!, vault_ref: pay.refs.vault_ref!, pay_tx: pay.tx_hash!, accept_tx: accept.tx_hash!, ...(accept.refs.returned_ref === undefined ? {} : { returned_ref: accept.refs.returned_ref }) },
        facts: { lock_lovelace: pay.facts.lock_lovelace, advert_ref: pay.facts.advert_ref, recorded_from_parts: true },
      });
      return { kind: 'done', message: 'the hire is recorded from its Pay and its Accept' };
    }
    const port = makePort(session, 'escrow');
    const vaultRef = await liveVaultRef(session);
    session.out.out(`the kit would hire the advert ${session.extra.advertRef} and pay it from the vault ${vaultRef}, send the job, verify the receipt and accept it with the delegate key`);
    session.out.out(`the buyer funds the price and both bonds (the delegation allows ${units(session.extra.limitLovelace)} for one payment); the accept pays the supplier the price and the supplier bond, and the buyer bond returns to the vault`);
    const { advertRef, payload, maxPriceLovelace, maxSupplierBondLovelace, maxBuyerBondLovelace } = session.extra;
    const result = await callKit(session, () => port.hire({ advertRef, payload, vaultRef, maxPriceLovelace, maxSupplierBondLovelace, maxBuyerBondLovelace }), { hiring: true });
    if (result.kind === 'dry') return { kind: 'dry' };
    const done = result.value;
    session.state.recordStep('hire', {
      confirmed_at: iso(session.clock.now()), tx_hash: done.acceptTxHash,
      refs: { escrow_ref: done.escrowRef, vault_ref: done.vaultRef, pay_tx: done.payTxHash, accept_tx: done.acceptTxHash, ...(done.returnedRef === null ? {} : { returned_ref: done.returnedRef }) },
      facts: { lock_lovelace: done.lockLovelace, advert_ref: advertRef, text_length: done.text.length },
    });
    session.evidence.add({ step: 'hire', status: 'confirmed', tx_hash: done.acceptTxHash, shows: { escrow_ref: done.escrowRef, pay_tx: done.payTxHash, accept_tx: done.acceptTxHash, lock_lovelace: done.lockLovelace, vault_ref: done.vaultRef, returned_ref: done.returnedRef } });
    return { kind: 'done', message: `the escrow ${done.escrowRef} was paid from the vault, delivered and accepted (${done.acceptTxHash})` };
  },
  async verify(session: Ses, record) {
    const checks = [liveVault(session.state.step('delegate')!.refs.delegation_id!, record.refs.vault_ref!, 0n)];
    if (record.refs.returned_ref !== undefined) checks.push(returned(session.ring.get('member').keyHash, record.refs.returned_ref, 1n));
    await verifyWithTools(session, 'hire', checks, { vault: record.refs.vault_ref, kind: 'Live', returned: record.refs.returned_ref ?? null });
  },
});

const pay = (makePort: (session: Ses, kind: VaultKind) => HirePort): Step => ({
  name: 'pay',
  async run(session: Ses) {
    const port = makePort(session, 'refund');
    const vaultRef = await liveVaultRef(session);
    session.out.out(`the kit would pay the advert ${session.extra.advertRef} from the vault ${vaultRef} and send no job (the delegation allows ${units(session.extra.limitLovelace)} for one payment)`);
    const { advertRef, maxPriceLovelace, maxSupplierBondLovelace, maxBuyerBondLovelace } = session.extra;
    const result = await callKit(session, () => port.pay({ advertRef, vaultRef, maxPriceLovelace, maxSupplierBondLovelace, maxBuyerBondLovelace }), { hiring: true });
    if (result.kind === 'dry') return { kind: 'dry' };
    const paid = result.value;
    // The guarded chain wrote the step when the Pay landed. A port that did not is recorded here.
    if (session.state.step('pay') === undefined) {
      session.state.recordStep('pay', {
        confirmed_at: iso(session.clock.now()), tx_hash: paid.txHash, refs: { escrow_ref: paid.escrowRef, vault_ref: paid.vaultRef },
        facts: { lock_lovelace: paid.lockLovelace, deliver_by: paid.deliverBy, advert_ref: advertRef },
      });
      session.evidence.add({ step: 'pay', status: 'confirmed', tx_hash: paid.txHash, shows: { escrow_ref: paid.escrowRef, vault_ref: paid.vaultRef, lock_lovelace: paid.lockLovelace, deliver_by: iso(paid.deliverBy) } });
    }
    return { kind: 'done', message: `the escrow ${paid.escrowRef} is paid from the vault; nobody gets a job, and it can be reclaimed after ${iso(paid.deliverBy)}` };
  },
  async verify(session: Ses, record) {
    await verifyWithTools(session, 'pay', [liveVault(session.state.step('delegate')!.refs.delegation_id!, record.refs.vault_ref!, 0n)], { vault: record.refs.vault_ref, kind: 'Live', after: 'payment' });
  },
});

const reclaim = (makePort: (session: Ses, kind: VaultKind) => HirePort, kind: VaultKind): Step => ({
  name: 'reclaim',
  async run(session: Ses) {
    const escrow = stranded(session);
    if (escrow === null) throw new PreconditionError('no escrow was paid from the vault: there is nothing to reclaim');
    const from = escrow.deliverBy + RECLAIM_AFTER_MS;
    if (session.clock.now() < from) return waitFor(from, session.clock.now(), `the escrow ${escrow.escrowRef} can be reclaimed after its deliver_by ${iso(escrow.deliverBy)}`);
    session.out.out(`the janitor of the kit would reclaim the escrow ${escrow.escrowRef}; the lock returns to the vault of the member as a Returned output`);
    const result = await callKit(session, () => makePort(session, kind).reclaim({ escrowRef: escrow.escrowRef, deliverBy: escrow.deliverBy }), { hiring: false });
    if (result.kind === 'dry') return { kind: 'dry' };
    const done = result.value;
    if (session.state.step('reclaim') === undefined) {
      session.state.recordStep('reclaim', {
        confirmed_at: iso(session.clock.now()), tx_hash: done.txHash, refs: { returned_ref: done.returnedRef, escrow_ref: escrow.escrowRef }, facts: { lock_lovelace: escrow.lockLovelace },
      });
      session.evidence.add({ step: 'reclaim', status: 'confirmed', tx_hash: done.txHash, shows: { returned_ref: done.returnedRef } });
    }
    return { kind: 'done', message: `the escrow was reclaimed in ${done.txHash}; the Returned output is ${done.returnedRef}` };
  },
  async verify(session: Ses, record) {
    await verifyWithTools(session, 'reclaim', [returned(session.ring.get('member').keyHash, record.refs.returned_ref!, BigInt(String(record.facts.lock_lovelace)))], { returned_ref: record.refs.returned_ref, kind: 'Returned' });
  },
});

const close: Step = {
  name: 'vault_close',
  async run(session: Ses) {
    const refs = [await liveVaultRef(session), ...returnedRefs(session)];
    const member = session.ring.get('member');
    const context = await session.chain.context(member.address);
    const built = await buildVaultClose(context, { changeAddress: member.address, nowMs: session.clock.now(), vaultRefs: refs });
    const request = {
      step: 'vault_close', built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
      plan: stepPlan(session, { outflow: { member: session.settings.maxFeeLovelace }, explained: new Set(refs) }),
      refs: { delegation_id: session.state.step('delegate')!.refs.delegation_id! }, facts: { closed: refs, total_lovelace: built.totalLovelace },
      notes: [`the member key closes ${refs.length === 1 ? 'the vault' : 'the Live and the Returned outputs'} ${refs.join(', ')}; ${units(built.totalLovelace)} return to the member wallet, less the fee`],
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

/**
 * The unfinished work of a check, from the end: an escrow that nobody claimed is reclaimed when it is due (the run waits until then), then the vault is closed, then the delegation ends.
 * Each step that is owed is run and verified. When the cleanup took something back, the check is ended: it does not go on from a closed vault.
 */
async function finish(session: Ses, reclaimStep: Step): Promise<StepOutcome> {
  const state = session.state;
  const owed: Step[] = [];
  if (state.step('hire') === undefined && state.step('reclaim') === undefined && stranded(session) !== null) owed.push(reclaimStep);
  if (state.step('vault_open') !== undefined && state.step('vault_close') === undefined) owed.push(close);
  if (state.step('delegate') !== undefined && state.step('undelegate') === undefined) owed.push(undelegate);
  if (owed.length === 0) return { kind: 'done', message: 'nothing is left to take back: the vault is closed and the delegation has ended, or neither was made' };
  for (const step of owed) {
    const outcome = await step.run(session, new Set());
    if (outcome.kind !== 'done') return outcome;
    session.out.out(outcome.message);
    await verifyStep(session, step, state.step(step.name)!);
  }
  state.setNote('cleaned_up', iso(session.clock.now()));
  return { kind: 'done', message: 'nothing stays locked: the vault is closed and the delegation has ended' };
}

export function vaultCheck(kind: VaultKind, makePort: (session: Ses, kind: VaultKind) => HirePort): CheckDefinition<VaultSettings> {
  const reclaimStep = reclaim(makePort, kind);
  const steps: Step[] = kind === 'escrow' ? [delegate, open, hire(makePort), close, undelegate] : [delegate, open, pay(makePort), reclaimStep, close, undelegate];
  return {
    name: kind === 'escrow' ? 'vault-escrow' : 'vault-refund',
    title: kind === 'escrow' ? 'the record pays an agent from the vault of a member, the job is done and accepted' : 'the record pays an agent from the vault of a member, no job is sent, and the lock returns to the vault',
    needs: { keys: ['controller', 'agent', 'member'], chain: true, hosted: ['vector_get_delegation', 'vector_get_vault'] },
    steps: steps.map((step) => step.name),
    parse: (env) => parseVaultSettings(env),
    next: (session, flags) => {
      if (session.state.note('cleaned_up') !== undefined) throw new PreconditionError('the cleanup of this check took back the vault and the delegation and ended the check: use a new CHECKS_STATE_DIR for a new run');
      return runSteps(session, steps, flags);
    },
    cleanup: (session) => finish(session, reclaimStep),
  };
}
