// agents/sourcing-agent/src/scoring/vendors.ts
// The vendor master of the buyer, as a scorer reads it. A scorer calls `GET /vendors` of the mock service under its sub-delegation, and the body is `{ vendors: [...] }`. This file reads that body with a strict
// parser and picks the one entry of a bidder. The entry is data for the model and never a filter in code: it feeds the score of the bidder, and a bidder with no entry is still scored (the model is told
// that there is none, by `vendor: null`).
//
// The parser takes the members of the vendor of the mock service and no others, in its ranges. It takes any value and never throws. It returns a new plain list with the texts in the NFC form, or a refusal with
// the code `bad_shape`. A detail names the member and never repeats a value. The two free texts, the name and each certification, are read by the model, so they refuse every hidden character.
//
// The entry of a bidder is chosen by its VERIFIED organisation only: the entry whose `organisation` equals it. The caller passes `null` for an organisation that no check backs, so a domain that a bidder
// states about itself never picks an entry.
import { parseSku } from '@vsa/usecase-kit/bids';
import { accepted, checkMembers, parseCanonicalDocument, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue, ProtocolResult } from '@vsa/usecase-kit/protocol';

/** One vendor of the vendor master: the members of the vendor of the mock service. */
export interface VendorEntry {
  readonly vendor_id: string;
  /** A lower-case domain of at most 64 characters with at least two labels. */
  readonly organisation: string;
  readonly name: string;
  /** From 0 to 1. */
  readonly on_time_delivery_rate: number;
  /** From 0 to 1. */
  readonly defect_rate: number;
  readonly years_as_vendor: number;
  readonly payment_terms_days: number;
  readonly certifications: string[];
  /** A date as `YYYY-MM-DD`. */
  readonly last_audit: string;
}

/** The most vendors that a list holds: the limit of the mock service. */
export const MAX_VENDORS = 50;
/** The most characters of the name of a vendor. The mock service keeps its names shorter. */
export const MAX_NAME_CHARS = 500;
/** The most certifications of a vendor, and the most characters of one: the limits of the mock service. */
export const MAX_CERTIFICATIONS = 10;
export const MAX_CERTIFICATION_CHARS = 64;

const MEMBERS = ['vendor_id', 'organisation', 'name', 'on_time_delivery_rate', 'defect_rate', 'years_as_vendor', 'payment_terms_days', 'certifications', 'last_audit'] as const;

/** A character that a reader cannot see or that moves the text: a control, a format character, a line or paragraph separator, a lone surrogate, and a default ignorable character. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MAX_DOMAIN_CHARS = 64;

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } => typeof value === 'object' && value !== null && !Array.isArray(value);
const isList = (value: JsonValue | undefined): value is readonly JsonValue[] => Array.isArray(value);

/** A text of `1` to `max` characters with no hidden character. */
function parseText(value: unknown, field: string, max: number): ProtocolResult<string> {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return refused('bad_shape', `${field} must be a text of 1 to ${max} characters`);
  return HIDDEN.test(value) ? refused('bad_shape', `${field} must not hold a hidden character`) : accepted(value);
}

/** A domain name in lower case with at least two labels and at most 64 characters: the form of the organisation of an agent record. */
function parseDomain(value: unknown, field: string): ProtocolResult<string> {
  const form = `${field} must be a domain name in lower case with at least two labels and at most ${MAX_DOMAIN_CHARS} characters`;
  if (typeof value !== 'string' || value.length > MAX_DOMAIN_CHARS) return refused('bad_shape', form);
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) ? accepted(value) : refused('bad_shape', form);
}

/** A number from 0 to 1. The number minus zero is read as 0. */
function parseRate(value: unknown, field: string): ProtocolResult<number> {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? accepted(value === 0 ? 0 : value) : refused('bad_shape', `${field} must be a number from 0 to 1`);
}

/** A whole number from `min` to `max`. The number minus zero is read as 0. */
function parseWhole(value: unknown, field: string, min: number, max: number): ProtocolResult<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? accepted(value === 0 ? 0 : value) : refused('bad_shape', `${field} must be a whole number from ${min} to ${max}`);
}

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** A calendar date as `YYYY-MM-DD` that exists. The year is 0100 or later, as the stores of the mock service take it. */
function parseDay(value: unknown, field: string): ProtocolResult<string> {
  const parts = typeof value === 'string' ? DATE.exec(value) : null;
  if (typeof value !== 'string' || parts === null) return refused('bad_shape', `${field} must be a date as YYYY-MM-DD`);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const longest = month === 2 && isLeap(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return year >= 100 && day >= 1 && day <= longest ? accepted(value) : refused('bad_shape', `${field} must be a date that exists`);
}

function parseEntry(value: JsonValue | undefined, field: string): ProtocolResult<VendorEntry> {
  if (!isObject(value)) return refused('bad_shape', `${field} must be a JSON object`);
  const members = checkMembers(value, field, MEMBERS);
  if (members !== null) return members;
  const id = parseSku(value.vendor_id, `${field}.vendor_id`);
  if (!id.ok) return id;
  const organisation = parseDomain(value.organisation, `${field}.organisation`);
  if (!organisation.ok) return organisation;
  const name = parseText(value.name, `${field}.name`, MAX_NAME_CHARS);
  if (!name.ok) return name;
  const onTime = parseRate(value.on_time_delivery_rate, `${field}.on_time_delivery_rate`);
  if (!onTime.ok) return onTime;
  const defects = parseRate(value.defect_rate, `${field}.defect_rate`);
  if (!defects.ok) return defects;
  const years = parseWhole(value.years_as_vendor, `${field}.years_as_vendor`, 0, 200);
  if (!years.ok) return years;
  const terms = parseWhole(value.payment_terms_days, `${field}.payment_terms_days`, 0, 365);
  if (!terms.ok) return terms;
  const listed = value.certifications;
  if (!isList(listed) || listed.length > MAX_CERTIFICATIONS) return refused('bad_shape', `${field}.certifications must be a list of at most ${MAX_CERTIFICATIONS} texts`);
  const certifications: string[] = [];
  for (let at = 0; at < listed.length; at += 1) {
    const certification = parseText(listed[at], `${field}.certifications[${at}]`, MAX_CERTIFICATION_CHARS);
    if (!certification.ok) return certification;
    certifications.push(certification.value);
  }
  const audit = parseDay(value.last_audit, `${field}.last_audit`);
  if (!audit.ok) return audit;
  return accepted({
    vendor_id: id.value,
    organisation: organisation.value,
    name: name.value,
    on_time_delivery_rate: onTime.value,
    defect_rate: defects.value,
    years_as_vendor: years.value,
    payment_terms_days: terms.value,
    certifications,
    last_audit: audit.value,
  });
}

/**
 * The vendors of the body that `GET /vendors` gave: `{ vendors: [...] }` with 1 to 50 entries, each with the members of the vendor of the mock service and no other, and each `vendor_id` once. A body of
 * another form, an entry that breaks a rule of its members, and a list of 0 or 51 entries are refused. The result is a copy: it shares no object with the body.
 */
export function parseVendors(body: unknown): ProtocolResult<readonly VendorEntry[]> {
  const copy = parseCanonicalDocument(body, 'vendor list');
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, 'vendor list', ['vendors']);
  if (members !== null) return members;
  const listed = copy.value.vendors;
  if (!isList(listed) || listed.length < 1 || listed.length > MAX_VENDORS) return refused('bad_shape', `vendor list.vendors must be a list of 1 to ${MAX_VENDORS} entries`);
  const entries: VendorEntry[] = [];
  const seen = new Set<string>();
  for (let at = 0; at < listed.length; at += 1) {
    const entry = parseEntry(listed[at], `vendor list.vendors[${at}]`);
    if (!entry.ok) return entry;
    if (seen.has(entry.value.vendor_id)) return refused('bad_shape', `vendor list.vendors[${at}].vendor_id is listed twice`);
    seen.add(entry.value.vendor_id);
    entries.push(entry.value);
  }
  return accepted(entries);
}

/**
 * The entry of the vendor master for a bidder: the one entry whose `organisation` equals the verified organisation of the bidder. It is `null` for a `null` organisation, for an organisation that no entry
 * names, and for an organisation that two entries name: the master is then ambiguous, and the model is told that there is no entry. The match is exact, with no change of case.
 */
export function vendorFor(vendors: readonly VendorEntry[], organisation: string | null): VendorEntry | null {
  if (typeof organisation !== 'string') return null;
  const named = vendors.filter((entry) => entry.organisation === organisation);
  return named.length === 1 ? (named[0] ?? null) : null;
}
