// packages/usecase-kit/src/priorauth/parts.ts
// The parts of a record that the intake record of use case 2 (prior authorization) shares in form with the order confirmation of use case 1 (inventory reorder): the sender, the approval, the checks, and the
// decision with the hire that bought it. The inventory folder keeps its own parsers of these parts private, and a kit folder imports the protocol folder and no other folder, so this folder keeps copies. A
// later change can lift both copies into the protocol folder. A test holds each copy to its original: the two parse the same values, and they must give the same answer.
//
// The rules are the rules of the originals:
//   identifiers   a DID, an attestation id, a key hash, an output reference and a capability id are checked as they are written. They are ASCII, so a text that passes is in the NFC form already, and a
//                 text that only NFC turns into a valid text (the Kelvin sign that becomes the letter K) is refused.
//   organisation  the one free text: null, or a text of at most 1024 characters. The shared sender check takes any text from the record of the sender, and a stricter parser would make a reader refuse a
//                 record after the work was done. The copy holds the text in the NFC form.
//   approval end  null, or a time in UTC with milliseconds, as `Date.prototype.toISOString` writes it: a year of four digits, or a sign and six digits.
//   checks        each name that the caller lists with the value true, and no other member. The caller gives the list, so this file holds no list of check names.
//   decision      the name that the caller gives, the choice as the model gave it (any JSON), a reasoning that is not blank, and the hire that bought it. A decision keeps every text as it came, because it
//                 holds the words of a model and the signed receipt of its supplier.
// A parser takes a value that `parseDocument` of the protocol has copied: a plain object with its own members, each read one time as data. It gives a new plain object with its members in the order of the
// protocol. It never throws for data. The detail of a refusal names the field and never repeats the value. The one TypeError is a list of check names that is wrong, which is an error of the caller.
import { RECEIPT_CHECKS, accepted, checkMembers, parseAttestationId, parseDid, parseKeyHash, parseOutputRef, refused } from '../protocol/index.ts';
import type { AttestationId, Decision, Did, JsonValue, ProtocolResult, ReceiptVerification, SubJob } from '../protocol/index.ts';
import { isList, objectOf, parseId, valuesOf } from './ids.ts';

/** The sender of a job, as a record names it. */
export interface Sender {
  readonly did: Did;
  /** The organisation that the covering Accountable Party names, or null. */
  readonly organisation: string | null;
  /** True only when the gateway says that it verified the organisation. */
  readonly organisation_verified: boolean;
}

/** The approval that a job came with, as a record names it. */
export interface Approval {
  readonly attestation: AttestationId;
  /** The record of the issuer, or null when the issuer has no record. */
  readonly issuer_did: Did | null;
  /** The end of the validity as a time in UTC with milliseconds, or null when the attestation has no end. */
  readonly valid_until: string | null;
}

/** The longest organisation that a record holds, in characters. It is a limit of size only. */
const MAX_ORGANISATION_CHARS = 1024;
/** A time in UTC with milliseconds, as `toISOString` writes it: a year of four digits, or the extended form of a year, which is a sign and six digits. */
const TIME = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The signature of a receipt: printable characters with no space. A signature is hex or base64, so no more is asked of it. */
const SIGNATURE = /^[\x21-\x7e]{1,1024}$/;

/** The organisation of the sender: null, or any text of at most MAX_ORGANISATION_CHARS characters. The copy holds the text in the NFC form. */
export function parseOrganisation(value: JsonValue, field: string): ProtocolResult<string | null> {
  if (value === null) return accepted(null);
  if (typeof value === 'string' && value.length <= MAX_ORGANISATION_CHARS) return accepted(value.normalize('NFC'));
  return refused('bad_shape', `${field} must be null or a text of at most ${MAX_ORGANISATION_CHARS} characters`);
}

export function parseSender(value: JsonValue, field: string): ProtocolResult<Sender> {
  const sender = objectOf(value, field);
  if (!sender.ok) return sender;
  const members = checkMembers(sender.value, field, ['did', 'organisation', 'organisation_verified']);
  if (members !== null) return members;
  const did = parseDid(sender.value.did, `${field}.did`);
  if (!did.ok) return did;
  const organisation = parseOrganisation(sender.value.organisation, `${field}.organisation`);
  if (!organisation.ok) return organisation;
  const verified = sender.value.organisation_verified;
  if (typeof verified !== 'boolean') return refused('bad_shape', `${field}.organisation_verified must be true or false`);
  return accepted({ did: did.value, organisation: organisation.value, organisation_verified: verified });
}

/** The end of an approval: null, or a time that exists and that `toISOString` gives back as the same text. The text of a time with no milliseconds, or with an offset, is not this form. */
export function parseEnd(value: JsonValue, field: string): ProtocolResult<string | null> {
  if (value === null) return accepted(null);
  if (typeof value === 'string' && TIME.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && new Date(ms).toISOString() === value) return accepted(value);
  }
  return refused('bad_shape', `${field} must be null or a time in UTC with milliseconds that exists, as YYYY-MM-DDTHH:MM:SS.mmmZ, with a year of four digits or a sign and six digits`);
}

export function parseApproval(value: JsonValue, field: string): ProtocolResult<Approval> {
  const approval = objectOf(value, field);
  if (!approval.ok) return approval;
  const members = checkMembers(approval.value, field, ['attestation', 'issuer_did', 'valid_until']);
  if (members !== null) return members;
  const attestation = parseAttestationId(approval.value.attestation, `${field}.attestation`);
  if (!attestation.ok) return attestation;
  const issuer = approval.value.issuer_did === null ? accepted(null) : parseDid(approval.value.issuer_did, `${field}.issuer_did`);
  if (!issuer.ok) return issuer;
  const end = parseEnd(approval.value.valid_until, `${field}.valid_until`);
  if (!end.ok) return end;
  return accepted({ attestation: attestation.value, issuer_did: issuer.value, valid_until: end.value });
}

/**
 * The checks of a record: a copy with each name of `names` as a member, each with the value true, in the order of `names`, and no other member. A record exists only for a job whose checks all passed, so a
 * check that is false, a check that is missing and a check that is not listed are refused. The caller gives the names. A list that is empty, or that holds a name two times, is a TypeError: with no name,
 * every object would pass.
 */
export function parseChecks<N extends string>(value: JsonValue, field: string, names: readonly N[]): ProtocolResult<{ readonly [name in N]: true }> {
  if (names.length === 0 || new Set(names).size !== names.length) throw new TypeError('the names of the checks must be one or more names, and no name two times');
  const checks = objectOf(value, field);
  if (!checks.ok) return checks;
  const members = checkMembers(checks.value, field, names);
  if (members !== null) return members;
  for (const name of names) {
    if (checks.value[name] !== true) return refused('bad_shape', `${field}.${name} must be true`);
  }
  // Each listed name is a member and its value is true (the loop above), so the entries make the object of the type.
  return accepted(Object.fromEntries(names.map((name): [N, true] => [name, true])) as { readonly [name in N]: true });
}

export function parseVerification(value: JsonValue, field: string): ProtocolResult<ReceiptVerification> {
  const verification = objectOf(value, field);
  if (!verification.ok) return verification;
  const members = checkMembers(verification.value, field, RECEIPT_CHECKS);
  if (members !== null) return members;
  for (const name of RECEIPT_CHECKS) {
    if (typeof verification.value[name] !== 'boolean') return refused('bad_shape', `${field}.${name} must be true or false`);
  }
  // Each of the eight checks is a member and a boolean (the loop above), so the entries make the object of the type.
  return accepted(Object.fromEntries(RECEIPT_CHECKS.map((name) => [name, verification.value[name]])) as ReceiptVerification);
}

export function parseSubJob(value: JsonValue, field: string): ProtocolResult<SubJob> {
  const subJob = objectOf(value, field);
  if (!subJob.ok) return subJob;
  const members = checkMembers(subJob.value, field, ['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
  if (members !== null) return members;
  const capability = parseId(subJob.value.capability_id, `${field}.capability_id`);
  if (!capability.ok) return capability;
  const advert = parseOutputRef(subJob.value.advert_ref, `${field}.advert_ref`);
  if (!advert.ok) return advert;
  const escrow = parseOutputRef(subJob.value.escrow_ref, `${field}.escrow_ref`);
  if (!escrow.ok) return escrow;
  const supplier = parseKeyHash(subJob.value.supplier_pkh, `${field}.supplier_pkh`);
  if (!supplier.ok) return supplier;
  const receipt = objectOf(subJob.value.receipt, `${field}.receipt`);
  if (!receipt.ok) return receipt;
  const signature = subJob.value.receipt_signature;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return refused('bad_shape', `${field}.receipt_signature must be 1 to 1024 printable characters with no space`);
  const verification = parseVerification(subJob.value.verification, `${field}.verification`);
  if (!verification.ok) return verification;
  return accepted({
    capability_id: capability.value, advert_ref: advert.value, escrow_ref: escrow.value, supplier_pkh: supplier.value, receipt: receipt.value, receipt_signature: signature, verification: verification.value,
  });
}

export function parseInference(value: JsonValue, field: string): ProtocolResult<Decision['inference']> {
  const inference = objectOf(value, field);
  if (!inference.ok) return inference;
  const members = checkMembers(inference.value, field, ['path', 'sub_job', 'accepted']);
  if (members !== null) return members;
  if (inference.value.path !== 'marketplace') return refused('bad_shape', `${field}.path must be "marketplace"`);
  const how = inference.value.accepted;
  if (how !== 'confirmed' && how !== 'pending') return refused('bad_shape', `${field}.accepted must be "confirmed" or "pending"`);
  const subJob = parseSubJob(inference.value.sub_job, `${field}.sub_job`);
  if (!subJob.ok) return subJob;
  const result: Decision['inference'] = { path: 'marketplace', sub_job: subJob.value, accepted: how };
  return accepted(result);
}

/** One decision of the protocol: its name, which is `named`, the choice as the model gave it (any JSON), the reasoning (a text that is not blank), and the hire that bought it. */
export function parseDecision(value: JsonValue, field: string, named: string): ProtocolResult<Decision> {
  const decision = objectOf(value, field);
  if (!decision.ok) return decision;
  const members = checkMembers(decision.value, field, ['name', 'choice', 'reasoning', 'inference']);
  if (members !== null) return members;
  const { name, choice, reasoning } = decision.value;
  if (name !== named) return refused('bad_shape', `${field}.name must be "${named}"`);
  if (typeof reasoning !== 'string' || reasoning.trim() === '') return refused('bad_shape', `${field}.reasoning must be a text that is not blank`);
  const inference = parseInference(decision.value.inference, `${field}.inference`);
  if (!inference.ok) return inference;
  return accepted({ name, choice, reasoning, inference: inference.value });
}

/** The decisions of a record: a list of exactly one decision, and its name is `named`. */
export function parseDecisions(value: JsonValue, field: string, named: string): ProtocolResult<readonly Decision[]> {
  if (!isList(value)) return refused('bad_shape', `${field} must be a list`);
  if (value.length !== 1) return refused('bad_shape', `${field} must hold exactly one decision, named "${named}"`);
  return valuesOf(Array.from(value, (entry, index) => parseDecision(entry, `${field}[${index}]`, named)));
}
