// agents/prior-authorization-agent/src/execute/execute.ts
// The job `execute` of the Prior Authorization Agent (use case 2, prior authorization). It submits the authorization request that the hirer approved: it pays the advert of the Insurer Intake Agent that the request
// names, from the vault of the delegation, sends the handoff, decides whether the intake record is the one it paid for, and writes the submission to the records system. Every end is a typed result of the protocol.
// The steps, in order:
//   1. The settings: the three limits and the DID of the agent. A wrong setting stops the job here, before any read and before any Pay.
//   2. The request document must be an authorization request (`bad_document` otherwise). The target of the records write needs its order id, so it is made here, and a wrong base of the mock service is a wrong setting
//      too. The request must name the tenant of the job (`request_not_for_tenant` otherwise), because the records system takes a request for the tenant of its URL only.
//   3. The authority: a delegation that names another agent is a refusal for the server (`delegation_not_mine`). A delegation that the ledger does not show goes on, and the ledger refuses the Pay.
//   4. The delegation key: the key that the delegation names pays. A key that the agent does not hold is `delegation_key_unknown`. A ledger that cannot be read is `ledger_unavailable`.
//   5. The handoff, with the document, the salt and the approval as the request gave them. A null approval goes on: the Insurer Intake Agent refuses it. With the fault `alter_after_approval` on, the handoff then gets
//      a document with another last sentence of the justification: the digest is not checked again, so the Insurer Intake Agent sees a document that is not the approved one. The fault switch is read here, one time.
//   6. One hire (`hireCounterparty`): one Pay, no retry and no second hire. The decision on the delivery is `judgeDelivery`. It compares the hash of the document IN THE HANDOFF.
//   7. The end of the hire becomes a result:
//        completed                          the submission is written to the records system: 201 is `completed`, a refusal is `refused_by_system`, any other end is `failed`
//        not_accepted, declined_by_model    a challenge against the open claim of the Insurer Intake Agent, with the evidence: `disputed` (Escalated), or `disputed` (Failed) when none is filed
//        not_accepted, any other reason     `failed` with that reason, and no challenge
//        refused_by_counterparty            `refused_by_counterparty`, with the exit state that `exitStateOf` gives
//        vault_refused                      `vault_refused`, and Cancelled when the delegation was ended
//        failed, interrupted, pay_unconfirmed   `failed`
//        refused                            a refusal for the server
// The submission is written only after a `completed` hire whose decision is the acceptance of the model. A refused or failed payment is never `completed`. The field `fault_mode` of a result is not written here:
// the service stamps it on every result.
import { callWithToken, requestRouteToken, tokenTarget } from '@vsa/usecase-kit/access';
import type { SystemResult, TokenTarget } from '@vsa/usecase-kit/access';
import { BAD_DOCUMENT, INCONSISTENT_OUTCOME, checkAuthority, checkLimits, completedResult, disputedResult, failedResult, handoffOf, hireCounterparty, refusedResult, settledResult } from '@vsa/usecase-kit/buyer';
import type { CompletedStep, HireDeps, HireLimits, HireStep, NotAcceptedStep, RefusedCode, ResultPieces, VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { disputedFields } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, DisputeOutcome } from '@vsa/usecase-kit/dispute';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS, parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { IntakeRecord, PriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import { ERROR_STATUS, canonicalSha256, isPlainObject, parseDid, parseHandoff } from '@vsa/usecase-kit/protocol';
import type { Decision, Did, ExecuteRequest, ExecuteResult, Handoff, HandoffRecord, ProtocolResult, WriteRecord } from '@vsa/usecase-kit/protocol';
import { flatText } from '@vsa/service-kit/text';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { NOT_ACCEPTED, judgeDelivery } from './decision.ts';
import type { Learned } from './decision.ts';
import { disputeDelivery } from './dispute.ts';
import { alterJustification } from './fault.ts';
import type { DelegationKeyDeps, ExecuteDeps } from './ports.ts';

/** The job of the Prior Authorization Agent ends 1,620,000 ms after its request arrived: 27 minutes, inside the window of its advert. */
export const JOB_DEADLINE_MS = 1_620_000;

/**
 * A request that the job refuses before it pays: a delegation that names another agent (400), a request that is too large (400), and a setting of the agent that is wrong (500). The service answers with `code`
 * and `status`. No Pay was made.
 */
export class ExecuteRefusal extends Error {
  readonly code: RefusedCode;
  readonly status: number;

  constructor(code: RefusedCode, detail: string) {
    super(detail);
    this.name = 'ExecuteRefusal';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

const USE_CASE = 'prior-authorization';
const RECORDS_SYSTEM = 'records';
const SUBMISSION_ROUTE = 'POST /records/orders/{order_id}/submission';
/** The status of a submission that the records system recorded. */
const SUBMISSION_RECORDED = 201;
/** A reference of the records system that a result may hold: an identifier of at most 128 characters. Any other value of the answer is not kept. */
const RECORD_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The most characters of the draft of a refused Pay that one log line holds. */
const DRAFT_LOG_CHARS = 20_000;
/** The reason of a challenge whose dispute folder threw: a transaction may have landed, and the job cannot say which. */
const PORT_ERROR = 'port_error';

/** The codes of a `failed` result that this job writes itself. The hire flow and the decision write others, and the hire kit names the rest. */
const FAILED = {
  aborted: 'aborted',
  keyUnknown: 'delegation_key_unknown',
  ledger: 'ledger_unavailable',
  notRecordable: 'delivery_not_recordable',
  timeout: 'decision_timeout',
  token: 'token_failed',
  system: 'mock_system_failed',
  tenant: 'request_not_for_tenant',
} as const;

/**
 * Every code that `runExecute` writes itself as the reason of a result, for the page of the agent. The codes that pass through are not here: the codes of the hire flow (the refusals of the counterparty, the
 * refusals of the vault, `deadline`, `no_live_vault`, `advert_not_counterparty` and the rest), the codes of the dispute folder (for a challenge that is not filed), and the codes of the records system (for a
 * submission that it refuses). A request that the job refuses with an error for the server (`ExecuteRefusal`) has a code of the protocol and no reason.
 */
export const EXECUTE_REASONS: readonly string[] = Object.freeze([
  ...Object.values(FAILED), BAD_DOCUMENT, INCONSISTENT_OUTCOME, NOT_ACCEPTED.invalid, NOT_ACCEPTED.notForRequest, NOT_ACCEPTED.failed, PORT_ERROR,
]);

function piecesOf(request: ExecuteRequest, decisions: readonly Decision[] = [], writes: readonly WriteRecord[] = []): Omit<ResultPieces, 'handoff'> {
  return { use_case: USE_CASE, proposal_digest: request.proposal.proposal_digest, writes, decisions, fault_mode: '' };
}

/** The decision of the model that the job paid for, when the model made one: its acceptance and its no. */
function decisionsOf(learned: Learned | null): readonly Decision[] {
  return learned !== null && (learned.said === 'accepted' || learned.said === NOT_ACCEPTED.declined) ? [learned.decision] : [];
}

/** A log that never throws: a function that fails to log changes no result. */
function noteOf(log: ExecuteDeps['log']): (line: string) => void {
  return (line) => {
    try {
      log(line);
    } catch {
      // The line is lost, and the job goes on.
    }
  };
}

interface Settings {
  readonly limits: HireLimits;
  readonly agent: Did;
}

/** The settings that the job needs before it reads the document, as checked values. A wrong one is a fault of the service, and it is found before any read and before any Pay. */
function settingsOf(deps: ExecuteDeps): Settings {
  const limits = checkLimits(deps.limits);
  if (!limits.ok) throw new ExecuteRefusal('internal', limits.detail);
  const agent = parseDid(deps.agent.did, 'agent.did');
  if (!agent.ok) throw new ExecuteRefusal('internal', agent.detail);
  return { limits: limits.value, agent: agent.value };
}

/** The target of the write to the records system. A wrong base of the mock service is a fault of the service: it stops the job before any read and before any Pay. */
function targetOf(deps: ExecuteDeps, request: ExecuteRequest, document: PriorAuthRequest): TokenTarget {
  const target = tokenTarget(deps.calls.bases, request.tenant, 'records.submission', { order_id: document.order_id });
  if (!target.ok) throw new ExecuteRefusal('internal', `the write to the records system has no target: ${target.detail}`);
  return target.value;
}

/**
 * The delegation key that pays: the key that the delegation names as its delegate key. A delegation that the ledger does not show has none, and the first key of the agent goes on: it finds no Live vault of that
 * delegation, the flow ends with a typed result, and the ledger decides what is paid.
 */
async function keyOfDelegation(deps: ExecuteDeps, request: ExecuteRequest): Promise<{ readonly ok: true; readonly entry: DelegationKeyDeps } | { readonly ok: false; readonly code: string }> {
  let hash: string | null;
  try {
    hash = await deps.delegateKeyOf(request.authority.delegation);
  } catch {
    return { ok: false, code: FAILED.ledger };
  }
  if (hash === null) return { ok: true, entry: deps.delegationKeys.first };
  const entry = deps.delegationKeys.find(hash);
  return entry === null ? { ok: false, code: FAILED.keyUnknown } : { ok: true, entry };
}

/** The handoff with another document. The result is checked again by the parser of the protocol, and the digest of the document is not: the Insurer Intake Agent checks that. */
function withDocument(handoff: Handoff, document: PriorAuthRequest): ProtocolResult<Handoff> {
  return parseHandoff({ ...handoff, document });
}

interface Job {
  readonly deps: ExecuteDeps;
  readonly request: ExecuteRequest;
  /** The approved request document, as the job checked it. */
  readonly document: PriorAuthRequest;
  /** The handoff as it was sent: its document is the document that the Insurer Intake Agent read. It is not the approved document when the fault is on. */
  readonly sent: Handoff;
  readonly agent: Did;
  readonly target: TokenTarget;
  readonly entry: DelegationKeyDeps;
  /** What the decision on the delivery learned, read after the hire. */
  readonly learned: Learned | null;
  readonly note: (line: string) => void;
}

/** The result of one call to the records system: the record of a write, a refusal with its code, or a failure with its code. The detail is for the log: the kit writes it with no key, token or proof in it. */
type SubmissionWrite =
  | { readonly kind: 'written'; readonly record: WriteRecord }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: string }
  | { readonly kind: 'failed'; readonly code: string; readonly detail: string };

/**
 * What the call to the records system came to. Only the status 201 is a recorded submission. A refusal of the system (401 and 403) is a refusal. So is an error status below 500 with the code of a rule
 * (`duplicate_submission` is one): the request was understood and refused, and nothing was written. Any other end may have written the submission, so it is a failure.
 */
function writeOf(sent: SystemResult): SubmissionWrite {
  if (sent.ok) {
    if (sent.status !== SUBMISSION_RECORDED) return { kind: 'failed', code: FAILED.system, detail: `the records system answered ${sent.status}, and a recorded submission is ${SUBMISSION_RECORDED}` };
    const ref: unknown = isPlainObject(sent.body) ? sent.body.submission_id : undefined;
    return { kind: 'written', record: { system: RECORDS_SYSTEM, route: SUBMISSION_ROUTE, status: SUBMISSION_RECORDED, ref: typeof ref === 'string' && RECORD_REF.test(ref) ? ref : null } };
  }
  if (sent.code === 'refused_by_system') return { kind: 'refused', reason: sent.reason, detail: sent.detail };
  if (sent.status !== null && sent.status >= 400 && sent.status < 500 && sent.systemCode !== null) return { kind: 'refused', reason: sent.systemCode, detail: sent.detail };
  return { kind: 'failed', code: FAILED.system, detail: sent.detail };
}

/**
 * The submission to the records system, with a token for the route `priorauth.submit` that the delegation key of the delegation asks for. The body holds the number of the request, the id that the insurer
 * portal gave, and the status: all three come from the intake record that the model judged. One token, one call, no retry.
 */
async function writeSubmission(job: Job, record: IntakeRecord): Promise<SubmissionWrite> {
  const { deps, request, agent, target, entry, note } = job;
  const token = await requestRouteToken(deps.tokens, {
    target, holder: 'agent', subject: { did: agent, key: deps.agent.authenticationKey }, dpopKey: entry.dpopKey, delegation: request.authority.delegation,
  });
  const body = { request_number: record.request_number, intake_id: record.intake_id, status: record.status };
  const written: SubmissionWrite = token.ok ? writeOf(await callWithToken(deps.calls, token.value, target, body)) : { kind: 'failed', code: FAILED.token, detail: token.detail };
  if (written.kind === 'written') note(`execute: the records system recorded the submission (${written.record.status})`);
  else note(`execute: the submission was not recorded (${written.kind === 'refused' ? written.reason : written.code}): ${flatText(written.detail, 300)}`);
  return written;
}

/** A hire that the vault paid, whose receipt passed its checks, and that the model accepted: the submission goes to the records system, and the result says how that ended. */
async function completed(job: Job, step: CompletedStep): Promise<ExecuteResult> {
  const { request, learned, note } = job;
  if (step.booking_failed !== null) {
    note(`execute: the ledger did not book the fee of the Accept: accept transaction ${flatText(step.booking_failed.accept_tx_hash ?? 'unknown', 80)}, fee ${step.booking_failed.fee_lovelace} lovelace`);
  }
  // The Accept is made only after the decision of the model, so a completed hire has that decision on record. A hire that says completed with no such decision does not hold together: nothing is written.
  if (learned === null || learned.said !== 'accepted') return failedResult({ ...piecesOf(request, decisionsOf(learned)), handoff: step.handoff }, INCONSISTENT_OUTCOME);
  const decisions = decisionsOf(learned);
  const written = await writeSubmission(job, learned.record);
  switch (written.kind) {
    case 'written': return completedResult({ ...piecesOf(request, decisions, [written.record]), handoff: step.handoff });
    case 'refused': return refusedResult('system', { ...piecesOf(request, decisions), handoff: step.handoff }, written.reason);
    default: return failedResult({ ...piecesOf(request, decisions), handoff: step.handoff }, written.code);
  }
}

/** One line for the log about a challenge: what was filed, or why not, and each transaction that landed before the step stopped. */
function challengeLine(result: ChallengeResult): string {
  if (result.ok) return `execute: challenge filed against claim ${result.value.record.claim}, evidence ${result.value.record.evidence}, challenge ${result.value.record.challenge}`;
  const landed = [
    result.evidence === null ? null : `evidence ${result.evidence.tx_hash}`,
    result.sent === null ? null : `sent ${result.sent.tx_hash} (may land ${result.sent.may_land}, valid to ${result.sent.valid_to})`,
    result.challenge === null ? null : `challenge ${result.challenge.challenge} against claim ${result.challenge.claim}`,
    result.wrong_document === null ? null : `document ${result.wrong_document.tx_hash}`,
  ].filter((piece) => piece !== null);
  return `execute: challenge not filed (${result.code})${landed.length === 0 ? ', nothing landed' : `, landed: ${landed.join('; ')}`}`;
}

/**
 * The model did not accept the delivery. The job files a challenge against the open claim of the Insurer Intake Agent: its capability, the second statement of its claim, the delegation keys of this agent as the
 * buyer of the escrow, and the evidence with the request that was sent, the intake record and the hash that the receipt commits to. The result is the one that the dispute folder gives: `disputed` with the
 * challenge, or `disputed` with the code of the step that failed (`no_open_claim` when the Insurer Intake Agent has no open claim), and no challenge.
 */
async function dispute(job: Job, handoff: HandoffRecord, delivery: VerifiedDelivery, learned: Extract<Learned, { said: typeof NOT_ACCEPTED.declined }>): Promise<ExecuteResult> {
  const { deps, request, document, sent, note } = job;
  const pieces = { ...piecesOf(request, [learned.decision]), handoff };
  // The decision read the record from this object, so it is there. The challenge needs the record as evidence.
  if (delivery.result === null) return failedResult(pieces, INCONSISTENT_OUTCOME);
  let result: ChallengeResult;
  let fields: DisputeOutcome;
  try {
    // The hash is the SHA-256 of the text of the delivery, which the check `response_hash_matches` holds equal to the `response_hash` of the receipt that the Insurer Intake Agent signed. The request is the document
    // of the handoff: it is the document that was sent, and it is not the approved document when the fault is on.
    result = await disputeDelivery(
      deps,
      { counterparty: document.insurer_did, escrow_ref: handoff.escrow_ref, request: sent.document, intake_record: delivery.result, intake_record_sha256: sha256Utf8Hex(delivery.text) },
      deps.buyerPkhs,
    );
    fields = disputedFields(result);
  } catch {
    note('execute: the challenge stopped with an error, and a transaction may have landed');
    return disputedResult(pieces, { reason: PORT_ERROR });
  }
  note(challengeLine(result));
  return disputedResult(pieces, fields.challenge === null ? { reason: fields.reason } : { challenge: fields.challenge });
}

/** The delivery was not accepted. Only a no of the model starts a challenge: every other reason is a failure, and the model had no say in it. */
async function notAccepted(job: Job, step: NotAcceptedStep): Promise<ExecuteResult> {
  const { request, learned } = job;
  const stopped = (code: string): ExecuteResult => failedResult({ ...piecesOf(request), handoff: step.handoff }, code);
  if (step.why === 'not_recordable') return stopped(FAILED.notRecordable);
  if (step.why === 'decision_timeout') return stopped(FAILED.timeout);
  switch (step.declined) {
    case NOT_ACCEPTED.invalid:
    case NOT_ACCEPTED.notForRequest:
    case NOT_ACCEPTED.failed:
      return stopped(step.declined);
    case NOT_ACCEPTED.declined:
      return learned?.said === NOT_ACCEPTED.declined ? dispute(job, step.handoff, step.delivery, learned) : stopped(INCONSISTENT_OUTCOME);
    default:
      return stopped(INCONSISTENT_OUTCOME);
  }
}

/** One line for the log about the end of the hire: codes and references of the chain, and for a refused Pay the evaluation error of the node, which the hire flow flattens and cuts. No word of the Insurer Intake Agent is here. */
function stepLine(step: HireStep): string {
  switch (step.kind) {
    case 'completed': return `execute: the hire of the Insurer Intake Agent is completed, escrow ${step.handoff.escrow_ref}`;
    case 'refused_by_counterparty': return `execute: the Insurer Intake Agent refused (${step.reason}, ${step.source}), escrow ${step.handoff.escrow_ref}`;
    case 'vault_refused': return `execute: the vault refused the Pay (${step.refusal}), the delegation is ${step.delegation}: ${step.reason}`;
    case 'failed': return `execute: the hire failed (${step.reason})${step.handoff === null ? '' : `, escrow ${step.handoff.escrow_ref}`}`;
    case 'not_accepted': return `execute: the delivery was not accepted (${step.why}), escrow ${step.handoff.escrow_ref}`;
    case 'interrupted': return `execute: the hire was interrupted (${step.cause_kind}), escrow ${step.escrow_ref}`;
    case 'pay_unconfirmed': return `execute: the Pay was sent and not seen confirmed, escrow ${step.escrow_ref}, transaction ${step.tx_hash}, it may land ${step.may_land} until ${step.valid_to}`;
    default: return `execute: the request was refused before the Pay (${step.code})`;
  }
}

/** The result for the end of the hire. A step that is `refused` is an error for the server, and the other steps are results. */
async function finish(job: Job, step: HireStep): Promise<ExecuteResult> {
  switch (step.kind) {
    case 'refused': throw new ExecuteRefusal(step.code, step.detail);
    case 'completed': return completed(job, step);
    case 'not_accepted': return notAccepted(job, step);
    default: {
      if (step.kind === 'vault_refused' && step.evidence.transaction_body !== null) job.note(`execute: the draft of the Pay that the vault refused: ${flatText(step.evidence.transaction_body, DRAFT_LOG_CHARS)}`);
      return settledResult(step, piecesOf(job.request, decisionsOf(job.learned)));
    }
  }
}

/**
 * Submits the approved authorization request of an `execute` request that arrived at `arrivedAt` (POSIX milliseconds). It throws `ExecuteRefusal` for a request that it refuses before it pays, and for a setting that
 * is wrong. It gives a result for every other end. The job ends 1,620,000 ms after the arrival of the request (JOB_DEADLINE_MS). A caller that hung up (`signal`) before the hire starts stops the job with `failed` and
 * `aborted`. The job reads the signal one time, at that point: a job that then waits in the lane of the key, or on a read of the ledger, still pays. After the Pay the job runs to its end, because a hire that was
 * paid for is carried to a result.
 */
export async function runExecute(deps: ExecuteDeps, request: ExecuteRequest, arrivedAt: number, signal?: AbortSignal): Promise<ExecuteResult> {
  const note = noteOf(deps.log);
  const settings = settingsOf(deps);
  const stop = (code: string): ExecuteResult => failedResult({ ...piecesOf(request), handoff: null }, code);

  const parsed = parsePriorAuthRequest(request.proposal.document, 'proposal.document');
  if (!parsed.ok) return stop(BAD_DOCUMENT);
  const document = parsed.value;
  const target = targetOf(deps, request, document);
  // The records system takes a request for the tenant of its URL, and for no other. A request of another tenant would be refused after the Pay and the Accept, so it stops here, before any read of the ledger.
  if (document.tenant !== request.tenant) return stop(FAILED.tenant);

  const authority = await checkAuthority(deps.reads, settings.agent, request.authority.delegation);
  if (!authority.ok) {
    if (authority.code === 'ledger_unavailable') return stop(FAILED.ledger);
    throw new ExecuteRefusal(authority.code, authority.detail);
  }
  const chosen = await keyOfDelegation(deps, request);
  if (!chosen.ok) return stop(chosen.code);

  const approved = handoffOf({ use_case: USE_CASE, agent_did: settings.agent, request });
  if (!approved.ok) return stop(BAD_DOCUMENT);
  // The fault switch is read here, one time. With the fault on, the document of the handoff is not the approved document, and the digest of the proposal is not checked again.
  const altered = deps.fault.mode === 'alter_after_approval';
  const handoff = altered ? withDocument(approved.value, alterJustification(document)) : approved;
  if (!handoff.ok) return stop(BAD_DOCUMENT);
  if (altered) note('execute: the fault alter_after_approval changed the last sentence of the justification before the handoff');
  const sent = handoff.value;
  // The hash that the model compares is the hash of the document that goes on the wire, with no salt: it is the hash that the Insurer Intake Agent computes for the document that it receives.
  const sentSha256 = canonicalSha256(sent.document);
  if (!sentSha256.ok) return stop(BAD_DOCUMENT);

  // The job reads the signal one time, here, before the hire starts. The hire then waits in the lane of the key and reads the ledger, and it still pays when the caller hangs up in that time.
  if (signal?.aborted === true) return stop(FAILED.aborted);

  const judge = judgeDelivery({ acceptDelivery: deps.acceptDelivery, agent: settings.agent, note }, { request_number: document.request_number, request_sha256: sentSha256.value });
  const hireDeps: HireDeps = { key: chosen.entry.key, hire: { ...deps.hire, deadlineMs: arrivedAt + JOB_DEADLINE_MS }, reads: deps.reads };
  const step = await hireCounterparty(hireDeps, {
    message: sent, counterparty_did: document.insurer_did, capability_id: PRIORAUTH_CAPABILITIES.intake, model: PRIORAUTH_MODELS.intake, limits: settings.limits, decide: judge.decide,
  });
  note(stepLine(step));
  return finish({ deps, request, document, sent, agent: settings.agent, target, entry: chosen.entry, learned: judge.learned(), note }, step);
}
