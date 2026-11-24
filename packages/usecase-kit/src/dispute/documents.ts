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
// The text of a value never holds U+0000 or the six characters `\u0000`. The publish builder of the buyer code refuses a document that holds either, and a counterparty that put one in its own value
// would block each challenge against itself. U+0000 is shown as `<U+0000>`. A backslash that stands before the text `u0000` is shown as `\u005c`. The text `<U+0000>` of a value is shown with its first
// character as `\u003c`. So a reader can tell the character from the text, and two different values never give the same text.
//
// A document is plain text. Its bytes are the same for the same input: it has no time and no random part. The evidence of an approval has the two digests and the references, and no text of the request. The
// evidence of an intake record has the request number, the two hashes and the references, and no other text of the request.
//
// An evidence document is about one statement of the claim. The kind of the evidence decides which one (`EVIDENCE_STATEMENTS`), so the header and the statement row of the document name that id, and the code
// that chooses the claim to challenge reads the same table. A caller never names the id.
//
// A claim document is read back with `readClaimDocument`, the inverse of `claimDocument`: it reads the fields, writes the document again, and accepts the bytes only when the new document is the same bytes.
// An evidence document that the challenge code wrote is read back for its references only (`evidenceReferences`): the facts of an evidence document are not in it whole.
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
/** The id of a statement of a claim: a claim document has three statements, S1 to S3. */
export type StatementId = 'S1' | 'S2' | 'S3';
const STATEMENT_IDS: readonly StatementId[] = ['S1', 'S2', 'S3'];

/**
 * The statement of a claim that each kind of evidence is about: the statement that the facts of the kind contradict. A kind is about exactly one statement. The header of an evidence document, its statement
 * row and the choice of the claim that a challenge names all read the id from this table, and the table is frozen. No caller names an id.
 */
export const EVIDENCE_STATEMENTS = Object.freeze({
  order_confirmation: 'S1', quote_price: 'S1', approval_digest: 'S1', intake_record: 'S2',
} as const satisfies Record<EvidenceFacts['kind'], StatementId>);

/** A kind of evidence: the `kind` member of its facts. */
export type EvidenceKind = EvidenceFacts['kind'];

/** The first row of an evidence document about the statement `id`. */
const headerOf = (id: StatementId): string => `Evidence about statement ${id} of a claim on the Vector marketplace.`;

const MAX_SHOWN_CHARS = 80;
/** A statement of a claim is shown longer than another value: it is the sentence that the evidence is about. It is still cut at this size, with a note, so the references stay in the document. */
const MAX_STATEMENT_SHOWN_CHARS = 300;

export type DocumentCode = 'bad_shape' | 'document_too_large' | 'no_contradiction' | 'confirmation_not_for_order' | 'record_not_for_request';

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
export interface EvidenceReferences {
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

/** What every evidence document needs: its references, and the text of the statement that its kind is about, which the challenge reads from the claim document on the chain. */
export interface EvidenceParties extends EvidenceReferences {
  /** The text of the statement of the claim document of the claim that the kind of the evidence is about (`EVIDENCE_STATEMENTS`). The evidence shows it, cut when it is long. */
  readonly statement_text: string;
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

/**
 * Use case 2 (prior authorization), a buyer-side agent: the intake record that the insurer intake agent returned does not name the hash of the request that this agent sent. It is the evidence about the statement S2
 * of the claim of the insurer intake agent ("An intake record names the hash of the request this agent received"), and the only kind that is about S2. The document computes the hash of the request itself. It holds the
 * request number, the two hashes and the references, and no other text of the request.
 */
export interface IntakeRecordFacts {
  readonly kind: 'intake_record';
  /** The request that the agent sent: the document of its hand-off. Its canonical SHA-256 is computed here, and only its `request_number` goes into the evidence document. */
  readonly request: Document;
  /** The intake record that the insurer intake agent returned. Only its `request_number` and its `request_sha256` are read. */
  readonly intake_record: JsonObject;
  /** The hash that the signed receipt commits to for the intake record (the `response_hash`). */
  readonly intake_record_sha256: Digest;
}

export type EvidenceFacts = OrderConfirmationFacts | QuotePriceFacts | ApprovalDigestFacts | IntakeRecordFacts;
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

/** A capability identifier: 1 to 64 characters, letters, digits, dot, underscore and hyphen, and it starts with a letter or a digit. */
export function parseCapabilityId(value: unknown, field = 'capability_id'): ProtocolResult<string> {
  return typeof value === 'string' && CAPABILITY.test(value) ? accepted(value) : refused('bad_shape', `${field} must be 1 to 64 characters: letters, digits, dot, underscore and hyphen`);
}

/** A statement id: `S1`, `S2` or `S3`. The detail names the field and never repeats the value. */
export function parseStatementId(value: unknown, field = 'statement_id'): ProtocolResult<StatementId> {
  const id = STATEMENT_IDS.find((candidate) => candidate === value);
  return id === undefined ? refused('bad_shape', `${field} must be "S1", "S2" or "S3"`) : accepted(id);
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

/** The text of one statement of a claim: plain text that fits a document. The detail names the field and never repeats the value. The challenge code checks the statement that a job hired with it too. */
export function parseStatementText(value: unknown, field: string): ProtocolResult<string, 'bad_shape' | 'document_too_large'> {
  if (typeof value !== 'string') return refused('bad_shape', `${field} must be a text`);
  // A statement longer than the whole document cannot fit. The check comes before the pattern, so a huge text is not scanned.
  if (value.length > MAX_JUROR_DOCUMENT_BYTES) return refused('document_too_large', `${field} is longer than a document for a juror can be`);
  if (!PLAIN_TEXT.test(value)) return refused('bad_shape', `${field} must be plain text: no control character, no line break, no space at either end`);
  // The builder of a document transaction refuses U+0000 and its JSON escape, because a chain indexer gives no JSON for the metadata of such a text. U+0000 is a control character, and the pattern refused it
  // already. The escape is refused here too, so each claim of this kit has metadata with a JSON form, and a claim whose document has none is not a claim of this kit.
  if (value.includes('\\u0000')) return refused('bad_shape', `${field} must not hold the six characters of the escape of U+0000: a chain indexer gives no JSON for them`);
  return accepted(value);
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
  const capability = parseCapabilityId(root.capability_id, 'claim document.capability_id');
  if (!capability.ok) return capability;
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
    const text = parseStatementText(statement.text, `${field}.text`);
    if (!text.ok) return text;
    rows.push(`${statement.id}: ${text.value}`);
  }
  return finish('claim', lines([
    'Claim of an agent on the Vector marketplace.',
    `The agent is ${agent.value}. Its capability is ${capability.value}.`,
    'The agent makes the statements below about the work that it does, and it stakes a deposit on them.',
    ...rows,
    'A challenger can show that a statement is false with evidence that names the statement.',
    `The manifest of the agent has the SHA-256 ${manifest.value}.`,
  ]));
}

const CLAIM_DOCUMENT_ROWS = 8;
const AGENT_ROW = /^The agent is (did:vector:[0-9a-f]{64})\. Its capability is (.*)\.$/;
const MANIFEST_ROW = /^The manifest of the agent has the SHA-256 ([0-9a-f]{64})\.$/;

/** The text of the bytes of a document of this folder, or null when the bytes are not UTF-8 text or are not 1 to MAX_JUROR_DOCUMENT_BYTES long. */
function textOfDocument(bytes: unknown): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_JUROR_DOCUMENT_BYTES) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The input of a claim document, read from its bytes: the inverse of `claimDocument`. It reads the fields, writes the document again with `claimDocument`, and accepts the bytes only when the new
 * document is the same bytes. So a document that this folder did not write is refused: a changed sentence, a space or a line more or less, and a statement or a capability that `claimDocument` would
 * refuse. The detail never repeats the bytes.
 */
export function readClaimDocument(bytes: Uint8Array): ProtocolResult<ClaimDocumentInput, 'bad_shape'> {
  const bad = (why: string): ProtocolResult<ClaimDocumentInput, 'bad_shape'> => refused('bad_shape', `the bytes are not a claim document that this kit writes: ${why}`);
  const text = textOfDocument(bytes);
  if (text === null) return bad(`they are not UTF-8 text of 1 to ${MAX_JUROR_DOCUMENT_BYTES} bytes`);
  const rows = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
  if (rows.length !== CLAIM_DOCUMENT_ROWS) return bad(`they do not have the ${CLAIM_DOCUMENT_ROWS} rows of a claim document`);
  const agent = AGENT_ROW.exec(rows[1]!);
  if (agent === null) return bad('the row of the agent');
  const manifest = MANIFEST_ROW.exec(rows[7]!);
  if (manifest === null) return bad('the row of the manifest');
  const statements = [0, 1, 2].map((index) => {
    const prefix = `S${index + 1}: `;
    const row = rows[3 + index]!;
    return row.startsWith(prefix) ? row.slice(prefix.length) : null;
  });
  const [first, second, third] = statements;
  if (first === null || second === null || third === null) return bad('a row of a statement');
  const input: ClaimDocumentInput = {
    agent_did: agent[1]!, capability_id: agent[2]!, manifest_sha256: manifest[1]!,
    claim: { statements: [{ id: 'S1', text: first }, { id: 'S2', text: second }, { id: 'S3', text: third }] },
  };
  const again = claimDocument(input);
  if (!again.ok || !again.value.bytes.equals(bytes)) return bad('they are not the bytes that this kit writes for these fields');
  return accepted(input);
}

// --- The evidence documents -------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A piece of the JSON text of a value that `printable` writes again: an escape (a backslash and one character, or `\u` and four hex digits), the text `<U+0000>`, or one character that is not printable
 * ASCII.
 */
const PIECE = /\\(?:u[0-9a-f]{4}|[^])|<U\+0000>|[^\x20-\x7e]/g;

/**
 * The JSON text of a value, written with printable ASCII only, and with no U+0000 and no `\u0000` in it. Each character that is not printable ASCII is written as `\u` and four hex digits. U+0000 is
 * written as `<U+0000>`. A backslash that stands before the text `u0000` (the text of the value, which JSON writes as two backslashes and `u0000`) is written as `\u005c`. The text `<U+0000>` of a value
 * is written with its first character as `\u003c`. The text reads back as JSON when `<U+0000>` is put back as `\u0000`, so two different values never give the same text. Any other text is as JSON writes it.
 */
function printable(json: string): string {
  return json.replace(PIECE, (piece, offset: number) => {
    if (piece === '\\u0000') return '<U+0000>';
    if (piece === '\\\\') return json.startsWith('u0000', offset + 2) ? '\\u005c' : piece;
    if (piece === '<U+0000>') return '\\u003cU+0000>';
    return piece.length === 1 ? `\\u${piece.charCodeAt(0).toString(16).padStart(4, '0')}` : piece;
  });
}

/** One unit of the text that `printable` writes: an escape, the text `<U+0000>`, or one character. */
const UNIT = /\\(?:u[0-9a-f]{4}|[^])|<U\+0000>|[^]/g;

/** The longest start of `text` that has at most `limit` characters and ends between two units, so that no escape and no `<U+0000>` is shown in part. */
function cutAt(text: string, limit: number): string {
  let end = 0;
  for (const [unit] of text.matchAll(UNIT)) {
    if (end + unit.length > limit) break;
    end += unit.length;
  }
  return text.slice(0, end);
}

/** The text of a value, written by `printable`. A long value is cut at `limit` characters, between two units, and the note says so. */
function show(value: JsonValue | undefined, limit = MAX_SHOWN_CHARS): string {
  if (value === undefined) return '(not named)';
  const written = canonicalJson(value);
  const text = printable(written.ok ? written.value : '(unreadable)');
  if (text.length <= limit) return text;
  return `${cutAt(text, limit)} [cut: the text of the value has ${text.length} characters]`;
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

function parseParties(root: JsonObject): ProtocolResult<EvidenceParties, DocumentCode> {
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
  const statement = parseStatementText(root.statement_text, 'evidence.statement_text');
  if (!statement.ok) return statement;
  return accepted({ claim: claim.value, claim_token: token.value, against_did: against.value, by_did: by.value, escrow_ref: escrow.value, statement_text: statement.value });
}

/** The sentence that the evidence is about, as the rules of a statement of a claim document have it. */
const statementRow = (id: StatementId, parties: EvidenceParties): string => `Statement ${id} of the claim reads: ${show(parties.statement_text, MAX_STATEMENT_SHOWN_CHARS)}`;

const references = (parties: EvidenceParties, rows: readonly string[]): string[] => [
  'References',
  `Claim: ${parties.claim}`,
  `Claim token: ${parties.claim_token}`,
  `Claimer: ${parties.against_did}`,
  `Challenger: ${parties.by_did}`,
  `Escrow of the job: ${parties.escrow_ref}`,
  ...rows,
];

function orderEvidence(parties: EvidenceParties, root: JsonObject): ProtocolResult<readonly string[], 'bad_shape' | 'no_contradiction' | 'confirmation_not_for_order'> {
  const members = checkMembers(root, 'evidence', ['claim', 'claim_token', 'against_did', 'by_did', 'escrow_ref', 'statement_text', 'kind', 'purchase_order', 'confirmation', 'confirmation_sha256']);
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
  // The text below says that the order desk signed the confirmation for this purchase order. It says so only when the confirmation names this purchase order by its hash.
  const answered = member(confirmation, 'po_sha256');
  if (answered === undefined) return refused('confirmation_not_for_order', 'the confirmation has no po_sha256, so it is not tied to this purchase order');
  if (answered !== orderSha.value) return refused('confirmation_not_for_order', 'the po_sha256 of the confirmation is not the canonical SHA-256 of this purchase order');
  return accepted([
    'The claimer is an order desk. The challenger is the agent that sent the order desk a purchase order.',
    `The purchase order names ${namesIn(order)}.`,
    `The confirmation that the order desk signed for this purchase order names ${namesIn(confirmation)}.`,
    ORDER_FIELDS.map(([name, label]) => (differing.some(([other]) => other === name) ? `The ${label} differs.` : `The ${label} is the same in both.`)).join(' '),
    'So the confirmation does not name the same SKU, lot and quantity as the purchase order that it answers.',
    'The challenger did not accept the confirmation.',
    ...references(parties, [`SHA-256 of the purchase order: ${orderSha.value}`, `SHA-256 of the confirmation: ${confirmationSha.value}`]),
  ]);
}

function quoteEvidence(parties: EvidenceParties, root: JsonObject): ProtocolResult<readonly string[], 'bad_shape' | 'no_contradiction'> {
  const members = checkMembers(root, 'evidence', [
    'claim', 'claim_token', 'against_did', 'by_did', 'escrow_ref', 'statement_text', 'kind', 'sku', 'quantity', 'quoted_unit_price', 'listed_unit_price', 'price_list_sha256', 'quote_sha256',
  ]);
  if (members !== null) return members;
  const priceList = parseDigest(root.price_list_sha256, 'evidence.price_list_sha256');
  if (!priceList.ok) return priceList;
  const quote = parseDigest(root.quote_sha256, 'evidence.quote_sha256');
  if (!quote.ok) return quote;
  if (same(root.quoted_unit_price, root.listed_unit_price)) return refused('no_contradiction', 'the quoted unit price is the unit price of the published price list');
  return accepted([
    'The claimer is a bid desk. The challenger is the agent that asked the bid desk for a quote.',
    `The bid desk quoted the unit price ${show(root.quoted_unit_price)} for the SKU ${show(root.sku)} at the quantity ${show(root.quantity)}.`,
    `The published price list of the bid desk gives the unit price ${show(root.listed_unit_price)} for the SKU ${show(root.sku)} at the quantity ${show(root.quantity)}.`,
    'The quoted unit price is not the unit price of the published price list.',
    'The challenger did not accept the quote.',
    ...references(parties, [`SHA-256 of the published price list: ${priceList.value}`, `SHA-256 of the quote: ${quote.value}`]),
  ]);
}

const DIGEST_ROLES = {
  'inventory-reorder': { claimer: 'a reorder agent', challenger: 'the order desk', sent: 'purchase order', receiver: 'The challenger is the order desk that received a purchase order from the claimer.' },
  'prior-authorization': {
    claimer: 'a prior authorization agent', challenger: 'the insurer intake agent', sent: 'request',
    receiver: 'The challenger is the insurer intake agent that received a request from the claimer.',
  },
} as const;

function approvalEvidence(parties: EvidenceParties, root: JsonObject): ProtocolResult<readonly string[], 'bad_shape' | 'no_contradiction'> {
  const members = checkMembers(root, 'evidence', ['claim', 'claim_token', 'against_did', 'by_did', 'escrow_ref', 'statement_text', 'kind', 'use_case', 'approval', 'mismatch']);
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
  return accepted([
    `The claimer is ${role.claimer}. ${role.receiver}`,
    `The hirer of the claimer approved a document. The approval holds the digest ${expected.value}.`,
    `The ${role.sent} that the claimer sent holds the digest ${observed.value}.`,
    `The two digests differ. So the ${role.sent} that the claimer sent is not the document that its hirer approved.`,
    `The digest of a ${role.sent} is the SHA-256 of its salt followed by its canonical text. This evidence has no text of the ${role.sent} and no salt.`,
    `The challenger refused the ${role.sent} before it did any work.`,
    ...references(parties, [`Approval attestation: ${approval.value.attestation}`, `Approval issuer: ${approval.value.issuer_did}`]),
  ]);
}

const INTAKE_MEMBERS = ['claim', 'claim_token', 'against_did', 'by_did', 'escrow_ref', 'statement_text', 'kind', 'request', 'intake_record', 'intake_record_sha256'];

function intakeEvidence(parties: EvidenceParties, root: JsonObject): ProtocolResult<readonly string[], 'bad_shape' | 'no_contradiction' | 'record_not_for_request'> {
  const members = checkMembers(root, 'evidence', INTAKE_MEMBERS);
  if (members !== null) return members;
  const request = root.request;
  const record = root.intake_record;
  if (!isObject(request)) return refused('bad_shape', 'evidence.request must be a JSON object');
  if (!isObject(record)) return refused('bad_shape', 'evidence.intake_record must be a JSON object');
  const requestNumber = member(request, 'request_number');
  if (typeof requestNumber !== 'string' || requestNumber.length === 0) return refused('bad_shape', 'evidence.request must have a member "request_number" that is a text');
  const recordSha = parseDigest(root.intake_record_sha256, 'evidence.intake_record_sha256');
  if (!recordSha.ok) return recordSha;
  // The hash of the request is computed here, from the request itself. No member that the caller gives stands for it.
  const sentSha = canonicalSha256(request, 'evidence.request');
  if (!sentSha.ok) return sentSha;
  const named = member(record, 'request_sha256');
  if (named === sentSha.value) return refused('no_contradiction', 'the intake record names the SHA-256 of the request that was sent');
  // The text below says that the insurer intake agent signed the record for this request. It says so only when the record names the number of this request.
  if (member(record, 'request_number') !== requestNumber) return refused('record_not_for_request', 'the request_number of the intake record is not the request_number of the request that was sent');
  const shownNumber = show(requestNumber);
  const digest = parseDigest(named, 'request_sha256');
  const signed = `The insurer intake agent signed an intake record for the request number ${shownNumber}.`;
  const recordRows = digest.ok
    ? [
      `${signed} The intake record names the SHA-256 ${digest.value} for the request that it received.`,
      'The two SHA-256 hashes differ. So the intake record does not name the hash of the request that the challenger sent.',
    ]
    : [
      `${signed} The intake record names no SHA-256 for the request that it received: its member request_sha256 is ${show(named)}.`,
      'So the intake record does not name the hash of the request that the challenger sent.',
    ];
  return accepted([
    'The claimer is an insurer intake agent. The challenger is the agent that sent the insurer intake agent a request.',
    `The request has the request number ${shownNumber}.`,
    `The SHA-256 of the request that the challenger sent is ${sentSha.value}.`,
    ...recordRows,
    'The challenger did not accept the intake record.',
    'This evidence has no text of the request.',
    ...references(parties, [`SHA-256 of the intake record: ${recordSha.value}`]),
  ]);
}

/** The rows of an evidence document after its statement row: the facts, and then the references. */
type EvidenceRows = ProtocolResult<readonly string[], DocumentCode>;

/** The rows for each kind. The compiler checks that the table has an entry for each kind of `EVIDENCE_STATEMENTS`. */
const EVIDENCE_ROWS = {
  order_confirmation: orderEvidence, quote_price: quoteEvidence, approval_digest: approvalEvidence, intake_record: intakeEvidence,
} as const satisfies Record<EvidenceKind, (parties: EvidenceParties, root: JsonObject) => EvidenceRows>;

const isEvidenceKind = (value: unknown): value is EvidenceKind => typeof value === 'string' && Object.hasOwn(EVIDENCE_STATEMENTS, value);
const KINDS_QUOTED = Object.keys(EVIDENCE_STATEMENTS).map((kind) => `"${kind}"`);
const KINDS_WORDS = `${KINDS_QUOTED.slice(0, -1).join(', ')} or ${KINDS_QUOTED[KINDS_QUOTED.length - 1]}`;

/**
 * The evidence document of a challenge. It is about the statement that its kind names in `EVIDENCE_STATEMENTS`: its header and its statement row say which one. It refuses an input that is not in its form
 * (`bad_shape`: the detail names the member and never repeats the value), facts that show no contradiction (`no_contradiction`: nothing is worth a challenge), a confirmation that is not tied to the purchase
 * order by its hash (`confirmation_not_for_order`), and a document over the limit (`document_too_large`). It never cuts a document.
 */
export function evidenceDocument(input: EvidenceDocumentInput): ProtocolResult<JurorDocument, DocumentCode> {
  const copy = parseJsonValue(input, 'evidence');
  if (!copy.ok) return copy;
  const root = copy.value;
  if (!isObject(root)) return refused('bad_shape', 'evidence must be a JSON object');
  const parties = parseParties(root);
  if (!parties.ok) return parties;
  const kind = root.kind;
  if (!isEvidenceKind(kind)) return refused('bad_shape', `evidence.kind must be ${KINDS_WORDS}`);
  const rows = EVIDENCE_ROWS[kind](parties.value, root);
  if (!rows.ok) return rows;
  const id = EVIDENCE_STATEMENTS[kind];
  return finish('evidence', lines([headerOf(id), statementRow(id, parties.value), ...rows.value]));
}

const REFERENCE_LABELS = ['Claim', 'Claim token', 'Claimer', 'Challenger', 'Escrow of the job'] as const;
/** The first row of an evidence document that this kit writes: the header for each statement that a kind is about. */
const EVIDENCE_HEADERS: readonly string[] = [...new Set(Object.values(EVIDENCE_STATEMENTS))].map(headerOf);

/**
 * The references of an evidence document that `evidenceDocument` wrote: the claim, the claim token, the two agents and the job. The first row must be the header of a statement that a kind of evidence is about,
 * and the rows come after the row `References`, in the order of `evidenceDocument`. The facts of an evidence document are not read back: they are not in it whole. The caller must know where the document comes
 * from: a document that this reads is only as true as its source.
 */
export function evidenceReferences(bytes: Uint8Array): ProtocolResult<EvidenceReferences, 'bad_shape'> {
  const bad = (why: string): ProtocolResult<EvidenceReferences, 'bad_shape'> => refused('bad_shape', `the bytes are not an evidence document that this kit writes: ${why}`);
  const text = textOfDocument(bytes);
  if (text === null) return bad(`they are not UTF-8 text of 1 to ${MAX_JUROR_DOCUMENT_BYTES} bytes`);
  const rows = text.split('\n');
  if (!EVIDENCE_HEADERS.includes(rows[0]!)) return bad('the first row');
  const start = rows.indexOf('References');
  if (start < 0 || rows.lastIndexOf('References') !== start) return bad('the row References');
  const values = REFERENCE_LABELS.map((label, index) => {
    const prefix = `${label}: `;
    const row = rows[start + 1 + index];
    return row !== undefined && row.startsWith(prefix) ? row.slice(prefix.length) : null;
  });
  const [claimText, tokenText, againstText, byText, escrowText] = values;
  if (claimText === null || tokenText === null || againstText === null || byText === null || escrowText === null) return bad('a row of the references');
  const claim = parseOutputRef(claimText, 'claim');
  const token = parseClaimToken(tokenText, 'claim token');
  const against = parseDid(againstText, 'claimer');
  const by = parseDid(byText, 'challenger');
  const escrow = parseOutputRef(escrowText, 'escrow of the job');
  if (!claim.ok || !token.ok || !against.ok || !by.ok || !escrow.ok) return bad('a value of the references');
  return accepted({ claim: claim.value, claim_token: token.value, against_did: against.value, by_did: by.value, escrow_ref: escrow.value });
}
