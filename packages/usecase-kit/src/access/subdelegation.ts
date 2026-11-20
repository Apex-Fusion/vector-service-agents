// packages/usecase-kit/src/access/subdelegation.ts
// The sub-delegation of an agent to a subagent, for one job. An agent that reads a mock system through a subagent gives the subagent a delegation of its own: one action on one resource, one hop
// below the delegation that the hirer gave to the agent. `withSubDelegation` makes it, waits until the gateway can issue a token under it, runs the job of the caller, and ENDS it in a `finally`
// path: after a success, a refusal, a failure, a throw of the job, a timeout of the job, and a timeout of the wait. It returns what the job returned together with the result of the end step.
//
// The sub-delegation is narrow by construction, and the caller cannot widen it: `remaining` is 0 (the subagent cannot delegate again), the value limit is `{ per_tx: 0, total: 0 }` with the period of
// the parent, and the validity is inside the validity of the parent and ends within `validForMs`. The action and the resource come from the route table, and the host of the resource is the public base of
// the mock service (`bases`), and never a host that the caller names. The keys sign the BYTES of a transaction
// that was read (txcheck.ts), and never the report of the builder about them, so a builder that gives the bytes of a wider delegation gets no signature. A sub-delegation that is not ended still
// ends by itself at its `notAfter`, and the result gives the reference that a janitor needs to end it earlier.
//
// The Delegate carries its own end of validity: the TTL of its body is the slot that the end of validity in the report of the build gives (`DelegationChain.slotAt`), and the reference of a left
// sub-delegation holds that slot. A Delegate that the ledger does not show when the slot of the chain tip is at or past that TTL never lands, so a janitor may drop its reference then. The janitor
// compares the slot of the tip with `delegateTtlSlot`, never the clock with `delegateValidTo`: the TTL is in the signed bytes, and the time is only what the build port reported.
//
// Runs of one agent wallet at one time go through the queue of that wallet for the build and the send of each transaction (queue.ts), and the end step ends only the delegation that its own run made.
// Every wait on a port has a bound, and a port that gives no answer is a typed failure.
//
// What it costs and locks, from the builders: the Delegate makes one output at the delegation address that holds the ledger minimum for its datum (`DelegateBuild.outputLovelace`). The agent pays
// that deposit and the fee of the transaction from the wallet of its live delegation key. The Undelegate returns the deposit to that wallet, less its own fee.
import type { DelegateBuild, DelegateParams, UndelegateBuild, UndelegateParams } from '@vsa/buyer-core';
import { encodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import { accepted, agentIdOf, parseDelegationId, parseDid, parseKeyHash, parseTenantId, refused, type Accepted, type DelegationId, type Did, type Refused, type SerialQueue } from '../protocol/index.ts';
import { MAX_WAIT_MS, within, type Clock } from './ports.ts';
import { takeTurn } from './queue.ts';
import { ROUTES, originOf, type MockBases, type RouteId, type TokenTarget } from './routes.ts';
import { errorText, safeText } from './text.ts';
import { addressHexOf, delegateTxProblem, delegationScriptProblem, undelegateTxProblem, type DelegationScript } from './txcheck.ts';

/** The confirmations that the gateway wants for every delegation of a chain, before it issues a token under it. */
export const CONFIRMATIONS_REQUIRED = 30;
/** The shortest validity that a sub-delegation gets, in milliseconds. A parent that ends sooner gives `parent_expiring`. */
export const MIN_SUB_DELEGATION_MS = 300_000;
/** The longest validity that a caller can ask for, in milliseconds: one day. */
export const MAX_SUB_DELEGATION_MS = 86_400_000;
export const DEFAULT_CONFIRMATION_WAIT_MS = 360_000;
export const DEFAULT_POLL_MS = 5_000;
export const DEFAULT_END_TIMEOUT_MS = 120_000;
/** The longest wait for one answer of a port, in milliseconds: the read of the parent, the build, the hook, the send, and each call of the end step. The default is 60 seconds. */
export const DEFAULT_STEP_TIMEOUT_MS = 60_000;
/** The longest time that a Delegate keeps its turn in the queue of the wallet after its send, while it waits to be on the ledger, in milliseconds. The default is 120 seconds. */
export const DEFAULT_LANDING_WAIT_MS = 120_000;

/** The datum of a delegation as the builders of the ledger give it. */
export type DelegationDatum = DelegateBuild['delegation'];

/** A delegation that the ledger shows as live. */
export interface LiveDelegation {
  readonly id: string;
  readonly delegation: DelegationDatum;
  /** The hash of the transaction that made the delegation: the `txHash` of its output. The end step ends only a delegation that the Delegate of its own run made. */
  readonly txHash: string;
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
  /**
   * The slot that a time gives on the slot clock of the chain: the slot that the builders write in the TTL of a transaction for a `validTo` of `ms` POSIX milliseconds. The TTL is the first slot in which the
   * transaction can no longer land. The keys sign a Delegate only when its TTL is this slot for the `validTo` that the report of its build gives. `deploymentSlotAt` gives the rule of the identity deployment.
   */
  slotAt(ms: number): Promise<number>;
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
  /** The delegation script of the identity deployment: `deployment.delegation` of `@vsa/buyer-core`. The keys sign only a transaction that mints the token of this script and puts it in an output at its address. */
  readonly delegationScript: DelegationScript;
  /**
   * The two origins of the mock service: the same bases that the calls take. The resource of a sub-delegation is `<publicBase>/t/<tenant>/<system>` for the route, and no other. A target with a resource on
   * another host gets no sub-delegation, whatever the delegation of the parent covers.
   */
  readonly bases: MockBases;
  /**
   * The queue of the wallet key of the agent: the same queue that holds its other transactions. The build and the send of a Delegate or an Undelegate go through it, one at a time, and each keeps its
   * turn until the ledger shows it. `createSerialQueue()` makes one for a test and for a caller that has none.
   */
  readonly walletQueue: SerialQueue;
  /**
   * Called with the reference of the sub-delegation just BEFORE the Delegate is sent, so that a crash of the process cannot leave a sub-delegation that no record names. Write the reference to the
   * store of the janitor here, and remove it when the run gives `end.state` of `ended` or `not_made`. A Delegate that the ledger does not show when the slot of the chain tip is at or past
   * `delegateTtlSlot` never lands, so a janitor may drop the reference of a run that crashed then. A hook that throws stops the run with `journal_failed`: nothing is sent.
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
  /**
   * The longest time from the start of the run to the moment when the gateway can issue a token: the wait for the turn in the queue of the wallet, the Delegate, and the wait for its 30 confirmations.
   * The default is DEFAULT_CONFIRMATION_WAIT_MS.
   */
  readonly confirmationWaitMs?: number;
  /** The time between two reads of the ledger. The default is DEFAULT_POLL_MS. */
  readonly pollMs?: number;
  /** The longest time of the end step: the turn in the queue, the Undelegate, and the wait until the ledger shows it. The default is DEFAULT_END_TIMEOUT_MS. */
  readonly endTimeoutMs?: number;
  /** The longest wait for one answer of a port: the read of the parent, the build, the hook, the send, and each call of the end step. The default is DEFAULT_STEP_TIMEOUT_MS. */
  readonly stepTimeoutMs?: number;
  /** The longest time that the Delegate keeps its turn in the queue after its send, while it waits to be on the ledger. The default is DEFAULT_LANDING_WAIT_MS. */
  readonly landingWaitMs?: number;
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
  'confirmation_timeout', 'ledger_unreadable', 'sub_delegation_unusable', 'journal_failed', 'step_timeout', 'internal',
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
  /** The end of the validity of the Delegate transaction, in POSIX milliseconds, as the build port reported it. It is for people: a janitor uses `delegateTtlSlot`. */
  readonly delegateValidTo: number;
  /**
   * The TTL of the Delegate transaction: the first slot in which it can no longer land. The bytes that the keys signed carry it. A Delegate that the ledger does not show when the slot of the chain tip is
   * at or past this slot never lands, and a janitor may drop the reference then.
   */
  readonly delegateTtlSlot: number;
  /** When the delegation ends by itself, in POSIX milliseconds. */
  readonly notAfter: number;
  /** The hash of the Undelegate that was sent, or null when none was sent. */
  readonly endTxHash: string | null;
}

export type SubDelegationEnd =
  /** Nothing of this run is on the ledger and nothing can land: no Delegate was sent, or the ledger shows a delegation with this identifier that ANOTHER transaction made, so the Delegate of this run never lands. There is nothing to end. */
  | { readonly state: 'not_made' }
  /** The ledger no longer shows the sub-delegation. `txHash` is the Undelegate. */
  | { readonly state: 'ended'; readonly txHash: string }
  /**
   * The sub-delegation may be alive. `left` is what a janitor needs. `end_failed`: the Undelegate was not sent. `end_unconfirmed`: the time ran out before the step could tell. The Undelegate was sent and the
   * ledger still shows the sub-delegation, or the ledger shows nothing yet, or it could not be read, or it shows the delegation of this run with a transaction hash that is not 64 lower-case hex characters, so
   * the step cannot tell which transaction made it.
   */
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
  /** The action of the route table, and the resource of the target after the check of its form. These two are the action and the resource of the sub-delegation. */
  readonly action: string;
  readonly resource: string;
  readonly parent: DelegationId;
  readonly subagentId: string;
  readonly agentSigner: TxSigner;
  readonly subagentSigner: TxSigner;
  readonly walletAddress: string;
  /** The bytes of the address of the wallet, in hex: every output of a transaction of this run that is not the delegation output goes there. */
  readonly walletHex: string;
  readonly script: DelegationScript;
  readonly validForMs: number;
  readonly jobTimeoutMs: number;
  readonly confirmationWaitMs: number;
  readonly pollMs: number;
  readonly endTimeoutMs: number;
  readonly stepTimeoutMs: number;
  readonly landingWaitMs: number;
}

/** The form of a transaction hash: 64 lower-case hex characters. A build reports its hash in this form, and the ledger must show the hash of the transaction of a delegation in the same form. */
const TX_HASH = /^[0-9a-f]{64}$/;
const NOT_MADE: SubDelegationEnd = { state: 'not_made' };
const hexOf = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const isWhole = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function signerProblem(signer: unknown, field: string): string | null {
  if (typeof signer !== 'object' || signer === null) return `${field} must be a signer`;
  const { keyHash, sign } = signer as { keyHash?: unknown; sign?: unknown };
  const hash = parseKeyHash(keyHash, `${field}.keyHash`);
  if (!hash.ok) return hash.detail;
  return typeof sign === 'function' ? null : `${field}.sign must be a function`;
}

/** The first rule that the resource of a target breaks, or null: it is exactly `<public base>/t/<tenant>/<system>` for the system of the route, in its canonical form. `origin` is the origin of the public base. */
function resourceProblem(resource: unknown, origin: string, system: string): string | null {
  if (typeof resource !== 'string') return 'the resource of the target must be text';
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return 'the resource of the target is not a URL';
  }
  if (url.protocol !== 'https:' || url.href !== resource || url.username !== '' || url.password !== '' || resource.includes('?') || resource.includes('#')) {
    return 'the resource of the target must be an https URL in its canonical form, with no user part, no query and no fragment';
  }
  const [, prefix, tenant, name, ...rest] = url.pathname.split('/');
  if (prefix !== 't' || rest.length > 0 || name !== system || !parseTenantId(tenant).ok) return `the resource of the target must be <public base>/t/<tenant>/${system}`;
  return resource === `${origin}/t/${tenant}/${system}` ? null : 'the resource of the target is not on the public base of the mock service';
}

/**
 * The route of a target as the route table gives it, or why no sub-delegation is made for it. The action and who may call come from `ROUTES[target.route]` only, and the target of the caller must
 * agree with them: a target that says more, such as a write route with the callers of a read route, or any other action or resource, is `bad_request`. The resource must be on the public base `origin`.
 * Nothing is built for it.
 */
function routeOf(target: TokenTarget, origin: string): Accepted<{ readonly action: string; readonly resource: string }> | SubDelegationFailure {
  const bad = (detail: string): SubDelegationFailure => refused('bad_request', detail);
  const route: unknown = typeof target === 'object' && target !== null ? target.route : undefined;
  if (typeof route !== 'string' || !Object.hasOwn(ROUTES, route)) return bad('the route of the target is not a route of the mock systems');
  const spec = ROUTES[route as RouteId];
  if (spec.credential !== 'token') return bad(`the route ${route} takes no access token`);
  if (spec.callers !== 'agent-or-subagent') return bad(`the route ${route} takes the agent only: a subagent gets no delegation for it`);
  if (target.credential !== 'token' || target.callers !== spec.callers || target.action !== spec.action || target.system !== spec.system) {
    return bad(`the target is not the target of the route ${route}: its credential, its callers, its action and its system are the ones of the route table`);
  }
  const problem = resourceProblem(target.resource, origin, spec.system);
  return problem === null ? accepted({ action: spec.action, resource: target.resource }) : bad(problem);
}

/** The plan of a request, or the first rule that it breaks. Nothing is sent before this passes. */
function planOf(deps: SubDelegationDeps, request: SubDelegationRequest, limits: SubDelegationLimits): Accepted<Plan> | SubDelegationFailure {
  const bad = (detail: string): SubDelegationFailure => refused('bad_request', detail);
  const scriptProblem = delegationScriptProblem(deps.delegationScript);
  if (scriptProblem !== null) return bad(scriptProblem);
  if (typeof deps.walletQueue !== 'object' || deps.walletQueue === null || typeof deps.walletQueue.run !== 'function') return bad('walletQueue must be the queue of the wallet key: an object with a run function');
  if (typeof deps.chain?.slotAt !== 'function') return bad('chain.slotAt must be the slot rule of the chain: a function that gives the slot of a time');
  const publicOrigin = originOf(deps.bases?.publicBase, 'publicBase');
  if (!publicOrigin.ok) return bad(`bases must be the bases of the mock service: ${publicOrigin.detail}`);
  const { target } = request;
  const route = routeOf(target, publicOrigin.value);
  if (!route.ok) return route;
  const parent = parseDelegationId(request.parent, 'parent');
  if (!parent.ok) return bad(parent.detail);
  const subagent = parseDid(request.subagent.did, 'subagent.did');
  if (!subagent.ok) return bad(subagent.detail);
  const problem = signerProblem(request.agent.signer, 'agent.signer') ?? signerProblem(request.subagent.signer, 'subagent.signer');
  if (problem !== null) return bad(problem);
  if (request.agent.signer.keyHash === request.subagent.signer.keyHash) return bad('the agent and the subagent must have two delegation keys');
  const walletHex = typeof request.agent.walletAddress === 'string' ? addressHexOf(request.agent.walletAddress) : null;
  if (walletHex === null) return bad('agent.walletAddress must be the address of the wallet of the delegation key');
  if (!isWhole(request.validForMs, MIN_SUB_DELEGATION_MS, MAX_SUB_DELEGATION_MS)) return bad(`validForMs must be a whole number from ${MIN_SUB_DELEGATION_MS} to ${MAX_SUB_DELEGATION_MS}`);
  const confirmationWaitMs = limits.confirmationWaitMs === undefined ? DEFAULT_CONFIRMATION_WAIT_MS : limits.confirmationWaitMs;
  const pollMs = limits.pollMs === undefined ? DEFAULT_POLL_MS : limits.pollMs;
  const endTimeoutMs = limits.endTimeoutMs === undefined ? DEFAULT_END_TIMEOUT_MS : limits.endTimeoutMs;
  const stepTimeoutMs = limits.stepTimeoutMs === undefined ? DEFAULT_STEP_TIMEOUT_MS : limits.stepTimeoutMs;
  const landingWaitMs = limits.landingWaitMs === undefined ? DEFAULT_LANDING_WAIT_MS : limits.landingWaitMs;
  if (!isWhole(limits.jobTimeoutMs, 1, MAX_WAIT_MS)) return bad(`jobTimeoutMs must be a whole number from 1 to ${MAX_WAIT_MS}`);
  if (![confirmationWaitMs, pollMs, endTimeoutMs, stepTimeoutMs, landingWaitMs].every((ms) => isWhole(ms, 1, MAX_WAIT_MS))) {
    return bad(`confirmationWaitMs, pollMs, endTimeoutMs, stepTimeoutMs and landingWaitMs must be whole numbers from 1 to ${MAX_WAIT_MS}`);
  }
  return accepted({
    target, action: route.value.action, resource: route.value.resource, parent: parent.value, subagentId: agentIdOf(subagent.value), agentSigner: request.agent.signer,
    subagentSigner: request.subagent.signer, walletAddress: request.agent.walletAddress, walletHex, script: deps.delegationScript, validForMs: request.validForMs,
    jobTimeoutMs: limits.jobTimeoutMs, confirmationWaitMs, pollMs, endTimeoutMs, stepTimeoutMs, landingWaitMs,
  });
}

/** The datum of the delegation that was asked for, as the output of the Delegate must hold it. Every field comes from the request, the parent or the clock, and only the start comes from the build. */
function askedDatum(plan: Plan, parent: DelegationDatum, notBefore: number, notAfter: number, periodMs: number): DelegationDatum {
  return {
    delegator: { type: 'Agent', id: parent.delegate }, parent: plan.parent, delegate: plan.subagentId, delegateKey: plan.subagentSigner.keyHash, actions: [hexOf(plan.action)],
    resources: [hexOf(plan.resource)], notBefore, notAfter, depth: parent.depth + 1, remaining: 0, purpose: null, value: { perTx: 0n, total: 0n, periodMs },
  };
}

/**
 * The first way in which the REPORT of a build is not the narrow sub-delegation that was asked for, or null. The bytes of the transaction are read by `delegateTxProblem` after this check and
 * before any key signs. The start of the delegation is the one thing that the builder chooses: it is from the start of the parent to the later of now and that start.
 */
function buildProblem(built: DelegateBuild, plan: Plan, parent: DelegationDatum, notAfter: number, periodMs: number, now: number): string | null {
  const d = built.delegation;
  const only = (items: readonly string[], text: string): boolean => items.length === 1 && items[0] === hexOf(text);
  if (!/^[0-9a-f]{64}$/.test(built.id)) return 'the build has no delegation identifier';
  if (!TX_HASH.test(built.txHash)) return 'the build has no transaction hash';
  if (!isWhole(built.validTo, 1)) return 'the build has no end of validity: its validTo is not a whole number of POSIX milliseconds';
  if (d.remaining !== 0) return `the build allows ${String(d.remaining)} further hops, and a sub-delegation allows none`;
  if (d.value === null || d.value.perTx !== 0n || d.value.total !== 0n) return 'the build has a value above 0, or no value limit';
  if (d.value.periodMs !== periodMs) return 'the build has not the period that was asked for';
  if (d.delegator.type !== 'Agent' || d.delegator.id !== parent.delegate) return 'the delegator of the build is not the agent that the parent names as its delegate';
  if (d.purpose !== null) return 'the build has a purpose, and a sub-delegation has none';
  if (d.parent !== plan.parent) return 'the build is not one hop below the parent that was asked for';
  if (d.delegate !== plan.subagentId || d.delegateKey !== plan.subagentSigner.keyHash) return 'the build has not the delegate and the delegate key of the subagent';
  if (!only(d.actions, plan.action) || !only(d.resources, plan.resource)) return 'the build has not exactly the one action and the one resource of the route';
  if (d.depth !== parent.depth + 1) return 'the build has not the depth of the parent plus one';
  if (d.notBefore < parent.notBefore || d.notAfter > parent.notAfter || d.notAfter !== notAfter || d.notAfter <= d.notBefore) return 'the build has not a period inside the period of the parent';
  if (d.notBefore > Math.max(now, parent.notBefore)) return 'the build starts later than the parent and the clock';
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

/** The answer of one call of a port: its value, the error that it threw, or `timed_out` when no answer came within `ms` of the clock. A call that never answers does not hold the run. */
type Answer<T> = { readonly state: 'value'; readonly value: T } | { readonly state: 'threw'; readonly error: unknown } | { readonly state: 'timed_out' };

async function answerOf<T>(clock: Clock, ms: number, call: () => Promise<T>): Promise<Answer<T>> {
  try {
    const result = await within(clock, ms, call);
    return result.timedOut ? { state: 'timed_out' } : { state: 'value', value: result.value };
  } catch (error) {
    return { state: 'threw', error };
  }
}

const timedOut = (what: string, ms: number): SubDelegationFailure => refused('step_timeout', `${what} did not answer within ${ms} ms`);

/** What the ledger shows of one delegation: it is live and made by the transaction `txHash`, it is not on the ledger, or it cannot be read. */
type Seen = { readonly state: 'live'; readonly txHash: string } | { readonly state: 'absent' } | { readonly state: 'unreadable'; readonly detail: string };

/**
 * What the ledger shows of the delegation `id`. A delegation that comes with a transaction hash that is not in the form of a hash is `unreadable`: the step cannot tell which transaction made it, and a
 * hash that only differs from the hash of this run in its form (for example in capital letters) is not another transaction. So such an answer is never read as a delegation of another transaction.
 */
async function seenOn(deps: SubDelegationDeps, plan: Plan, id: string): Promise<Seen> {
  const read = await answerOf(deps.clock, plan.stepTimeoutMs, () => deps.chain.readDelegation(id));
  if (read.state === 'timed_out') return { state: 'unreadable', detail: `the ledger did not answer within ${plan.stepTimeoutMs} ms` };
  if (read.state === 'threw') return { state: 'unreadable', detail: errorText(read.error) };
  if (read.value === null) return { state: 'absent' };
  const shown: unknown = read.value; // a port in JavaScript can give any value, so the answer is checked as an unknown value
  const txHash: unknown = typeof shown === 'object' && shown !== null && 'txHash' in shown ? shown.txHash : undefined;
  return typeof txHash === 'string' && TX_HASH.test(txHash)
    ? { state: 'live', txHash }
    : { state: 'unreadable', detail: 'the ledger shows the delegation, and the hash of its transaction is not 64 lower-case hex characters' };
}

/**
 * Reads the parent, builds the Delegate, checks the build, reads the slot of its end of validity, checks the BYTES of its transaction, signs it, and sends it. Each call of a port has the bound
 * `stepTimeoutMs`, and a call that gives no answer is `step_timeout`. `left.current` is set before the send: a transaction that was sent may land, even when the send throws or gives no answer, and the end
 * step then runs as for a Delegate that may have landed.
 */
async function buildAndSend(deps: SubDelegationDeps, plan: Plan, left: { current: LeftSubDelegation | null }): Promise<Accepted<LeftSubDelegation> | SubDelegationFailure> {
  const { chain, clock } = deps;
  const read = await answerOf(clock, plan.stepTimeoutMs, () => chain.readDelegation(plan.parent));
  if (read.state === 'timed_out') return timedOut('the read of the parent delegation', plan.stepTimeoutMs);
  if (read.state === 'threw') return refused('parent_unreadable', `the parent delegation could not be read: ${errorText(read.error)}`);
  const parent: LiveDelegation | null = read.value;
  if (parent === null) return refused('parent_not_live', 'the parent delegation is not live: it does not exist, or it ended');
  const datum = parent.delegation;
  if (datum.remaining < 1) return refused('parent_exhausted', 'the parent delegation allows no further hop: its remaining is 0');
  const now = clock.now();
  const notAfter = Math.min(now + plan.validForMs, datum.notAfter);
  if (notAfter - Math.max(now, datum.notBefore) < MIN_SUB_DELEGATION_MS) return refused('parent_expiring', `the parent delegation leaves less than ${MIN_SUB_DELEGATION_MS} ms for a sub-delegation`);
  const periodMs = datum.value === null ? plan.validForMs : datum.value.periodMs;
  const params: DelegateParams = {
    changeAddress: plan.walletAddress, nowMs: now, parent: plan.parent, delegate: plan.subagentId, delegateKey: plan.subagentSigner.keyHash,
    actions: [plan.action], resources: [plan.resource], notAfter, remaining: 0, value: { perTx: 0n, total: 0n, periodMs },
  };
  const build = await answerOf(clock, plan.stepTimeoutMs, () => chain.buildDelegate(params));
  if (build.state === 'timed_out') return timedOut('the build of the Delegate', plan.stepTimeoutMs);
  if (build.state === 'threw') return refused('build_refused', `the Delegate could not be built: ${errorText(build.error)}`);
  const built: DelegateBuild = build.value;
  const problem = buildProblem(built, plan, datum, notAfter, periodMs, now);
  if (problem !== null) return refused('build_mismatch', problem);
  let datumHex: string;
  try {
    datumHex = encodeDelegationDatum(askedDatum(plan, datum, built.delegation.notBefore, notAfter, periodMs));
  } catch (error) {
    return refused('build_mismatch', `the datum that was asked for cannot be written: ${errorText(error)}`);
  }
  const slot = await answerOf(clock, plan.stepTimeoutMs, () => chain.slotAt(built.validTo));
  if (slot.state === 'timed_out') return timedOut('the slot clock of the chain', plan.stepTimeoutMs);
  if (slot.state === 'threw') return refused('ledger_unreadable', `the slot of the end of validity of the Delegate could not be read: ${errorText(slot.error)}`);
  if (!isWhole(slot.value, 0)) return refused('ledger_unreadable', 'the slot clock of the chain gave a slot that is not a whole number from 0');
  const ttlSlot = slot.value;
  const txProblem = delegateTxProblem(built.txCbor, {
    txHash: built.txHash, id: built.id, script: plan.script, walletHex: plan.walletHex, signers: [plan.agentSigner.keyHash, plan.subagentSigner.keyHash], datumHex, ttlSlot,
  });
  if (txProblem !== null) return refused('build_mismatch', txProblem);
  const signed = signAll(built.txCbor, built.requiredSigners, [plan.agentSigner, plan.subagentSigner]);
  if (!signed.ok) return signed;
  const made: LeftSubDelegation = {
    id: built.id, parent: plan.parent, action: plan.action, resource: plan.resource, delegateTxHash: built.txHash, delegateValidTo: built.validTo, delegateTtlSlot: ttlSlot, notAfter,
    endTxHash: null,
  };
  const journal = await answerOf(clock, plan.stepTimeoutMs, async () => deps.beforeSend?.(made));
  if (journal.state === 'timed_out') return timedOut('the hook that writes the reference of the sub-delegation', plan.stepTimeoutMs);
  if (journal.state === 'threw') return refused('journal_failed', `the reference of the sub-delegation could not be written: ${errorText(journal.error)}`);
  left.current = made;
  const sent = await answerOf(clock, plan.stepTimeoutMs, () => chain.submit(signed.value));
  if (sent.state === 'timed_out') return timedOut('the node, after the Delegate was sent to it,', plan.stepTimeoutMs);
  if (sent.state === 'threw') return refused('submit_failed', `the Delegate was not accepted by the node: ${errorText(sent.error)}`);
  return accepted(made);
}

/**
 * Waits, for at most `landingWaitMs`, until the ledger shows a delegation with the identifier of this run. The caller holds the turn of the wallet queue meanwhile, so the next build reads the
 * outputs that this Delegate left. A delegation of ANOTHER transaction under the same identifier means that this Delegate can never land: that is `submit_failed`. A wait that ends before
 * the delegation shows is not a failure: the run goes on, and the wait for the confirmations decides.
 */
async function landed(deps: SubDelegationDeps, plan: Plan, made: LeftSubDelegation): Promise<SubDelegationFailure | null> {
  const { clock } = deps;
  const polls = Math.ceil(plan.landingWaitMs / plan.pollMs) + 1;
  const outcome = await within(clock, plan.landingWaitMs, async (signal): Promise<'ours' | 'taken' | 'unseen'> => {
    for (let poll = 0; poll < polls && !signal.aborted; poll += 1) {
      const seen = await seenOn(deps, plan, made.id);
      if (seen.state === 'live') return seen.txHash === made.delegateTxHash ? 'ours' : 'taken';
      await clock.sleep(plan.pollMs, signal);
    }
    return 'unseen';
  });
  return !outcome.timedOut && outcome.value === 'taken'
    ? refused('submit_failed', 'the ledger shows a delegation with the identifier of this run that another transaction made, so the Delegate of this run never lands')
    : null;
}

/** Takes the turn of the wallet queue, builds and sends the Delegate, and keeps the turn until the ledger shows it. */
async function makeSubDelegation(deps: SubDelegationDeps, plan: Plan, left: { current: LeftSubDelegation | null }): Promise<Accepted<LeftSubDelegation> | SubDelegationFailure> {
  const turn = await takeTurn(deps.walletQueue, deps.clock, plan.confirmationWaitMs);
  if (turn.state === 'timed_out') return refused('step_timeout', `the turn in the queue of the wallet did not come within ${plan.confirmationWaitMs} ms`);
  if (turn.state === 'failed') return refused('internal', `the queue of the wallet failed: ${errorText(turn.error)}`);
  try {
    const made = await buildAndSend(deps, plan, left);
    return made.ok ? ((await landed(deps, plan, made.value)) ?? made) : made;
  } finally {
    turn.release();
  }
}

/**
 * Waits, within `budgetMs`, until the gateway can issue a token under the sub-delegation. A read that fails is tried again until the bound. At the bound, a wait that never read the ledger is
 * `ledger_unreadable`.
 */
async function waitUntilReady(deps: SubDelegationDeps, plan: Plan, made: LeftSubDelegation, budgetMs: number): Promise<Accepted<true> | SubDelegationFailure> {
  const { chain, clock } = deps;
  const seen: { failure: string | null; confirmations: number | null; unusable: readonly string[] | null } = { failure: null, confirmations: null, unusable: null };
  const polls = Math.ceil(budgetMs / plan.pollMs) + 1;
  const bounded = await within(clock, budgetMs, async () => {
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

/**
 * The end step: the Undelegate, signed by the agent key, and then the wait until the ledger no longer shows the delegation. It never throws: every failure is in the result, with the reference of
 * what is left.
 *
 * It ends only the delegation that THIS run made. The ledger shows the transaction that made each delegation: one that this run made is ended, and one that another transaction made under the same
 * identifier is left alone, because the Delegate of this run can never land (`not_made`). A delegation that the ledger shows with a transaction hash that is not in the form of a hash is not taken as the
 * delegation of another transaction: the step cannot tell who made it, so it reads again until `endTimeoutMs`, and then it gives `not_ended` with the reference, and never `not_made`. A Delegate that was
 * sent may not be on the ledger yet: the step reads the ledger again until `endTimeoutMs`. When the ledger shows the delegation and the builder refuses, the step stops at once (`end_failed`), because that
 * refusal is a rule and time does not change it.
 *
 * The build and the send of the Undelegate go through the queue of the wallet, and the turn is kept until the ledger no longer shows the delegation. Every call of a port has the bound
 * `stepTimeoutMs`, and the whole step has the bound `endTimeoutMs`.
 */
async function endSubDelegation(deps: SubDelegationDeps, plan: Plan, left: LeftSubDelegation | null): Promise<SubDelegationEnd> {
  if (left === null) return NOT_MADE;
  const { clock } = deps;
  let current = left;
  const notEnded = (code: 'end_failed' | 'end_unconfirmed', detail: string): SubDelegationEnd => ({ state: 'not_ended', code, detail, left: current });
  const deadline = clock.now() + plan.endTimeoutMs;
  const polls = Math.ceil(plan.endTimeoutMs / plan.pollMs) + 1;
  try {
    const bounded = await within(clock, plan.endTimeoutMs, async (signal): Promise<SubDelegationEnd> => {
      let used = 0;
      /** False when the polls or the time are spent. */
      const wait = async (): Promise<boolean> => {
        used += 1;
        if (used >= polls || signal.aborted) return false;
        await clock.sleep(plan.pollMs, signal);
        return !signal.aborted;
      };
      /** The Undelegate, with the turn held from the build until the ledger no longer shows the delegation. Null when the build gave no answer: the caller reads the ledger and tries again. */
      const undelegate = async (): Promise<SubDelegationEnd | null> => {
        const turn = await takeTurn(deps.walletQueue, clock, Math.max(1, deadline - clock.now()));
        if (turn.state === 'timed_out') return notEnded('end_unconfirmed', 'the turn in the queue of the wallet did not come before the end step ran out of time');
        if (turn.state === 'failed') return notEnded('end_failed', `the queue of the wallet failed: ${errorText(turn.error)}`);
        try {
          const build = await answerOf(clock, plan.stepTimeoutMs, () => deps.chain.buildUndelegate({ changeAddress: plan.walletAddress, nowMs: clock.now(), id: left.id, signer: plan.agentSigner.keyHash }));
          if (build.state === 'timed_out') return null;
          if (build.state === 'threw') return notEnded('end_failed', `the Undelegate could not be built: ${errorText(build.error)}`);
          const built: UndelegateBuild = build.value;
          if (built.id !== left.id) return notEnded('end_failed', 'the Undelegate is for another delegation');
          const problem = undelegateTxProblem(built.txCbor, { txHash: built.txHash, id: left.id, script: plan.script, walletHex: plan.walletHex, signers: [plan.agentSigner.keyHash] });
          if (problem !== null) return notEnded('end_failed', problem);
          const signed = signAll(built.txCbor, built.requiredSigners, [plan.agentSigner]);
          if (!signed.ok) return notEnded('end_failed', signed.detail);
          current = { ...left, endTxHash: built.txHash };
          const sent = await answerOf(clock, plan.stepTimeoutMs, () => deps.chain.submit(signed.value));
          if (sent.state === 'threw') return notEnded('end_failed', `the Undelegate was not accepted by the node: ${errorText(sent.error)}`);
          let why = 'the ledger still shows the sub-delegation after the Undelegate was sent';
          do {
            const seen = await seenOn(deps, plan, left.id);
            if (seen.state === 'absent') return { state: 'ended', txHash: built.txHash };
            why = seen.state === 'unreadable' ? `the ledger could not be read after the Undelegate was sent: ${seen.detail}` : 'the ledger still shows the sub-delegation after the Undelegate was sent';
          } while (await wait());
          return notEnded('end_unconfirmed', why);
        } finally {
          turn.release();
        }
      };
      let why = 'the sub-delegation is not on the ledger';
      do {
        const seen = await seenOn(deps, plan, left.id);
        if (seen.state === 'live') {
          if (seen.txHash !== left.delegateTxHash) return NOT_MADE;
          const ended = await undelegate();
          if (ended !== null) return ended;
          why = `the build of the Undelegate did not answer within ${plan.stepTimeoutMs} ms`;
        } else {
          why = seen.state === 'absent' ? 'the sub-delegation is not on the ledger' : `the ledger could not be read: ${seen.detail}`;
        }
      } while (await wait());
      return notEnded('end_unconfirmed', why);
    });
    return bounded.timedOut ? notEnded('end_unconfirmed', `the end did not finish within ${plan.endTimeoutMs} ms`) : bounded.value;
  } catch (error) {
    return notEnded('end_failed', `the end step failed: ${errorText(error)}`);
  }
}

/**
 * Makes a sub-delegation, runs `job` under it, and ends it. It never throws, and `end` of the result is always there.
 *
 * The steps are in this order: the request is checked and nothing is sent when it is wrong; the turn in the queue of the wallet comes; the parent is read; the Delegate is built, and its report and its
 * bytes are checked; it is signed by the agent key and the subagent key, and sent; the turn is kept until the ledger shows the Delegate; the wait for 30 confirmations runs; the job runs, bounded by
 * `jobTimeoutMs`; and the end step runs in a `finally` path, for every outcome after the Delegate was sent. The end step is the Undelegate. It is ended only when the ledger no longer shows the
 * delegation. A failed end step does not change the result of the job. `confirmationWaitMs` bounds everything from the start of the run to the moment when a token can be issued.
 */
export async function withSubDelegation<T>(
  deps: SubDelegationDeps,
  request: SubDelegationRequest,
  limits: SubDelegationLimits,
  job: (handle: SubDelegationHandle) => Promise<T>,
): Promise<SubDelegationRun<T>> {
  const planned = planOf(deps, request, limits);
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
  const startedAt = deps.clock.now();
  const made = await makeSubDelegation(deps, plan, left);
  if (!made.ok) return { ok: false, kind: 'not_ready', failure: made };
  const ready = await waitUntilReady(deps, plan, made.value, Math.max(1, startedAt + plan.confirmationWaitMs - deps.clock.now()));
  if (!ready.ok) return { ok: false, kind: 'not_ready', failure: ready };
  try {
    const bounded = await within(deps.clock, plan.jobTimeoutMs, (signal) => job({ id: made.value.id, parent: plan.parent, target: plan.target, notAfter: made.value.notAfter, signal }));
    return bounded.timedOut ? { ok: false, kind: 'timed_out' } : { ok: true, kind: 'returned', value: bounded.value };
  } catch (error) {
    return { ok: false, kind: 'threw', error };
  }
}
