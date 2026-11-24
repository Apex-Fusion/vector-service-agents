// agents/prior-authorization-agent/src/evidence/subread.ts
// One read through ONE subagent: the generic part of the two reads of the evidence (use case 2, prior authorization). The agent never reads a record or a guideline with its own token. Each read has its own
// subagent, its own sub-delegation and its own token (statement S3 of the claim of the agent). `readThroughSubagent` does this, and the files of the two reads give it their route, their codes and their parser.
//
// The steps, in this order. A failure of a step is a typed result with a code, and no step reads success from a text.
//   1. A caller that hung up stops the read before it starts, and so does a deadline that leaves less than `LEAST_READ_MS`. Nothing is read from the chain and nothing is sent.
//   2. The sub-delegation, through `withSubDelegation` of the kit: one action on one resource, one hop below the delegation of the hirer, no value, made by the delegation key of this agent and the delegation key
//      of the subagent. The subagent asks the gateway for its token after the 30 confirmations and reads the document with it. The sub-delegation is ENDED in every case: after the document, after a refusal,
//      after a failure, after a throw and after a timeout. The records of the sub-delegation are the ones that `bookkeeping.ts` says.
//   3. The job of the subagent: a token for the route under the sub-delegation (`requestSubagentToken`, so the holder is always `subagent`), the call of the system, and the parser of the read. A refusal or a
//      failure of the call gives the code of the system only when it is one of `MOCK_CODES`. Any other code of a system, such as its `internal` or its `ledger_unavailable`, is `mock_system_failed`, so that a
//      code of a system never looks like a code of this agent.
//
// A read that gives its document also says how its sub-delegation ended (`end`). An end that is `not_ended` means that the sub-delegation may be alive: its entry is in the list of left sub-delegations, and the
// janitor ends it. The caller decides what that means for the next read.
//
// Time. A read starts only when the deadline leaves it the least budget: the least wait for the confirmations, the job under the sub-delegation, and the end step. The wait for the confirmations is trimmed so that
// the end step is inside the deadline. The sub-delegation stays valid for that wait, the job and `VALIDITY_SLACK_MS` more, and it ends by itself then.
import {
  DEFAULT_CONFIRMATION_WAIT_MS, DEFAULT_END_TIMEOUT_MS, DEFAULT_POLL_MS, GATEWAY_FAILURES, SUB_DELEGATION_FAILURES, askWhileTooYoung, callWithToken, requestSubagentToken, withSubDelegation,
} from '@vsa/usecase-kit/access';
import type { RouteTokenResult, SubDelegationEnd, SubDelegationHandle, SystemFailed, SystemRefused, TokenTarget } from '@vsa/usecase-kit/access';
import type { DelegationId, ProtocolResult } from '@vsa/usecase-kit/protocol';
import { beforeSendOf, leave, note, updateList } from './bookkeeping.ts';
import type { Book } from './bookkeeping.ts';
import type { EvidenceDeps, EvidenceRequest, EvidenceRun, Subagent, SubagentName } from './ports.ts';

/** The longest wait for the 30 confirmations of the sub-delegation. A trimmed wait is never shorter than the least wait below. */
export const CONFIRMATION_WAIT_MS = DEFAULT_CONFIRMATION_WAIT_MS;
/** The least wait that makes sense for 30 confirmations: they take about two minutes, so a shorter wait would end before the gateway can issue a token. */
export const MIN_CONFIRMATION_WAIT_MS = 180_000;
/** The longest time that the subagent keeps asking while the gateway says that the delegation is too young: the gateway reads the ledger by itself, and it may see the 30 confirmations later than this agent. */
export const TOKEN_PATIENCE_MS = 120_000;
/** The longest time of the job under the sub-delegation: the patience, one token request, and one call of the system with room to spare. */
export const JOB_TIMEOUT_MS = 240_000;
/** The longest time of the end step of the sub-delegation: the default of the access folder. */
export const END_TIMEOUT_MS = DEFAULT_END_TIMEOUT_MS;
/** The time that the sub-delegation stays valid after its job: it ends by itself then, when its end step failed and the janitor did not end it. */
export const VALIDITY_SLACK_MS = 300_000;
/** The least time that a read needs from its start to the end of its end step: 540,000 ms. A read with less time left is `deadline`, and it sends nothing. */
export const LEAST_READ_MS = MIN_CONFIRMATION_WAIT_MS + JOB_TIMEOUT_MS + END_TIMEOUT_MS;

/**
 * The codes that this folder gives itself, for the two reads. `mock_system_failed` is the one code for every answer of a system that is not a document and not one of `MOCK_CODES`.
 * `sub_delegation_not_ended` is for an evidence that stops because the first sub-delegation did not end: it may be alive, and the janitor ends it.
 */
const OWN_FAILURES = [
  'record_read_timeout', 'guideline_read_timeout', 'record_set_invalid', 'guideline_invalid', 'mock_system_failed', 'sub_delegation_not_ended', 'deadline', 'aborted', 'internal',
] as const;

/**
 * The codes of a mock system that a read passes on as its reason, and no other code of a mock system: the two codes for an id that the system does not know, and the five refusals of the credential of a token
 * route, which are the codes that the mock gives with the status 401 or 403 for a token (`tokenRefusal` of its identity source). Every other code of a mock system, also its `internal`, `bad_request`,
 * `ledger_unavailable` and `tenant_not_found`, is `mock_system_failed`: a code of a mock system must never look like a code of this agent.
 */
export const MOCK_CODES = ['order_not_found', 'guideline_not_found', 'token_invalid', 'not_covered', 'delegation_ended', 'chain_too_deep', 'actor_not_active'] as const;
const PASSED_ON: ReadonlySet<string> = new Set(MOCK_CODES);

/**
 * Every code that `readEvidence` gives as the reason of a failed read, and no other code: the own codes, the codes of a mock system that a read passes on (`MOCK_CODES`), `sub_delegation_` and the code of the
 * access folder for the failure of a sub-delegation, and `token_` and the code of the access folder for the failure of a token. The name of the subagent is in the log and not in the code.
 */
export const EVIDENCE_FAILURES: readonly string[] = Object.freeze([
  ...OWN_FAILURES,
  ...MOCK_CODES,
  ...SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`),
  ...GATEWAY_FAILURES.map((code) => `token_${code}`),
]);

/**
 * How the sub-delegation of a read ended. `ended`: the ledger no longer shows it. `not_made`: nothing of the read is on the ledger and nothing can land. `not_ended`: it may be alive, and its entry is in the
 * list of left sub-delegations for the janitor.
 */
export type EndState = SubDelegationEnd['state'];

/** What one read gives: the parsed document with the end of its sub-delegation, or the code of the failure. */
export type SubreadResult<T> = { readonly ok: true; readonly value: T; readonly end: EndState } | { readonly ok: false; readonly code: string };

/** What the job under the sub-delegation gives: the parsed document, or the code of the failure. */
type JobResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

/**
 * What a read of the evidence is made of. `name` is the name of the subagent, which the log shows. `target` is the route, its action and its resource, and `parse` is the parser of the body that the system
 * gives. `timeoutCode` is the code for a job that ran out of time, and `invalidCode` is the code for a body that `parse` refuses. A code that has not the form of a code becomes `internal`.
 */
export interface SubreadSpec<T> {
  readonly name: SubagentName;
  readonly subagent: Subagent;
  readonly target: TokenTarget;
  readonly timeoutCode: string;
  readonly invalidCode: string;
  parse(body: unknown): ProtocolResult<T>;
}

/** A code with the form of a code: lower-case letters, digits and `_`, 64 characters at most. Any other text, such as the words of a system, becomes `internal`. */
const CODE_FORM = /^[a-z0-9_]{1,64}$/;

/**
 * The result of a failed read. It writes one line to the log, which names the subagent and holds the code and nothing else, and it gives the code. A code that has not the form of a code is `internal`. The
 * reason of a failed job does not name the subagent, so this line tells an operator which of the two reads failed.
 */
export function failedRead(deps: EvidenceDeps, name: SubagentName, code: unknown): { readonly ok: false; readonly code: string } {
  const checked = typeof code === 'string' && CODE_FORM.test(code) ? code : 'internal';
  note({ deps, name }, `the read failed with ${checked}`);
  return { ok: false, code: checked };
}

/** The caller hung up before a step of the job started. */
class HungUp extends Error {}

/**
 * The reason of a call that the system refused or failed: the code of the system when it is one of `MOCK_CODES`, and `mock_system_failed` for any other code and for no code. A refusal has its code in
 * `reason`, and a failure has it in `systemCode`.
 */
function reasonOf(answer: SystemRefused | SystemFailed): string {
  const code = answer.code === 'refused_by_system' ? answer.reason : answer.systemCode;
  return code !== null && PASSED_ON.has(code) ? code : 'mock_system_failed';
}

/**
 * The job of the subagent: a token for the route under the sub-delegation, the call of the system, and the parser of the body. The gateway may need some time to see the 30 confirmations, so a token request
 * that gets `delegation_too_young` is asked again for the patience of the job. A call is made once. A job that ran past its time makes no further request: the sub-delegation is ended by then. A job whose
 * caller hung up makes no further request either, and it gives `aborted`. The token is the token of the SUBAGENT: `requestSubagentToken` takes the DID and the keys of the subagent and the id of its
 * sub-delegation, and this folder holds no other key.
 */
async function readJob<T>(deps: EvidenceDeps, run: EvidenceRun, spec: SubreadSpec<T>, handle: SubDelegationHandle): Promise<JobResult<T>> {
  let token: RouteTokenResult;
  try {
    token = await askWhileTooYoung(
      deps.clock,
      () => {
        if (run.signal?.aborted === true) throw new HungUp();
        return requestSubagentToken(deps.tokens, {
          target: spec.target,
          subagent: { did: spec.subagent.did, authenticationKey: spec.subagent.authenticationKey, delegationKey: spec.subagent.delegationKey },
          subDelegation: handle.id,
        });
      },
      { waitMs: TOKEN_PATIENCE_MS, pollMs: DEFAULT_POLL_MS },
    );
  } catch (error) {
    if (error instanceof HungUp) return { ok: false, code: 'aborted' };
    throw error;
  }
  if (token.ok !== true) return { ok: false, code: `token_${token.code}` };
  if (handle.signal.aborted) throw new Error('the time of the job ended');
  if (run.signal?.aborted === true) return { ok: false, code: 'aborted' };
  const answer = await callWithToken(deps.calls, token.value, spec.target);
  if (answer.ok !== true) return { ok: false, code: reasonOf(answer) };
  const parsed = spec.parse(answer.body);
  return parsed.ok === true ? { ok: true, value: parsed.value } : { ok: false, code: spec.invalidCode };
}

/** The read, with the codes as the job and the sub-delegation give them. `readThroughSubagent` checks the form of the code. */
async function readUnder<T>(book: Book, request: EvidenceRequest, run: EvidenceRun, spec: SubreadSpec<T>): Promise<SubreadResult<T>> {
  const { deps } = book;
  if (run.signal?.aborted === true) return { ok: false, code: 'aborted' };
  const left = Math.floor(run.deadline - deps.clock.now());
  if (!(left >= LEAST_READ_MS)) return { ok: false, code: 'deadline' };
  const confirmationWaitMs = Math.min(CONFIRMATION_WAIT_MS, left - JOB_TIMEOUT_MS - END_TIMEOUT_MS);
  const { key } = request;
  const sent: { id: DelegationId | null } = { id: null };
  try {
    const result = await withSubDelegation(
      { ...deps.subDelegation, walletQueue: key.queue, beforeSend: beforeSendOf(book, key.signer.keyHash, sent) },
      {
        target: spec.target,
        parent: request.delegation,
        agent: { signer: key.signer, walletAddress: key.walletAddress },
        subagent: { did: spec.subagent.did, signer: spec.subagent.signer },
        validForMs: confirmationWaitMs + JOB_TIMEOUT_MS + VALIDITY_SLACK_MS,
      },
      { jobTimeoutMs: JOB_TIMEOUT_MS, confirmationWaitMs, endTimeoutMs: END_TIMEOUT_MS },
      (handle) => readJob(deps, run, spec, handle),
    );
    await updateList(book, sent.id, key.signer.keyHash, result.end);
    if (result.kind === 'returned') return result.value.ok ? { ok: true, value: result.value.value, end: result.end.state } : result.value;
    if (result.kind === 'timed_out') return { ok: false, code: spec.timeoutCode };
    if (result.kind === 'threw') return { ok: false, code: 'internal' };
    return { ok: false, code: `sub_delegation_${result.failure.code}` };
  } finally {
    leave(book, sent.id);
  }
}

/**
 * Reads one document through one subagent, and ends the sub-delegation. The sub-delegation is made by the delegation key of this agent (`request.key`) and the delegation key of the subagent, and the records of
 * the sub-delegation are kept as the head of `bookkeeping.ts` says. The result is the parsed document with the end of its sub-delegation, or the code of the failure: `aborted` for a caller that hung up
 * before the read started, `deadline` for a read that has not the least time, a code of the sub-delegation, the code of the token, a code of `MOCK_CODES` or `mock_system_failed` for a refusal or a failure of
 * the call, the invalid code of the spec for a body that the parser refuses, the timeout code of the spec for a job that ran out of time, and `internal` for a job that threw. A failed read writes one line to
 * the log, and it makes no read after it. A throw of the code of the sub-delegation itself is not hidden: the id leaves the set of the sub-delegations in use, and the entry stays for the janitor.
 */
export async function readThroughSubagent<T>(deps: EvidenceDeps, request: EvidenceRequest, run: EvidenceRun, spec: SubreadSpec<T>): Promise<SubreadResult<T>> {
  const result = await readUnder({ deps, name: spec.name }, request, run, spec);
  return result.ok ? result : failedRead(deps, spec.name, result.code);
}
