// packages/usecase-kit/src/buyer/steps.ts
// How a hire of a counterparty ended, as one tagged union. A caller switches on `kind`, and the compiler checks that it handled every kind. No kind is read from a text, and no kind is a pass
// except `completed`. A step holds what the hire kit knows of the payment: the escrow, the vault that continues, and the terms. It holds no text of the counterparty.
//
//   completed                the vault paid the hire, the receipt passed the eight checks, the decision accepted the delivery, and the Accept was made. A ledger of the caller that failed to book the Accept does not change this: `booking_failed` says it.
//   refused_by_counterparty  the counterparty refused the job by a rule of the protocol: before its Claim (status 403 and a refusal code of its kind), or after its Claim (a code of AFTER_CLAIM_REFUSALS that the protocol lists for its kind). Before its Claim the escrow stays Open. After its Claim the escrow is Claimed. Either way it returns to the vault after its deadline.
//   vault_refused            the ledger refused the Pay from the vault, or the Pay could not be made. Nothing was signed and no money moved.
//   failed                   the job did not finish, and it is not a refusal. A job that failed after the Claim is here, and so is an answer before the Claim that is not a refusal by a rule of the protocol.
//   not_accepted             the delivery came, and the decision said no or did not answer in time, or the delivery passed the eight checks and cannot be recorded. The code of the use case files the challenge.
//   interrupted              an error ended the hire after the Pay was confirmed.
//   pay_unconfirmed          the Pay was sent and not seen confirmed. It may still land.
//   refused                  the request is refused before any ledger read of the Pay: an error of the protocol with its code.
import type { ErrorCode, HandoffRecord, OutputRef, ReceiptVerification } from '@vsa/usecase-kit/protocol';
import type { HireTerms } from '@vsa/hire-kit';
import type { JsonObject } from '@vsa/usecase-kit/protocol';
import type { DelegationAfter } from './authority.ts';

/** A delivery that passed the eight checks of the receipt. The decision of a use case gets it. */
export interface VerifiedDelivery {
  readonly escrow_ref: OutputRef;
  readonly advert_ref: OutputRef;
  /** The text of the answer of the counterparty, as it gave it. */
  readonly text: string;
  /** The answer as a JSON object, or `null` when its text is not one. The confirmation, the intake record or the quote is here. */
  readonly result: JsonObject | null;
  /** The receipt as the counterparty signed it. */
  readonly receipt: JsonObject;
  readonly receipt_signature: string;
  /** The eight checks of the receipt. */
  readonly verification: ReceiptVerification;
}

/** What the hire kit says of an escrow that a Pay opened. */
interface PaidStep {
  /** The hire for the result of the agent. */
  readonly handoff: HandoffRecord;
  /** The vault that continues after the Pay. */
  readonly vault_ref: string | null;
  readonly terms: HireTerms;
}

/**
 * The ledger of the caller threw when the hire kit booked the fee of an Accept that was confirmed. The Accept is on the chain, so the caller books the fee by other means, and the hash and the fee below are what
 * the hire kit gave to the ledger in that call. The ledger may have written the booking before it threw: the caller checks its ledger by `accept_tx_hash` before it books the fee again. The error is for the
 * log of the operator. Never put it in a result.
 */
export interface BookingFailure {
  /** The error that the ledger threw. */
  readonly cause: unknown;
  /** The hash of the Accept transaction, as the hire kit gave it to the ledger. `null` when the call holds no hash: the type of the ledger of the hire kit names only the fee. */
  readonly accept_tx_hash: string | null;
  /** The fee of the Accept transaction in lovelace, as the hire kit gave it to the ledger. */
  readonly fee_lovelace: bigint;
}

export interface CompletedStep extends PaidStep {
  readonly kind: 'completed';
  readonly delivery: VerifiedDelivery;
  /**
   * Set when the ledger of the caller threw while it booked the fee of the Accept. The Accept is confirmed on the chain, and the work is paid for: the step is still `completed`, because a failed result for
   * paid work invites a second execute of the same work. The service must log the error and book the fee by other means, with the hash and the fee that this member holds. The ledger may have written the
   * booking before it threw, so the service checks its ledger by that hash before it books the fee again. `null` when the booking worked.
   */
  readonly booking_failed: BookingFailure | null;
}

export interface RefusedByCounterpartyStep extends PaidStep {
  readonly kind: 'refused_by_counterparty';
  /** A refusal code that the protocol lists for the counterparty of the use case. Never a text of the counterparty. */
  readonly reason: string;
  /** Before its Claim (status 403 and a refusal code of its kind that is not an after-Claim code), or after its Claim (a code of `AFTER_CLAIM_REFUSALS` that is a refusal code of its kind). */
  readonly source: 'before_claim' | 'after_claim';
  /** 403 when the refusal came before the Claim, and `null` when it came after. */
  readonly runtime_status: number | null;
}

export interface VaultRefusedStep {
  readonly kind: 'vault_refused';
  /** The evaluation error of the node for a Pay that the vault script refused or the node did not evaluate, and the code of the builder for a Pay that could not be built. */
  readonly reason: string;
  readonly refusal: 'ledger' | 'not_evaluated' | 'impossible';
  /** What the delegation was when the flow read it again after the refusal. */
  readonly delegation: DelegationAfter;
  /** True when the hirer ended the delegation. The exit state is then `Cancelled`. */
  readonly delegation_ended: boolean;
  /** For the evidence file. It is not part of the result of the agent. */
  readonly evidence: { readonly transaction_body: string | null };
  /** No escrow was posted. */
  readonly handoff: null;
}

export interface FailedStep {
  readonly kind: 'failed';
  /** A code. A code of the hire kit for a job that failed after the Pay, or a code of this folder. */
  readonly reason: string;
  /** One sentence for a log. It holds no text of the counterparty. */
  readonly detail: string;
  /** The hire, or `null` when no escrow was posted. */
  readonly handoff: HandoffRecord | null;
  readonly vault_ref: string | null;
  readonly terms: HireTerms | null;
  /** The error that ended the hire, for the log of the operator. Never put it in a result. */
  readonly cause?: unknown;
}

/**
 * What can be recorded of a delivery that passed the eight checks and that cannot be written as JSON data of the protocol: a receipt whose member is nested too deep, for example. The receipt itself is not
 * here.
 */
export interface UnrecordedDelivery {
  readonly escrow_ref: OutputRef;
  readonly advert_ref: OutputRef;
  /** The hash of the supplier key: 56 lower-case hex characters. */
  readonly supplier_pkh: string;
  /** The eight checks of the receipt. */
  readonly verification: ReceiptVerification;
}

/** The delivery came and can be recorded. The decision said no (`declined`), or it did not answer in time (`decision_timeout`). No Accept was made. */
interface NotAcceptedByDecisionStep extends PaidStep {
  readonly kind: 'not_accepted';
  readonly why: 'declined' | 'decision_timeout';
  /** The reason that the decision gave when it said no, and `null` for a decision that did not answer. It is the words of the use case, never of the counterparty. */
  readonly declined: string | null;
  readonly delivery: VerifiedDelivery;
}

/**
 * The delivery passed the eight checks, and it cannot be written as JSON data of the protocol, so no result can hold it and the flow cannot accept it. The decision was not asked, and no Accept was made:
 * the escrow stays Submitted. The counterparty must not be able to choose this end for itself, so the use case treats this step as it treats a delivery that its decision refused, and files its challenge
 * with what the step holds.
 */
interface NotAcceptedUnrecordableStep extends PaidStep {
  readonly kind: 'not_accepted';
  readonly why: 'not_recordable';
  readonly declined: null;
  readonly delivery: null;
  readonly unrecorded: UnrecordedDelivery;
}

export type NotAcceptedStep = NotAcceptedByDecisionStep | NotAcceptedUnrecordableStep;

/** Why an error ended a hire after the Pay was confirmed. */
export type InterruptionCause = 'deadline' | 'store_write' | 'decision_error' | 'other';

export interface InterruptedStep {
  readonly kind: 'interrupted';
  readonly cause_kind: InterruptionCause;
  readonly detail: string;
  /** The vault that continues. The next Pay starts from it. */
  readonly vault_ref: string;
  readonly escrow_ref: OutputRef;
  readonly handoff: HandoffRecord;
  /** The delivery that the decision was given, or `null` when the hire ended before the decision. */
  readonly delivery: VerifiedDelivery | null;
  /** The error that ended the hire, for the log of the operator. Never put it in a result. */
  readonly cause: unknown;
}

export interface PayUnconfirmedStep {
  readonly kind: 'pay_unconfirmed';
  readonly detail: string;
  /** The escrow that the Pay opens if it lands. */
  readonly escrow_ref: OutputRef;
  /** The vault that continues if the Pay lands. */
  readonly vault_ref_if_landed: string;
  readonly tx_hash: string;
  /** False when the Pay certainly did not reach the node. */
  readonly may_land: boolean;
  /** The time after which the Pay cannot land, in POSIX milliseconds. A caller starts no other Pay from the old vault before it. */
  readonly valid_to: number;
  readonly handoff: HandoffRecord;
  readonly cause: unknown;
}

/** The codes of a request that is refused before the Pay. Each one is an error code of the protocol with its HTTP status. `internal` is a fault of the settings of the agent. */
export type RefusedCode = Extract<ErrorCode, 'delegation_not_mine' | 'request_too_large' | 'bad_shape' | 'internal'>;

export interface RefusedStep {
  readonly kind: 'refused';
  readonly code: RefusedCode;
  readonly detail: string;
}

export type HireStep = CompletedStep | RefusedByCounterpartyStep | VaultRefusedStep | FailedStep | NotAcceptedStep | InterruptedStep | PayUnconfirmedStep | RefusedStep;
