// packages/usecase-kit/src/protocol/codes.ts
// The names that the protocol fixes: the use cases, the operations, the outcomes of a buyer-side agent, the exit states of a run, and every error and refusal code with its HTTP status.
//
// A buyer-side agent answers 200 with an `outcome` whenever it could read the request. The outcome and the reason are in the signed receipt, so what happened is on record:
//   - `refused_by_counterparty`: the counterparty refused the job. `reason` holds the code that the counterparty gave. For most codes the refusal comes before the Claim: the escrow stays Open and returns
//     to the vault after `deliver_by`. For a code of AFTER_CLAIM_REFUSALS the escrow is Claimed, and it stays Claimed until the buyer reclaims it after the deadline.
//   - `vault_refused`: the ledger refused the payment from the vault. `reason` holds the evaluation error that the node reported.
//   - `refused_by_system`: a mock system refused a call. `reason` holds its code (see SYSTEM_REFUSALS).
// A counterparty answers 200 only when it did the work. It refuses with `403 { error: <refusal code>, message }`. A refusal comes before the Claim, so the escrow stays Open and nothing is paid. The
// one exception is AFTER_CLAIM_REFUSALS: a decision of the counterparty after its Claim. An error of any agent is `{ error: <code>, message }` with the status of ERROR_STATUS.
import type { CounterpartyKind } from './kinds.ts';

export const USE_CASES = ['inventory-reorder', 'prior-authorization', 'bid-evaluation'] as const;
export type UseCase = (typeof USE_CASES)[number];

/** The use cases that have a handoff to a counterparty. Use case 3 (supplier bid evaluation) has none: a bid desk gets a request for quotation, and the buyer approves the ranking. */
export const HANDOFF_USE_CASES = ['inventory-reorder', 'prior-authorization'] as const satisfies readonly UseCase[];
export type HandoffUseCase = (typeof HANDOFF_USE_CASES)[number];

export const OPERATIONS = ['propose', 'execute'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** What a `propose` job can end with. */
export const PROPOSE_OUTCOMES = ['proposed', 'failed'] as const;
/** What an `execute` job can end with. */
export const EXECUTE_OUTCOMES = ['completed', 'vault_refused', 'refused_by_counterparty', 'refused_by_system', 'disputed', 'failed'] as const;
export const OUTCOMES = ['proposed', 'completed', 'vault_refused', 'refused_by_counterparty', 'refused_by_system', 'disputed', 'failed'] as const;
export type ProposeOutcome = (typeof PROPOSE_OUTCOMES)[number];
export type ExecuteOutcome = (typeof EXECUTE_OUTCOMES)[number];
export type Outcome = (typeof OUTCOMES)[number];

/** The state in which a run ends. The rule that gives the state of an `execute` result is `exitStateOf`. */
export const EXIT_STATES = ['Completed', 'Rejected', 'Expired', 'Cancelled', 'Escalated', 'Failed'] as const;
export type ExitState = (typeof EXIT_STATES)[number];

// The refusals of a counterparty, in the order in which it checks them. The first check that fails ends the job.
export const SENDER_REFUSALS = ['sender_not_active', 'sender_unaccountable', 'sender_key_mismatch'] as const;
export const DELEGATION_REFUSALS = ['delegation_invalid', 'delegation_ended'] as const;
/** The escrow was not paid from a vault of the delegation. The check comes after the checks of the delegation. */
export const VAULT_REFUSALS = ['not_vault_paid'] as const;
export const APPROVAL_REFUSALS = [
  'approval_not_found', 'approval_wrong_type', 'approval_wrong_subject', 'approval_wrong_issuer', 'approval_revoked', 'approval_expired', 'approval_issuer_invalid', 'approval_digest_mismatch',
] as const;

const COMMON_REFUSALS = [...SENDER_REFUSALS, ...DELEGATION_REFUSALS, ...VAULT_REFUSALS] as const;

/** For each counterparty, every refusal code that it can answer: the codes of the protocol, then the codes of its own page. The bid desk takes no approval, so it has no code of an approval. */
export const COUNTERPARTY_REFUSALS = {
  'order-desk': [...COMMON_REFUSALS, ...APPROVAL_REFUSALS, 'not_for_this_supplier', 'lot_mismatch', 'quantity_mismatch', 'duplicate_po', 'cannot_supply'],
  'insurer-intake-agent': [...COMMON_REFUSALS, ...APPROVAL_REFUSALS, 'not_for_this_insurer', 'advert_mismatch', 'duplicate_request'],
  'bid-desk': [...COMMON_REFUSALS, 'duplicate_rfq'],
} as const satisfies Record<CounterpartyKind, readonly string[]>;

/** Every refusal code of every counterparty, once. */
export const REFUSAL_CODES = [
  ...COMMON_REFUSALS, ...APPROVAL_REFUSALS,
  'not_for_this_supplier', 'lot_mismatch', 'quantity_mismatch', 'duplicate_po', 'cannot_supply',
  'not_for_this_insurer', 'advert_mismatch', 'duplicate_request',
  'duplicate_rfq',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * The refusal codes that a counterparty answers after its Claim. Every other refusal comes before the Claim. `cannot_supply` is a decision of the Order Desk: its model decides after the Claim
 * that the lot cannot be supplied. The buyer sees a job that failed after the Claim, with this code in the message. The escrow is Claimed, and it stays Claimed until the buyer reclaims it after
 * the deadline. Nothing is paid for the work that was not done.
 */
export const AFTER_CLAIM_REFUSALS = ['cannot_supply'] as const;

/**
 * The HTTP status of every error code of an agent. A refusal code of a counterparty is a 403. A request that cannot be read is a 400, and so is a delegation that names another agent. A check of a
 * counterparty that could not read its source is a 503 (`check_unavailable`). The job of a counterparty, after its Claim, ends with a 500 when it has no record of its pre-check (`precheck_missing`),
 * and with a 502 when the identity gateway gives it no SVID (`svid_failed`).
 */
export const ERROR_STATUS = {
  bad_wire: 400,
  request_too_large: 400,
  bad_shape: 400,
  // The delegation exists and names another agent as its delegate. A delegation that is not found does not end the job with this code: the ledger refuses the payment later.
  delegation_not_mine: 400,
  unauthorized: 401,
  sender_not_active: 403,
  sender_unaccountable: 403,
  sender_key_mismatch: 403,
  delegation_invalid: 403,
  delegation_ended: 403,
  not_vault_paid: 403,
  approval_not_found: 403,
  approval_wrong_type: 403,
  approval_wrong_subject: 403,
  approval_wrong_issuer: 403,
  approval_revoked: 403,
  approval_expired: 403,
  approval_issuer_invalid: 403,
  approval_digest_mismatch: 403,
  not_for_this_supplier: 403,
  lot_mismatch: 403,
  quantity_mismatch: 403,
  duplicate_po: 403,
  cannot_supply: 403,
  not_for_this_insurer: 403,
  advert_mismatch: 403,
  duplicate_request: 403,
  duplicate_rfq: 403,
  busy: 409,
  deadline: 422,
  inference_failed: 502,
  model_output_invalid: 502,
  token_failed: 502,
  mock_system_failed: 502,
  hire_failed: 502,
  // The job of a counterparty could not get the SVID that it needs to call the system of its organisation: the identity gateway refused the request or gave no answer. It is not a refusal code of a rule,
  // so it is not in REFUSAL_CODES.
  svid_failed: 502,
  shutting_down: 503,
  // A check of a counterparty could not read its source: the ledger or the gateway. It is never a pass, and the counterparty does not take the job. It is not a refusal code of a rule, so it is
  // not in REFUSAL_CODES.
  check_unavailable: 503,
  store_write_failed: 500,
  // The job of a counterparty has no record that its pre-check passed for this request, or the record is for another request. The job writes nothing then. It is not a refusal code of a rule, so it is
  // not in REFUSAL_CODES.
  precheck_missing: 500,
  internal: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

/** The body of an error answer of an agent. */
export interface ErrorBody {
  readonly error: ErrorCode;
  /** Words for a person. It never repeats a value of the request that could be secret. */
  readonly message: string;
}

/** True when the value is the name of an error code of the protocol. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_STATUS, value);
}

/** True when the value is the name of a refusal code of a counterparty. */
export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === 'string' && (REFUSAL_CODES as readonly string[]).includes(value);
}

/**
 * The refusals of a mock system that the protocol names, and the status of each: 401 for a token that is not valid, and 403 for the other rules, among them the eight codes of an approval. They are
 * the possible `reason` of `refused_by_system`. A mock system can answer other codes of its own (for a client certificate, a tenant or a host). A buyer-side agent passes any code on as the reason, so
 * a reason that is not in this list is not an error.
 */
export const SYSTEM_REFUSALS = ['token_invalid', 'not_covered', 'delegation_ended', 'chain_too_deep', 'supplier_not_active', ...APPROVAL_REFUSALS] as const;
export type SystemRefusal = (typeof SYSTEM_REFUSALS)[number];

export const SYSTEM_REFUSAL_STATUS = {
  token_invalid: 401,
  not_covered: 403,
  delegation_ended: 403,
  chain_too_deep: 403,
  supplier_not_active: 403,
  approval_not_found: 403,
  approval_wrong_type: 403,
  approval_wrong_subject: 403,
  approval_wrong_issuer: 403,
  approval_revoked: 403,
  approval_expired: 403,
  approval_issuer_invalid: 403,
  approval_digest_mismatch: 403,
} as const satisfies Record<SystemRefusal, 401 | 403>;

/** True when the value is the name of a refusal that the protocol names for a mock system. A code of a mock system that is not in the list can still be a reason. */
export function isSystemRefusal(value: unknown): value is SystemRefusal {
  return typeof value === 'string' && (SYSTEM_REFUSALS as readonly string[]).includes(value);
}
