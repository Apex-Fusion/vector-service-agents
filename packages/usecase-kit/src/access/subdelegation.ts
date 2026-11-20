// packages/usecase-kit/src/access/subdelegation.ts
// The sub-delegation of an agent to a subagent, for one job. An agent that reads a mock system through a subagent gives the subagent a delegation of its own: one action on one resource, one hop
// below the delegation that the hirer gave to the agent. `withSubDelegation` makes it, waits until the gateway can issue a token under it, runs the job of the caller, and ENDS it in a `finally`
// path: after a success, a refusal, a failure, a throw of the job, a timeout of the job, and a timeout of the wait. It returns what the job returned together with the result of the end step.
//
// The sub-delegation is narrow by construction, and the caller cannot widen it: `remaining` is 0 (the subagent cannot delegate again), the value limit is `{ per_tx: 0, total: 0 }` with the period of
// the parent, and the validity is inside the validity of the parent and ends within `validForMs`. The build is checked again before it is signed, so a builder that gives a wider delegation never
// gets a signature. A sub-delegation that is not ended still ends by itself at its `notAfter`, and the result gives the reference that a janitor needs to end it earlier.
//
// What it costs and locks, from the builders: the Delegate makes one output at the delegation address that holds the ledger minimum for its datum (`DelegateBuild.outputLovelace`). The agent pays
// that deposit and the fee of the transaction from the wallet of its live delegation key. The Undelegate returns the deposit to that wallet, less its own fee.
import { isAction, isResource, type DelegateBuild, type DelegateParams, type UndelegateBuild, type UndelegateParams } from '@vsa/buyer-core';
import { accepted, parseDelegationId, parseDid, refused, type Accepted, type DelegationId, type Did, type Refused } from '../protocol/index.ts';
import { MAX_WAIT_MS, within, type Clock } from './ports.ts';
import type { TokenTarget } from './routes.ts';
import { errorText, safeText } from './text.ts';

/** The confirmations that the gateway wants for every delegation of a chain, before it issues a token under it. */
export const CONFIRMATIONS_REQUIRED = 30;
/** The shortest validity that a sub-delegation gets, in milliseconds. A parent that ends sooner gives `parent_expiring`. */
export const MIN_SUB_DELEGATION_MS = 300_000;
/** The longest validity that a caller can ask for, in milliseconds: one day. */
export const MAX_SUB_DELEGATION_MS = 86_400_000;
export const DEFAULT_CONFIRMATION_WAIT_MS = 360_000;
export const DEFAULT_POLL_MS = 5_000;
export const DEFAULT_END_TIMEOUT_MS = 120_000;

/** The datum of a delegation as the builders of the ledger give it. */
export type DelegationDatum = DelegateBuild['delegation'];

/** A delegation that the ledger shows as live. */
export interface LiveDelegation {
  readonly id: string;
  readonly delegation: DelegationDatum;
}

/** Whether the gateway can issue a token under a delegation now. */
export type Readiness =
  /** Every delegation of the chain has 30 confirmations or more, and the chain is usable for the action and the resource. */
  | { readonly state: 'ready' }
  /** The delegation is not usable yet because it has fewer than 30 confirmations, or the ledger does not show it yet. `confirmations` is the least depth of the chain, or null when it is not known. */
  | { readonly state: 'waiting'; readonly confirmations: number | null }
  /** The chain is not usable for another reason that time does not change: for example a delegate that is not Active. */
  | { readonly state: 'unusable'; readonly problems: readonly string[] };

/**
 * What a sub-delegation needs from the ledger. The builders are the ones of `@vsa/buyer-core` (`buildDelegate` and `buildUndelegate` over an `IdentityContext`), and the reads are its
 * `readDelegation` and `checkDelegationUse` with `minConfirmations: 30`. A method throws when the ledger cannot be read or the node refuses; the throw is never taken as a pass.
 */
export interface DelegationChain {
  /** The live delegation `id`, or null when the ledger shows none: it never existed, or it ended. */
  readDelegation(id: string): Promise<LiveDelegation | null>;
  /** Can the gateway issue a token under `id` for this action and this resource at `atMs`? */
  readiness(id: string, route: { readonly action: string; readonly resource: string }, atMs: number): Promise<Readiness>;
  buildDelegate(params: DelegateParams): Promise<DelegateBuild>;
  buildUndelegate(params: UndelegateParams): Promise<UndelegateBuild>;
  /** Sends a signed transaction to the node. */
  submit(signedCborHex: string): Promise<string>;
}

/** A key that signs a transaction. */
export interface TxSigner {
  /** The hash of the public key: 56 lower-case hex characters. */
  readonly keyHash: string;
  /** The transaction with the witness of this key added. The body stays as it is. */
  sign(txCborHex: string): string;
}

export interface SubDelegationDeps {
  readonly chain: DelegationChain;
  readonly clock: Clock;
  /**
   * Called with the reference of the sub-delegation just BEFORE the Delegate is sent, so that a crash of the process cannot leave a sub-delegation that no record names. Write the reference to the
   * store of the janitor here, and remove it when the run gives `end.state` of `ended` or `not_made`. A hook that throws stops the run with `journal_failed`: nothing is sent.
   */
  readonly beforeSend?: (reference: LeftSubDelegation) => void | Promise<void>;
}

export interface SubDelegationRequest {
  /** The route that the subagent reads. It gives the one action and the one resource of the sub-delegation. A route that takes the agent only is refused. */
  readonly target: TokenTarget;
  /** The delegation that the hirer gave to this agent. The sub-delegation is one hop below it. */
  readonly parent: DelegationId;
  /** The agent: its live delegation key (the delegate key of the parent), which signs the Delegate and the Undelegate, and the address of its wallet, which pays the fees and gets the deposit back. */
  readonly agent: { readonly signer: TxSigner; readonly walletAddress: string };
  /** The subagent: its DID and its delegation key, which is the delegate key of the sub-delegation. */
  readonly subagent: { readonly did: Did; readonly signer: TxSigner };
  /** How long the sub-delegation lasts at most, in milliseconds from now. It also ends at the end of the parent. From MIN_SUB_DELEGATION_MS to MAX_SUB_DELEGATION_MS. */
  readonly validForMs: number;
}

export interface SubDelegationLimits {
  /** The longest time that the job runs, in milliseconds. A job that is slower is not waited for, and the sub-delegation is ended. */
  readonly jobTimeoutMs: number;
  /** The longest wait for the confirmations. The default is DEFAULT_CONFIRMATION_WAIT_MS. */
  readonly confirmationWaitMs?: number;
  /** The time between two reads of the ledger. The default is DEFAULT_POLL_MS. */
  readonly pollMs?: number;
  /** The longest time of the end step: the Undelegate, and the wait until the ledger shows it. The default is DEFAULT_END_TIMEOUT_MS. */
  readonly endTimeoutMs?: number;
}

/** What the job gets. */
export interface SubDelegationHandle {
  /** The identifier of the sub-delegation: the `subDelegation` of the token request of the subagent. */
  readonly id: DelegationId;
  readonly parent: DelegationId;
  readonly target: TokenTarget;
  /** When the sub-delegation ends by itself, in POSIX milliseconds. */
  readonly notAfter: number;
  /** Aborts when the job time ends. A job that makes a call passes it on, so that the call stops. */
  readonly signal: AbortSignal;
}

export const SUB_DELEGATION_FAILURES = [
  'bad_request', 'parent_unreadable', 'parent_not_live', 'parent_exhausted', 'parent_expiring', 'build_refused', 'build_mismatch', 'missing_signer', 'sign_failed', 'submit_failed',
  'confirmation_timeout', 'ledger_unreadable', 'sub_delegation_unusable', 'journal_failed', 'internal',
] as const;
export type SubDelegationFailureCode = (typeof SUB_DELEGATION_FAILURES)[number];
/** Why the job did not start. The error code of the protocol for a buyer-side agent is `failed`, with this code as the reason. */
export type SubDelegationFailure = Refused<SubDelegationFailureCode>;

/** A sub-delegation that this folder sent to the node and did not see ended. A janitor ends it later with the Undelegate; the key of the agent signs. */
export interface LeftSubDelegation {
  readonly id: DelegationId;
  readonly parent: DelegationId;
  readonly action: string;
  readonly resource: string;
  /** The hash of the Delegate transaction. */
  readonly delegateTxHash: string;
  /** The end of the validity of the Delegate transaction, in POSIX milliseconds. A Delegate that is not on the ledger by then never lands. */
  readonly delegateValidTo: number;
  /** When the delegation ends by itself, in POSIX milliseconds. */
  readonly notAfter: number;
  /** The hash of the Undelegate that was sent, or null when none was sent. */
  readonly endTxHash: string | null;
}

export type SubDelegationEnd =
  /** Nothing was sent to the node, so there is nothing to end. */
  | { readonly state: 'not_made' }
  /** The ledger no longer shows the sub-delegation. `txHash` is the Undelegate. */
  | { readonly state: 'ended'; readonly txHash: string }
  /** The sub-delegation may be alive. `left` is what a janitor needs. `end_failed`: the Undelegate was not sent. `end_unconfirmed`: it was sent, or the time ran out, and the ledger still shows the sub-delegation. */
  | { readonly state: 'not_ended'; readonly code: 'end_failed' | 'end_unconfirmed'; readonly detail: string; readonly left: LeftSubDelegation };

/**
 * What the job and the wait gave. `end` is added to it in `SubDelegationRun`.
 * - `returned`: the job returned `value`. This says nothing about what the value means: a refusal that the job found is in `value`.
 * - `threw`: the job threw `error`. It is the error of the job, unchanged.
 * - `timed_out`: the job did not end within `jobTimeoutMs`.
 * - `not_ready`: the sub-delegation was not made, or no token could be issued under it before the wait ended. The job did not run.
 */
export type SubDelegationOutcome<T> =
  | { readonly ok: true; readonly kind: 'returned'; readonly value: T }
  | { readonly ok: false; readonly kind: 'threw'; readonly error: unknown }
  | { readonly ok: false; readonly kind: 'timed_out' }
  | { readonly ok: false; readonly kind: 'not_ready'; readonly failure: SubDelegationFailure };

/** What `withSubDelegation` gives back. `end` is always there. A caller that gets `not_ended` hands `left` to its janitor. */
export type SubDelegationRun<T> = SubDelegationOutcome<T> & { readonly end: SubDelegationEnd };

interface Plan {
  readonly target: TokenTarget;
  readonly parent: DelegationId;
  readonly subagentId: string;
  readonly agentSigner: TxSigner;
  readonly subagentSigner: TxSigner;
  readonly walletAddress: string;
  readonly validForMs: number;
  readonly jobTimeoutMs: number;
  readonly confirmationWaitMs: number;
  readonly pollMs: number;
  readonly endTimeoutMs: number;
}

const KEY_HASH = /^[0-9a-f]{56}$/;
const NOT_MADE: SubDelegationEnd = { state: 'not_made' };
const hexOf = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const isWhole = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function signerProblem(signer: unknown, field: string): string | null {
  if (typeof signer !== 'object' || signer === null) return `${field} must be a signer`;
  const { keyHash, sign } = signer as { keyHash?: unknown; sign?: unknown };
  if (typeof keyHash !== 'string' || !KEY_HASH.test(keyHash)) return `${field}.keyHash must be 56 lower-case hex characters`;
  return typeof sign === 'function' ? null : `${field}.sign must be a function`;
}

/** The plan of a request, or the first rule that it breaks. Nothing is sent before this passes. */
function planOf(request: SubDelegationRequest, limits: SubDelegationLimits): Accepted<Plan> | SubDelegationFailure {
  const bad = (detail: string): SubDelegationFailure => refused('bad_request', detail);
  const { target } = request;
  if (target.callers !== 'agent-or-subagent') return bad(`the route ${String(target.route)} takes the agent only: a subagent gets no delegation for it`);
  if (!isAction(target.action)) return bad('the action of the route is not an action of the delegation rules');
  if (!isResource(target.resource)) return bad('the resource of the route is not a resource of the delegation rules: it must be an https URL');
  const parent = parseDelegationId(request.parent, 'parent');
  if (!parent.ok) return bad(parent.detail);
  const subagent = parseDid(request.subagent.did, 'subagent.did');
  if (!subagent.ok) return bad(subagent.detail);
  const problem = signerProblem(request.agent.signer, 'agent.signer') ?? signerProblem(request.subagent.signer, 'subagent.signer');
  if (problem !== null) return bad(problem);
  if (request.agent.signer.keyHash === request.subagent.signer.keyHash) return bad('the agent and the subagent must have two delegation keys');
  if (typeof request.agent.walletAddress !== 'string' || request.agent.walletAddress.length < 1) return bad('agent.walletAddress must be the address of the wallet of the delegation key');
  if (!isWhole(request.validForMs, MIN_SUB_DELEGATION_MS, MAX_SUB_DELEGATION_MS)) return bad(`validForMs must be a whole number from ${MIN_SUB_DELEGATION_MS} to ${MAX_SUB_DELEGATION_MS}`);
  const confirmationWaitMs = limits.confirmationWaitMs === undefined ? DEFAULT_CONFIRMATION_WAIT_MS : limits.confirmationWaitMs;
  const pollMs = limits.pollMs === undefined ? DEFAULT_POLL_MS : limits.pollMs;
  const endTimeoutMs = limits.endTimeoutMs === undefined ? DEFAULT_END_TIMEOUT_MS : limits.endTimeoutMs;
  if (!isWhole(limits.jobTimeoutMs, 1, MAX_WAIT_MS)) return bad(`jobTimeoutMs must be a whole number from 1 to ${MAX_WAIT_MS}`);
  if (!isWhole(confirmationWaitMs, 1, MAX_WAIT_MS) || !isWhole(pollMs, 1, MAX_WAIT_MS) || !isWhole(endTimeoutMs, 1, MAX_WAIT_MS)) return bad(`confirmationWaitMs, pollMs and endTimeoutMs must be whole numbers from 1 to ${MAX_WAIT_MS}`);
  return accepted({
    target, parent: parent.value, subagentId: subagent.value.slice('did:vector:'.length), agentSigner: request.agent.signer, subagentSigner: request.subagent.signer,
    walletAddress: request.agent.walletAddress, validForMs: request.validForMs, jobTimeoutMs: limits.jobTimeoutMs, confirmationWaitMs, pollMs, endTimeoutMs,
  });
}

/** The first way in which a build is not the narrow sub-delegation that was asked for, or null. The build is checked after the builder made it, and before any key signs. */
function buildProblem(built: DelegateBuild, plan: Plan, parent: DelegationDatum, notAfter: number, periodMs: number): string | null {
  const d = built.delegation;
  const only = (items: readonly string[], text: string): boolean => items.length === 1 && items[0] === hexOf(text);
  if (!/^[0-9a-f]{64}$/.test(built.id)) return 'the build has no delegation identifier';
  if (d.remaining !== 0) return `the build allows ${String(d.remaining)} further hops, and a sub-delegation allows none`;
  if (d.value === null || d.value.perTx !== 0n || d.value.total !== 0n) return 'the build has a value above 0, or no value limit';
  if (d.value.periodMs !== periodMs) return 'the build has not the period that was asked for';
  if (d.delegator.type !== 'Agent') return 'the delegator of the build is not an agent';
  if (d.parent !== plan.parent) return 'the build is not one hop below the parent that was asked for';
  if (d.delegate !== plan.subagentId || d.delegateKey !== plan.subagentSigner.keyHash) return 'the build has not the delegate and the delegate key of the subagent';
  if (!only(d.actions, plan.target.action) || !only(d.resources, plan.target.resource)) return 'the build has not exactly the one action and the one resource of the route';
  if (d.depth !== parent.depth + 1) return 'the build has not the depth of the parent plus one';
  if (d.notBefore < parent.notBefore || d.notAfter > parent.notAfter || d.notAfter !== notAfter || d.notAfter <= d.notBefore) return 'the build has not a period inside the period of the parent';
  return null;
}

/** The transaction signed by every required signer, or why it cannot be. A required signer that the caller gave no key for is named by its key hash, which is public. */
function signAll(cbor: string, required: readonly { readonly keyHash: string }[], keys: readonly TxSigner[]): Accepted<string> | Refused<'missing_signer' | 'sign_failed'> {
  const missing = required.filter((r) => !keys.some((k) => k.keyHash === r.keyHash)).map((r) => r.keyHash);
  if (missing.length > 0) return refused('missing_signer', `no key is given for the required signer ${missing.join(', ')}`);
  try {
    return accepted(required.reduce((signed, r) => keys.find((k) => k.keyHash === r.keyHash)!.sign(signed), cbor));
  } catch (error) {
    return refused('sign_failed', `a key could not sign: ${error instanceof Error ? safeText(error.name) : 'a value that is not an error was thrown'}`);
  }
}

/** Reads the parent, builds the Delegate, checks the build, signs it, and sends it. `left.current` is set before the send: a transaction that was sent may land, even when the send throws. */
async function makeSubDelegation(deps: SubDelegationDeps, plan: Plan, left: { current: LeftSubDelegation | null }): Promise<Accepted<LeftSubDelegation> | SubDelegationFailure> {
  const { chain, clock } = deps;
  let parent: LiveDelegation | null;
  try {
    parent = await chain.readDelegation(plan.parent);
  } catch (error) {
    return refused('parent_unreadable', `the parent delegation could not be read: ${errorText(error)}`);
  }
  if (parent === null) return refused('parent_not_live', 'the parent delegation is not live: it does not exist, or it ended');
  const datum = parent.delegation;
  if (datum.remaining < 1) return refused('parent_exhausted', 'the parent delegation allows no further hop: its remaining is 0');
  const now = clock.now();
  const notAfter = Math.min(now + plan.validForMs, datum.notAfter);
  if (notAfter - Math.max(now, datum.notBefore) < MIN_SUB_DELEGATION_MS) return refused('parent_expiring', `the parent delegation leaves less than ${MIN_SUB_DELEGATION_MS} ms for a sub-delegation`);
  const periodMs = datum.value === null ? plan.validForMs : datum.value.periodMs;
  const params: DelegateParams = {
    changeAddress: plan.walletAddress, nowMs: now, parent: plan.parent, delegate: plan.subagentId, delegateKey: plan.subagentSigner.keyHash,
    actions: [plan.target.action], resources: [plan.target.resource], notAfter, remaining: 0, value: { perTx: 0n, total: 0n, periodMs },
  };
  let built: DelegateBuild;
  try {
    built = await chain.buildDelegate(params);
  } catch (error) {
    return refused('build_refused', `the Delegate could not be built: ${errorText(error)}`);
  }
  const problem = buildProblem(built, plan, datum, notAfter, periodMs);
  if (problem !== null) return refused('build_mismatch', problem);
  const signed = signAll(built.txCbor, built.requiredSigners, [plan.agentSigner, plan.subagentSigner]);
  if (!signed.ok) return signed;
  const made: LeftSubDelegation = {
    id: built.id, parent: plan.parent, action: plan.target.action, resource: plan.target.resource, delegateTxHash: built.txHash, delegateValidTo: built.validTo, notAfter, endTxHash: null,
  };
  try {
    await deps.beforeSend?.(made);
  } catch (error) {
    return refused('journal_failed', `the reference of the sub-delegation could not be written: ${errorText(error)}`);
  }
  left.current = made;
  try {
    await chain.submit(signed.value);
  } catch (error) {
    return refused('submit_failed', `the Delegate was not accepted by the node: ${errorText(error)}`);
  }
  return accepted(made);
}

/** Waits, within the bound, until the gateway can issue a token under the sub-delegation. A read that fails is tried again until the bound. At the bound, a wait that never read the ledger is `ledger_unreadable`. */
async function waitUntilReady(deps: SubDelegationDeps, plan: Plan, made: LeftSubDelegation): Promise<Accepted<true> | SubDelegationFailure> {
  const { chain, clock } = deps;
  const seen: { failure: string | null; confirmations: number | null; unusable: readonly string[] | null } = { failure: null, confirmations: null, unusable: null };
  const polls = Math.ceil(plan.confirmationWaitMs / plan.pollMs) + 1;
  const bounded = await within(clock, plan.confirmationWaitMs, async () => {
    for (let poll = 0; poll < polls; poll += 1) {
      try {
        const readiness = await chain.readiness(made.id, { action: made.action, resource: made.resource }, clock.now());
        seen.failure = null;
        if (readiness.state === 'ready') return true;
        if (readiness.state === 'unusable') {
          seen.unusable = readiness.problems;
          return false;
        }
        seen.confirmations = readiness.confirmations;
      } catch (error) {
        seen.failure = errorText(error);
      }
      await clock.sleep(plan.pollMs);
    }
    return false;
  });
  if (!bounded.timedOut && bounded.value) return accepted(true);
  if (seen.unusable !== null) return refused('sub_delegation_unusable', `the sub-delegation cannot be used: ${safeText(seen.unusable.join('; '))}`);
  if (seen.failure !== null) return refused('ledger_unreadable', `the ledger could not be read when the wait ended: ${seen.failure}`);
  return refused('confirmation_timeout', `the sub-delegation had ${seen.confirmations === null ? 'an unknown number' : String(seen.confirmations)} of ${CONFIRMATIONS_REQUIRED} confirmations when the wait ended`);
}

/** True when the ledger shows the delegation, false when it does not, and null when the ledger cannot be read. */
async function showsLive(chain: DelegationChain, id: string): Promise<boolean | null> {
  try {
    return (await chain.readDelegation(id)) !== null;
  } catch {
    return null;
  }
}

/**
 * The end step: the Undelegate, signed by the agent key, and then the wait until the ledger no longer shows the delegation. It never throws: every failure is in the result, with the reference of
 * what is left. A Delegate that was sent may not be on the ledger yet: the step tries to build the Undelegate again until `endTimeoutMs`, and it stops at once when the ledger shows the delegation
 * and the builder still refuses, because that refusal is a rule and time does not change it.
 */
async function endSubDelegation(deps: SubDelegationDeps, plan: Plan, left: LeftSubDelegation | null): Promise<SubDelegationEnd> {
  if (left === null) return NOT_MADE;
  const { chain, clock } = deps;
  let current = left;
  const notEnded = (code: 'end_failed' | 'end_unconfirmed', detail: string): SubDelegationEnd => ({ state: 'not_ended', code, detail, left: current });
  try {
    const bounded = await within(clock, plan.endTimeoutMs, async (): Promise<SubDelegationEnd> => {
      const polls = Math.ceil(plan.endTimeoutMs / plan.pollMs) + 1;
      let sent: UndelegateBuild | null = null;
      let why = 'the sub-delegation is not on the ledger';
      for (let poll = 0; poll < polls; poll += 1) {
        if (sent !== null) {
          if ((await showsLive(chain, left.id)) === false) return { state: 'ended', txHash: sent.txHash };
          await clock.sleep(plan.pollMs);
          continue;
        }
        let built: UndelegateBuild | null = null;
        try {
          built = await chain.buildUndelegate({ changeAddress: plan.walletAddress, nowMs: clock.now(), id: left.id, signer: plan.agentSigner.keyHash });
        } catch (error) {
          why = `the Undelegate could not be built: ${errorText(error)}`;
          if ((await showsLive(chain, left.id)) === true) return notEnded('end_failed', why);
        }
        if (built !== null) {
          if (built.id !== left.id) return notEnded('end_failed', 'the Undelegate is for another delegation');
          const signed = signAll(built.txCbor, built.requiredSigners, [plan.agentSigner, plan.subagentSigner]);
          if (!signed.ok) return notEnded('end_failed', signed.detail);
          current = { ...left, endTxHash: built.txHash };
          try {
            await chain.submit(signed.value);
          } catch (error) {
            return notEnded('end_failed', `the Undelegate was not accepted by the node: ${errorText(error)}`);
          }
          sent = built;
        }
        await clock.sleep(plan.pollMs);
      }
      return notEnded('end_unconfirmed', sent === null ? why : 'the ledger still shows the sub-delegation after the Undelegate was sent');
    });
    return bounded.timedOut ? notEnded('end_unconfirmed', `the end did not finish within ${plan.endTimeoutMs} ms`) : bounded.value;
  } catch (error) {
    return notEnded('end_failed', `the end step failed: ${errorText(error)}`);
  }
}

/**
 * Makes a sub-delegation, runs `job` under it, and ends it. It never throws, and `end` of the result is always there.
 *
 * The steps are in this order: the request is checked and nothing is sent when it is wrong; the parent is read; the Delegate is built, checked and signed by the agent key and the subagent key; it
 * is sent; the wait for 30 confirmations runs, bounded by `confirmationWaitMs`; the job runs, bounded by `jobTimeoutMs`; and the end step runs in a `finally` path, for every outcome after the Delegate
 * was sent. The end step is the Undelegate. It is ended only when the ledger no longer shows the delegation. A failed end step does not change the result of the job.
 */
export async function withSubDelegation<T>(
  deps: SubDelegationDeps,
  request: SubDelegationRequest,
  limits: SubDelegationLimits,
  job: (handle: SubDelegationHandle) => Promise<T>,
): Promise<SubDelegationRun<T>> {
  const planned = planOf(request, limits);
  if (!planned.ok) return { ok: false, kind: 'not_ready', failure: planned, end: NOT_MADE };
  const plan = planned.value;
  const left: { current: LeftSubDelegation | null } = { current: null };
  let outcome: SubDelegationOutcome<T>;
  let end: SubDelegationEnd = NOT_MADE;
  try {
    outcome = await runUnder(deps, plan, left, job);
  } catch (error) {
    outcome = { ok: false, kind: 'not_ready', failure: refused('internal', `the sub-delegation failed: ${errorText(error)}`) };
  } finally {
    end = await endSubDelegation(deps, plan, left.current);
  }
  return { ...outcome, end };
}

async function runUnder<T>(deps: SubDelegationDeps, plan: Plan, left: { current: LeftSubDelegation | null }, job: (handle: SubDelegationHandle) => Promise<T>): Promise<SubDelegationOutcome<T>> {
  const made = await makeSubDelegation(deps, plan, left);
  if (!made.ok) return { ok: false, kind: 'not_ready', failure: made };
  const ready = await waitUntilReady(deps, plan, made.value);
  if (!ready.ok) return { ok: false, kind: 'not_ready', failure: ready };
  try {
    const bounded = await within(deps.clock, plan.jobTimeoutMs, (signal) => job({ id: made.value.id, parent: plan.parent, target: plan.target, notAfter: made.value.notAfter, signal }));
    return bounded.timedOut ? { ok: false, kind: 'timed_out' } : { ok: true, kind: 'returned', value: bounded.value };
  } catch (error) {
    return { ok: false, kind: 'threw', error };
  }
}
