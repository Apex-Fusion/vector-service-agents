// packages/usecase-kit/src/buyer/outcome.ts
// The map from what the hire kit says to a step of this folder, in one function with one table. The exit state of a result is never written here: `exitStateOf` of the protocol gives it.
//
//   outcome of the hire kit                                     step                       reason of the result
//   completed, VERIFIED and all eight checks true               completed                  none
//   refused_before_claim                                        refused_by_counterparty    the code of the counterparty when the protocol has it, else `counterparty_refused`
//   failed_after_claim, `failed`, with a code of AFTER_CLAIM    refused_by_counterparty    that code (the decision of the counterparty after its Claim)
//   failed_after_claim, any other                               failed                     the reason of the hire kit. It is NOT a refusal.
//   vault_refused                                               vault_refused              the evaluation error of the node, or the code of the builder when the Pay could not be built
//   not_accepted, declined                                      not_accepted               (the code of the use case files the challenge)
//   not_accepted, decision_timeout                              not_accepted               (the same)
//   not_accepted, receipt_failed                                failed                     `receipt_failed`
//   HireInterrupted                                             interrupted                `deadline`, `store_write_failed`, `decision_error` or `hire_interrupted`
//   HirePayUnconfirmed                                          pay_unconfirmed            `pay_unconfirmed`
//   a hire that no outcome names (a fault before any Pay)       failed                     `advert_unavailable`, `post_failed` or `hire_error`
//   anything else, or a `completed` that does not hold         failed                     `inconsistent_outcome`
//
// A counterparty code is read only when the protocol has it: the text of a counterparty never reaches a reason. A job that failed after the Claim is a failure and never a refusal. The one
// exception is the code that the counterparty answered as its own decision after its Claim: the runtime copies the answer of the service into the message of the failure, and this file reads that
// one fixed form.
import { verificationOf } from '@vsa/hire-kit';
import type { AgentDelivery, AgentEscrow, AgentOutcome, HireFailure, HireTerms } from '@vsa/hire-kit';
import { flatText } from '@vsa/service-kit/text';
import { AFTER_CLAIM_REFUSALS, RECEIPT_CHECKS, isErrorCode, isPlainObject, parseJsonText, parseJsonValue, parseOutputRef } from '@vsa/usecase-kit/protocol';
import type { Did, HandoffRecord, JsonObject, OutputRef, ReceiptCheck, ReceiptVerification } from '@vsa/usecase-kit/protocol';
import type { DelegationAfter } from './authority.ts';
import type { FailedStep, HireStep, VerifiedDelivery } from './steps.ts';

/** The reason of a refusal whose code the protocol does not name. */
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
  /** What the delegation was after a refused Pay. The flow reads it when the outcome is `vault_refused`; it is `null` for any other outcome. */
  readonly delegation_after: DelegationAfter | null;
}

/** The longest reason that the use case gave when it said no: it is words, and the flow cuts them. */
const DECLINED_MAX = 300;
/** The longest evaluation error of the node that a reason holds. */
const EVALUATION_ERROR_MAX = 300;

/** A code of `AFTER_CLAIM_REFUSALS`. */
export type AfterClaimRefusal = (typeof AFTER_CLAIM_REFUSALS)[number];

/**
 * The code of the counterparty in the message of a job that failed after its Claim, when the counterparty answered with a code of `AFTER_CLAIM_REFUSALS`. The runtime copies the answer of the
 * service, `{"error":"<code>", ...}`, into the failure. The function reads only that member, and only for the codes that the protocol lists. Any other text is `null`.
 */
export function afterClaimRefusalIn(message: unknown): AfterClaimRefusal | null {
  if (typeof message !== 'string') return null;
  return AFTER_CLAIM_REFUSALS.find((code) => message.includes(`"error":"${code}"`)) ?? null;
}

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

/** The delivery as a decision and a result see it, or `null` when the hire kit gave a delivery that cannot be written as JSON data. Each call makes a new copy. */
export function deliveryOf(delivery: AgentDelivery): VerifiedDelivery | null {
  const escrow = parseOutputRef(delivery.escrowRef, 'escrow');
  const advert = parseOutputRef(delivery.advertRef, 'advert');
  const receipt = jsonObjectOf(delivery.record.receipt);
  const verification = verificationFrom(delivery.record.verification);
  const signature: unknown = delivery.record.receipt_signature;
  if (!escrow.ok || !advert.ok || receipt === null || verification === null || typeof signature !== 'string' || typeof delivery.text !== 'string') return null;
  const parsed = parseJsonText(delivery.text);
  return {
    escrow_ref: escrow.value, advert_ref: advert.value, text: delivery.text, result: parsed.ok ? jsonObjectOf(parsed.value) : null, receipt, receipt_signature: signature, verification,
  };
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

/** The hire as the result of the agent records it. `delivery` is `null` when no delivery came. */
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

/** The step for an outcome that does not hold together. It names the escrow when it is known, so that no escrow is lost from the record. */
function inconsistent(context: StepContext, detail: string, escrow: Escrow | null = null, accepted: HandoffRecord['accepted'] = null): FailedStep {
  return failure(INCONSISTENT_OUTCOME, detail, {
    handoff: escrow === null ? null : recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, null, accepted),
    vault_ref: escrow?.vault_ref ?? null, terms: escrow?.terms ?? null,
  });
}

type Completed = Extract<AgentOutcome, { outcome: 'completed' }>;
type Refused = Extract<AgentOutcome, { outcome: 'refused_before_claim' }>;
type FailedAfterClaim = Extract<AgentOutcome, { outcome: 'failed_after_claim' }>;
type VaultRefused = Extract<AgentOutcome, { outcome: 'vault_refused' }>;
type NotAccepted = Extract<AgentOutcome, { outcome: 'not_accepted' }>;

/**
 * `completed` holds only when everything that the protocol means by it holds: the verdict is VERIFIED, all eight checks are true, and the Accept is confirmed or pending. Anything else is
 * `inconsistent_outcome`: a hire that did not verify is never reported as done.
 */
function completedStep(outcome: Completed, context: StepContext): HireStep {
  const escrow = escrowOf(outcome);
  if (escrow === null) return inconsistent(context, 'the hire kit gave an escrow or an advert that is not an output reference');
  const delivery = deliveryOf({ escrowRef: outcome.escrowRef, advertRef: outcome.advertRef, text: outcome.text, record: outcome.record, verdict: outcome.verdict });
  if (delivery === null) return inconsistent(context, 'the delivery of the hire cannot be written as JSON data', escrow, outcome.accepted === 'confirmed' ? 'confirmed' : 'pending');
  const verified = outcome.verdict.verdict === 'VERIFIED' && RECEIPT_CHECKS.every((check) => delivery.verification[check] === true);
  if (!verified) return inconsistent(context, 'the hire says completed, and its receipt is not verified', escrow);
  if (outcome.accepted !== 'confirmed' && outcome.accepted !== 'pending') return inconsistent(context, 'the hire says completed, and it does not say whether the Accept was seen', escrow);
  return {
    kind: 'completed', handoff: recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, delivery, outcome.accepted, outcome.paidFrom === 'vault'), vault_ref: escrow.vault_ref, terms: escrow.terms, delivery,
  };
}

function refusedBeforeClaimStep(outcome: Refused, context: StepContext): HireStep {
  const escrow = escrowOf(outcome);
  if (escrow === null) return inconsistent(context, 'the hire kit gave an escrow or an advert that is not an output reference');
  return {
    kind: 'refused_by_counterparty', reason: isErrorCode(outcome.code) ? outcome.code : COUNTERPARTY_REFUSED, source: 'before_claim',
    runtime_status: Number.isSafeInteger(outcome.status) ? outcome.status : null,
    handoff: recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, null, null), vault_ref: escrow.vault_ref, terms: escrow.terms,
  };
}

function failedAfterClaimStep(outcome: FailedAfterClaim, context: StepContext): HireStep {
  const escrow = escrowOf(outcome);
  if (escrow === null) return inconsistent(context, 'the hire kit gave an escrow or an advert that is not an output reference');
  const handoff = recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, null, null);
  const refusal = outcome.reason === 'failed' ? afterClaimRefusalIn(outcome.message) : null;
  if (refusal !== null) {
    return { kind: 'refused_by_counterparty', reason: refusal, source: 'after_claim', runtime_status: null, handoff, vault_ref: escrow.vault_ref, terms: escrow.terms };
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
  if (delivery === null) return inconsistent(context, 'the delivery of the hire cannot be written as JSON data', escrow);
  return {
    kind: 'not_accepted', why: outcome.reason, declined: outcome.reason === 'declined' ? flatText(String(outcome.declined), DECLINED_MAX) : null,
    handoff: recordOf(context.counterparty_did, escrow.advert_ref, escrow.escrow_ref, delivery, 'no'), vault_ref: escrow.vault_ref, terms: escrow.terms, delivery,
  };
}

/**
 * The step for one outcome of the hire kit. The switch has no default that passes: an outcome that is not one of the five is `inconsistent_outcome`.
 * `context.delegation_after` is read by the flow for `vault_refused`; the function reads no ledger.
 */
export function stepOfOutcome(outcome: AgentOutcome, context: StepContext): HireStep {
  if (typeof outcome !== 'object' || outcome === null) return inconsistent(context, 'the hire kit gave no outcome');
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
}
