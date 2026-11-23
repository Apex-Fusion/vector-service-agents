// agents/reorder-agent/src/execute/execute.ts
// The job `execute` of the Reorder Agent (use case 1, inventory reorder). It carries out the purchase order that the hirer approved: it pays the advert of the Order Desk that the order names, from the
// vault of the delegation, sends the handoff, decides whether the confirmation is the one it paid for, and writes the order to the PO store. Every end is a typed result of the protocol. The steps, in order:
//   1. The settings: the three limits, the DID of the agent and the target of the PO store. A wrong setting stops the job here, before any read and before any Pay.
//   2. The order document must be a purchase order (`bad_document` otherwise), it must have a hash, and it must name the tenant of the request (`po_not_for_tenant` otherwise).
//   3. The authority: a delegation that names another agent is a refusal for the server (`delegation_not_mine`). A delegation that the ledger does not show goes on, and the ledger refuses the Pay.
//   4. The delegation key: the key that the delegation names pays. A key that the agent does not hold is `delegation_key_unknown`. A ledger that cannot be read is `ledger_unavailable`.
//   5. The handoff, with the document, the salt and the approval as the request gave them. A null approval goes on: the Order Desk refuses it.
//   6. One hire (`hireCounterparty`): one Pay, no retry and no second hire. The decision on the delivery is `judgeDelivery`.
//   7. The end of the hire becomes a result:
//        completed                          the order is written to the PO store: 201 is `completed`, a refusal is `refused_by_system`, any other end is `failed`
//        not_accepted, declined_by_model    a challenge against the open claim of the Order Desk, with the evidence: `disputed` (Escalated), or `disputed` (Failed) when none is filed
//        not_accepted, any other reason     `failed` with that reason, and no challenge
//        refused_by_counterparty            `refused_by_counterparty`, with the exit state that `exitStateOf` gives
//        vault_refused                      `vault_refused`, and Cancelled when the delegation was ended
//        failed, interrupted, pay_unconfirmed   `failed`
//        refused                            a refusal for the server
// The order is written only after a `completed` hire whose decision is the acceptance of the model. A refused or failed payment is never `completed`.
import { callWithToken, requestRouteToken, tokenTarget } from '@vsa/usecase-kit/access';
import type { SystemResult, TokenTarget } from '@vsa/usecase-kit/access';
import { BAD_DOCUMENT, INCONSISTENT_OUTCOME, checkAuthority, checkLimits, completedResult, disputedResult, failedResult, handoffOf, hireCounterparty, refusedResult, settledResult } from '@vsa/usecase-kit/buyer';
import type { CompletedStep, HireDeps, HireLimits, HireStep, NotAcceptedStep, RefusedCode, ResultPieces, VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { disputedFields } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, DisputeOutcome } from '@vsa/usecase-kit/dispute';
import { INVENTORY_CAPABILITIES, ORDER_DESK_CLAIM, parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { PurchaseOrder } from '@vsa/usecase-kit/inventory';
import { ERROR_STATUS, canonicalSha256, isPlainObject, parseDid } from '@vsa/usecase-kit/protocol';
import type { Decision, Did, ExecuteRequest, ExecuteResult, HandoffRecord, WriteRecord } from '@vsa/usecase-kit/protocol';
import { flatText } from '@vsa/service-kit/text';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { NOT_ACCEPTED, judgeDelivery } from './decision.ts';
import type { Learned } from './decision.ts';
import type { DelegationKeyDeps, ExecuteDeps } from './ports.ts';

/** The job of the Reorder Agent ends 1,620,000 ms after its request arrived: 27 minutes, inside the window of its advert. */
export const JOB_DEADLINE_MS = 1_620_000;

/**
 * A request that the job refuses before it pays: a delegation that names another agent (400), a request that is too large (400), and a setting of the agent that is wrong (500). The service answers
 * with `code` and `status`. No Pay was made.
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

const USE_CASE = 'inventory-reorder';
const PO_SYSTEM = 'po-store';
const PO_ROUTE = 'POST /po';
/** The status of an order that the PO store recorded. */
const PO_RECORDED = 201;
/** A reference of the PO store that a result may hold: an identifier of at most 128 characters. Any other value of the answer is not kept. */
const RECORD_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The most characters of the draft of a refused Pay that one log line holds. */
const DRAFT_LOG_CHARS = 20_000;

/** The codes of a `failed` result that this job writes. The hire flow and the decision write others, and the hire kit names the rest. */
const FAILED = {
  aborted: 'aborted',
  keyUnknown: 'delegation_key_unknown',
  ledger: 'ledger_unavailable',
  notRecordable: 'delivery_not_recordable',
  timeout: 'decision_timeout',
  token: 'token_failed',
  system: 'mock_system_failed',
  tenant: 'po_not_for_tenant',
} as const;

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
  readonly target: TokenTarget;
}

/** The settings that the job needs, as checked values. A wrong one is a fault of the service, and it is found before any read and before any Pay. */
function settingsOf(deps: ExecuteDeps, request: ExecuteRequest): Settings {
  const limits = checkLimits(deps.limits);
  if (!limits.ok) throw new ExecuteRefusal('internal', limits.detail);
  const agent = parseDid(deps.agent.did, 'agent.did');
  if (!agent.ok) throw new ExecuteRefusal('internal', agent.detail);
  const target = tokenTarget(deps.calls.bases, request.tenant, 'po.write');
  if (!target.ok) throw new ExecuteRefusal('internal', `the write to the PO store has no target: ${target.detail}`);
  return { limits: limits.value, agent: agent.value, target: target.value };
}

/**
 * The delegation key that pays: the key that the delegation names as its delegate key. A delegation that the ledger does not show has none, and the first key of the agent goes on: it finds no Live
 * vault of that delegation, the flow ends with a typed result, and the ledger decides what is paid.
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

interface Job {
  readonly deps: ExecuteDeps;
  readonly request: ExecuteRequest;
  readonly order: PurchaseOrder;
  readonly settings: Settings;
  readonly entry: DelegationKeyDeps;
  /** What the decision on the delivery learned, read after the hire. */
  readonly learned: Learned | null;
  readonly note: (line: string) => void;
}

/** The result of one call to the PO store: the record of a write, a refusal with its code, or a failure with its code. The detail is for the log: the kit writes it with no key, token or proof in it. */
type PoWrite =
  | { readonly kind: 'written'; readonly record: WriteRecord }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: string }
  | { readonly kind: 'failed'; readonly code: string; readonly detail: string };

/**
 * What the call to the PO store came to. Only the status 201 is a recorded order. A refusal of the system (401 and 403) is a refusal. So is an error status below 500 with the code of a rule: the
 * request was understood and refused, and nothing was written. Any other end may have written the order, so it is a failure.
 */
function writeOf(sent: SystemResult): PoWrite {
  if (sent.ok) {
    if (sent.status !== PO_RECORDED) return { kind: 'failed', code: FAILED.system, detail: `the PO store answered ${sent.status}, and a recorded order is ${PO_RECORDED}` };
    const ref: unknown = isPlainObject(sent.body) ? sent.body.record_id : undefined;
    return { kind: 'written', record: { system: PO_SYSTEM, route: PO_ROUTE, status: PO_RECORDED, ref: typeof ref === 'string' && RECORD_REF.test(ref) ? ref : null } };
  }
  if (sent.code === 'refused_by_system') return { kind: 'refused', reason: sent.reason, detail: sent.detail };
  if (sent.status !== null && sent.status >= 400 && sent.status < 500 && sent.systemCode !== null) return { kind: 'refused', reason: sent.systemCode, detail: sent.detail };
  return { kind: 'failed', code: FAILED.system, detail: sent.detail };
}

/** The order to the PO store, with a token for the route `po.write` that the delegation key of the delegation asks for. One token, one call, no retry. */
async function writeOrder(job: Job): Promise<PoWrite> {
  const { deps, request, settings, entry, note } = job;
  const token = await requestRouteToken(deps.tokens, {
    target: settings.target, holder: 'agent', subject: { did: settings.agent, key: deps.agent.authenticationKey }, dpopKey: entry.dpopKey, delegation: request.authority.delegation,
  });
  const written: PoWrite = token.ok ? writeOf(await callWithToken(deps.calls, token.value, settings.target, request.proposal.document)) : { kind: 'failed', code: FAILED.token, detail: token.detail };
  if (written.kind === 'written') note(`execute: the PO store recorded the order (${written.record.status})`);
  else note(`execute: the order was not recorded (${written.kind === 'refused' ? written.reason : written.code}): ${flatText(written.detail, 300)}`);
  return written;
}

/** A hire that the vault paid, whose receipt passed its checks, and that the model accepted: the order goes to the PO store, and the result says how that ended. */
async function completed(job: Job, step: CompletedStep): Promise<ExecuteResult> {
  const { request, learned, note } = job;
  if (step.booking_failed !== null) {
    note(`execute: the ledger did not book the fee of the Accept: accept transaction ${flatText(step.booking_failed.accept_tx_hash ?? 'unknown', 80)}, fee ${step.booking_failed.fee_lovelace} lovelace`);
  }
  // The Accept is made only after the decision of the model, so a completed hire has that decision on record. A hire that says completed with no such decision does not hold together: the order is not written.
  if (learned === null || learned.said !== 'accepted') return failedResult({ ...piecesOf(request, decisionsOf(learned)), handoff: step.handoff }, INCONSISTENT_OUTCOME);
  const decisions = decisionsOf(learned);
  const written = await writeOrder(job);
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
 * The model did not accept the delivery. The job files a challenge against the open claim of the Order Desk: its capability, the first statement of its claim, the delegation keys of this agent as the
 * buyer of the escrow, and the evidence with the purchase order, the confirmation and the hash that the receipt commits to. The result is the one that the dispute folder gives: `disputed` with the
 * challenge, or `disputed` with the code of the step that failed (`no_open_claim` when the Order Desk has no open claim), and no challenge.
 */
async function dispute(job: Job, handoff: HandoffRecord, delivery: VerifiedDelivery, learned: Extract<Learned, { said: typeof NOT_ACCEPTED.declined }>): Promise<ExecuteResult> {
  const { deps, request, order, note } = job;
  const pieces = { ...piecesOf(request, [learned.decision]), handoff };
  // The decision read the confirmation from this object, so it is there. The challenge needs the confirmation as evidence.
  if (delivery.result === null) return failedResult(pieces, INCONSISTENT_OUTCOME);
  let result: ChallengeResult;
  let fields: DisputeOutcome;
  try {
    result = await deps.dispute.challengeDelivery({
      counterparty: order.supplier_did,
      escrow_ref: handoff.escrow_ref,
      capability_id: INVENTORY_CAPABILITIES.order,
      statement_text: ORDER_DESK_CLAIM.statements[0].text,
      buyer_pkhs: deps.buyerPkhs,
      // The hash is the SHA-256 of the text of the delivery, which the check `response_hash_matches` holds equal to the `response_hash` of the receipt that the Order Desk signed.
      evidence: { kind: 'order_confirmation', purchase_order: request.proposal.document, confirmation: delivery.result, confirmation_sha256: sha256Utf8Hex(delivery.text) },
    });
    fields = disputedFields(result);
  } catch {
    note('execute: the challenge stopped with an error, and a transaction may have landed');
    return disputedResult(pieces, { reason: 'port_error' });
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
    case NOT_ACCEPTED.notForOrder:
    case NOT_ACCEPTED.failed:
      return stopped(step.declined);
    case NOT_ACCEPTED.declined:
      return learned?.said === NOT_ACCEPTED.declined ? dispute(job, step.handoff, step.delivery, learned) : stopped(INCONSISTENT_OUTCOME);
    default:
      return stopped(INCONSISTENT_OUTCOME);
  }
}

/** One line for the log about the end of the hire: codes and references of the chain, and for a refused Pay the evaluation error of the node, which the hire flow flattens and cuts. No word of the Order Desk is here. */
function stepLine(step: HireStep): string {
  switch (step.kind) {
    case 'completed': return `execute: the hire of the Order Desk is completed, escrow ${step.handoff.escrow_ref}`;
    case 'refused_by_counterparty': return `execute: the Order Desk refused (${step.reason}, ${step.source}), escrow ${step.handoff.escrow_ref}`;
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
 * Carries out the approved purchase order of an `execute` request that arrived at `arrivedAt` (POSIX milliseconds). It throws `ExecuteRefusal` for a request that it refuses before it pays, and for a
 * setting that is wrong. It gives a result for every other end. The job ends 1,620,000 ms after the arrival of the request (JOB_DEADLINE_MS). A caller that hung up (`signal`) before the Pay stops the job
 * with `failed` and `aborted`; after the Pay the job runs to its end, because a hire that was paid for is carried to a result.
 */
export async function runExecute(deps: ExecuteDeps, request: ExecuteRequest, arrivedAt: number, signal?: AbortSignal): Promise<ExecuteResult> {
  const note = noteOf(deps.log);
  const settings = settingsOf(deps, request);
  const stop = (code: string): ExecuteResult => failedResult({ ...piecesOf(request), handoff: null }, code);

  const order = parsePurchaseOrder(request.proposal.document, 'proposal.document');
  if (!order.ok) return stop(BAD_DOCUMENT);
  const orderSha256 = canonicalSha256(order.value);
  if (!orderSha256.ok) return stop(BAD_DOCUMENT);
  // The PO store takes an order for the tenant of its URL, and for no other. An order of another tenant would be refused after the Pay and the Accept, so it stops here, before any read of the ledger.
  if (order.value.tenant !== request.tenant) return stop(FAILED.tenant);

  const authority = await checkAuthority(deps.reads, settings.agent, request.authority.delegation);
  if (!authority.ok) {
    if (authority.code === 'ledger_unavailable') return stop(FAILED.ledger);
    throw new ExecuteRefusal(authority.code, authority.detail);
  }
  const chosen = await keyOfDelegation(deps, request);
  if (!chosen.ok) return stop(chosen.code);

  const handoff = handoffOf({ use_case: USE_CASE, agent_did: settings.agent, request });
  if (!handoff.ok) return stop(BAD_DOCUMENT);

  // The last point at which the job can stop with nothing paid.
  if (signal?.aborted === true) return stop(FAILED.aborted);

  const judge = judgeDelivery({ acceptDelivery: deps.acceptDelivery, note }, order.value, orderSha256.value);
  const hireDeps: HireDeps = { key: chosen.entry.key, hire: { ...deps.hire, deadlineMs: arrivedAt + JOB_DEADLINE_MS }, reads: deps.reads };
  const step = await hireCounterparty(hireDeps, {
    message: handoff.value, counterparty_did: order.value.supplier_did, capability_id: INVENTORY_CAPABILITIES.order, model: order.value.lot, limits: settings.limits, decide: judge.decide,
  });
  note(stepLine(step));
  return finish({ deps, request, order: order.value, settings, entry: chosen.entry, learned: judge.learned(), note }, step);
}
