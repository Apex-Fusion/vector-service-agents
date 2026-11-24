// packages/usecase-kit/src/priorauth/request.ts
// The authorization request of use case 2 (prior authorization). The Prior Authorization Agent proposes it, the Insurer Intake Agent reads it in a handoff, and the insurer portal of the mock service files
// it. It is the document of a proposal, so its digest is `proposalDigest(salt, document)` of the protocol, and the hirer approves that digest.
//
// The parser takes what the insurer portal takes for the members that the portal reads (the schema, the tenant, the request number and the service code), and the limits below for the rest:
//   request_number, order_id, patient_ref, ordering_clinician_ref, service_code
//                         an identifier of 1 to 64 letters, digits, dots, hyphens and underscores, starting with a letter or a digit
//   tenant                1 to 48 lower-case letters, digits and hyphens, starting with a letter or a digit (the protocol takes 64 characters for the tenant of a request: the portal takes 48)
//   diagnosis_codes       1 to 8 texts of 1 to 16 characters, the list that the records system gives for the order, with no control, format, separator or default ignorable character and no surrogate that
//                         stands alone (the record set takes the characters that the records system takes)
//   justification         1 to 4,000 characters, counted as code points. It holds the line feed, and no other control, format, separator or default ignorable character, and no surrogate that stands alone
//   guideline_refs        0 to 20 identifiers, none twice
//   record_refs           0 to 50 identifiers, none twice
//   record_set_sha256     a digest
//   insurer_did           a DID
//   advert_ref            a reference to an output, in the form of the protocol
// A member is read one time as data. The result is a new plain object with its members in the order above. Each identifier is checked as it is written, and every form above but the two free texts
// (`justification` and `diagnosis_codes`) is ASCII, so a text that passes is in the NFC form that the digest binds already. A text that only NFC turns into a valid text, such as the Kelvin sign that becomes the
// letter K, is refused, as the portal refuses it. The copy holds the two free texts in the NFC form. An accessor, the key `__proto__` and a member that is not listed are refused. The detail of a refusal
// names the field and never repeats the value.
import { DOCUMENT_SCHEMAS, accepted, checkMembers, parseDid, parseDigest, parseDocument, parseOutputRef, refused } from '../protocol/index.ts';
import type { Did, Digest, OutputRef, ProtocolResult, TenantId } from '../protocol/index.ts';
import { parseDiagnosisCodes, parseId, parseIds } from './ids.ts';

/** The schema of the authorization request: the schema that the protocol names for use case 2. */
export const PRIORAUTH_REQUEST_SCHEMA = DOCUMENT_SCHEMAS['prior-authorization'];

export interface PriorAuthRequest {
  readonly schema: typeof PRIORAUTH_REQUEST_SCHEMA;
  /** `<tenant>-<counter>`, from `requestNumberOf`. The portal files one entry for each number, without regard to case. */
  readonly request_number: string;
  readonly tenant: TenantId;
  readonly order_id: string;
  /** A synthetic reference. No patient exists behind it. */
  readonly patient_ref: string;
  readonly ordering_clinician_ref: string;
  readonly service_code: string;
  readonly diagnosis_codes: readonly string[];
  readonly justification: string;
  /** The identifiers of the criteria of the guideline that the justification cites. */
  readonly guideline_refs: readonly string[];
  /** The identifiers of the records that the justification cites. */
  readonly record_refs: readonly string[];
  /** The hash of the record set that the model was given: `recordSetSha256`. */
  readonly record_set_sha256: Digest;
  /** The Insurer Intake Agent that the request is for. */
  readonly insurer_did: Did;
  /** The advert of the Insurer Intake Agent that the request pays. */
  readonly advert_ref: OutputRef;
}

const MEMBERS = [
  'schema', 'request_number', 'tenant', 'order_id', 'patient_ref', 'ordering_clinician_ref', 'service_code', 'diagnosis_codes', 'justification', 'guideline_refs', 'record_refs', 'record_set_sha256',
  'insurer_did', 'advert_ref',
] as const;

/** The most characters of a justification, counted as code points. */
export const MAX_JUSTIFICATION_CHARS = 4000;
const MAX_GUIDELINE_REFS = 20;
const MAX_RECORD_REFS = 50;
/** The most characters of a request number. */
const MAX_NUMBER_CHARS = 64;

const TENANT = /^[a-z0-9][a-z0-9-]{0,47}$/;
/**
 * The characters that a justification never holds, but the line feed: the control characters (Cc), the format characters (Cf: zero width, direction, byte order mark and tag characters), the surrogates that
 * stand alone (Cs), the line and paragraph separators (Zl and Zp), and the default ignorable characters. The default ignorable characters include the variation selectors, and they include characters that no
 * other class names: the Mongolian free variation selectors, the combining grapheme joiner, the Hangul fillers and the Khmer inherent vowels. A reviewer who reads the text cannot see these characters, and they
 * can change how a text reads, or hide a text, without a change of a letter. A pair of surrogates is one code point and passes: a regular expression with the `u` flag reads it as one character.
 */
const JUSTIFICATION_CONTROL = /(?!\n)[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
/** The characters that a diagnosis code of a request never holds: the characters above, with no exception for the line feed. The records system takes some of them in a code, so the record set keeps its own rule. */
const CODE_HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

function parseTenant(value: unknown, field: string): ProtocolResult<TenantId> {
  return typeof value === 'string' && TENANT.test(value)
    ? accepted(value)
    : refused('bad_shape', `${field} must be 1 to 48 characters: lower-case letters, digits and hyphens, and it starts with a letter or a digit`);
}

/** The number of code points of a text. A high surrogate with a low surrogate after it is one code point, and a lone surrogate is one code point. */
function pointsIn(text: string): number {
  let points = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    points += 1;
  }
  return points;
}

/**
 * The justification: 1 to MAX_JUSTIFICATION_CHARS code points, with no control, format, separator, surrogate or default ignorable character but the line feed. The limit holds for the text as it is written and for its
 * NFC form, so the copy is a text that this takes again: the Insurer Intake Agent reads the copy. The copy holds the text in the NFC form, and the check of the characters runs on the copy.
 */
function parseJustification(value: unknown, field: string): ProtocolResult<string> {
  if (typeof value !== 'string') return refused('bad_shape', `${field} must be a text`);
  const limit = `${field} must have 1 to ${MAX_JUSTIFICATION_CHARS} characters`;
  // A code point has one or two code units, so a text of more than twice the limit in code units has more code points than the limit. The check keeps the scan below short.
  if (value.length < 1 || value.length > 2 * MAX_JUSTIFICATION_CHARS) return refused('bad_shape', limit);
  const form = value.normalize('NFC');
  if (pointsIn(value) > MAX_JUSTIFICATION_CHARS || pointsIn(form) > MAX_JUSTIFICATION_CHARS) return refused('bad_shape', limit);
  if (JUSTIFICATION_CONTROL.test(form)) return refused('bad_shape', `${field} must not hold a control, format, separator, lone surrogate or default ignorable character but the line feed`);
  return accepted(form);
}

/**
 * An authorization request with exactly the members above, as a new plain object, or a refusal with the code `bad_shape`. `field` is the name that the detail of a refusal gives to the request: a caller that
 * reads the document of a handoff passes `handoff.document`.
 */
export function parsePriorAuthRequest(value: unknown, field = 'authorization request'): ProtocolResult<PriorAuthRequest> {
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, MEMBERS);
  if (members !== null) return members;
  const request = copy.value;
  if (request.schema !== PRIORAUTH_REQUEST_SCHEMA) return refused('bad_shape', `${field}.schema must be "${PRIORAUTH_REQUEST_SCHEMA}"`);
  const requestNumber = parseId(request.request_number, `${field}.request_number`);
  if (!requestNumber.ok) return requestNumber;
  const tenant = parseTenant(request.tenant, `${field}.tenant`);
  if (!tenant.ok) return tenant;
  const orderId = parseId(request.order_id, `${field}.order_id`);
  if (!orderId.ok) return orderId;
  const patient = parseId(request.patient_ref, `${field}.patient_ref`);
  if (!patient.ok) return patient;
  const clinician = parseId(request.ordering_clinician_ref, `${field}.ordering_clinician_ref`);
  if (!clinician.ok) return clinician;
  const serviceCode = parseId(request.service_code, `${field}.service_code`);
  if (!serviceCode.ok) return serviceCode;
  const diagnoses = parseDiagnosisCodes(request.diagnosis_codes, `${field}.diagnosis_codes`);
  if (!diagnoses.ok) return diagnoses;
  const hidden = diagnoses.value.findIndex((code) => CODE_HIDDEN.test(code));
  if (hidden !== -1) return refused('bad_shape', `${field}.diagnosis_codes[${hidden}] must not hold a control, format, separator, lone surrogate or default ignorable character`);
  const justification = parseJustification(request.justification, `${field}.justification`);
  if (!justification.ok) return justification;
  const criteria = parseIds(request.guideline_refs, `${field}.guideline_refs`, 0, MAX_GUIDELINE_REFS);
  if (!criteria.ok) return criteria;
  const records = parseIds(request.record_refs, `${field}.record_refs`, 0, MAX_RECORD_REFS);
  if (!records.ok) return records;
  const recordSet = parseDigest(request.record_set_sha256, `${field}.record_set_sha256`);
  if (!recordSet.ok) return recordSet;
  const insurer = parseDid(request.insurer_did, `${field}.insurer_did`);
  if (!insurer.ok) return insurer;
  const advert = parseOutputRef(request.advert_ref, `${field}.advert_ref`);
  if (!advert.ok) return advert;
  const parsed: PriorAuthRequest = {
    schema: PRIORAUTH_REQUEST_SCHEMA,
    request_number: requestNumber.value,
    tenant: tenant.value,
    order_id: orderId.value,
    patient_ref: patient.value,
    ordering_clinician_ref: clinician.value,
    service_code: serviceCode.value,
    diagnosis_codes: diagnoses.value,
    justification: justification.value,
    guideline_refs: criteria.value,
    record_refs: records.value,
    record_set_sha256: recordSet.value,
    insurer_did: insurer.value,
    advert_ref: advert.value,
  };
  return accepted(parsed);
}

/**
 * The number of a request: the tenant, a hyphen and the counter, with no padding. The tenant has the form of the portal (1 to 48 lower-case letters, digits and hyphens), and the counter is a whole
 * number of 0 or more. The result has at most 64 characters, so that the parser takes it. A tenant or a counter of another form is a TypeError, and the message never repeats it. The counter 0 gives a number
 * that no request has, and a service uses it to check a tenant.
 */
export function requestNumberOf(tenant: string, counter: number): string {
  if (typeof tenant !== 'string' || !TENANT.test(tenant)) throw new TypeError('a tenant is 1 to 48 lower-case letters, digits and hyphens, and it starts with a letter or a digit');
  if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) throw new TypeError('a counter is a whole number of 0 or more');
  const number = `${tenant}-${counter}`;
  if (number.length > MAX_NUMBER_CHARS) throw new TypeError(`a request number has at most ${MAX_NUMBER_CHARS} characters`);
  return number;
}

/**
 * The key of a request number: the number in lower case. The insurer portal files one entry for each number without regard to case, so a number is unique without regard to case, and a book of requests
 * keys each number by this key. `RUN1-1` and `run1-1` are one request.
 */
export function requestNumberKey(requestNumber: string): string {
  return requestNumber.toLowerCase();
}
