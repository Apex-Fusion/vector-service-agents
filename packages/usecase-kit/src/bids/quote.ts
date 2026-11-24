// packages/usecase-kit/src/bids/quote.ts
// The quote of use case 3 (supplier bid evaluation). A Bid Desk returns it as the result of a job, and the Sourcing Agent reads it before its model sees any of it. Its members, in this order:
//   schema, outcome ("done"), rfq_id, rfq_sha256 (the canonical SHA-256 of the request that the desk received), desk_did, organisation (the domain of the desk), lines, total, lead_time_days, valid_until,
//   notes, price_list_sha256 (the SHA-256 of the price list that the desk priced from), credential (a compact JWS from the identity gateway), sender { did, organisation, organisation_verified },
//   checks, decisions, fault_mode
//
// The quote is the document of a job of a counterparty, and not a proposal. Its hash is the SHA-256 of its text, which is the `response_hash` of the signed receipt. It has no salt.
//
// The three numbers of a quote are arithmetic and not decisions. A line total is the quantity times the unit price, the total is the sum of the line totals, and the lead time is the longest lead time of
// the lines. The desk makes them with `quoteTotals` from the lines that its model chose, and `parseQuote` checks all three: a text with a number that is not the arithmetic of its lines is no quote. The
// limits of a line are the limits of the other documents of the folder: 1 to 20 lines, each SKU once, a quantity from 1 to 1,000,000, and a unit price from 1 to 1,000,000 and a lead time from 0 to 365 days as
// a price list has them. So a line at a listed price is always a line that a quote can hold.
//
// `checks` has one member for each name of QUOTE_CHECKS, and each value is true: the six shared checks of a bid desk, in the order that they run, and then `not_duplicate`. A quote exists only for a job whose
// checks all passed, so a check that is false, a check that is missing and a check that is not listed are refused. The list is written out in this file, because the folder imports no other folder of the
// kit. A test holds its first six names to the shared checks of the checks folder.
//
// The organisation of the desk is its own domain: not null, in lower case, with at least two labels and at most 64 characters, as the organisation of an agent record is. The organisation of the sender is
// recorded and never a reason to refuse. It is null when no party names one, and else any text of at most 1024 characters, because the shared sender check takes any text from the record of the sender. The
// notes are the words of the desk: at most 500 characters and no control character, because the document is a signed record. The credential has three parts of base64url text with a dot between them, and at
// most 8192 characters.
//
// `decisions` holds exactly one decision of the protocol, and its name is `quote`: the model decision of the Bid Desk. The desk makes it in every job, also when a fault value is set, so a list with no
// decision, with two decisions, or with a decision of another name is refused. The decision keeps every text as it came, because it holds the words of a model and the signed receipt of its supplier. Every
// other identifier, date and digest is checked as it is written, and it is ASCII, so a text that passes is in the NFC form already: a text that only NFC turns into a valid text, such as the Kelvin sign that
// becomes the letter K, is refused. The notes and the organisation of the sender are the free texts, and the copy holds them in the NFC form. NFC can make a text longer, so a text is refused when the text or
// its NFC form is above the limit: every copy that the parser gives passes the parser again, and gives the same copy. A member is read one time as data. An accessor, the key `__proto__` and a member that
// is not listed are refused. The detail of a refusal names the field and never repeats the value.
import {
  RECEIPT_CHECKS, accepted, checkMembers, isFaultSetting, isPlainObject, parseDid, parseDigest, parseDocument, parseKeyHash, parseOutputRef, refused,
} from '../protocol/index.ts';
import type { Decision, Did, Digest, FaultSetting, JsonValue, ProtocolResult, ReceiptVerification, SubJob } from '../protocol/index.ts';
import { MAX_ITEM_QUANTITY, isList, objectOf, parseDay, parseQuantity, parseRfqId, parseSku, parseWhole, valuesOf } from './ids.ts';
import { MAX_RFQ_ITEMS } from './rfq.ts';

/** The schema of a quote. */
export const QUOTE_SCHEMA = 'vector.usecase.quote.v1';

/** The names of `checks`, in the order that the checks run: the six shared checks of a bid desk (the sender, the delegation and the payment from a vault), and then `not_duplicate`. */
export const QUOTE_CHECKS = ['sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid', 'not_duplicate'] as const;

type QuoteCheck = (typeof QUOTE_CHECKS)[number];

/** One line of a quote: the SKU, the quantity that the desk quotes, its unit price, the line total (quantity times unit price) and the lead time of the SKU in days. */
export interface QuoteLine {
  readonly sku: string;
  readonly quantity: number;
  readonly unit_price: number;
  readonly line_total: number;
  readonly lead_time_days: number;
}

/** The quote that a Bid Desk returns: the members of its page, in this order. */
export interface Quote {
  readonly schema: typeof QUOTE_SCHEMA;
  readonly outcome: 'done';
  readonly rfq_id: string;
  /** The canonical SHA-256 of the request that the desk received. */
  readonly rfq_sha256: Digest;
  readonly desk_did: Did;
  /** The organisation of the desk: a domain name. */
  readonly organisation: string;
  readonly lines: readonly QuoteLine[];
  /** The sum of the line totals. */
  readonly total: number;
  /** The longest lead time of the lines, in days. */
  readonly lead_time_days: number;
  readonly valid_until: string;
  readonly notes: string;
  /** The SHA-256 of the bytes of the price list that the desk priced from. */
  readonly price_list_sha256: Digest;
  /** The credential of the desk from the identity gateway: a compact JWS text. */
  readonly credential: string;
  readonly sender: {
    readonly did: Did;
    /** The organisation that the covering Accountable Party names, or null. */
    readonly organisation: string | null;
    /** True only when the gateway says that it verified the organisation. */
    readonly organisation_verified: boolean;
  };
  readonly checks: { readonly [name in QuoteCheck]: true };
  readonly decisions: readonly Decision[];
  readonly fault_mode: FaultSetting<'bid-desk'>;
}

type Sender = Quote['sender'];

const MEMBERS = [
  'schema', 'outcome', 'rfq_id', 'rfq_sha256', 'desk_did', 'organisation', 'lines', 'total', 'lead_time_days', 'valid_until', 'notes', 'price_list_sha256', 'credential', 'sender', 'checks', 'decisions',
  'fault_mode',
] as const;
const LINE_MEMBERS = ['sku', 'quantity', 'unit_price', 'line_total', 'lead_time_days'] as const;
/** The members of an input line of `quoteTotals`: the four that the desk chooses. */
const CHOSEN_MEMBERS = ['sku', 'quantity', 'unit_price', 'lead_time_days'] as const;

/** The limits of a line. The unit price and the lead time have the limits of a price list. The limits keep each line total at most 10^12 and each total at most 2 x 10^13, so every product and sum is exact. */
const MAX_UNIT_PRICE = 1_000_000;
const MAX_LEAD_TIME_DAYS = 365;
const MAX_LINE_TOTAL = MAX_ITEM_QUANTITY * MAX_UNIT_PRICE;
const MAX_TOTAL = MAX_RFQ_ITEMS * MAX_LINE_TOTAL;
/** The longest text of the notes, of the domain of the desk, of the organisation of the sender, and of the credential, in characters. */
const MAX_NOTES_CHARS = 500;
const MAX_DOMAIN_CHARS = 64;
const MAX_ORGANISATION_CHARS = 1024;
const MAX_CREDENTIAL_CHARS = 8192;
/** A label of a domain name: lower case letters, digits and hyphens, and no hyphen at either end. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A compact JWS: three parts of base64url text with a dot between them. */
const CREDENTIAL = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** A control character of the Unicode category Cc: the two blocks of controls and the delete character. A NUL is one of them. */
const CONTROL = /\p{Cc}/u;
/** The identifier of a capability: the form of a SKU. */
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The signature of a receipt: printable characters with no space. A signature is hex or base64, so no more is asked of it. */
const SIGNATURE = /^[\x21-\x7e]{1,1024}$/;
/** The name of the one decision of the Bid Desk: the model chooses the lines of the quote. */
const QUOTE_DECISION = 'quote';

/** The domain of the desk: a name in lower case with at least two labels and at most 64 characters. A name with a capital letter, a port, a path or a letter outside ASCII is not one. */
function parseDomain(value: JsonValue, field: string): ProtocolResult<string> {
  if (typeof value === 'string' && value.length <= MAX_DOMAIN_CHARS) {
    const labels = value.split('.');
    if (labels.length >= 2 && labels.every((label) => LABEL.test(label))) return accepted(value);
  }
  return refused('bad_shape', `${field} must be a domain name in lower case with at least two labels and at most ${MAX_DOMAIN_CHARS} characters`);
}

/** The text in the NFC form, when the text and its NFC form are both at most `max` characters, and else null. NFC can make a text longer, and the copy must pass the parser again. */
function nfcWithin(value: JsonValue, max: number): string | null {
  if (typeof value !== 'string' || value.length > max) return null;
  const copy = value.normalize('NFC');
  return copy.length > max ? null : copy;
}

/** The organisation of the sender: null, or any text of at most MAX_ORGANISATION_CHARS characters. The copy holds the text in the NFC form. */
function parseOrganisation(value: JsonValue, field: string): ProtocolResult<string | null> {
  if (value === null) return accepted(null);
  const copy = nfcWithin(value, MAX_ORGANISATION_CHARS);
  if (copy !== null) return accepted(copy);
  return refused('bad_shape', `${field} must be null or a text of at most ${MAX_ORGANISATION_CHARS} characters`);
}

function parseSender(value: JsonValue, field: string): ProtocolResult<Sender> {
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

/** The four members of a line that the desk chooses, read by the rules of a line of a quote. The line total is not one of them: it is the product of two of them. */
function parseChosen(values: Readonly<Record<string, unknown>>, field: string): ProtocolResult<Omit<QuoteLine, 'line_total'>> {
  const sku = parseSku(values.sku, `${field}.sku`);
  if (!sku.ok) return sku;
  const quantity = parseQuantity(values.quantity, `${field}.quantity`);
  if (!quantity.ok) return quantity;
  const price = parseWhole(values.unit_price, `${field}.unit_price`, 1, MAX_UNIT_PRICE);
  if (!price.ok) return price;
  const lead = parseWhole(values.lead_time_days, `${field}.lead_time_days`, 0, MAX_LEAD_TIME_DAYS);
  if (!lead.ok) return lead;
  return accepted({ sku: sku.value, quantity: quantity.value, unit_price: price.value, lead_time_days: lead.value });
}

function parseLine(value: JsonValue, field: string): ProtocolResult<QuoteLine> {
  const line = objectOf(value, field);
  if (!line.ok) return line;
  const members = checkMembers(line.value, field, LINE_MEMBERS);
  if (members !== null) return members;
  const chosen = parseChosen(line.value, field);
  if (!chosen.ok) return chosen;
  const { sku, quantity, unit_price, lead_time_days } = chosen.value;
  const lineTotal = parseWhole(line.value.line_total, `${field}.line_total`, 1, MAX_LINE_TOTAL);
  if (!lineTotal.ok) return lineTotal;
  if (lineTotal.value !== quantity * unit_price) return refused('bad_shape', `${field}.line_total must be quantity times unit_price`);
  return accepted({ sku, quantity, unit_price, line_total: lineTotal.value, lead_time_days });
}

/** The lines of a quote: 1 to 20 lines, and each SKU once. The detail of a SKU that comes two times names the second line. */
function parseLines(value: JsonValue, field: string): ProtocolResult<readonly QuoteLine[]> {
  if (!isList(value)) return refused('bad_shape', `${field} must be a list`);
  if (value.length < 1 || value.length > MAX_RFQ_ITEMS) return refused('bad_shape', `${field} must have 1 to ${MAX_RFQ_ITEMS} lines`);
  const lines = valuesOf(Array.from(value, (entry, index) => parseLine(entry, `${field}[${index}]`)));
  if (!lines.ok) return lines;
  const seen = new Set<string>();
  for (const [index, line] of lines.value.entries()) {
    if (seen.has(line.sku)) return refused('bad_shape', `${field}[${index}].sku is in the quote two times`);
    seen.add(line.sku);
  }
  return lines;
}

/** The notes: a text of at most MAX_NOTES_CHARS characters with no control character. The copy holds the text in the NFC form. */
function parseNotes(value: JsonValue, field: string): ProtocolResult<string> {
  const copy = nfcWithin(value, MAX_NOTES_CHARS);
  if (copy !== null && !CONTROL.test(copy)) return accepted(copy);
  return refused('bad_shape', `${field} must be a text of at most ${MAX_NOTES_CHARS} characters with no control character`);
}

/** The credential: a compact JWS text. The length is checked first, so that a long text is never matched. */
function parseCredential(value: JsonValue, field: string): ProtocolResult<string> {
  if (typeof value === 'string' && value.length <= MAX_CREDENTIAL_CHARS && CREDENTIAL.test(value)) return accepted(value);
  return refused('bad_shape', `${field} must be a compact JWS: three parts of letters, digits, hyphens and underscores with a dot between them, at most ${MAX_CREDENTIAL_CHARS} characters in all`);
}

function parseChecks(value: JsonValue, field: string): ProtocolResult<Quote['checks']> {
  const checks = objectOf(value, field);
  if (!checks.ok) return checks;
  const members = checkMembers(checks.value, field, QUOTE_CHECKS);
  if (members !== null) return members;
  for (const name of QUOTE_CHECKS) {
    if (checks.value[name] !== true) return refused('bad_shape', `${field}.${name} must be true`);
  }
  // Each listed name is a member and its value is true (the loop above), so the entries make the object of the type.
  return accepted(Object.fromEntries(QUOTE_CHECKS.map((name) => [name, true])) as Quote['checks']);
}

function parseVerification(value: JsonValue, field: string): ProtocolResult<ReceiptVerification> {
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

function parseSubJob(value: JsonValue, field: string): ProtocolResult<SubJob> {
  const subJob = objectOf(value, field);
  if (!subJob.ok) return subJob;
  const members = checkMembers(subJob.value, field, ['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
  if (members !== null) return members;
  const capability = subJob.value.capability_id;
  if (typeof capability !== 'string' || !CAPABILITY.test(capability)) return refused('bad_shape', `${field}.capability_id must be 1 to 64 characters: letters, digits, dot, hyphen and underscore, and it starts with a letter or a digit`);
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
    capability_id: capability, advert_ref: advert.value, escrow_ref: escrow.value, supplier_pkh: supplier.value, receipt: receipt.value, receipt_signature: signature, verification: verification.value,
  });
}

function parseInference(value: JsonValue, field: string): ProtocolResult<Decision['inference']> {
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

/** One decision of the protocol: its name (`quote`), the choice as the model gave it (any JSON), the reasoning (a text that is not blank), and the hire that bought it. */
function parseDecision(value: JsonValue, field: string): ProtocolResult<Decision> {
  const decision = objectOf(value, field);
  if (!decision.ok) return decision;
  const members = checkMembers(decision.value, field, ['name', 'choice', 'reasoning', 'inference']);
  if (members !== null) return members;
  const { name, choice, reasoning } = decision.value;
  if (name !== QUOTE_DECISION) return refused('bad_shape', `${field}.name must be "${QUOTE_DECISION}"`);
  if (typeof reasoning !== 'string' || reasoning.trim() === '') return refused('bad_shape', `${field}.reasoning must be a text that is not blank`);
  const inference = parseInference(decision.value.inference, `${field}.inference`);
  if (!inference.ok) return inference;
  return accepted({ name, choice, reasoning, inference: inference.value });
}

/** The decisions of a quote: a list of exactly one decision, the decision `quote`. */
function parseDecisions(value: JsonValue, field: string): ProtocolResult<readonly Decision[]> {
  if (!isList(value)) return refused('bad_shape', `${field} must be a list`);
  if (value.length !== 1) return refused('bad_shape', `${field} must hold exactly one decision, named "${QUOTE_DECISION}"`);
  return valuesOf(Array.from(value, (entry, index) => parseDecision(entry, `${field}[${index}]`)));
}

/**
 * A quote with exactly the members above, as a new plain object, or a refusal with the code `bad_shape`. `outcome` is `done` and nothing else: a Bid Desk answers a refusal or a failure with an error and
 * not with a quote. The three numbers are checked against the lines: each line total is its quantity times its unit price, the total is the sum of the line totals, and the lead time is the longest lead time
 * of the lines. The parser does not compare the quote with a request or with a price list: `checkQuoteAnswersRfq` and `checkQuoteFromList` do that.
 */
export function parseQuote(value: unknown): ProtocolResult<Quote> {
  const field = 'quote';
  const whole = parseDocument(value, field);
  if (!whole.ok) return whole;
  const members = checkMembers(whole.value, field, MEMBERS);
  if (members !== null) return members;
  const record = whole.value;
  if (record.schema !== QUOTE_SCHEMA) return refused('bad_shape', `${field}.schema must be "${QUOTE_SCHEMA}"`);
  if (record.outcome !== 'done') return refused('bad_shape', `${field}.outcome must be "done"`);
  const rfqId = parseRfqId(record.rfq_id, `${field}.rfq_id`);
  if (!rfqId.ok) return rfqId;
  const rfqSha = parseDigest(record.rfq_sha256, `${field}.rfq_sha256`);
  if (!rfqSha.ok) return rfqSha;
  const deskDid = parseDid(record.desk_did, `${field}.desk_did`);
  if (!deskDid.ok) return deskDid;
  const organisation = parseDomain(record.organisation, `${field}.organisation`);
  if (!organisation.ok) return organisation;
  const lines = parseLines(record.lines, `${field}.lines`);
  if (!lines.ok) return lines;
  const total = parseWhole(record.total, `${field}.total`, 1, MAX_TOTAL);
  if (!total.ok) return total;
  if (total.value !== lines.value.reduce((sum, line) => sum + line.line_total, 0)) return refused('bad_shape', `${field}.total must be the sum of the line totals`);
  const lead = parseWhole(record.lead_time_days, `${field}.lead_time_days`, 0, MAX_LEAD_TIME_DAYS);
  if (!lead.ok) return lead;
  if (lead.value !== Math.max(...lines.value.map((line) => line.lead_time_days))) return refused('bad_shape', `${field}.lead_time_days must be the longest lead time of the lines`);
  const validUntil = parseDay(record.valid_until, `${field}.valid_until`);
  if (!validUntil.ok) return validUntil;
  const notes = parseNotes(record.notes, `${field}.notes`);
  if (!notes.ok) return notes;
  const listSha = parseDigest(record.price_list_sha256, `${field}.price_list_sha256`);
  if (!listSha.ok) return listSha;
  const credential = parseCredential(record.credential, `${field}.credential`);
  if (!credential.ok) return credential;
  const sender = parseSender(record.sender, `${field}.sender`);
  if (!sender.ok) return sender;
  const checks = parseChecks(record.checks, `${field}.checks`);
  if (!checks.ok) return checks;
  const decisions = parseDecisions(record.decisions, `${field}.decisions`);
  if (!decisions.ok) return decisions;
  const faultMode = record.fault_mode;
  if (!isFaultSetting('bid-desk', faultMode)) return refused('bad_shape', `${field}.fault_mode must be the empty text or a fault value of the Bid Desk`);
  const quote: Quote = {
    schema: QUOTE_SCHEMA,
    outcome: 'done',
    rfq_id: rfqId.value,
    rfq_sha256: rfqSha.value,
    desk_did: deskDid.value,
    organisation: organisation.value,
    lines: lines.value,
    total: total.value,
    lead_time_days: lead.value,
    valid_until: validUntil.value,
    notes: notes.value,
    price_list_sha256: listSha.value,
    credential: credential.value,
    sender: sender.value,
    checks: checks.value,
    decisions: decisions.value,
    fault_mode: faultMode,
  };
  return accepted(quote);
}

/**
 * The arithmetic of a quote, from the lines that a Bid Desk chose, or null. An input line has a SKU, a quantity, a unit price and a lead time. The result has the lines with the five members of a quote line
 * in the order of the page, the total (the sum of the line totals) and the longest lead time of the lines. The result is null for an empty list, for more than 20 lines, for a SKU two times, and for a line that
 * no quote could hold: a member that is not a whole number in its range, whatever its type is. So the result is also null for a product or a sum that a number cannot hold exactly, and every line of a result
 * passes `parseQuote`. The lines of the result are new objects: the input is not changed, and a member that is not one of the four is left out. A value that is not a list, and an entry that is not a plain
 * object with the four members of its own, give null: a member that only a prototype holds is not read.
 */
export function quoteTotals(lines: readonly { sku: string; quantity: number; unit_price: number; lead_time_days: number }[]): { lines: QuoteLine[]; total: number; lead_time_days: number } | null {
  const list: unknown = lines;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_RFQ_ITEMS) return null;
  const made: QuoteLine[] = [];
  const seen = new Set<string>();
  let total = 0;
  let longest = 0;
  for (const entry of list as readonly unknown[]) {
    const chosen = isPlainObject(entry) && CHOSEN_MEMBERS.every((name) => Object.hasOwn(entry, name)) ? parseChosen(entry, 'line') : null;
    if (chosen === null || !chosen.ok || seen.has(chosen.value.sku)) return null;
    seen.add(chosen.value.sku);
    const { sku, quantity, unit_price, lead_time_days } = chosen.value;
    const lineTotal = quantity * unit_price;
    made.push({ sku, quantity, unit_price, line_total: lineTotal, lead_time_days });
    total += lineTotal;
    longest = Math.max(longest, lead_time_days);
  }
  return { lines: made, total, lead_time_days: longest };
}
