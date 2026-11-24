// packages/usecase-kit/src/bids/ranking.ts
// The ranking of use case 3 (supplier bid evaluation), the hash of a receipt, and the builder of the ranking. The Sourcing Agent proposes the ranking as the `document` of a proposal, so its digest is
// `proposalDigest(salt, document)` of the protocol. The hirer approves that digest. The agent then writes the ranking to the sourcing record of the mock service, which hashes the ranking exactly as it
// was sent. Its members, in this order:
//   schema, rfq_id, rfq_sha256 (the canonical hash of the request, `rfqSha256`), tenant, weights, ranked, excluded
// A ranked entry holds: rank, desk_did, organisation (only when the bidder has one), score, components, quote { escrow_ref, receipt_sha256, total, lead_time_days }.
// An excluded entry holds: desk_did, reason (one of `EXCLUDED_REASONS`) and code (the refusal code, the failure code or the code of the evidence, or null).
// The ranking holds no free text of a bidder: its members are identifiers, hashes, numbers, a domain and codes, and each text has a strict form. So a text that a bidder wrote never reaches the approver
// through the document.
//
// The order of `ranked` is the order that the model gave, and the rank is the position in the list: no code sorts by score, and a list that is not in the order of the scores is a ranking that the model
// chose. The score and the components are the numbers of the scorer. The parser checks their range and does not compute them.
//
// The sourcing record of the mock service takes a ranking of 1 to 20 entries with one entry of rank 1, `organisation` only as a lower-case domain (a member with the value `null` is refused), and the tenant of
// the URL. The parser takes a subset of that: every ranking that it takes is a ranking that the record takes for the same tenant. A test holds the two rules side by side.
// `parseRanking` reads its input with `parseDocument` of the protocol: each member is read one time as data, the copy is a new plain object, and an accessor, the key `__proto__` and a member that is not
// listed are refused. Each text is checked as it is written. A text that passes is ASCII, so it is in the NFC form that the digest binds already. A text that only NFC turns into a valid text, such as the
// Kelvin sign that becomes the letter K, is refused. The detail of a refusal names the member and never repeats the value.
import { DOCUMENT_SCHEMAS, accepted, canonicalSha256, checkMembers, isPlainObject, parseDid, parseDigest, parseDocument, parseJsonValue, parseOutputRef, refused } from '../protocol/index.ts';
import type { Digest, Did, JsonValue, OutputRef, ProtocolResult } from '../protocol/index.ts';
import { isList, objectOf, parseRfqId, parseWhole, valuesOf } from './ids.ts';
import { parseRfqDocument, rfqSha256 } from './rfq.ts';
import type { RfqDocument } from './rfq.ts';
import { parseComponents, parseScoreValue } from './scores.ts';
import type { Components } from './scores.ts';
import { parseWeights } from './weights.ts';
import type { Weights } from './weights.ts';

/** The schema of the ranking: the schema that the protocol names for the documents of use case 3. */
export const RANKING_SCHEMA = DOCUMENT_SCHEMAS['bid-evaluation'];

/**
 * Why a bidder is not in the ranked list: the Sourcing Agent did not invite it, its record was not active, it refused the request, its job failed, or its quote was not accepted and was challenged. The
 * code of the excluded entry says more.
 */
export const EXCLUDED_REASONS = ['not_invited', 'not_active', 'refused', 'failed', 'disputed'] as const;
export type ExcludedReason = (typeof EXCLUDED_REASONS)[number];

/** The most entries that a ranked list holds: the most that the sourcing record takes. */
const MAX_RANKED = 20;
/** The most entries that an excluded list holds. The sourcing record does not read the list, so this limit is the kit's own: it keeps the document small. */
const MAX_EXCLUDED = 20;
/** The form of a tenant of the mock service: 1 to 48 lower-case letters, digits and hyphens, starting with a letter or a digit. */
const TENANT = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** One label of a domain: 1 to 63 lower-case letters, digits and hyphens, starting and ending with a letter or a digit. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_ORGANISATION_CHARS = 64;
/** The code of an excluded entry: 1 to 64 lower-case letters, digits and underscores. */
const CODE = /^[a-z0-9_]{1,64}$/;

/** The quote that a score was computed from: the escrow that paid for it, the hash of its signed receipt, and its two numbers. */
export interface RankedQuote {
  readonly escrow_ref: OutputRef;
  /** The hash that `receiptSha256` gives for the receipt and the signature of the quote job. */
  readonly receipt_sha256: Digest;
  readonly total: number;
  readonly lead_time_days: number;
}

/** A bidder in the ranked list. `organisation` is a member only when the bidder has one: the sourcing record refuses the value `null`. */
export interface RankedEntry {
  /** The position in the list, from 1. */
  readonly rank: number;
  readonly desk_did: Did;
  readonly organisation?: string;
  readonly score: number;
  readonly components: Components;
  readonly quote: RankedQuote;
}

/** A bidder that is not in the ranked list. The code is the refusal code, the failure code or the code of the evidence, or null. */
export interface ExcludedEntry {
  readonly desk_did: Did;
  readonly reason: ExcludedReason;
  readonly code: string | null;
}

export interface Ranking {
  readonly schema: typeof RANKING_SCHEMA;
  readonly rfq_id: string;
  readonly rfq_sha256: Digest;
  readonly tenant: string;
  readonly weights: Weights;
  readonly ranked: readonly RankedEntry[];
  readonly excluded: readonly ExcludedEntry[];
}

const MEMBERS = ['schema', 'rfq_id', 'rfq_sha256', 'tenant', 'weights', 'ranked', 'excluded'] as const;

function parseTenant(value: unknown, field: string): ProtocolResult<string> {
  return typeof value === 'string' && TENANT.test(value)
    ? accepted(value)
    : refused('bad_shape', `${field} must be 1 to 48 lower-case letters, digits and hyphens, and it starts with a letter or a digit`);
}

/** A domain in lower case with at least two labels and at most 64 characters: the form that the sourcing record takes. The same label rule as the record. */
function parseOrganisation(value: unknown, field: string): ProtocolResult<string> {
  if (typeof value === 'string' && value.length <= MAX_ORGANISATION_CHARS) {
    const labels = value.split('.');
    if (labels.length >= 2 && labels.every((label) => LABEL.test(label))) return accepted(value);
  }
  return refused('bad_shape', `${field} must be a domain name in lower case, with at least two labels and at most ${MAX_ORGANISATION_CHARS} characters (leave the member out when there is none)`);
}

function parseExcludedReason(value: unknown, field: string): ProtocolResult<ExcludedReason> {
  const reason = EXCLUDED_REASONS.find((candidate) => candidate === value);
  return reason === undefined ? refused('bad_shape', `${field} must be one of ${EXCLUDED_REASONS.join(', ')}`) : accepted(reason);
}

function parseCode(value: unknown, field: string): ProtocolResult<string | null> {
  if (value === null) return accepted(null);
  return typeof value === 'string' && CODE.test(value) ? accepted(value) : refused('bad_shape', `${field} must be null or 1 to 64 lower-case letters, digits and underscores`);
}

function parseQuote(value: JsonValue, field: string): ProtocolResult<RankedQuote> {
  const quote = objectOf(value, field);
  if (!quote.ok) return quote;
  const members = checkMembers(quote.value, field, ['escrow_ref', 'receipt_sha256', 'total', 'lead_time_days']);
  if (members !== null) return members;
  const escrow = parseOutputRef(quote.value.escrow_ref, `${field}.escrow_ref`);
  if (!escrow.ok) return escrow;
  const receipt = parseDigest(quote.value.receipt_sha256, `${field}.receipt_sha256`);
  if (!receipt.ok) return receipt;
  const total = parseWhole(quote.value.total, `${field}.total`, 0, Number.MAX_SAFE_INTEGER);
  if (!total.ok) return total;
  const lead = parseWhole(quote.value.lead_time_days, `${field}.lead_time_days`, 0, Number.MAX_SAFE_INTEGER);
  if (!lead.ok) return lead;
  return accepted({ escrow_ref: escrow.value, receipt_sha256: receipt.value, total: total.value, lead_time_days: lead.value });
}

/** A ranked entry. `position` is the place of the entry in the list, from 1, and the rank must be that number. */
function parseRankedEntry(value: JsonValue, field: string, position: number): ProtocolResult<RankedEntry> {
  const entry = objectOf(value, field);
  if (!entry.ok) return entry;
  const members = checkMembers(entry.value, field, ['rank', 'desk_did', 'score', 'components', 'quote'], ['organisation']);
  if (members !== null) return members;
  const rank = parseWhole(entry.value.rank, `${field}.rank`, 1, MAX_RANKED);
  if (!rank.ok) return rank;
  if (rank.value !== position) return refused('bad_shape', `${field}.rank must be ${position}, the position of the entry in the list`);
  const desk = parseDid(entry.value.desk_did, `${field}.desk_did`);
  if (!desk.ok) return desk;
  // The member is read only when the entry has it as its own member: a member that a prototype holds is never the organisation of a bidder.
  const organisation = Object.hasOwn(entry.value, 'organisation') ? parseOrganisation(entry.value.organisation, `${field}.organisation`) : null;
  if (organisation !== null && !organisation.ok) return organisation;
  const score = parseScoreValue(entry.value.score, `${field}.score`);
  if (!score.ok) return score;
  const components = parseComponents(entry.value.components, `${field}.components`);
  if (!components.ok) return components;
  const quote = parseQuote(entry.value.quote, `${field}.quote`);
  if (!quote.ok) return quote;
  return accepted({
    rank: rank.value,
    desk_did: desk.value,
    ...(organisation === null ? {} : { organisation: organisation.value }),
    score: score.value,
    components: components.value,
    quote: quote.value,
  });
}

function parseExcludedEntry(value: JsonValue, field: string): ProtocolResult<ExcludedEntry> {
  const entry = objectOf(value, field);
  if (!entry.ok) return entry;
  const members = checkMembers(entry.value, field, ['desk_did', 'reason', 'code']);
  if (members !== null) return members;
  const desk = parseDid(entry.value.desk_did, `${field}.desk_did`);
  if (!desk.ok) return desk;
  const reason = parseExcludedReason(entry.value.reason, `${field}.reason`);
  if (!reason.ok) return reason;
  const code = parseCode(entry.value.code, `${field}.code`);
  if (!code.ok) return code;
  return accepted({ desk_did: desk.value, reason: reason.value, code: code.value });
}

/**
 * A ranking with exactly the members above, as a new plain object, or a refusal with the code `bad_shape`. The ranked list has 1 to 20 entries, and the ranks are 1 to n in the order of the list. Each
 * `desk_did` is in the ranking once, across `ranked` and `excluded`. The excluded list has 0 to 20 entries. `field` is the name that the detail of a refusal gives to the ranking: a caller that reads the document
 * of a proposal passes `proposal.document`.
 */
export function parseRanking(value: unknown, field = 'ranking'): ProtocolResult<Ranking> {
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, MEMBERS);
  if (members !== null) return members;
  if (copy.value.schema !== RANKING_SCHEMA) return refused('bad_shape', `${field}.schema must be "${RANKING_SCHEMA}"`);
  const rfqId = parseRfqId(copy.value.rfq_id, `${field}.rfq_id`);
  if (!rfqId.ok) return rfqId;
  const rfqHash = parseDigest(copy.value.rfq_sha256, `${field}.rfq_sha256`);
  if (!rfqHash.ok) return rfqHash;
  const tenant = parseTenant(copy.value.tenant, `${field}.tenant`);
  if (!tenant.ok) return tenant;
  const weights = parseWeights(copy.value.weights, `${field}.weights`);
  if (!weights.ok) return weights;
  const rankedList = copy.value.ranked;
  if (!isList(rankedList)) return refused('bad_shape', `${field}.ranked must be a list`);
  if (rankedList.length < 1 || rankedList.length > MAX_RANKED) return refused('bad_shape', `${field}.ranked must have 1 to ${MAX_RANKED} entries`);
  const ranked = valuesOf(Array.from(rankedList, (entry, index) => parseRankedEntry(entry, `${field}.ranked[${index}]`, index + 1)));
  if (!ranked.ok) return ranked;
  const excludedList = copy.value.excluded;
  if (!isList(excludedList)) return refused('bad_shape', `${field}.excluded must be a list`);
  if (excludedList.length > MAX_EXCLUDED) return refused('bad_shape', `${field}.excluded must have at most ${MAX_EXCLUDED} entries`);
  const excluded = valuesOf(Array.from(excludedList, (entry, index) => parseExcludedEntry(entry, `${field}.excluded[${index}]`)));
  if (!excluded.ok) return excluded;
  const seen = new Set<string>();
  for (const [index, entry] of ranked.value.entries()) {
    if (seen.has(entry.desk_did)) return refused('bad_shape', `${field}.ranked[${index}].desk_did is in the ranking two times`);
    seen.add(entry.desk_did);
  }
  for (const [index, entry] of excluded.value.entries()) {
    if (seen.has(entry.desk_did)) return refused('bad_shape', `${field}.excluded[${index}].desk_did is in the ranking two times`);
    seen.add(entry.desk_did);
  }
  const ranking: Ranking = { schema: RANKING_SCHEMA, rfq_id: rfqId.value, rfq_sha256: rfqHash.value, tenant: tenant.value, weights: weights.value, ranked: ranked.value, excluded: excluded.value };
  return accepted(ranking);
}

/**
 * The hash of a quote receipt: the canonical hash of the pair `{ receipt, signature }`, with no salt, as 64 lower-case hex characters. It is the `receipt_sha256` of the quote in a ranked entry, so an
 * approver can open a score down to the signed receipt that it was computed from. The receipt is a JSON object, and the signature is a text. Both are bound: a change of one member of the receipt, or of the
 * signature, gives another hash. The function does not check the signature. A caller checks it before it hashes the pair.
 */
export function receiptSha256(receipt: unknown, signature: unknown): ProtocolResult<Digest> {
  if (!isPlainObject(receipt)) return refused('bad_shape', 'receipt must be a JSON object');
  if (typeof signature !== 'string') return refused('bad_shape', 'signature must be a text');
  const copy = parseJsonValue(receipt, 'receipt');
  if (!copy.ok) return copy;
  return canonicalSha256({ receipt: copy.value, signature }, 'receipt');
}

/**
 * One entry of the builder as a member of the document: the entry as it is given, with `rank` first. The rank is the position, and an entry that names another rank is refused by the parser. A member of
 * the entry that has the value `undefined` is no member: `organisation` is a member only when the bidder has one. Only the own members of the entry are read, so a member of a prototype never enters.
 * A value that is not a plain object goes on as it is, and the parser refuses it.
 */
function rankedMember(entry: unknown, position: number): unknown {
  if (!isPlainObject(entry)) return entry;
  const member: Record<string, unknown> = { rank: position, ...entry };
  if (Object.hasOwn(member, 'organisation') && member.organisation === undefined) Reflect.deleteProperty(member, 'organisation');
  return member;
}

/**
 * Builds the ranking of a job. `rfq` is the request that was sent: it gives `rfq_id` and `rfq_sha256`. `entries` come in the order of the model, each without a `rank`. The builder gives the ranks 1 to n by
 * position, builds the document, and runs `parseRanking` on it: the result is that result, so a ranking that this function returns is a ranking that the parser takes, and a ranking that the parser
 * refuses is never returned. It never sorts, never changes a score and never drops an entry. An empty list of entries is a refusal, as a list of more than 20.
 */
export function buildRanking(input: {
  readonly rfq: RfqDocument;
  readonly tenant: string;
  readonly weights: Weights;
  readonly entries: readonly Omit<RankedEntry, 'rank'>[];
  readonly excluded: readonly ExcludedEntry[];
}): ProtocolResult<Ranking> {
  const { rfq, tenant, weights, entries, excluded } = input;
  const request = parseRfqDocument(rfq, 'rfq');
  if (!request.ok) return request;
  const hash = rfqSha256(request.value);
  if (!hash.ok) return hash;
  const given: unknown = entries;
  if (!Array.isArray(given)) return refused('bad_shape', 'entries must be a list');
  if (given.length < 1 || given.length > MAX_RANKED) return refused('bad_shape', `entries must hold 1 to ${MAX_RANKED} entries`);
  const ranked = Array.from<unknown, unknown>(given, (entry, index) => rankedMember(entry, index + 1));
  return parseRanking({ schema: RANKING_SCHEMA, rfq_id: request.value.rfq_id, rfq_sha256: hash.value, tenant, weights, ranked, excluded });
}
