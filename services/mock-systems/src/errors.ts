// services/mock-systems/src/errors.ts
// Every refusal of this service is a typed result. It has a code, the status of that code and the rule that failed. No code reads success or failure from a text.
// A refusal body is `{ error, message }`: `error` is the code. The rule goes to the log line, and the message tells a person what to change.

/**
 * The codes of the service, and the HTTP status of each. A code has one status. The groups:
 * - the credential: 401 for a credential that is missing or not valid, 403 for a credential that is valid and does not give the right;
 * - the approval checks of a ranking, and the supplier of its top rank;
 * - the host and the certificate header;
 * - the gateway or the ledger could not be read: 503, and the call is refused;
 * - the request itself and the data of the tenant.
 */
export const STATUS_OF = {
  token_invalid: 401,
  not_covered: 403,
  delegation_ended: 403,
  chain_too_deep: 403,
  actor_not_active: 403,

  svid_missing: 401,
  svid_invalid: 401,
  agent_not_active: 403,
  organisation_mismatch: 403,
  organisation_unverified: 403,

  approval_not_found: 403,
  approval_wrong_type: 403,
  approval_wrong_subject: 403,
  approval_wrong_issuer: 403,
  approval_revoked: 403,
  approval_expired: 403,
  approval_issuer_invalid: 403,
  approval_digest_mismatch: 403,
  supplier_not_active: 403,

  wrong_host: 421,
  client_certificate_unexpected: 400,
  client_certificate_multiple: 400,
  client_certificate_malformed: 400,

  operator_token_invalid: 401,

  gateway_unavailable: 503,
  ledger_unavailable: 503,
  approval_unavailable: 503,
  service_busy: 503,

  bad_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  tenant_not_found: 404,
  sku_not_found: 404,
  order_not_found: 404,
  guideline_not_found: 404,
  requirements_not_found: 404,
  duplicate_po: 409,
  duplicate_request: 409,
  duplicate_submission: 409,
  tenant_limit: 409,
  tenant_changed: 409,
  body_too_large: 413,
  unsupported_media_type: 415,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof STATUS_OF;

/** The eight codes of an approval that is not good: what the approval check may answer. */
export const APPROVAL_CODES = [
  'approval_not_found', 'approval_wrong_type', 'approval_wrong_subject', 'approval_wrong_issuer', 'approval_revoked', 'approval_expired', 'approval_issuer_invalid', 'approval_digest_mismatch',
] as const satisfies readonly ErrorCode[];
export type ApprovalCode = (typeof APPROVAL_CODES)[number];

/** A call that is refused: the code with its status, the rule that failed (a name for the log), and the words that go to the caller. */
export interface Refusal {
  readonly status: number;
  readonly code: ErrorCode;
  readonly rule: string;
  readonly message: string;
}

/** A call that is refused. */
export type Refused = { readonly ok: false; readonly refusal: Refusal };

/** A decision: it passes with a value, or it is refused with the rule that failed. */
export type Outcome<T> = { readonly ok: true; readonly value: T } | Refused;

export const pass = <T>(value: T): Outcome<T> => ({ ok: true, value });

export function refuse(code: ErrorCode, rule: string, message: string): Refused {
  return { ok: false, refusal: { status: STATUS_OF[code], code, rule, message } };
}
