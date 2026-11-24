// packages/usecase-kit/src/priorauth/records.ts
// The three documents of the mock systems that both agents of use case 2 read:
//   the record set      the clinical order and the records behind it, from the records system (`GET /records/orders/{order_id}`)
//   the guideline       the criteria that a service must meet, from the guideline store (`GET /guidelines/{code}`)
//   the requirement set what the insurer needs in a request for a service, from the insurer portal (`GET /insurer/requirements/{service_code}`)
// Every record is synthetic: no patient exists behind a reference. The Prior Authorization Agent reads the first two and drafts a request from them. The Insurer Intake Agent reads the third and judges a
// request against it. The two agents are two packages and they do not import each other, so the kit holds the three forms that both read.
//
// A parser takes what the mock service sends, and no more, with one exception: it refuses a text that NFC makes longer than its limit, although the service takes it. A copy must pass the parser,
// because `recordSetSha256` parses the copy of a set again. The limits are the limits of the service, and each text is counted in UTF-16 code units, as the service counts it:
//   record set    an order, and 1 to 50 records with a record id that no other record has
//   order         order_id, patient_ref, service_code and ordering_clinician_ref are identifiers; service_description is 1 to 200 characters; diagnosis_codes is 1 to 8 texts of 1 to 16 characters;
//                 ordered_at is a date
//   record        record_id is an identifier; type is 1 to 32 characters; recorded_at is a date; summary is 1 to 2,000 characters
//   guideline     code is an identifier; title is 1 to 200 characters; version is 1 to 32 characters; criteria is 1 to 20 criteria with an id that no other criterion has; documentation is 0 to 20
//                 texts of 1 to 500 characters
//   requirement set  service_code is an identifier; title is 1 to 200 characters; requirements is 1 to 20 criteria with an id that no other requirement has
//   criterion     id is an identifier; text is 1 to 500 characters
// A parser reads its input with `parseDocument` of the protocol: each member is read one time as data, and the result is a new plain object with its members in the order above. An identifier and a date are
// checked as they are written, and they are ASCII, so a text that only NFC turns into a valid text, such as the Kelvin sign that becomes the letter K, is refused. A free text is copied in the NFC form. An
// accessor, the key `__proto__` and a member that is not listed are refused. The detail of a refusal names the field and never repeats the value.
import { accepted, canonicalSha256, checkMembers, parseDocument } from '../protocol/index.ts';
import type { Digest, JsonValue, ProtocolResult } from '../protocol/index.ts';
import { checkUnique, objectOf, parseDay, parseDiagnosisCodes, parseId, parseList, parseText } from './ids.ts';

/** An order of the clinical system: what the provider asks the insurer to authorize. The two references are synthetic ids with no clinical content. */
export interface ClinicalOrder {
  readonly order_id: string;
  readonly patient_ref: string;
  readonly service_code: string;
  readonly service_description: string;
  readonly diagnosis_codes: readonly string[];
  readonly ordering_clinician_ref: string;
  readonly ordered_at: string;
}

/** One record of the chart behind an order. */
export interface ClinicalRecord {
  readonly record_id: string;
  readonly type: string;
  readonly recorded_at: string;
  readonly summary: string;
}

/** The answer of the records system for one order: the order and its records. */
export interface RecordSet {
  readonly order: ClinicalOrder;
  readonly records: readonly ClinicalRecord[];
}

/** One criterion of a guideline, or one requirement of an insurer. */
export interface Criterion {
  readonly id: string;
  readonly text: string;
}

/** The guideline of a service: what the records must show before the insurer authorizes the service. */
export interface Guideline {
  readonly code: string;
  readonly title: string;
  readonly version: string;
  readonly criteria: readonly Criterion[];
  readonly documentation: readonly string[];
}

/** What an insurer needs in a request for a service. */
export interface RequirementSet {
  readonly service_code: string;
  readonly title: string;
  readonly requirements: readonly Criterion[];
}

const ORDER_MEMBERS = ['order_id', 'patient_ref', 'service_code', 'service_description', 'diagnosis_codes', 'ordering_clinician_ref', 'ordered_at'] as const;
const RECORD_MEMBERS = ['record_id', 'type', 'recorded_at', 'summary'] as const;
const GUIDELINE_MEMBERS = ['code', 'title', 'version', 'criteria', 'documentation'] as const;
const REQUIREMENT_SET_MEMBERS = ['service_code', 'title', 'requirements'] as const;

const MAX_RECORDS = 50;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_TYPE_CHARS = 32;
const MAX_SUMMARY_CHARS = 2000;
const MAX_TITLE_CHARS = 200;
const MAX_VERSION_CHARS = 32;
const MAX_CRITERIA = 20;
const MAX_REQUIREMENTS = 20;
const MAX_DOCUMENTATION = 20;
/** The most characters of the text of a criterion or a requirement, and of a line of documentation. */
const MAX_LINE_CHARS = 500;

function parseOrder(value: JsonValue, field: string): ProtocolResult<ClinicalOrder> {
  const order = objectOf(value, field);
  if (!order.ok) return order;
  const members = checkMembers(order.value, field, ORDER_MEMBERS);
  if (members !== null) return members;
  const orderId = parseId(order.value.order_id, `${field}.order_id`);
  if (!orderId.ok) return orderId;
  const patient = parseId(order.value.patient_ref, `${field}.patient_ref`);
  if (!patient.ok) return patient;
  const serviceCode = parseId(order.value.service_code, `${field}.service_code`);
  if (!serviceCode.ok) return serviceCode;
  const description = parseText(order.value.service_description, `${field}.service_description`, MAX_DESCRIPTION_CHARS);
  if (!description.ok) return description;
  const diagnoses = parseDiagnosisCodes(order.value.diagnosis_codes, `${field}.diagnosis_codes`);
  if (!diagnoses.ok) return diagnoses;
  const clinician = parseId(order.value.ordering_clinician_ref, `${field}.ordering_clinician_ref`);
  if (!clinician.ok) return clinician;
  const orderedAt = parseDay(order.value.ordered_at, `${field}.ordered_at`);
  if (!orderedAt.ok) return orderedAt;
  return accepted({
    order_id: orderId.value,
    patient_ref: patient.value,
    service_code: serviceCode.value,
    service_description: description.value,
    diagnosis_codes: diagnoses.value,
    ordering_clinician_ref: clinician.value,
    ordered_at: orderedAt.value,
  });
}

function parseRecord(value: JsonValue, field: string): ProtocolResult<ClinicalRecord> {
  const record = objectOf(value, field);
  if (!record.ok) return record;
  const members = checkMembers(record.value, field, RECORD_MEMBERS);
  if (members !== null) return members;
  const recordId = parseId(record.value.record_id, `${field}.record_id`);
  if (!recordId.ok) return recordId;
  const type = parseText(record.value.type, `${field}.type`, MAX_TYPE_CHARS);
  if (!type.ok) return type;
  const recordedAt = parseDay(record.value.recorded_at, `${field}.recorded_at`);
  if (!recordedAt.ok) return recordedAt;
  const summary = parseText(record.value.summary, `${field}.summary`, MAX_SUMMARY_CHARS);
  if (!summary.ok) return summary;
  return accepted({ record_id: recordId.value, type: type.value, recorded_at: recordedAt.value, summary: summary.value });
}

function parseCriterion(value: JsonValue, field: string): ProtocolResult<Criterion> {
  const criterion = objectOf(value, field);
  if (!criterion.ok) return criterion;
  const members = checkMembers(criterion.value, field, ['id', 'text']);
  if (members !== null) return members;
  const id = parseId(criterion.value.id, `${field}.id`);
  if (!id.ok) return id;
  const text = parseText(criterion.value.text, `${field}.text`, MAX_LINE_CHARS);
  if (!text.ok) return text;
  return accepted({ id: id.value, text: text.value });
}

/** 1 to `max` criteria with an id that no other criterion has. The detail of a repeated id names the second place and never repeats the id. */
function parseCriteria(value: JsonValue, field: string, max: number): ProtocolResult<readonly Criterion[]> {
  const criteria = parseList(value, field, 1, max, parseCriterion);
  if (!criteria.ok) return criteria;
  return checkUnique(criteria.value, field, (criterion) => criterion.id, '.id') ?? criteria;
}

/**
 * The record set of an order, with its members as a new object: the order, and 1 to 50 records. The `record_id` of each record is the id of the record in the chart, and no two records have one. The result
 * keeps the records in the order that the records system gave them: the order of the records is part of the set.
 */
export function parseRecordSet(value: unknown): ProtocolResult<RecordSet> {
  const field = 'record set';
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, ['order', 'records']);
  if (members !== null) return members;
  const order = parseOrder(copy.value.order, `${field}.order`);
  if (!order.ok) return order;
  const records = parseList(copy.value.records, `${field}.records`, 1, MAX_RECORDS, parseRecord);
  if (!records.ok) return records;
  const twice = checkUnique(records.value, `${field}.records`, (record) => record.record_id, '.record_id');
  if (twice !== null) return twice;
  const set: RecordSet = { order: order.value, records: records.value };
  return accepted(set);
}

/**
 * The hash that a request carries for the record set that its drafter was given: the SHA-256 of the canonical text of the checked copy of the set, as 64 lower-case hex characters. The canonical text has
 * the members of each object in the order of their keys, and each text in the NFC form. So two sets with the same data and a different order of the members have one hash, and a text in the NFD form and
 * the same text in the NFC form have one hash. The list of the records keeps its order, so a set with the records in another order has another hash. A value that `parseRecordSet` refuses is a TypeError,
 * and the message names the field and never repeats the value.
 */
export function recordSetSha256(set: RecordSet): Digest {
  const checked = parseRecordSet(set);
  if (!checked.ok) throw new TypeError(`a record set must pass parseRecordSet before it is hashed: ${checked.detail}`);
  const digest = canonicalSha256(checked.value, 'record set');
  if (!digest.ok) throw new TypeError(`a record set cannot be hashed: ${digest.detail}`);
  return digest.value;
}

/** The guideline of a service, with its members as a new object: the code, the title, the version, 1 to 20 criteria with an id that no other criterion has, and 0 to 20 lines of documentation. */
export function parseGuideline(value: unknown): ProtocolResult<Guideline> {
  const field = 'guideline';
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, GUIDELINE_MEMBERS);
  if (members !== null) return members;
  const code = parseId(copy.value.code, `${field}.code`);
  if (!code.ok) return code;
  const title = parseText(copy.value.title, `${field}.title`, MAX_TITLE_CHARS);
  if (!title.ok) return title;
  const version = parseText(copy.value.version, `${field}.version`, MAX_VERSION_CHARS);
  if (!version.ok) return version;
  const criteria = parseCriteria(copy.value.criteria, `${field}.criteria`, MAX_CRITERIA);
  if (!criteria.ok) return criteria;
  const documentation = parseList(copy.value.documentation, `${field}.documentation`, 0, MAX_DOCUMENTATION, (line, place) => parseText(line, place, MAX_LINE_CHARS));
  if (!documentation.ok) return documentation;
  const guideline: Guideline = { code: code.value, title: title.value, version: version.value, criteria: criteria.value, documentation: documentation.value };
  return accepted(guideline);
}

/** The requirement set of a service, with its members as a new object: the service code, the title, and 1 to 20 requirements with an id that no other requirement has. */
export function parseRequirementSet(value: unknown): ProtocolResult<RequirementSet> {
  const field = 'requirement set';
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, REQUIREMENT_SET_MEMBERS);
  if (members !== null) return members;
  const serviceCode = parseId(copy.value.service_code, `${field}.service_code`);
  if (!serviceCode.ok) return serviceCode;
  const title = parseText(copy.value.title, `${field}.title`, MAX_TITLE_CHARS);
  if (!title.ok) return title;
  const requirements = parseCriteria(copy.value.requirements, `${field}.requirements`, MAX_REQUIREMENTS);
  if (!requirements.ok) return requirements;
  const set: RequirementSet = { service_code: serviceCode.value, title: title.value, requirements: requirements.value };
  return accepted(set);
}
