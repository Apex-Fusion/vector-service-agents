// agents/prior-authorization-agent/src/propose/propose.ts
// The job `propose` of the Prior Authorization Agent (use case 2, prior authorization). It reads the delegation, finds the paying key, reads the advert of the insurer, gets the records and the guideline through
// the evidence port, asks the model for the justification, builds the authorization request, and returns the proposal. Nothing is paid here. The hirer reads the request and approves its digest, and `execute`
// then submits it.
//
// The steps, in this order. A failure of a step is a typed result: `failedProposalResult` with a code, and no step reads success from a text.
//   1. The authority. A delegation that names another agent as its delegate is a refusal that the service answers with its status (`ProposeRefusal`, `delegation_not_mine`). A delegation that the ledger does not
//      show goes on, because the ledger decides when the request is paid. A ledger that cannot be read is `failed` `ledger_unavailable`.
//   2. The paying key: the delegate key of the delegation, found among the delegation keys of this agent. The evidence cannot make a sub-delegation without it, and nothing is sent: `ledger_unavailable` for a
//      ledger that cannot be read, `delegation_not_found` for a delegation that the ledger does not show, `delegation_key_unknown` for a key that this agent does not hold.
//   3. The insurer. It is read before anything is sent to the chain, so an insurer that is not listed costs nothing. A failure is `failed` with the code of the reader. The reference of the advert that the
//      reader gives must be a reference of an output that the protocol takes: else `failed` `internal`, and nothing is read, hired or counted for it.
//   4. The evidence: the record set of the order and the guideline of its service. It gets a deadline that leaves the decision its time (`DECISION_RESERVE_MS`). A failure is `failed` with its code. The job then
//      checks the two documents itself with the parsers of the kit, and it checks that the record set is the set of the order that the request names (`record_set_mismatch`) and that the guideline is the
//      guideline of the service of that order (`guideline_mismatch`). It keeps its own copies of the two documents: the values of the request and the hash of the record set come from the copies, which it
//      reads before the decision starts. Last, it makes a trial of the request with a stand-in number, a stand-in justification and no references. A record that the kit refuses in a request (a diagnosis code
//      with a tab or a format character is one) is `failed` `bad_document` here, before the model is hired and before a number is taken.
//   5. The decision `justification`, once, with the record set and the guideline that the job checked. A failure gives `failed` with its code and no decision. The request is built from the choice only when it
//      EQUALS the choice that the decision records: no code changes what the model chose, and a difference is `failed` `decision_mismatch`. The equality is the equality of the canonical forms. The result keeps
//      the decision with its choice as the decision records it, each text as the model wrote it, and the request is built from that copy: the request parser makes the NFC copy. A reference of the choice that
//      names no record of the set and no criterion of the guideline is `failed` `bad_document`: the decision checks the references too, and the job does not rely on that. The decision is kept in the result
//      when a later step fails.
//   6. The request. The number comes from the counter, which stores it before this step uses it. The document must be accepted by `parsePriorAuthRequest`.
//
// Every answer of a port is read one time. The job keeps what it read in constants and never goes back to an object of a port, because a port could change its objects while the job waits for the next port.
// The record set, the guideline and the choice that the job uses are copies that it checked.
//
// Time. Every wait of the job is bounded by the deadline: `PROPOSE_DEADLINE_MS` after the arrival of the job. A call of a port that would start after it is not made. A caller that hangs up stops the job before
// its next step: no step starts after that.
import { within } from '@vsa/usecase-kit/access';
import { checkAuthority, failedProposalResult, proposedResult } from '@vsa/usecase-kit/buyer';
import type { ProposalPieces } from '@vsa/usecase-kit/buyer';
import { PRIORAUTH_REQUEST_SCHEMA, parseGuideline, parsePriorAuthRequest, parseRecordSet, recordSetSha256, requestNumberOf } from '@vsa/usecase-kit/priorauth';
import { ERROR_STATUS, canonicalJson, isPlainObject, parseJsonValue, parseOutputRef } from '@vsa/usecase-kit/protocol';
import type { Decision, ProposalResult } from '@vsa/usecase-kit/protocol';
import type { DelegationKey, ProposeDeps, ProposeRequest } from './ports.ts';

/** The job deadline of the Prior Authorization Agent: the time from the arrival of a job to the end of every wait of `propose`, in milliseconds. */
export const PROPOSE_DEADLINE_MS = 1_620_000;

/** The time that the job keeps for the decision, in milliseconds. The evidence gets a deadline that is this much earlier than the deadline of the job, so a read never starts when it would eat this time. */
export const DECISION_RESERVE_MS = 300_000;

/**
 * Every code that `runPropose` gives as the reason of a failed proposal, except the codes that pass through from the evidence, from the decision and from a mock system. The codes of the evidence are the
 * failures of its two sub-delegations (`sub_delegation_` and a code of the access folder), of its two tokens (`token_` and a code of the gateway), and its own codes. The insurer codes are the two that the
 * reader of the insurer gives, and the job passes them on.
 */
export const PROPOSE_FAILURES: readonly string[] = Object.freeze([
  'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'insurer_not_listed', 'insurer_unavailable', 'record_set_mismatch', 'guideline_mismatch', 'decision_mismatch', 'bad_document',
  'store_write_failed', 'deadline', 'aborted', 'internal',
]);

const TENANT_RULE = 'request.tenant must be 1 to 48 characters: lower-case letters, digits and hyphens, and it starts with a letter or a digit';

/** The justification of the trial of the request before the decision. The real justification is the choice of the model, and the trial checks the members that the model does not write. */
const STAND_IN_JUSTIFICATION = 'A stand-in text for the trial of the request. The decision writes the real justification.';

/**
 * A request that the job refuses before it does anything: a delegation that names another agent (`delegation_not_mine`), and a request that cannot be served (`bad_shape`). The status is the status of the
 * code in `ERROR_STATUS`. The message names the member and never repeats a value of the request.
 */
export class ProposeRefusal extends Error {
  readonly code: 'delegation_not_mine' | 'bad_shape';
  readonly status: number;

  constructor(code: 'delegation_not_mine' | 'bad_shape', message: string) {
    super(message);
    this.name = 'ProposeRefusal';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/** What one job knows from its start: its deps, its deadline and the signal of the caller. */
interface Run {
  readonly deps: ProposeDeps;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
}

/** The answer of one call of a port: its value, a throw, or the end of the time. */
type Attempt<T> = { readonly state: 'value'; readonly value: T } | { readonly state: 'threw' } | { readonly state: 'timed_out' };

/**
 * Runs a call of a port and gives its answer. The call is bounded by the time that is left until the deadline, and it is not made when no time is left. A throw is `threw`, and the words of the error are
 * dropped: they could repeat a part of a record.
 */
async function attempt<T>(run: Run, call: () => Promise<T>): Promise<Attempt<T>> {
  const left = Math.min(run.deadline - run.deps.clock.now(), PROPOSE_DEADLINE_MS);
  if (!(left >= 1)) return { state: 'timed_out' };
  try {
    const bounded = await within(run.deps.clock, left, () => call());
    return bounded.timedOut ? { state: 'timed_out' } : { state: 'value', value: bounded.value };
  } catch {
    return { state: 'threw' };
  }
}

/** A code with the form of a code: lower-case letters, digits and `_`, 64 characters at most. Any other text, such as the words of a port, becomes `internal`. */
const CODE_FORM = /^[a-z0-9_]{1,64}$/;

/** The pieces of a proposal result: the decisions so far and the sub-jobs that bought them. The service stamps `fault_mode` on every result, so the job writes the empty text. */
function piecesOf(decisions: readonly Decision[]): ProposalPieces {
  return { use_case: 'prior-authorization', decisions, sub_jobs: decisions.map((decision) => decision.inference.sub_job), fault_mode: '' };
}

/** True when a decision holds the sub-job that bought it, which `sub_jobs` of the result lists. */
function isDecision(value: unknown): value is Decision {
  if (typeof value !== 'object' || value === null) return false;
  const inference: unknown = Reflect.get(value, 'inference');
  if (typeof inference !== 'object' || inference === null) return false;
  const subJob: unknown = Reflect.get(inference, 'sub_job');
  return typeof subJob === 'object' && subJob !== null;
}

/** The reference of the advert that the reader of the insurer gave, as a reference of an output that the protocol takes, or `null` when the answer is not an object with such a reference. */
function advertRefOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const reference = parseOutputRef(Reflect.get(value, 'advert_ref'), 'advert_ref');
  return reference.ok ? reference.value : null;
}

/** True when `value` is a list of texts and each text is one of `ids`. A reference to a record or a criterion that the job did not read would put a false statement into the request. */
function namesOnly(value: unknown, ids: ReadonlySet<string>): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && ids.has(entry));
}

/** Writes one line to the log of the deps. A log that throws changes no result: the line is lost, and the job goes on. */
function note(deps: ProposeDeps, line: string): void {
  try {
    deps.log(line);
  } catch {
    // The line is lost. The result of the job does not depend on it.
  }
}

/**
 * Runs `propose` for a request that the service parsed. It returns the proposal, or a failed proposal with a code. It throws `ProposeRefusal` for a request that it refuses before it does anything. `arrivedAt`
 * is the time that the job arrived, by the clock of the deps, and the deadline of every wait is `PROPOSE_DEADLINE_MS` after it. `signal` aborts when the caller hangs up: no read, request, call or hire starts
 * after that, and a decision that was already paid for is kept in the result.
 */
export async function runPropose(deps: ProposeDeps, request: ProposeRequest, arrivedAt: number, signal?: AbortSignal): Promise<ProposalResult> {
  const tenant = request.tenant;
  const orderId = request.order_id;
  const insurerDid = request.insurer_did;
  const delegation = request.authority.delegation;
  let standInNumber: string;
  try {
    standInNumber = requestNumberOf(tenant, 0);
  } catch {
    note(deps, 'propose refused at intake: bad_shape');
    throw new ProposeRefusal('bad_shape', TENANT_RULE);
  }
  const run: Run = { deps, deadline: arrivedAt + PROPOSE_DEADLINE_MS, signal };
  let decisions: readonly Decision[] = [];
  /** The failed result for a step. The reason is the code, or `internal` for any text that is not a code. The decisions so far stay in the result. */
  const failed = (step: string, code: unknown): ProposalResult => {
    const reason = typeof code === 'string' && CODE_FORM.test(code) ? code : 'internal';
    note(deps, `propose stopped at ${step}: ${reason}`);
    return failedProposalResult(piecesOf(decisions), reason);
  };
  /** The failed result for a call that gave no value: the deadline came first, or the call threw and `threw` is the code for it. */
  const lost = (step: string, answer: Attempt<unknown>, threw: string): ProposalResult => failed(step, answer.state === 'timed_out' ? 'deadline' : threw);
  /** The failed result for a job that must not start another step: the caller hung up, or the deadline came. A NaN clock or deadline counts as the deadline. */
  const stopped = (step: string): ProposalResult | null => {
    if (signal?.aborted === true) return failed(step, 'aborted');
    return deps.clock.now() < run.deadline ? null : failed(step, 'deadline');
  };

  // 1. The authority.
  const beforeAuthority = stopped('authority');
  if (beforeAuthority !== null) return beforeAuthority;
  const authority = await attempt(run, () => checkAuthority(deps.reads, deps.agent.did, delegation));
  if (authority.state !== 'value') return lost('authority', authority, 'internal');
  const checked = authority.value;
  if (checked.ok !== true) {
    if (checked.code === 'ledger_unavailable') return failed('authority', 'ledger_unavailable');
    note(deps, `propose refused at authority: ${checked.code}`);
    throw new ProposeRefusal(checked.code, checked.detail);
  }

  // 2. The paying key.
  const beforeKey = stopped('paying_key');
  if (beforeKey !== null) return beforeKey;
  const keyHash = await attempt(run, () => deps.delegateKeyOf(delegation));
  if (keyHash.state !== 'value') return lost('paying_key', keyHash, 'ledger_unavailable');
  if (keyHash.value === null) return failed('paying_key', 'delegation_not_found');
  let key: DelegationKey | null;
  try {
    key = typeof keyHash.value === 'string' ? deps.delegationKeys.find(keyHash.value) : null;
  } catch {
    return failed('paying_key', 'internal');
  }
  if (key === null || key === undefined) return failed('paying_key', 'delegation_key_unknown');

  // 3. The insurer.
  const beforeInsurer = stopped('insurer');
  if (beforeInsurer !== null) return beforeInsurer;
  const insurerRead = await attempt(run, () => deps.readInsurer(insurerDid));
  if (insurerRead.state !== 'value') return lost('insurer', insurerRead, 'internal');
  const read = insurerRead.value;
  if (typeof read !== 'object' || read === null) return failed('insurer', 'internal');
  if (read.ok !== true) return failed('insurer', read.code);
  const advertRef = advertRefOf(read.value);
  if (advertRef === null) return failed('insurer', 'internal');

  // 4. The evidence.
  const beforeEvidence = stopped('evidence');
  if (beforeEvidence !== null) return beforeEvidence;
  const evidenceDeadline = arrivedAt + PROPOSE_DEADLINE_MS - DECISION_RESERVE_MS;
  const evidence = await attempt(run, () => deps.evidence({ tenant, order_id: orderId, delegation, key }, { deadline: evidenceDeadline, signal }));
  if (evidence.state !== 'value') return lost('evidence', evidence, 'internal');
  const answered = evidence.value;
  if (typeof answered !== 'object' || answered === null) return failed('evidence', 'internal');
  if (answered.ok !== true) return failed('evidence', answered.code);
  const givenSet: unknown = answered.record_set;
  const givenGuideline: unknown = answered.guideline;
  // The two documents are copies that the parsers of the kit made: from here on the job reads these copies, and never the objects of the port.
  const set = parseRecordSet(givenSet);
  const guideline = parseGuideline(givenGuideline);
  if (!set.ok || !guideline.ok) return failed('evidence', 'internal');
  const order = set.value.order;
  if (order.order_id !== orderId) return failed('evidence', 'record_set_mismatch');
  if (guideline.value.code !== order.service_code) return failed('evidence', 'guideline_mismatch');
  // The request gets these values from the checked order, and the hash of the set that the decision gets. They are read here, before the decision, because the decision could change the objects that it is given.
  const patientRef = order.patient_ref;
  const clinicianRef = order.ordering_clinician_ref;
  const serviceCode = order.service_code;
  const diagnosisCodes = [...order.diagnosis_codes];
  // The ids that the references of the choice must name. They are read here, before the decision, for the same reason.
  const recordIds: ReadonlySet<string> = new Set(set.value.records.map((record) => record.record_id));
  const criterionIds: ReadonlySet<string> = new Set(guideline.value.criteria.map((criterion) => criterion.id));
  let setSha256: string;
  try {
    setSha256 = recordSetSha256(set.value);
  } catch {
    return failed('evidence', 'bad_document');
  }
  /**
   * The request for a number, a justification and the two lists of references. The trial before the decision and the last request come from this one function, so they never differ in a member that the
   * decision does not write.
   */
  const requestWith = (requestNumber: string, justification: unknown, guidelineRefs: unknown, recordRefs: unknown): unknown => ({
    schema: PRIORAUTH_REQUEST_SCHEMA,
    request_number: requestNumber,
    tenant,
    order_id: orderId,
    patient_ref: patientRef,
    ordering_clinician_ref: clinicianRef,
    service_code: serviceCode,
    diagnosis_codes: diagnosisCodes,
    justification,
    guideline_refs: guidelineRefs,
    record_refs: recordRefs,
    record_set_sha256: setSha256,
    insurer_did: insurerDid,
    advert_ref: advertRef,
  });
  // The members that the decision does not write must make a request that the kit takes. The job checks them now, with a stand-in for the number, the justification and the references, because a record that
  // the kit refuses in a request (a diagnosis code with a tab or a format character is one) would be found after the model was hired and a number was taken.
  if (!parsePriorAuthRequest(requestWith(standInNumber, STAND_IN_JUSTIFICATION, [], [])).ok) return failed('evidence', 'bad_document');

  // 5. The decision.
  const beforeDecision = stopped('decision');
  if (beforeDecision !== null) return beforeDecision;
  const decided = await attempt(run, () => deps.justify(set.value, guideline.value));
  if (decided.state !== 'value') return lost('decision', decided, 'internal');
  const answer = decided.value;
  if (typeof answer !== 'object' || answer === null) return failed('decision', 'internal');
  if (answer.ok !== true) return failed('decision', answer.code);
  const decision: unknown = answer.decision;
  const choice: unknown = answer.choice;
  if (!isDecision(decision)) return failed('decision', 'internal');
  decisions = [decision];
  // The request is built from the choice only when it is the choice that the decision records: no code changes what the model chose. Both choices are copies that the job checks, each text as it came: the
  // decision records the text as the model wrote it, and the result keeps it so. The comparison is the comparison of the canonical forms, which write each text in the NFC form.
  const typed = parseJsonValue(choice, 'choice');
  const written = parseJsonValue(decision.choice, 'decision.choice');
  if (!typed.ok || !written.ok) return failed('decision', 'bad_document');
  const typedText = canonicalJson(typed.value, 'choice');
  const writtenText = canonicalJson(written.value, 'decision.choice');
  if (typedText.ok !== true || writtenText.ok !== true) return failed('decision', 'bad_document');
  if (typedText.value !== writtenText.value) return failed('decision', 'decision_mismatch');
  // From here on the job uses the copy of the recorded choice, and never an object of the port: the port could change its objects while the job waits for the number. The request parser makes the NFC copy.
  const chosen = written.value;
  if (!isPlainObject(chosen)) return failed('decision', 'bad_document');
  decisions = [{ ...decision, choice: chosen }];
  // The request cites only records of the set and criteria of the guideline that the job checked. This check comes before the number: a reference to a record that does not exist would put a false statement
  // into a request that the hirer approves.
  if (!namesOnly(chosen.record_refs, recordIds) || !namesOnly(chosen.guideline_refs, criterionIds)) return failed('decision', 'bad_document');

  // 6. The request.
  const beforeNumber = stopped('request');
  if (beforeNumber !== null) return beforeNumber;
  const counted = await attempt(run, () => deps.counter.next(tenant));
  if (counted.state !== 'value') return lost('request', counted, 'store_write_failed');
  const counter: unknown = counted.value;
  // The counter 0 is the number that no request has, so a counter that gives it is wrong.
  if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 1) return failed('request', 'internal');
  let requestNumber: string;
  try {
    requestNumber = requestNumberOf(tenant, counter);
  } catch {
    return failed('request', 'internal');
  }
  const parsed = parsePriorAuthRequest(requestWith(requestNumber, chosen.justification, chosen.guideline_refs, chosen.record_refs));
  if (!parsed.ok) return failed('request', 'bad_document');
  const result = proposedResult(parsed.value, piecesOf(decisions));
  if (result.outcome !== 'proposed') note(deps, `propose stopped at request: ${result.reason}`);
  return result;
}
