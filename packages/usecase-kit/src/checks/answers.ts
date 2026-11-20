// packages/usecase-kit/src/checks/answers.ts
// The answers of the ports, checked where they enter the folder. There is one function for each port. A function takes what the port gave and the question that was asked.
// An answer of the wrong type, or for another question, is a source that did not answer. The function gives `check_unavailable` for it. That is never a pass, and it is never the code of a rule.
// An answer that has the right type and says "no" is not for this file: the check that reads it gives the code of its rule.
// Each function checks the members that the checks read. The type of the answer is then the type that the port promises.
// A member that holds hex has the form of its kind: lower-case hex characters, and the exact length of the kind. The ledger codec and the gateway write it in this form. A member in upper case, with another
// character, or of another length is an answer that this code cannot judge, so it is `check_unavailable`. It is never read as another form of the same value: a key with more characters after it is not the key.
import { HIRE_ACTION } from '@vsa/buyer-core';
import type { AttestationCheck, DelegationUseCheck, DelegationView, EscrowVaultResult } from '@vsa/buyer-core';
import { EFFECTIVE_STATUSES } from '@vsa/id-kit/client';
import type { Resolution } from '@vsa/id-kit/client';
import { accepted, isPlainObject, parseOutputRef, refused } from '../protocol/index.ts';
import type { AttestationId, DelegationId, Did, OutputRef, ProtocolResult, Refused } from '../protocol/index.ts';
import { DIGEST_BYTES, ID_BYTES, KEY_BYTES, KEY_HASH_BYTES, TX_HASH_BYTES, isHex } from './ids.ts';

export type Answer<T> = ProtocolResult<T, 'check_unavailable'>;

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isTexts = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isText);
const isWhole = (value: unknown): value is number => Number.isSafeInteger(value);

const isKeyHash = (value: unknown): value is string => isHex(value, KEY_HASH_BYTES);
/** The identifier of an agent, of a delegation or of an attestation: the name of its token. */
const isId = (value: unknown): value is string => isHex(value, ID_BYTES);
const isIdOrNull = (value: unknown): value is string | null => value === null || isId(value);

/** An answer as the type that the port promises. A function of this file calls it after it checked the members that the checks read. */
const asType = <T>(answer: Record<string, unknown>): T => answer as unknown as T;

/** The refusal for an answer that is not usable. The reason goes to the log of the service, and it names no value. */
const unusable = (source: string, why: string): Refused<'check_unavailable'> => refused('check_unavailable', `the answer of the ${source} is not usable: ${why}`);

const KNOWN_STATUS: readonly unknown[] = EFFECTIVE_STATUSES;

const isRecordKey = (value: unknown): boolean => isPlainObject(value) && isKeyHash(value.keyHash) && isText(value.type) && isTexts(value.purposes);

/**
 * The DID resolution of the sender: the `value` of the gateway client. It must be the resolution of this DID, of a kind that this code knows (`resolved`, `deactivated` or `not_found`), and a
 * resolution that is `resolved` must have the metadata, the document of this DID and a list of keys that each have a hash of 56 lower-case hex characters, a type and a list of purposes.
 */
export function resolutionOf(answer: unknown, sender: Did): Answer<Resolution> {
  const bad = (why: string) => unusable('DID resolution', why);
  if (!isPlainObject(answer)) return bad('it is not an object');
  if (answer.did !== sender) return bad('it is not the resolution of the sender');
  const kind = answer.kind;
  if (kind !== 'resolved' && kind !== 'deactivated' && kind !== 'not_found') return bad('its kind is not known');
  if (kind !== 'not_found') {
    if (!KNOWN_STATUS.includes(answer.effectiveStatus)) return bad('its effective status is not known');
    if (!isTextOrNull(answer.effectiveReason)) return bad('its effective reason is not a text');
  }
  if (kind === 'resolved') {
    if (!isPlainObject(answer.metadata)) return bad('it has no metadata');
    if (!isPlainObject(answer.document) || answer.document.id !== sender) return bad('its document is not the document of the sender');
    if (!Array.isArray(answer.keys) || !answer.keys.every(isRecordKey)) return bad('its keys are not a list of keys with a hash of 56 lower-case hex characters, a type and a list of purposes');
  }
  return accepted(asType<Resolution>(answer));
}

const isDelegator = (value: unknown): boolean => isPlainObject(value) && (value.type === 'PrincipalKey' ? isKeyHash(value.hash) : value.type === 'Agent' && isId(value.id));

function isLink(value: unknown): boolean {
  if (!isPlainObject(value) || !isId(value.id) || !isPlainObject(value.delegation)) return false;
  const datum = value.delegation;
  return isId(datum.delegate) && isKeyHash(datum.delegateKey) && isIdOrNull(datum.parent) && isDelegator(datum.delegator);
}

/**
 * The delegation and its parents: the answer of `readDelegation`. It must be for this delegation. Its chain is a list of links that each have an identifier and a datum with a delegate, a delegate
 * key, a parent and a delegator. An identifier is 64 lower-case hex characters and a key hash is 56. The chain can be empty: the delegation is not live. A chain that starts with another delegation than the one that was asked for is not an answer to the question.
 */
export function delegationViewOf(answer: unknown, id: DelegationId): Answer<DelegationView> {
  const bad = (why: string) => unusable('delegation read', why);
  if (!isPlainObject(answer) || answer.id !== id) return bad('it is not the delegation that was asked for');
  if (!Array.isArray(answer.chain) || !answer.chain.every(isLink)) return bad('its chain is not a list of delegations with identifiers and key hashes in lower-case hex of the right length');
  if (!isIdOrNull(answer.missingParent)) return bad('its missing parent is not an identifier or null');
  if (answer.chain.length > 0 && answer.chain[0].id !== id) return bad('its chain starts with another delegation');
  return accepted(asType<DelegationView>(answer));
}

/** What a use check was asked: the delegation, the time and the resource. The action is the hire action. */
export interface UseQuestion {
  readonly id: DelegationId;
  readonly atMs: number;
  readonly resource: string;
}

/**
 * The use of a delegation: the answer of `delegationUse`. It must be for the same delegation, time, action and resource that were asked. `usable` is a boolean, `problems` is a list of texts,
 * and the two agree: the delegation is usable when no problem is listed, and only then.
 */
export function useCheckOf(answer: unknown, asked: UseQuestion): Answer<DelegationUseCheck> {
  const bad = (why: string) => unusable('delegation use read', why);
  if (!isPlainObject(answer)) return bad('it is not an object');
  if (!isPlainObject(answer.view) || answer.view.id !== asked.id) return bad('it is for another delegation');
  if (answer.atMs !== asked.atMs) return bad('it is for another time');
  if (answer.action !== HIRE_ACTION) return bad('it is for another action');
  if (answer.resource !== asked.resource) return bad('it is for another resource');
  if (typeof answer.usable !== 'boolean') return bad('usable is not true or false');
  if (!isTexts(answer.problems)) return bad('its problems are not a list of texts');
  if (answer.usable !== (answer.problems.length === 0)) return bad('usable and the list of problems do not agree');
  return accepted(asType<DelegationUseCheck>(answer));
}

/**
 * The payment of an escrow: the answer of `escrowPaid`. `paid` is true or false. A payment that was made is for the escrow and the delegation that were asked, and it names the vault output (an output
 * reference) and the transaction (its hash). A payment that was not made has a reason and a detail that are texts. This code checks the reason when it gives the code.
 */
export function paymentOf(answer: unknown, escrowRef: OutputRef, delegation: DelegationId): Answer<EscrowVaultResult> {
  const bad = (why: string) => unusable('vault read', why);
  if (!isPlainObject(answer)) return bad('it is not an object');
  if (answer.paid === true) {
    if (!parseOutputRef(answer.vaultRef).ok || !isHex(answer.payTx, TX_HASH_BYTES)) return bad('its vault output is not an output reference, or its transaction is not a transaction hash');
    if (answer.escrowRef !== escrowRef || answer.delegation !== delegation) return bad('it is for another escrow or another delegation');
    return accepted(asType<EscrowVaultResult>(answer));
  }
  if (answer.paid !== false) return bad('paid is not true or false');
  if (!isText(answer.reason) || !isText(answer.detail)) return bad('it has no reason or no detail');
  return accepted(asType<EscrowVaultResult>(answer));
}

const isLine = (value: unknown): boolean => isPlainObject(value) && isText(value.id) && (value.result === 'pass' || value.result === 'fail' || value.result === 'not_applicable') && isText(value.detail);

const isDatum = (value: unknown): boolean =>
  isPlainObject(value) && isWhole(value.attType) && isId(value.subject) && isHex(value.issuer, KEY_BYTES) && isIdOrNull(value.issuerId) && isHex(value.digest, DIGEST_BYTES)
  && (value.validUntil === null || isWhole(value.validUntil));

/**
 * The check of an attestation: the answer of `attestation`. It must be for this attestation and this time. `ruleValid` is true or false. The conditions are a list of lines that each have an
 * identifier, a result of `pass`, `fail` or `not_applicable`, and a detail, and no two lines have one identifier. The attestation is null, or it is this attestation with the datum members that the
 * approval check reads. The subject, the issuer key, the issuer record and the digest are each 64 lower-case hex characters.
 */
export function attestationCheckOf(answer: unknown, id: AttestationId, atMs: number): Answer<AttestationCheck> {
  const bad = (why: string) => unusable('attestation read', why);
  if (!isPlainObject(answer)) return bad('it is not an object');
  if (answer.id !== id || answer.atMs !== atMs) return bad('it is for another attestation or another time');
  if (typeof answer.ruleValid !== 'boolean') return bad('ruleValid is not true or false');
  if (!Array.isArray(answer.conditions) || !answer.conditions.every(isLine)) return bad('its conditions are not a list of lines');
  const ids = new Set<string>(answer.conditions.map((line: { id: string }) => line.id));
  if (ids.size !== answer.conditions.length) return bad('two condition lines have one identifier');
  const view = answer.attestation;
  if (view !== null && !(isPlainObject(view) && view.id === id && isDatum(view.attestation))) return bad('it holds no attestation, or another attestation, or an attestation whose datum has a member of the wrong type or a hex member of the wrong form');
  return accepted(asType<AttestationCheck>(answer));
}
