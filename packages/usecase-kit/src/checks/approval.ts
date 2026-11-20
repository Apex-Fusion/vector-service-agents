// packages/usecase-kit/src/checks/approval.ts
// The check of an approval. ONE function makes the six checks in this order. It answers with the types of the protocol.
//   found and authentic            approval_not_found
//   the type is the approval type  approval_wrong_type
//   the subject is the sender      approval_wrong_subject
//   the issuer is the root delegator of the delegation    approval_wrong_issuer
//     - Root delegator is a key principal: the hash of the issuer key is the hash of the root delegator.
//     - Root delegator is an agent: the issuer id is the id of the root delegator.
//     - The reference names an issuer record: it must be the issuer record of the attestation.
//   valid at the time of the check by the rule of the registry    approval_revoked, approval_expired, approval_issuer_invalid
//     - The attestation is active.
//     - The time is inside its validity range.
//     - The issuer was not invalid when it issued the approval. The envelope signature verifies, when there is one.
//   the digest is the digest of the document and the salt that were received    approval_digest_mismatch
//
// The read of the attestation decides the validity. This check uses what the read decided: `ruleValid`, and every condition line. The approval passes only when `ruleValid` is the boolean true
// and every line passes or does not apply. A failing line of a condition that this code knows gives the code of that condition. The read can give something that this check cannot judge: a line
// that has the wrong shape, two lines with one identifier, a line with no result that this code knows, a failing line of a condition that this code does not know, or `ruleValid` false with no
// failing line that explains it. The check then throws CheckUnavailableError.
//
// The time of the check can be before the time of issue. A relying party does not require that the time is after `issued_at`.
// The registry sets `issued_at` to the end of the validity window of the transaction. So it can be up to an hour after the block.
// The rule of the registry refuses a time that is more than an hour before `issued_at`.
//
// A null approval is `approval_not_found`. The check makes no read for it.
// A digest mismatch gives both digests: the digest that the attestation holds, and the digest of the document that was received.
import type { CheckLine } from '@vsa/buyer-core';
import type { Delegator } from '@vsa/vector-read/identity-codec';
import { APPROVAL_ATT_TYPE, isPlainObject, parseApprovalRef, parseDelegationId, parseDid, parseDigest, proposalDigest } from '../protocol/index.ts';
import type {
  ApprovalCheck, ApprovalInput, ApprovalRef, ApprovalRefusedByCheck, ApprovalResult, DelegationId, Did, Digest,
} from '../protocol/index.ts';
import { attestationCheckOf, delegationViewOf } from './answers.ts';
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

/**
 * The root delegator of the delegation, or null when the chain does not end at a root because a parent was ended. Every link names the next one as its parent.
 * A delegation that is not live has no chain. The shared checks found it live a moment before, so an empty chain is an answer that this check cannot judge: CheckUnavailableError.
 */
async function rootDelegatorOf(ports: ChecksPorts, id: DelegationId): Promise<Delegator | null> {
  const answer = await readThrough(ports, 'delegation', () => ports.ledger.readDelegation(id));
  const checked = delegationViewOf(answer, id);
  if (!checked.ok) return badAnswer(ports, 'delegation', checked.detail);
  const chain = checked.value.chain;
  if (chain.length === 0) return badAnswer(ports, 'delegation', 'the delegation is not live now');
  for (let index = 0; index < chain.length; index += 1) {
    const parent = index + 1 < chain.length ? chain[index + 1].id : null;
    if (chain[index].delegation.parent !== parent) return null;
  }
  return chain[chain.length - 1].delegation.delegator;
}

// The conditions of the validity rule, in the order that the rule lists them, each with the code that its failure gives.
//   - A `strict` condition applies to every attestation that exists. Its result is `pass` or `fail`. A result of `not_applicable` is an answer that this check cannot judge.
//   - The other conditions can be `not_applicable`: an attestation with no envelope, and an issuer that is a key with no record.
//   - `explain` says whether the detail of the line goes into the detail of the refusal. The line `authentic` names an address, so it does not.
// Decided: an envelope signature that does not verify gets `approval_issuer_invalid`.
const CONDITIONS = [
  { id: 'authentic', code: 'approval_not_found', text: 'no authentic attestation has this identifier', strict: true, explain: false },
  { id: 'active', code: 'approval_revoked', text: 'the approval was revoked', strict: true, explain: true },
  { id: 'time_window', code: 'approval_expired', text: 'the time of the check is not inside the validity range of the approval', strict: true, explain: true },
  { id: 'envelope', code: 'approval_issuer_invalid', text: 'the envelope signature of the approval does not verify with the issuer key', strict: false, explain: true },
  { id: 'issuer_not_invalidated', code: 'approval_issuer_invalid', text: 'the issuer of the approval was invalid when it issued the approval', strict: false, explain: true },
  { id: 'issuer_key_listed', code: 'approval_issuer_invalid', text: 'the issuer key was not listed for assertion when the approval was issued', strict: false, explain: true },
] as const satisfies readonly { id: string; code: ApprovalRefusedByCheck['code']; text: string; strict: boolean; explain: boolean }[];

type Condition = (typeof CONDITIONS)[number];
const AUTHENTIC: readonly Condition[] = CONDITIONS.filter((condition) => condition.id === 'authentic');
const RULE: readonly Condition[] = CONDITIONS.filter((condition) => condition.id !== 'authentic');

interface Lines {
  readonly byId: ReadonlyMap<string, CheckLine>;
  /** The lines of conditions that this code does not know. */
  readonly others: readonly CheckLine[];
}

/** The lines of the read by identifier. The read gives one line for each condition of the rule, and the answer was checked for two lines with one identifier. A missing line cannot be judged. */
function linesOf(ports: ChecksPorts, conditions: readonly CheckLine[]): Lines {
  const byId = new Map<string, CheckLine>(conditions.map((line): [string, CheckLine] => [line.id, line]));
  for (const condition of CONDITIONS) if (!byId.has(condition.id)) return badAnswer(ports, 'attestation', `the condition ${condition.id} has no line`);
  return { byId, others: conditions.filter((line) => !CONDITIONS.some((condition) => condition.id === line.id)) };
}

/** The first of these conditions that failed, as a refusal with its code, or null when none failed. A strict condition that does not apply is an answer that this check cannot judge. */
function failedCondition(ports: ChecksPorts, lines: Lines, which: readonly Condition[]): ApprovalRefusedByCheck | null {
  for (const condition of which) {
    const line = lines.byId.get(condition.id);
    if (line === undefined) return badAnswer(ports, 'attestation', `the condition ${condition.id} has no line`);
    if (line.result === 'fail') return refusedBy(condition.code, condition.explain ? `${condition.text} (${clip(line.detail, 100)})` : condition.text);
    if (line.result === 'not_applicable' && condition.strict) return badAnswer(ports, 'attestation', `the condition ${condition.id} does not apply to an attestation that exists`);
  }
  return null;
}

/**
 * Checks an approval against the ledger at `input.now_ms`. See the head of this file for the checks and their codes. The checks run in order and the first refusal is the answer.
 * It throws a TypeError for an input of the wrong type.
 * It throws CheckUnavailableError for a source that cannot be read, and for an answer that this check cannot judge. Decided: a caller treats a throw as "not available". It never treats it as a pass.
 * A list of checks turns the throw into the code `check_unavailable`.
 */
export async function checkApproval(ports: ChecksPorts, input: ApprovalInput): Promise<ApprovalResult> {
  const { ref, sender, delegation, observed, nowMs } = readInput(input);
  if (ref === null) return refusedBy('approval_not_found', 'the handoff has no approval');

  const answer = await readThrough(ports, 'attestation', () => ports.ledger.attestation(ref.attestation, nowMs));
  const asked = attestationCheckOf(answer, ref.attestation, nowMs);
  if (!asked.ok) return badAnswer(ports, 'attestation', asked.detail);
  const checked = asked.value;
  const lines = linesOf(ports, checked.conditions);

  const notAuthentic = failedCondition(ports, lines, AUTHENTIC);
  if (notAuthentic !== null) return notAuthentic;
  const view = checked.attestation;
  if (view === null) return badAnswer(ports, 'attestation', 'there is no attestation, and no line says that it is not authentic');
  const att = view.attestation;
  if (att.attType !== APPROVAL_ATT_TYPE) return refusedBy('approval_wrong_type', 'the attestation is not an approval');
  if (att.subject !== idOf(sender)) return refusedBy('approval_wrong_subject', 'the subject of the attestation is not the sender');

  const root = await rootDelegatorOf(ports, delegation);
  if (root === null) return refusedBy('approval_wrong_issuer', 'the delegation has no root, so the approval has no root delegator to compare with');
  const issuedByRoot = root.type === 'PrincipalKey' ? keyHashOf(att.issuer) === root.hash.toLowerCase() : att.issuerId !== null && att.issuerId === root.id;
  if (!issuedByRoot) return refusedBy('approval_wrong_issuer', 'the issuer of the attestation is not the root delegator of the delegation');
  if (att.issuerId !== null && didOf(att.issuerId) !== ref.issuer_did) return refusedBy('approval_wrong_issuer', 'the issuer record that the reference names is not the issuer record of the attestation');

  const rule = failedCondition(ports, lines, RULE);
  if (rule !== null) return rule;
  const failedOther = lines.others.find((line) => line.result === 'fail');
  if (failedOther !== undefined) return badAnswer(ports, 'attestation', `the condition ${clip(failedOther.id, 40)} failed, and this code does not know it`);
  if (checked.ruleValid !== true) return badAnswer(ports, 'attestation', 'the rule is not valid, and no condition that this code knows says why');

  const expected = parseDigest(att.digest, 'digest');
  if (!expected.ok) return badAnswer(ports, 'attestation', 'the digest of the attestation is not a digest');
  if (expected.value !== observed) {
    return {
      ok: false, code: 'approval_digest_mismatch', detail: 'the digest of the attestation is not the digest of the document and the salt that were received',
      expected_digest: expected.value, observed_digest: observed,
    };
  }
  // The issuer DID is the one that the attestation names, and never the one that the reference names: the reference is not verified. An attestation with no issuer record has none.
  return { ok: true, attestation: ref.attestation, issuer_did: att.issuerId === null ? null : didOf(att.issuerId), issuer_key_hash: keyHashOf(att.issuer), valid_until: att.validUntil };
}

/** The check bound to its ports: the `ApprovalCheck` of the protocol, for a service that takes the check as a dependency. It throws CheckUnavailableError as `checkApproval` does. */
export function approvalCheckOf(ports: ChecksPorts): ApprovalCheck {
  return (input) => checkApproval(ports, input);
}
