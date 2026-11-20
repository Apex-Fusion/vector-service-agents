// packages/usecase-kit/src/cosign/codes.ts
// The route `POST /cosign/delegate`: its path, its codes with their HTTP statuses, and its limits.
//
// A member builds a Delegate transaction for a buyer-side agent. The delegation contract needs the signature of the delegate key of the agent, and only the agent holds that key. The route
// takes the transaction in `{ "transaction": "<hex CBOR>" }` and answers `200 { "transaction": "<hex CBOR>" }`: the same transaction with one more vkey witness, of the delegation key that the
// datum names. A refusal is a 4xx `{ "error": "<code>", "message": "<words>" }`. A source that cannot be read, and a fault of the service, are 5xx: they are never a refusal and never a pass.
import { ERROR_STATUS } from '../protocol/index.ts';

/** The path of the route, on the origin of the endpoint in the record of the agent. */
export const COSIGN_PATH = '/cosign/delegate';

/**
 * The refusal codes of the route and the HTTP status of each. A code is the answer of one rule of the agent: it names the rule that failed. The six codes are the ones that the wire contract names. The wire
 * contract says only "a 4xx", so the statuses are the choice of this table: 400 for a transaction that is not what the route signs, 403 for a rule of the operator, 409 for a key that is in use.
 */
export const COSIGN_REFUSALS = {
  /** The transaction is not the one Delegate that the route signs: its form, its parts, its mint, its datum, its redeemer, its window or its signers are not the form of the Delegate. */
  not_a_delegation: 400,
  /** The delegation does not name this agent as the delegate, or it names a key that is not one of the delegation keys of this agent. */
  not_for_this_agent: 400,
  /** The delegation key is in use: the agent signed another body for it whose window is open, or a live delegation on the ledger names it. */
  key_in_use: 409,
  /** The delegator did not sign this body first (the transaction has no witness of the delegator that verifies over it), or the delegator is not a principal key on the allowlist of the operator, or it is a key of the agent. */
  principal_not_allowed: 403,
  /** An input or a collateral input of the transaction is an output of a wallet of a key of this agent. */
  spends_agent_funds: 403,
  /** The validity window of the transaction has ended, or the period of the delegation in its datum has ended. */
  expired: 400,
} as const;
export type CosignRefusal = keyof typeof COSIGN_REFUSALS;

/**
 * Every code that the route answers, with its status. The first six are the refusals. The rest are codes of the protocol (the status is the one of `ERROR_STATUS`) and two codes of the path: a request that
 * cannot be read (`bad_shape`, `request_too_large`), a ledger that cannot be read (`check_unavailable`, 503), a route that is at its limit for requests at one time (`busy`), and a fault of the service
 * (`internal`, 500). The statuses 405 and 415 are the ones of HTTP for a method and for a content type that the route does not take.
 */
export const COSIGN_STATUS = {
  ...COSIGN_REFUSALS,
  bad_shape: ERROR_STATUS.bad_shape,
  request_too_large: ERROR_STATUS.request_too_large,
  check_unavailable: ERROR_STATUS.check_unavailable,
  busy: ERROR_STATUS.busy,
  internal: ERROR_STATUS.internal,
  method_not_allowed: 405,
  unsupported_media_type: 415,
} as const;
export type CosignCode = keyof typeof COSIGN_STATUS;

/** The body of an error answer of the route. The message never repeats a part of the request. */
export interface CosignErrorBody {
  readonly error: CosignCode;
  readonly message: string;
}

/** The most hex characters of a transaction: 32,768, that is 16,384 bytes, the most that the ledger takes in one transaction. A request with a longer text is refused before it is parsed. */
export const MAX_TRANSACTION_HEX = 32_768;
/** The most bytes of a request: the hex of the largest transaction, and 256 bytes for the JSON around it. The check comes before the JSON parse. */
export const MAX_COSIGN_REQUEST_BYTES = MAX_TRANSACTION_HEX + 256;
/** The most outputs that a transaction spends or uses as collateral. A Delegate spends one or two outputs and has one collateral output. The ledger read is for this many outputs at most. */
export const MAX_SPENT_OUTPUTS = 32;
/** The longest validity window of a Delegate: one hour. The delegation contract refuses a longer window. */
export const MAX_WINDOW_MS = 3_600_000;
/** After the end of its window, a body that the agent signed keeps its key for this long. The node and this host can differ by seconds in their view of the end of the window. */
export const RESERVATION_MARGIN_MS = 60_000;
/** The length of a slot on the chain: one second. */
export const SLOT_MS = 1_000;
