// packages/usecase-kit/src/checks/approval.ts
// The check of an approval: ONE function that makes the six checks in their order, and answers with the types of the protocol.
//   found and authentic            approval_not_found
//   the type is the approval type  approval_wrong_type
//   the subject is the sender      approval_wrong_subject
//   the issuer is the root delegator of the delegation: for a key principal the hash of the issuer key is the hash of the root delegator, for an agent root the issuer id is the id of
//   the root delegator             approval_wrong_issuer
//   valid at the time of the check by the rule of the registry: active, inside its validity range, the issuer not invalid when it issued the approval
//                                  approval_revoked, approval_expired, approval_issuer_invalid
//   the digest is the digest of the document and the salt that were received   approval_digest_mismatch
//
// The time of the check can be before the time of issue. A relying party does not require that the time is after `issued_at`: the registry sets `issued_at` to the end of the validity
// window of the transaction, so it can be up to an hour after the block. The rule of the registry already refuses a time that is more than an hour before it.
//
// A null approval is `approval_not_found`, and no read is made. A digest mismatch gives both digests: the one that the attestation holds and the one of the document that was received.
// A source that cannot be read, or that gives an answer that is not for this check, throws CheckUnavailableError. It is never a pass, and it is never the code of a rule.
import type { CheckLine } from '@vsa/buyer-core';
import type { Delegator } from '@vsa/vector-read/identity-codec';
import { APPROVAL_ATT_TYPE, isPlainObject, parseApprovalRef, parseDelegationId, parseDid, parseDigest, proposalDigest } from '../protocol/index.ts';
import type {
  ApprovalCheck, ApprovalInput, ApprovalRef, ApprovalRefusedByCheck, ApprovalResult, DelegationId, Did, Digest,
} from '../protocol/index.ts';
import { clip, didOf, idOf, keyHashOf } from './ids.ts';
import { badAnswer, readThrough } from './ports.ts';
import type { ChecksPorts } from './ports.ts';

const refusedBy = (code: ApprovalRefusedByCheck['code'], detail: string): ApprovalRefusedByCheck => ({ ok: false, code, detail });

interface ReadInput {
  readonly ref: ApprovalRef | null;
  readonly sender: Did;
  readonly delegation: DelegationId;
  readonly observed: Digest;
  readonly nowMs: number;
}

/** The input as checked copies. A member of the wrong type is an error and never a pass: a time that is not a whole number would read as a time that is always in force. */
function readInput(input: ApprovalInput): ReadInput {
  if (!isPlainObject(input)) throw new TypeError('the input of the approval check must be an object');
  const ref = input.approval === null ? null : parseApprovalRef(input.approval, 'approval');
  if (ref !== null && !ref.ok) throw new TypeError(`the input of the approval check is wrong: ${ref.detail}`);
  const sender = parseDid(input.sender_did, 'sender_did');
  if (!sender.ok) throw new TypeError(`the input of the approval check is wrong: ${sender.detail}`);
  const delegation = parseDelegationId(input.delegation, 'delegation');
  if (!delegation.ok) throw new TypeError(`the input of the approval check is wrong: ${delegation.detail}`);
  const observed = proposalDigest(input.salt, input.document);
  if (!observed.ok) throw new TypeError(`the input of the approval check is wrong: ${observed.detail}`);
  if (!Number.isSafeInteger(input.now_ms) || input.now_ms < 0) throw new TypeError('the input of the approval check is wrong: now_ms must be a whole number of milliseconds since 1970');
  return { ref: ref === null ? null : ref.value, sender: sender.value, delegation: delegation.value, observed: observed.value, nowMs: input.now_ms };
}

/** The root delegator of the delegation, or null when the delegation is not live or its chain does not end at a root. Every link names the next one as its parent. */
async function rootDelegatorOf(ports: ChecksPorts, id: DelegationId): Promise<Delegator | null> {
  const view = await readThrough(ports, 'delegation', () => ports.ledger.readDelegation(id));
  const chain = view.chain;
  if (chain.length === 0 || chain[0].id !== id) return null;
  for (let index = 0; index < chain.length; index += 1) {
    const parent = index + 1 < chain.length ? chain[index + 1].id : null;
    if (chain[index].delegation.parent !== parent) return null;
  }
  return chain[chain.length - 1].delegation.delegator;
}

// The conditions of the validity rule in the order that the rule lists them. `strict` conditions pass only with `pass`: the attestation exists, so they always apply. The others can be
// `not_applicable` (an attestation with no envelope, an issuer that is a key with no record).
const CONDITIONS = [
  { id: 'active', code: 'approval_revoked', text: 'the approval was revoked', strict: true },
  { id: 'time_window', code: 'approval_expired', text: 'the time of the check is not inside the validity range of the approval', strict: true },
  { id: 'envelope', code: 'approval_issuer_invalid', text: 'the envelope signature of the approval does not verify with the issuer key', strict: false },
  { id: 'issuer_not_invalidated', code: 'approval_issuer_invalid', text: 'the issuer of the approval was invalid when it issued the approval', strict: false },
  { id: 'issuer_key_listed', code: 'approval_issuer_invalid', text: 'the issuer key was not listed for assertion when the approval was issued', strict: false },
] as const satisfies readonly { id: string; code: ApprovalRefusedByCheck['code']; text: string; strict: boolean }[];

const RESULTS: readonly unknown[] = ['pass', 'fail', 'not_applicable'];

function conditionRefusal(ports: ChecksPorts, conditions: readonly CheckLine[]): ApprovalRefusedByCheck | null {
  for (const condition of CONDITIONS) {
    const line = conditions.find((candidate) => candidate.id === condition.id);
    if (line === undefined || !RESULTS.includes(line.result)) return badAnswer(ports, 'attestation', `the condition ${condition.id} is missing or has a result that is not known`);
    if (line.result === 'pass' || (!condition.strict && line.result === 'not_applicable')) continue;
    return refusedBy(condition.code, `${condition.text} (${clip(String(line.detail), 100)})`);
  }
  return null;
}

/**
 * Checks an approval against the ledger at `input.now_ms`. See the head of this file for the checks and their codes. The checks run in order and the first refusal is the answer.
 * It throws a TypeError for an input of the wrong type, and CheckUnavailableError for a source that cannot be read.
 */
export async function checkApproval(ports: ChecksPorts, input: ApprovalInput): Promise<ApprovalResult> {
  const { ref, sender, delegation, observed, nowMs } = readInput(input);
  if (ref === null) return refusedBy('approval_not_found', 'the handoff has no approval');

  const checked = await readThrough(ports, 'attestation', () => ports.ledger.attestation(ref.attestation, nowMs));
  if (checked.id !== ref.attestation || checked.atMs !== nowMs) return badAnswer(ports, 'attestation', 'it is not for this attestation and this time');
  const view = checked.attestation;
  if (view === null) return refusedBy('approval_not_found', 'no authentic attestation has this identifier');
  if (view.id !== ref.attestation) return badAnswer(ports, 'attestation', 'the attestation is not the one that was asked for');
  const att = view.attestation;
  if (att.attType !== APPROVAL_ATT_TYPE) return refusedBy('approval_wrong_type', 'the attestation is not an approval');
  if (att.subject !== idOf(sender)) return refusedBy('approval_wrong_subject', 'the subject of the attestation is not the sender');

  const root = await rootDelegatorOf(ports, delegation);
  if (root === null) return refusedBy('approval_wrong_issuer', 'the delegation is not live or has no root, so the approval has no root delegator to compare with');
  const issuedByRoot = root.type === 'PrincipalKey' ? keyHashOf(att.issuer) === root.hash.toLowerCase() : att.issuerId !== null && att.issuerId === root.id;
  if (!issuedByRoot) return refusedBy('approval_wrong_issuer', 'the issuer of the attestation is not the root delegator of the delegation');
  if (att.issuerId !== null && didOf(att.issuerId) !== ref.issuer_did) return refusedBy('approval_wrong_issuer', 'the issuer record that the reference names is not the issuer record of the attestation');

  const condition = conditionRefusal(ports, checked.conditions);
  if (condition !== null) return condition;

  const expected = parseDigest(att.digest, 'digest');
  if (!expected.ok) return badAnswer(ports, 'attestation', 'the digest of the attestation is not a digest');
  if (expected.value !== observed) {
    return {
      ok: false, code: 'approval_digest_mismatch', detail: 'the digest of the attestation is not the digest of the document and the salt that were received',
      expected_digest: expected.value, observed_digest: observed,
    };
  }
  return { ok: true, attestation: ref.attestation, issuer_did: att.issuerId === null ? null : didOf(att.issuerId), issuer_key_hash: keyHashOf(att.issuer), valid_until: att.validUntil };
}

/** The check bound to its ports: the `ApprovalCheck` of the protocol, for a service that takes the check as a dependency. It throws CheckUnavailableError as `checkApproval` does. */
export function approvalCheckOf(ports: ChecksPorts): ApprovalCheck {
  return (input) => checkApproval(ports, input);
}
