// packages/usecase-kit/src/protocol/approval.ts
// The approval. The hiring organisation approves a proposal with an attestation of the type 5, whose digest is the proposal digest and whose subject is the buyer-side agent. Nothing on the ledger
// consumes the attestation: a counterparty, or a mock system, reads it and decides. A buyer-side agent does not check the approval. It passes the reference on, and a reference can be null.
//
// This file holds the reference, the constants of an approval, and the types of the check that a counterparty and a mock system share. The function that makes the check is not here.
import type { APPROVAL_REFUSALS } from './codes.ts';
import { parseAttestationId, parseDid } from './identifiers.ts';
import type { AttestationId, DelegationId, Did, Digest, Salt } from './identifiers.ts';
import type { Document } from './json.ts';
import { checkMembers, readMembers } from './members.ts';
import { accepted } from './result.ts';
import type { ProtocolResult } from './result.ts';

/** The attestation type of an approval. The hosted tools and the attestation builder call it `approval`. */
export const APPROVAL_ATT_TYPE = 5;
/** A hirer approves for 4 hours unless it chooses another time. */
export const APPROVAL_VALIDITY_DEFAULT_MS = 4 * 60 * 60 * 1000;
/** A hirer may choose a validity of up to 24 hours. */
export const APPROVAL_VALIDITY_MAX_MS = 24 * 60 * 60 * 1000;
/** The deposit that an attestation locks, in lovelace. It returns 90 days after the attestation ends. */
export const APPROVAL_DEPOSIT_LOVELACE = 5_000_000n;

/** The reference that the hirer gives with an `execute` request, and that the handoff carries: the attestation, and the record of its issuer. */
export interface ApprovalRef {
  readonly attestation: AttestationId;
  readonly issuer_did: Did;
}

/** An approval reference with exactly the two members, as a new object. The reference can be null in a request and in a handoff: that case is not for this parser. */
export function parseApprovalRef(value: unknown, field = 'approval'): ProtocolResult<ApprovalRef> {
  const read = readMembers(value, field);
  if (!read.ok) return read;
  const members = checkMembers(read.value, field, ['attestation', 'issuer_did']);
  if (members !== null) return members;
  const attestation = parseAttestationId(read.value.attestation, `${field}.attestation`);
  if (!attestation.ok) return attestation;
  const issuer = parseDid(read.value.issuer_did, `${field}.issuer_did`);
  if (!issuer.ok) return issuer;
  return accepted({ attestation: attestation.value, issuer_did: issuer.value });
}

/** The eight refusals of the checks of an approval, in the order of the checks. */
export type ApprovalRefusal = (typeof APPROVAL_REFUSALS)[number];

/** What the check of an approval needs. The members are the members of the handoff, and the time. */
export interface ApprovalInput {
  /** The reference that the handoff carries, or null when it carries none. A null reference gives `approval_not_found`. */
  readonly approval: ApprovalRef | null;
  /** The DID of the agent that sent the handoff. The subject of the attestation must be this agent. */
  readonly sender_did: Did;
  /** The delegation of the handoff. The issuer key of the attestation must be the root delegator of this delegation. */
  readonly delegation: DelegationId;
  /** The document and the salt that were received. The digest of the attestation must be SHA-256(salt ++ canonical document) of these two. */
  readonly document: Document;
  readonly salt: Salt;
  /** The time of the check, in milliseconds since 1970. The attestation must be in force at this time. */
  readonly now_ms: number;
}

/** The approval passed every check. The members tell what was found. */
export interface ApprovalAccepted {
  readonly ok: true;
  /** The attestation that passed. */
  readonly attestation: AttestationId;
  /** The record of the issuer, or null when the issuer has no record. */
  readonly issuer_did: Did | null;
  /** The hash of the issuer key: 56 lower-case hex characters. */
  readonly issuer_key_hash: string;
  /** The end of the validity of the attestation, in milliseconds since 1970, or null when it has none. */
  readonly valid_until: number | null;
}

/** The approval failed a check, and the check is not the digest check. `code` is the check that failed, and `detail` is a sentence for a log. */
export interface ApprovalRefusedByCheck {
  readonly ok: false;
  readonly code: Exclude<ApprovalRefusal, 'approval_digest_mismatch'>;
  readonly detail: string;
}

/** The digest of the attestation is not the digest of the document and the salt that were received. The two digests are the evidence of a challenge, so the check gives both. */
export interface ApprovalDigestMismatch {
  readonly ok: false;
  readonly code: 'approval_digest_mismatch';
  readonly detail: string;
  /** The digest that the attestation holds. */
  readonly expected_digest: Digest;
  /** The digest of the document and the salt that were received: SHA-256(salt ++ canonical document). */
  readonly observed_digest: Digest;
}

export type ApprovalRefused = ApprovalRefusedByCheck | ApprovalDigestMismatch;

export type ApprovalResult = ApprovalAccepted | ApprovalRefused;

/**
 * The check of an approval. A counterparty makes it before it claims a job, and the mock system of the third use case makes it on a ranking.
 *
 * A check can throw when it cannot read a source, such as the ledger or the gateway. A throw is not an answer. A caller treats it as "not available" (503): it is never a pass, and it is never a refusal of
 * a rule. The checks folder throws `CheckUnavailableError` in this case, and the mock service answers 503 `approval_unavailable`. A check that answers with `ok: false` is a refusal of a rule, and the
 * caller gives its code.
 */
export type ApprovalCheck = (input: ApprovalInput) => Promise<ApprovalResult>;
