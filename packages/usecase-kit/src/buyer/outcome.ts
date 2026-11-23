// packages/usecase-kit/src/buyer/outcome.ts
// The map from what the hire kit says to a step of this folder, in one function with one table. The exit state of a result is never written here: `exitStateOf` of the protocol gives it.
//
//   outcome of the hire kit                                     step                       reason of the result
//   completed, and it holds together (see completedStep)        completed                  none
//   refused_before_claim, status 403, a refusal code that the     refused_by_counterparty    that code
//     protocol lists for the counterparty of the use case
//   refused_before_claim, any other answer                        failed                     the code when it is a code of ERROR_STATUS, else `counterparty_refused`
//   failed_after_claim, `failed`, with the code of a decision        refused_by_counterparty    that code (the decision of the counterparty after its Claim)
//     after the Claim and the status that the protocol gives it,
//     which the protocol lists for the counterparty of the use case
//   failed_after_claim, `failed`, with such a code that the          failed                     that code
//     protocol does not list for that counterparty
//   failed_after_claim, any other                               failed                     the reason of the hire kit. It is NOT a refusal.
//   vault_refused                                               vault_refused              the evaluation error of the node, or the code of the builder when the Pay could not be built, or `vault_reason_missing` when none was given
//   not_accepted, declined                                      not_accepted               (the code of the use case files the challenge)
//   not_accepted, decision_timeout                              not_accepted               (the same)
//   not_accepted, and the delivery cannot be recorded           not_accepted, `not_recordable`   (the same, with the escrow, the advert, the supplier key hash and the eight checks)
//   not_accepted, receipt_failed                                failed                     `receipt_failed`
//   HireInterrupted                                             interrupted                `deadline`, `store_write_failed`, `decision_error` or `hire_interrupted`
//   HirePayUnconfirmed                                          pay_unconfirmed            `pay_unconfirmed`
//   a hire that no outcome names (a fault before any Pay)       failed                     `advert_unavailable`, `post_failed`, `earlier_pay_may_land` or `hire_error`
//   anything else, or a `completed` that does not hold         failed                     `inconsistent_outcome`
//
// The words of a counterparty never reach a reason: a reason is a code of the protocol, or a fixed code of this folder. An answer before the Claim is a refusal only when its status is 403 and its code
// is a refusal code that the protocol lists for the counterparty of the use case, and is not a code of AFTER_CLAIM_REFUSALS. A job that failed after the Claim is a failure and never a refusal. The one
// exception is the typed code of the outcome: the members `service_status` and `service_code` of a `failed_after_claim` with the reason `failed`, which the hire kit reads from the answer of the service of
// the counterparty, in the frame that the runtime writes. The flow reads no text of the counterparty. The code is a refusal only when it is a code of AFTER_CLAIM_REFUSALS with the status that ERROR_STATUS
// gives it, and the protocol lists it for the counterparty of the use case, as before the Claim. For any other counterparty it is the reason of a failure.
//
// A `completed` that does not hold together is `failed`, and its record keeps what the hire kit said of the Accept: `confirmed` or `pending`. The Accept was made on the chain, so the record must say so, or a use
// case that runs again would pay a second time for the same work. An outcome that did not reach the Accept has `null` there.
import { verificationOf } from '@vsa/hire-kit';
import type { AgentDelivery, AgentEscrow, AgentOutcome, HireFailure, HireTerms } from '@vsa/hire-kit';
import { flatText } from '@vsa/service-kit/text';
import { AFTER_CLAIM_REFUSALS, COUNTERPARTY_REFUSALS, ERROR_STATUS, RECEIPT_CHECKS, isErrorCode, isKeyHash, isPlainObject, parseJsonText, parseJsonValue, parseOutputRef } from '@vsa/usecase-kit/protocol';
import type { CounterpartyKind, Did, HandoffRecord, JsonObject, OutputRef, ReceiptCheck, ReceiptVerification, UseCase } from '@vsa/usecase-kit/protocol';
import type { DelegationAfter } from './authority.ts';
import type { BookingFailure, FailedStep, HireStep, UnrecordedDelivery, VerifiedDelivery } from './steps.ts';

/** The reason of a `failed` step for an answer before the Claim that is not a refusal by a rule of the protocol, and whose code is not a code of ERROR_STATUS. It is never the words of the counterparty. */
export const COUNTERPARTY_REFUSED = 'counterparty_refused';
/** The reason of a result that the flow cannot trust: the hire kit said something that does not hold together. It is never a pass. */
export const INCONSISTENT_OUTCOME = 'inconsistent_outcome';
/** The reason of a `vault_refused` step when the node or the builder gave no text: a fixed code of this folder, so that a result always has a reason. */
export const VAULT_REASON_MISSING = 'vault_reason_missing';

/** The codes of the hire kit for a hire that failed. The hire kit lists them as the type `HireFailure`. */
const KIT_FAILURES = ['post_failed', 'busy', 'refused', 'send_lost', 'failed', 'timeout', 'bad_result', 'receipt_failed', 'receipt_unavailable', 'accept_failed'] as const satisfies readonly HireFailure[];
// The next line stops compiling when the hire kit adds a code that the list above lacks.
const KIT_FAILURES_ARE_LISTED: [Exclude<HireFailure, (typeof KIT_FAILURES)[number]>] extends [never] ? true : never = true;

/** What the table needs to know besides the outcome. */
export interface StepContext {
  /** The counterparty as the approved document names it. */
  readonly counterparty_did: Did;
  /** The advert that the approved document names. A `completed` outcome is for this advert and no other. */
  readonly advert_ref: OutputRef;
  /** The use case of the job. It names the kind of the counterparty, and so the refusal codes that the counterparty can answer. */
  readonly use_case: UseCase;
  /** What the delegation was after a refused Pay. The flow reads it when the outcome is `vault_refused`; it is `null` for any other outcome. */
  readonly delegation_after: DelegationAfter | null;
  /** Set when the ledger of the caller threw while it booked the fee of the confirmed Accept. It is `null` when the booking worked, and for any outcome that has no Accept. */
  readonly booking_failed: BookingFailure | null;
}

/** The longest reason that the use case gave when it said no: it is words, and the flow cuts them. */
const DECLINED_MAX = 300;
/** The longest evaluation error of the node that a reason holds. */
const EVALUATION_ERROR_MAX = 300;

/** A code of `AFTER_CLAIM_REFUSALS`. */
export type AfterClaimRefusal = (typeof AFTER_CLAIM_REFUSALS)[number];

/** The label of the job in the messages of the hire kit. The flow gives it as the `label` of the request. No code of the flow reads a message of the kit. */
export const JOB_LABEL = 'the handoff';

/** A JSON object copy of a value, or `null` when the value is not a JSON object. */
function jsonObjectOf(value: unknown): JsonObject | null {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
  const checked = parseJsonValue(copy);
  return checked.ok && isPlainObject(checked.value) ? (checked.value as JsonObject) : null;
}

/** The eight checks as booleans, or `null` when one is missing or is not a boolean. */
function verificationFrom(value: unknown): ReceiptVerification | null {
  if (typeof value !== 'object' || value === null) return null;
  const checks = {} as Record<ReceiptCheck, boolean>;
  for (const check of RECEIPT_CHECKS) {
    const state: unknown = Reflect.get(value, check);
    if (typeof state !== 'boolean') return null;
    checks[check] = state;
  }
  return checks;
}

/**
 * The delivery as a decision and a result see it, or `null` when the hire kit gave a delivery that cannot be written as JSON data, or whose receipt has no member or whose signature is empty. Each call
 * makes a new copy. The function never throws.
 */
export function deliveryOf(delivery: AgentDelivery): VerifiedDelivery | null {
  try {
    const record: unknown = delivery.record;
    if (typeof record !== 'object' || record === null) return null;
    const escrow = parseOutputRef(delivery.escrowRef, 'escrow');
    const advert = parseOutputRef(delivery.advertRef, 'advert');
    const receipt = jsonObjectOf(Reflect.get(record, 'receipt'));
    const verification = verificationFrom(Reflect.get(record, 'verification'));
    const signature: unknown = Reflect.get(record, 'receipt_signature');
    if (!escrow.ok || !advert.ok || receipt === null || Object.keys(receipt).length === 0 || verification === null) return null;
    if (typeof signature !== 'string' || signature === '' || typeof delivery.text !== 'string') return null;
    const parsed = parseJsonText(delivery.text);
    return {
      escrow_ref: escrow.value, advert_ref: advert.value, text: delivery.text, result: parsed.ok ? jsonObjectOf(parsed.value) : null, receipt, receipt_signature: signature, verification,
    };
  } catch {
    return null;
  }
}

/** The escrow that a Pay opened, with its references in the form of the protocol. */
interface Escrow {
  readonly advert_ref: OutputRef;
  readonly escrow_ref: OutputRef;
  readonly vault_ref: string | null;
  readonly terms: HireTerms;
}

function escrowOf(outcome: AgentEscrow): Escrow | null {
  const advert = parseOutputRef(outcome.advertRef, 'advert');
  const escrow = parseOutputRef(outcome.escrowRef, 'escrow');
  if (!advert.ok || !escrow.ok) return null;
  return { advert_ref: advert.value, escrow_ref: escrow.value, vault_ref: typeof outcome.vaultRef === 'string' ? outcome.vaultRef : null, terms: outcome.terms };
}

/** The hire as the result of the agent records it. `delivery` is `null` when no delivery came. `paidFromVault` is false when the hire kit did not say that the vault paid. */
export function recordOf(
  counterparty: Did, advert: OutputRef, escrow: OutputRef, delivery: VerifiedDelivery | null, accepted: HandoffRecord['accepted'], paidFromVault = true,
): HandoffRecord {
  return {
    counterparty_did: counterparty, advert_ref: advert, escrow_ref: escrow, paid_from_vault: paidFromVault,
    receipt: delivery?.receipt ?? null, receipt_signature: delivery?.receipt_signature ?? null, verification: delivery?.verification ?? null, result: delivery?.result ?? null, accepted,
  };
}

/** A step that says nothing but that the hire failed, with a code and a sentence. */
export function failure(reason: string, detail: string, extra: Partial<Omit<FailedStep, 'kind' | 'reason' | 'detail'>> = {}): FailedStep {
  return { kind: 'failed', reason, detail, handoff: null, vault_ref: null, terms: null, ...extra };
}

/**
 * The step for an outcome that does not hold together. It names the escrow when it is known, so that no escrow is lost from the record. `accepted` is what the hire kit said of the Accept of a `completed` outcome:
 * `confirmed` or `pending` means that the Accept was made on the chain, and the record says so. It is `null` for an outcome that did not reach the Accept, and for one that does not say. `paidFromVault` is the word
 * of the hire kit: it is false when the kit did not say that the vault paid.
 */
function inconsistent(context: StepContext, detail: string, escrow: Escrow | null = null, paidFromVault = true, accepted: HandoffRecord['accepted'] = null): FailedStep {
  return failure(INCONSISTENT_OUTCOME, detail, {
    handoff: escrow === null ? null : recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, null, accepted, paidFromVault),
    vault_ref: escrow?.vault_ref ?? null, terms: escrow?.terms ?? null, ...(context.booking_failed === null ? {} : { cause: context.booking_failed.cause }),
  });
}

type Completed = Extract<AgentOutcome, { outcome: 'completed' }>;
type Refused = Extract<AgentOutcome, { outcome: 'refused_before_claim' }>;
type FailedAfterClaim = Extract<AgentOutcome, { outcome: 'failed_after_claim' }>;
type VaultRefused = Extract<AgentOutcome, { outcome: 'vault_refused' }>;
type NotAccepted = Extract<AgentOutcome, { outcome: 'not_accepted' }>;

/** The verdict of the kit as the flow reads it: VERIFIED, and each of the eight checks `pass`. */
function verdictHolds(verdict: unknown): boolean {
  if (typeof verdict !== 'object' || verdict === null) return false;
  const checks: unknown = Reflect.get(verdict, 'checks');
  return Reflect.get(verdict, 'verdict') === 'VERIFIED' && typeof checks === 'object' && checks !== null && RECEIPT_CHECKS.every((check) => Reflect.get(checks, check) === 'pass');
}

/**
 * `completed` holds only when its parts agree with each other, and not with the word `completed`: the vault paid it (the flow always hires from the Live vault of the delegation, so a hire that the
 * wallet paid is not the hire that the flow asked for), the escrow of the outcome is the escrow of the record and of the receipt, the advert of the outcome and of the record is the advert that the
 * approved document names, the receipt is the receipt of this hire (its agent is the counterparty that the document names, and when it names an advert, that advert is the advert of the document), the
 * verdict is VERIFIED and each of its eight checks passed, each of the eight members of the verification is the boolean `true`, the receipt is an object with members, its signature is a text that is not
 * empty, and the Accept is confirmed or pending. Anything else is `inconsistent_outcome`, and the step keeps the escrow: a hire that did not verify, or that the wallet paid, is never reported as done. The
 * record of that step says what the hire kit said of the payment (`paid_from_vault` is false when the kit did not say that the vault paid) and of the Accept (`accepted` is `confirmed` or `pending` when the kit
 * said so: the Accept was made, and the use case must not hire again for the same work).
 */
function completedStep(outcome: Completed, context: StepContext): HireStep {
  const escrow = escrowOf(outcome);
  if (escrow === null) return inconsistent(context, 'the hire kit gave an escrow or an advert that is not an output reference');
  const paidFromVault = outcome.paidFrom === 'vault';
  const accepted = outcome.accepted === 'confirmed' || outcome.accepted === 'pending' ? outcome.accepted : null;
  const no = (detail: string): FailedStep => inconsistent(context, detail, escrow, paidFromVault, accepted);
  if (!paidFromVault) return no('the hire says completed, and it does not say that the vault paid: the flow always hires from the Live vault of the delegation');
  if (escrow.advert_ref !== context.advert_ref) return no('the hire says completed for another advert than the advert that the approved document names');
  const record: unknown = outcome.record;
  const recorded = (member: string): unknown => (typeof record === 'object' && record !== null ? Reflect.get(record, member) : undefined);
  if (recorded('escrow_ref') !== escrow.escrow_ref) return no('the record of the hire is not the record of the escrow of the outcome');
  if (recorded('advert_ref') !== escrow.advert_ref) return no('the record of the hire is for another advert than the advert of the outcome');
  const delivery = deliveryOf({ escrowRef: outcome.escrowRef, advertRef: outcome.advertRef, text: outcome.text, record: outcome.record, verdict: outcome.verdict });
  if (delivery === null) return no('the delivery of the hire cannot be written as JSON data, or its receipt has no member, or its signature is empty');
  if (delivery.receipt.escrow_ref !== escrow.escrow_ref) return no('the receipt of the hire is not the receipt of the escrow of the outcome');
  if (delivery.receipt.agent_did !== context.counterparty_did) return no('the receipt of the hire does not name the counterparty of the approved document as its agent');
  if (Object.hasOwn(delivery.receipt, 'advert_ref') && delivery.receipt.advert_ref !== context.advert_ref) return no('the receipt of the hire names another advert than the advert that the approved document names');
  if (!verdictHolds(outcome.verdict)) return no('the hire says completed, and its verdict is not VERIFIED with each of the eight checks passed');
  if (!RECEIPT_CHECKS.every((check) => delivery.verification[check] === true)) return no('the hire says completed, and one of the eight checks of its record is not true');
  if (accepted === null) return no('the hire says completed, and it does not say whether the Accept was seen');
  return {
    kind: 'completed', handoff: recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, delivery, accepted), vault_ref: escrow.vault_ref, terms: escrow.terms, delivery,
    booking_failed: context.booking_failed,
  };
}

/** The kind of counterparty that each use case hires. The use case names it. */
const COUNTERPARTY_OF: Readonly<Record<UseCase, CounterpartyKind>> = {
  'inventory-reorder': 'order-desk', 'prior-authorization': 'insurer-intake-agent', 'bid-evaluation': 'bid-desk',
};

/** True when `code` is a refusal code that the protocol lists for the kind of counterparty of the use case. A use case that is not one of the three has none. */
function isRefusalOfUseCase(code: string, useCase: UseCase): boolean {
  return Object.hasOwn(COUNTERPARTY_OF, useCase) && (COUNTERPARTY_REFUSALS[COUNTERPARTY_OF[useCase]] as readonly string[]).includes(code);
}

/**
 * The code of a refusal by a rule of the protocol, or `null`. An answer before the Claim is a refusal only when its status is 403 and its code is a refusal code that the protocol lists for the kind of
 * counterparty of the use case, and is not a code of `AFTER_CLAIM_REFUSALS`: a decision after the Claim cannot come before it.
 */
function ruleRefusalIn(status: unknown, code: unknown, useCase: UseCase): string | null {
  if (status !== 403 || typeof code !== 'string') return null;
  if ((AFTER_CLAIM_REFUSALS as readonly string[]).includes(code)) return null;
  return isRefusalOfUseCase(code, useCase) ? code : null;
}

function refusedBeforeClaimStep(outcome: Refused, context: StepContext): HireStep {
  const escrow = escrowOf(outcome);
  if (escrow === null) return inconsistent(context, 'the hire kit gave an escrow or an advert that is not an output reference');
  const kept = { handoff: recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, null, null), vault_ref: escrow.vault_ref, terms: escrow.terms };
  const rule = ruleRefusalIn(outcome.status, outcome.code, context.use_case);
  if (rule !== null) return { kind: 'refused_by_counterparty', reason: rule, source: 'before_claim', runtime_status: 403, ...kept };
  // Any other answer before the Claim is a failure of the job. The reason is a code of the protocol, or the fixed code of this folder: the words of the counterparty never reach it.
  const reason = isErrorCode(outcome.code) ? outcome.code : COUNTERPARTY_REFUSED;
  return failure(reason, 'the counterparty answered before its Claim, and the answer is not a refusal by a rule of the protocol for this counterparty', kept);
}

/**
 * The code of a decision after the Claim, from the typed members of a job that failed: the hire kit read the status and the code of the answer of the service in the frame that the runtime writes, and this
 * function reads no text. The code is a decision after the Claim only when it is a code of `AFTER_CLAIM_REFUSALS` and the status is the one that `ERROR_STATUS` gives that code. Any other pair gives `null`.
 * So do a member that is missing or of another type, and a reason that is not `failed`: the members belong to that reason only.
 */
function afterClaimCodeOf(outcome: FailedAfterClaim): AfterClaimRefusal | null {
  if (outcome.reason !== 'failed') return null;
  const code = AFTER_CLAIM_REFUSALS.find((listed) => listed === outcome.service_code);
  return code !== undefined && outcome.service_status === ERROR_STATUS[code] ? code : null;
}

function failedAfterClaimStep(outcome: FailedAfterClaim, context: StepContext): HireStep {
  const escrow = escrowOf(outcome);
  if (escrow === null) return inconsistent(context, 'the hire kit gave an escrow or an advert that is not an output reference');
  const handoff = recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, null, null);
  const refusal = afterClaimCodeOf(outcome);
  if (refusal !== null) {
    // The same rule as before the Claim: the code is a refusal only when the protocol lists it for the counterparty of the use case. A counterparty that has no such code did not decide this by a rule of
    // the protocol, so the job failed, and the reason is that code.
    if (isRefusalOfUseCase(refusal, context.use_case)) {
      return { kind: 'refused_by_counterparty', reason: refusal, source: 'after_claim', runtime_status: null, handoff, vault_ref: escrow.vault_ref, terms: escrow.terms };
    }
    return failure(refusal, 'the counterparty answered after its Claim with a code that the protocol does not list as a refusal of its kind, so the job failed and it is not a refusal', { handoff, vault_ref: escrow.vault_ref, terms: escrow.terms });
  }
  if (!(KIT_FAILURES as readonly unknown[]).includes(outcome.reason)) return inconsistent(context, 'the hire kit gave a reason that it does not list', escrow);
  return failure(outcome.reason, `the hire failed after the Pay (${outcome.reason}), and it is not a refusal`, { handoff, vault_ref: escrow.vault_ref, terms: escrow.terms });
}

/** The reason of a `vault_refused` step: the text that the node or the builder gave, flat and cut short, or the fixed code of this folder when it gave no text. */
function vaultReasonOf(value: unknown): string {
  const text = typeof value === 'string' ? flatText(value, EVALUATION_ERROR_MAX) : '';
  return text.trim() === '' ? VAULT_REASON_MISSING : text;
}

function vaultRefusedStep(outcome: VaultRefused, context: StepContext): HireStep {
  const { refusal } = outcome;
  if (typeof refusal !== 'object' || refusal === null) return inconsistent(context, 'the hire kit gave a vault_refused outcome that holds no refusal');
  const delegation = context.delegation_after ?? 'unreadable';
  const base = { kind: 'vault_refused', delegation, delegation_ended: delegation === 'ended', handoff: null } as const;
  if (refusal.kind === 'impossible') return { ...base, reason: vaultReasonOf(refusal.reason), refusal: 'impossible', evidence: { transaction_body: null } };
  return {
    ...base, reason: vaultReasonOf(refusal.evaluationError), refusal: refusal.kind === 'ledger' ? 'ledger' : 'not_evaluated',
    evidence: { transaction_body: typeof refusal.body === 'string' ? refusal.body : null },
  };
}

/** What can be recorded of a delivery that cannot be written as JSON data: the escrow and the advert of the outcome, the supplier key hash and the eight checks of its record. `null` when one of them cannot be read. */
function unrecordedOf(delivery: AgentDelivery, escrow: Escrow): UnrecordedDelivery | null {
  try {
    const record: unknown = delivery.record;
    if (typeof record !== 'object' || record === null) return null;
    const supplier: unknown = Reflect.get(record, 'supplier_pkh');
    const verification = verificationFrom(Reflect.get(record, 'verification'));
    if (!isKeyHash(supplier) || verification === null) return null;
    return { escrow_ref: escrow.escrow_ref, advert_ref: escrow.advert_ref, supplier_pkh: supplier, verification };
  } catch {
    return null;
  }
}

/**
 * The step for a delivery that the hire kit verified and that cannot be recorded: `not_accepted` with its own reason, and what can be recorded. The use case files its challenge for it, as it does for a
 * delivery that its decision refused. The counterparty cannot choose to end the job with no challenge by sending a receipt that the reader of the protocol refuses.
 */
function unrecordedStep(delivery: AgentDelivery, context: StepContext, escrow: Escrow): HireStep {
  const unrecorded = unrecordedOf(delivery, escrow);
  if (unrecorded === null) return inconsistent(context, 'the delivery of the hire cannot be written as JSON data, and what can be recorded of it cannot be read either', escrow);
  return {
    kind: 'not_accepted', why: 'not_recordable', declined: null, delivery: null, unrecorded,
    handoff: { ...recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, null, 'no'), verification: unrecorded.verification }, vault_ref: escrow.vault_ref, terms: escrow.terms,
  };
}

function notAcceptedStep(outcome: NotAccepted, context: StepContext): HireStep {
  const escrow = escrowOf(outcome);
  if (escrow === null) return inconsistent(context, 'the hire kit gave an escrow or an advert that is not an output reference');
  if (outcome.reason === 'receipt_failed') {
    // The receipt failed a check, so the delivery was not judged: it is a failure of the job and not a decision. The record keeps the checks that the hire kit ran.
    const checks = verificationFrom(verificationOf(outcome.verdict.checks));
    const handoff: HandoffRecord = { ...recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, null, null), verification: checks };
    return failure('receipt_failed', 'the receipt of the delivery failed a check, so the escrow was not accepted', { handoff, vault_ref: escrow.vault_ref, terms: escrow.terms });
  }
  if (outcome.reason !== 'declined' && outcome.reason !== 'decision_timeout') return inconsistent(context, 'the hire kit gave a not_accepted that it does not list', escrow);
  const delivery = deliveryOf(outcome.delivery);
  if (delivery === null) return unrecordedStep(outcome.delivery, context, escrow);
  return {
    kind: 'not_accepted', why: outcome.reason, declined: outcome.reason === 'declined' ? flatText(String(outcome.declined), DECLINED_MAX) : null,
    handoff: recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, delivery, 'no'), vault_ref: escrow.vault_ref, terms: escrow.terms, delivery,
  };
}

/** The escrow that an outcome names, or `null` when it names none or cannot be read. It never throws. */
function escrowIfReadable(outcome: AgentOutcome): Escrow | null {
  try {
    return escrowOf(outcome as AgentEscrow);
  } catch {
    return null;
  }
}

/** What a `completed` outcome says of the Accept: `confirmed` or `pending`. It is `null` for any other outcome, for any other word, and when the outcome cannot be read. It never throws. */
function acceptedIfReadable(outcome: AgentOutcome): HandoffRecord['accepted'] {
  try {
    const accepted: unknown = outcome.outcome === 'completed' ? outcome.accepted : null;
    return accepted === 'confirmed' || accepted === 'pending' ? accepted : null;
  } catch {
    return null;
  }
}

/**
 * True when the outcome says `vault_refused`, the one outcome after which the flow reads the delegation again. It is the one read of the outcome that the flow makes before `stepOfOutcome`, and it is
 * guarded in the same way: a value that is not an object, or an outcome whose `outcome` member throws, is not a refused Pay here, and `stepOfOutcome` makes the step for it. The function never throws.
 */
export function isVaultRefused(outcome: unknown): boolean {
  try {
    return typeof outcome === 'object' && outcome !== null && Reflect.get(outcome, 'outcome') === 'vault_refused';
  } catch {
    return false;
  }
}

/**
 * The step for one outcome of the hire kit. The switch has no default that passes: an outcome that is not one of the five is `inconsistent_outcome`. An outcome that cannot be read (a member that
 * throws) is `inconsistent_outcome` too, with the escrow that it names, the Accept that a `completed` outcome says, and the error as the `cause` for the log. The function never throws.
 * `context.delegation_after` is read by the flow for `vault_refused` (see `isVaultRefused`); the function reads no ledger.
 */
export function stepOfOutcome(outcome: AgentOutcome, context: StepContext): HireStep {
  if (typeof outcome !== 'object' || outcome === null) return inconsistent(context, 'the hire kit gave no outcome');
  try {
    switch (outcome.outcome) {
      case 'completed': return completedStep(outcome, context);
      case 'refused_before_claim': return refusedBeforeClaimStep(outcome, context);
      case 'failed_after_claim': return failedAfterClaimStep(outcome, context);
      case 'vault_refused': return vaultRefusedStep(outcome, context);
      case 'not_accepted': return notAcceptedStep(outcome, context);
      default: {
        const unknown: never = outcome;
        void unknown;
        return inconsistent(context, 'the hire kit gave an outcome that it does not list');
      }
    }
  } catch (error) {
    return { ...inconsistent(context, 'the outcome of the hire could not be read', escrowIfReadable(outcome), true, acceptedIfReadable(outcome)), cause: error };
  }
}
