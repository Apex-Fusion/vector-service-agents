// packages/usecase-kit/src/dispute/documents.ts
// The documents that a juror reads: the claim document of an agent, and the evidence document of a challenge. Both are plain sentences. The evidence states the contradiction with its values first,
// and then the hashes and the references. A juror has no tools and cannot fetch anything, so each fact that matters is in the text.
//
// A document has at most MAX_JUROR_DOCUMENT_BYTES bytes. The check is hard: a document that is too large is refused with a typed code, and it is never cut. The reference jurors cut a document that is
// larger than their own limits (the input template `vector-jury-input/1`: 3,500 bytes of text, and 4,300 bytes after the text is escaped twice as a JSON string). The check here covers both limits, so
// a juror reads each document whole.
//
// A value that comes from a counterparty is shown as JSON text, with every character outside printable ASCII written as an escape. A long value is shown cut, with a note that says so. So a value
// cannot add a line or a sentence to the document, and a long value cannot push the references out of it. The comparison of two values always uses the whole values.
//
// A document is plain text. Its bytes are the same for the same input: it has no time and no random part. The evidence of an approval has the two digests and the references, and no text of the request.
import { documentHash } from '@vsa/buyer-core';
import {
  accepted, canonicalJson, canonicalSha256, checkMembers, parseApprovalRef, parseDid, parseDigest, parseJsonValue, parseOutputRef, refused,
} from '../protocol/index.ts';
import type { ApprovalDigestMismatch, ApprovalRef, Did, Digest, Document, JsonObject, JsonValue, ManifestClaim, OutputRef, ProtocolResult } from '../protocol/index.ts';

/** The most bytes of a document for a juror. */
export const MAX_JUROR_DOCUMENT_BYTES = 3_000;
/** The most bytes that the text of a document takes in the record of a juror, after it is escaped twice as a JSON string. */
export const JUROR_RECORD_LIMIT_BYTES = 4_300;
/** The media type of a document for a juror. */
export const JUROR_MEDIA_TYPE = 'text/plain';
/** The statement that the three evidence formats are about. */
export const EVIDENCE_STATEMENT = 'S1';

const MAX_SHOWN_CHARS = 80;

export type DocumentCode = 'bad_shape' | 'document_too_large' | 'no_contradiction';

/** A document for a juror: its text, its bytes and the hash that a claim or a challenge holds. */
export interface JurorDocument {
  readonly type: 'claim' | 'evidence';
  readonly media_type: typeof JUROR_MEDIA_TYPE;
  readonly text: string;
  readonly bytes: Buffer;
  /** The blake2b-256 hash of `bytes`, as 64 lower-case hex characters. */
  readonly hash: string;
}

/** What the claim document needs. The statements are the ones of the manifest of the agent. */
export interface ClaimDocumentInput {
  readonly agent_did: Did;
  readonly capability_id: string;
  /** The SHA-256 of the manifest of the agent. */
  readonly manifest_sha256: Digest;
  readonly claim: ManifestClaim;
}

/** The references that every evidence document holds: the claim that it is about, the two agents and the job. */
export interface EvidenceParties {
  /** The output that holds the claim at the time of the challenge. */
  readonly claim: OutputRef;
  /** The claim token: `636c6d5f` and 56 lower-case hex characters. */
  readonly claim_token: string;
  /** The claimer: the agent whose claim is challenged. */
  readonly against_did: Did;
  /** The challenger. */
  readonly by_did: Did;
  /** The escrow of the job that the evidence is about. */
  readonly escrow_ref: OutputRef;
}

/**
 * Use case 1 (inventory reorder), a buyer-side agent: the confirmation of the order desk does not match the purchase order. The documents are read for the SKU, the lot and the quantity: the
 * purchase order must have all three, and a member that the confirmation lacks is shown as not named.
 */
export interface OrderConfirmationFacts {
  readonly kind: 'order_confirmation';
  /** The purchase order that the agent sent. */
  readonly purchase_order: Document;
  /** The confirmation that the order desk returned. */
  readonly confirmation: JsonObject;
  /** The hash that the signed receipt commits to for the confirmation (the `response_hash`). */
  readonly confirmation_sha256: Digest;
}

/** Use case 3 (supplier bid evaluation), a buyer-side agent: the quoted unit price is not the price of the published price list for that SKU and quantity. */
export interface QuotePriceFacts {
  readonly kind: 'quote_price';
  readonly sku: JsonValue;
  readonly quantity: JsonValue;
  readonly quoted_unit_price: JsonValue;
  /** The unit price that the published price list gives for that SKU and quantity. */
  readonly listed_unit_price: JsonValue;
  readonly price_list_sha256: Digest;
  /** The hash that the signed receipt commits to for the quote (the `response_hash`). */
  readonly quote_sha256: Digest;
}

/**
 * A counterparty that refused a request because its digest is not the digest that the approval holds. It is the evidence of use case 2 (prior authorization), and of use case 1 (inventory
 * reorder) when the order desk finds the same fault. `mismatch` is the result of the approval check. Only its two digests go into the document. It has no text of the request and no salt.
 */
export interface ApprovalDigestFacts {
  readonly kind: 'approval_digest';
  readonly use_case: 'inventory-reorder' | 'prior-authorization';
  readonly approval: ApprovalRef;
  readonly mismatch: ApprovalDigestMismatch;
}

export type EvidenceFacts = OrderConfirmationFacts | QuotePriceFacts | ApprovalDigestFacts;
export type EvidenceDocumentInput = EvidenceParties & EvidenceFacts;

const PLAIN_WORD = '[\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}]';
/** Text with letters, marks, numbers, punctuation and symbols, and single spaces inside. No control character, no line break, and no space at either end. */
const PLAIN_TEXT = new RegExp(`^${PLAIN_WORD}(?:[\\p{L}\\p{M}\\p{N}\\p{P}\\p{S} ]*${PLAIN_WORD})?$`, 'u');
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLAIM_TOKEN = /^636c6d5f[0-9a-f]{56}$/;

/** A claim token: `636c6d5f` and 56 lower-case hex characters. */
export function parseClaimToken(value: unknown, field = 'claim_token'): ProtocolResult<string> {
  return typeof value === 'string' && CLAIM_TOKEN.test(value) ? accepted(value) : refused('bad_shape', `${field} must be "636c6d5f" and 56 lower-case hex characters`);
}

const isObject = (value: JsonValue | undefined): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const member = (record: JsonObject, name: string): JsonValue | undefined => (Object.hasOwn(record, name) ? record[name] : undefined);

/** The size of `text` in the record of a juror: escaped as a JSON string in the input, and the input escaped again as a JSON string in the record. */
export function jurorRecordSize(text: string): number {
  const escaped = (value: string): string => JSON.stringify(value).slice(1, -1);
  return Buffer.byteLength(escaped(escaped(text)), 'utf8');
}

/** The rows as one text: a line feed ends each row. */
const lines = (rows: readonly string[]): string => `${rows.join('\n')}\n`;

function finish(type: JurorDocument['type'], text: string): ProtocolResult<JurorDocument, 'document_too_large'> {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_JUROR_DOCUMENT_BYTES) {
    return refused('document_too_large', `the document has ${bytes.length} bytes, and a document for a juror has at most ${MAX_JUROR_DOCUMENT_BYTES} bytes`);
  }
  const record = jurorRecordSize(text);
  if (record > JUROR_RECORD_LIMIT_BYTES) {
    return refused('document_too_large', `the document takes ${record} bytes in the record of a juror, and the most is ${JUROR_RECORD_LIMIT_BYTES} bytes`);
  }
  return accepted({ type, media_type: JUROR_MEDIA_TYPE, text, bytes, hash: documentHash(bytes) });
}

// --- The claim document -----------------------------------------------------------------------------------------------------------------------------------------------

/** The claim document of an agent: who it is, its three statements, and the hash of its manifest. */
export function claimDocument(input: ClaimDocumentInput): ProtocolResult<JurorDocument, 'bad_shape' | 'document_too_large'> {
  const copy = parseJsonValue(input, 'claim document');
  if (!copy.ok) return copy;
  if (!isObject(copy.value)) return refused('bad_shape', 'claim document must be a JSON object');
  const root = copy.value;
  const members = checkMembers(root, 'claim document', ['agent_did', 'capability_id', 'manifest_sha256', 'claim']);
  if (members !== null) return members;
  const agent = parseDid(root.agent_did, 'claim document.agent_did');
  if (!agent.ok) return agent;
  if (typeof root.capability_id !== 'string' || !CAPABILITY.test(root.capability_id)) {
    return refused('bad_shape', 'claim document.capability_id must be 1 to 64 characters: letters, digits, dot, underscore and hyphen');
  }
  const manifest = parseDigest(root.manifest_sha256, 'claim document.manifest_sha256');
  if (!manifest.ok) return manifest;
  const claim = root.claim;
  if (!isObject(claim)) return refused('bad_shape', 'claim document.claim must be a JSON object');
  const claimMembers = checkMembers(claim, 'claim document.claim', ['statements']);
  if (claimMembers !== null) return claimMembers;
  const statements = claim.statements;
  if (!Array.isArray(statements) || statements.length !== 3) return refused('bad_shape', 'claim document.claim.statements must be a list of 3 statements');
  const rows: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const field = `claim document.claim.statements[${index}]`;
    const statement = statements[index];
    if (!isObject(statement)) return refused('bad_shape', `${field} must be a JSON object`);
    const statementMembers = checkMembers(statement, field, ['id', 'text']);
    if (statementMembers !== null) return statementMembers;
    if (statement.id !== `S${index + 1}`) return refused('bad_shape', `${field}.id must be "S${index + 1}"`);
    if (typeof statement.text !== 'string') return refused('bad_shape', `${field}.text must be a text`);
    // A statement longer than the whole document cannot fit. The check comes before the pattern, so a huge text is not scanned.
    if (statement.text.length > MAX_JUROR_DOCUMENT_BYTES) return refused('document_too_large', `${field}.text is longer than a document for a juror can be`);
    if (!PLAIN_TEXT.test(statement.text)) return refused('bad_shape', `${field}.text must be plain text: no control character, no line break, no space at either end`);
    rows.push(`${statement.id}: ${statement.text}`);
  }
  return finish('claim', lines([
    'Claim of an agent on the Vector marketplace.',
    `The agent is ${agent.value}. Its capability is ${root.capability_id}.`,
    'The agent makes the statements below about the work that it does, and it stakes AP3X on them.',
    ...rows,
    'A challenger can show that a statement is false with evidence that names the statement.',
    `The manifest of the agent has the SHA-256 ${manifest.value}.`,
  ]));
}

// --- The evidence documents -------------------------------------------------------------------------------------------------------------------------------------------

/** The text of a value, written as JSON with printable ASCII only. A long value is cut, and the note says so. */
function show(value: JsonValue | undefined): string {
  if (value === undefined) return '(not named)';
  const written = canonicalJson(value);
  const ascii = (written.ok ? written.value : '(unreadable)').replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (ascii.length <= MAX_SHOWN_CHARS) return ascii;
  return `${ascii.slice(0, MAX_SHOWN_CHARS).replace(/\\(?:u[0-9a-f]{0,3})?$/, '')} [cut: the text of the value has ${ascii.length} characters]`;
}

/** True when two values are the same JSON value. A value that is not named is the same as another value that is not named, and as nothing else. */
function same(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a.ok && b.ok && a.value === b.value;
}

const ORDER_FIELDS = [['sku', 'SKU'], ['lot', 'lot'], ['quantity', 'quantity']] as const;

/** The SKU, the lot and the quantity of an order record, as one phrase: "the SKU a, the lot b and the quantity c". */
function namesIn(record: JsonObject): string {
  const items = ORDER_FIELDS.map(([name, label]) => `the ${label} ${show(member(record, name))}`);
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function parseParties(root: JsonObject): ProtocolResult<EvidenceParties> {
  const claim = parseOutputRef(root.claim, 'evidence.claim');
  if (!claim.ok) return claim;
  const token = parseClaimToken(root.claim_token, 'evidence.claim_token');
  if (!token.ok) return token;
  const against = parseDid(root.against_did, 'evidence.against_did');
  if (!against.ok) return against;
  const by = parseDid(root.by_did, 'evidence.by_did');
  if (!by.ok) return by;
  if (against.value === by.value) return refused('bad_shape', 'evidence.against_did and evidence.by_did must be two different agents');
  const escrow = parseOutputRef(root.escrow_ref, 'evidence.escrow_ref');
  if (!escrow.ok) return escrow;
  return accepted({ claim: claim.value, claim_token: token.value, against_did: against.value, by_did: by.value, escrow_ref: escrow.value });
}

const references = (parties: EvidenceParties, rows: readonly string[]): string[] => [
  'References',
  `Claim: ${parties.claim}`,
  `Claim token: ${parties.claim_token}`,
  `Claimer: ${parties.against_did}`,
  `Challenger: ${parties.by_did}`,
  `Escrow of the job: ${parties.escrow_ref}`,
  ...rows,
];

function orderEvidence(parties: EvidenceParties, root: JsonObject): ProtocolResult<string, 'bad_shape' | 'no_contradiction'> {
  const members = checkMembers(root, 'evidence', ['claim', 'claim_token', 'against_did', 'by_did', 'escrow_ref', 'kind', 'purchase_order', 'confirmation', 'confirmation_sha256']);
  if (members !== null) return members;
  const order = root.purchase_order;
  const confirmation = root.confirmation;
  if (!isObject(order)) return refused('bad_shape', 'evidence.purchase_order must be a JSON object');
  if (!isObject(confirmation)) return refused('bad_shape', 'evidence.confirmation must be a JSON object');
  for (const [name] of ORDER_FIELDS) {
    if (member(order, name) === undefined) return refused('bad_shape', `evidence.purchase_order has no member "${name}"`);
  }
  const confirmationSha = parseDigest(root.confirmation_sha256, 'evidence.confirmation_sha256');
  if (!confirmationSha.ok) return confirmationSha;
  const orderSha = canonicalSha256(order, 'evidence.purchase_order');
  if (!orderSha.ok) return orderSha;
  const differing = ORDER_FIELDS.filter(([name]) => !same(member(order, name), member(confirmation, name)));
  if (differing.length === 0) return refused('no_contradiction', 'the confirmation has the same SKU, lot and quantity as the purchase order');
  return accepted(lines([
    'Evidence about statement S1 of a claim on the Vector marketplace.',
    'The claimer is an order desk. The challenger is the agent that sent the order desk a purchase order.',
    `The purchase order names ${namesIn(order)}.`,
    `The confirmation that the order desk signed for this purchase order names ${namesIn(confirmation)}.`,
    ORDER_FIELDS.map(([name, label]) => (differing.some(([other]) => other === name) ? `The ${label} differs.` : `The ${label} is the same in both.`)).join(' '),
    'So the confirmation does not name the same SKU, lot and quantity as the purchase order that it answers.',
    'The challenger did not accept the confirmation.',
    ...references(parties, [`SHA-256 of the purchase order: ${orderSha.value}`, `SHA-256 of the confirmation: ${confirmationSha.value}`]),
  ]));
}

function quoteEvidence(parties: EvidenceParties, root: JsonObject): ProtocolResult<string, 'bad_shape' | 'no_contradiction'> {
  const members = checkMembers(root, 'evidence', [
    'claim', 'claim_token', 'against_did', 'by_did', 'escrow_ref', 'kind', 'sku', 'quantity', 'quoted_unit_price', 'listed_unit_price', 'price_list_sha256', 'quote_sha256',
  ]);
  if (members !== null) return members;
  const priceList = parseDigest(root.price_list_sha256, 'evidence.price_list_sha256');
  if (!priceList.ok) return priceList;
  const quote = parseDigest(root.quote_sha256, 'evidence.quote_sha256');
  if (!quote.ok) return quote;
  if (same(root.quoted_unit_price, root.listed_unit_price)) return refused('no_contradiction', 'the quoted unit price is the unit price of the published price list');
  return accepted(lines([
    'Evidence about statement S1 of a claim on the Vector marketplace.',
    'The claimer is a bid desk. The challenger is the agent that asked the bid desk for a quote.',
    `The bid desk quoted the unit price ${show(root.quoted_unit_price)} for the SKU ${show(root.sku)} at the quantity ${show(root.quantity)}.`,
    `The published price list of the bid desk gives the unit price ${show(root.listed_unit_price)} for the SKU ${show(root.sku)} at the quantity ${show(root.quantity)}.`,
    'The quoted unit price is not the unit price of the published price list.',
    'The challenger did not accept the quote.',
    ...references(parties, [`SHA-256 of the published price list: ${priceList.value}`, `SHA-256 of the quote: ${quote.value}`]),
  ]));
}

const DIGEST_ROLES = {
  'inventory-reorder': { claimer: 'a reorder agent', challenger: 'the order desk', sent: 'purchase order', receiver: 'The challenger is the order desk that received a purchase order from the claimer.' },
  'prior-authorization': {
    claimer: 'a prior authorization agent', challenger: 'the insurer intake agent', sent: 'request',
    receiver: 'The challenger is the insurer intake agent that received a request from the claimer.',
  },
} as const;

function approvalEvidence(parties: EvidenceParties, root: JsonObject): ProtocolResult<string, 'bad_shape' | 'no_contradiction'> {
  const members = checkMembers(root, 'evidence', ['claim', 'claim_token', 'against_did', 'by_did', 'escrow_ref', 'kind', 'use_case', 'approval', 'mismatch']);
  if (members !== null) return members;
  const useCase = root.use_case;
  if (useCase !== 'inventory-reorder' && useCase !== 'prior-authorization') return refused('bad_shape', 'evidence.use_case must be "inventory-reorder" or "prior-authorization"');
  const approval = parseApprovalRef(root.approval, 'evidence.approval');
  if (!approval.ok) return approval;
  const mismatch = root.mismatch;
  if (!isObject(mismatch)) return refused('bad_shape', 'evidence.mismatch must be a JSON object');
  const mismatchMembers = checkMembers(mismatch, 'evidence.mismatch', ['ok', 'code', 'detail', 'expected_digest', 'observed_digest']);
  if (mismatchMembers !== null) return mismatchMembers;
  if (mismatch.ok !== false || mismatch.code !== 'approval_digest_mismatch') return refused('bad_shape', 'evidence.mismatch must be the result of an approval check that refused for "approval_digest_mismatch"');
  const expected = parseDigest(mismatch.expected_digest, 'evidence.mismatch.expected_digest');
  if (!expected.ok) return expected;
  const observed = parseDigest(mismatch.observed_digest, 'evidence.mismatch.observed_digest');
  if (!observed.ok) return observed;
  if (expected.value === observed.value) return refused('no_contradiction', 'the digest of the approval is the digest of the request that was sent');
  const role = DIGEST_ROLES[useCase];
  return accepted(lines([
    'Evidence about statement S1 of a claim on the Vector marketplace.',
    `The claimer is ${role.claimer}. ${role.receiver}`,
    `The hirer of the claimer approved a document. The approval holds the digest ${expected.value}.`,
    `The ${role.sent} that the claimer sent holds the digest ${observed.value}.`,
    `The two digests differ. So the ${role.sent} that the claimer sent is not the document that its hirer approved.`,
    `The digest of a ${role.sent} is the SHA-256 of its salt followed by its canonical text. This evidence has no text of the ${role.sent} and no salt.`,
    `The challenger refused the ${role.sent} before it did any work.`,
    ...references(parties, [`Approval attestation: ${approval.value.attestation}`, `Approval issuer: ${approval.value.issuer_did}`]),
  ]));
}

/**
 * The evidence document of a challenge. It refuses an input that is not in its form (`bad_shape`: the detail names the member and never repeats the value), facts that show no contradiction
 * (`no_contradiction`: nothing is worth a challenge), and a document over the limit (`document_too_large`). It never cuts a document.
 */
export function evidenceDocument(input: EvidenceDocumentInput): ProtocolResult<JurorDocument, DocumentCode> {
  const copy = parseJsonValue(input, 'evidence');
  if (!copy.ok) return copy;
  const root = copy.value;
  if (!isObject(root)) return refused('bad_shape', 'evidence must be a JSON object');
  const parties = parseParties(root);
  if (!parties.ok) return parties;
  const text =
    root.kind === 'order_confirmation' ? orderEvidence(parties.value, root)
      : root.kind === 'quote_price' ? quoteEvidence(parties.value, root)
        : root.kind === 'approval_digest' ? approvalEvidence(parties.value, root)
          : refused('bad_shape', 'evidence.kind must be "order_confirmation", "quote_price" or "approval_digest"');
  return text.ok ? finish('evidence', text.value) : text;
}
