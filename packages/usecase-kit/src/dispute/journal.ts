// packages/usecase-kit/src/dispute/journal.ts
// The journal of the challenges: for each job (one escrow) it keeps how far the challenge of this agent went. The challenge code writes it BEFORE it sends the evidence, and after each step that
// landed, and it reads it FIRST: a job that has a record gets that state, and nothing of it is sent a second time. So a restart of the process, or a second call for the same job, does not publish
// a second evidence document and does not file a second challenge.
//
// The journal is a port, because a process that keeps its records in memory forgets them when it stops. `MemoryJournal` is the default: it holds the records of the life of the process, and it is
// what a test uses. A service that must not file a job twice after a restart gives a journal that keeps the records on disk, and that returns from `put` only when the record is stored.
//
// A record is JSON data: the amounts are decimal texts, and nothing in it is a key or a part of a request. The code checks each record that a journal gives, because a record that is read from a
// disk can be damaged: a record that is not in its form is `journal_unavailable`, and never "no record". A record names the escrow that it is for. A journal that gives the record of another escrow
// has made a mistake, and the code does not take that record for the record of this job: that is `journal_unavailable` too, and nothing is sent.
import { accepted, checkMembers, parseDid, parseJsonValue, parseOutputRef, refused } from '../protocol/index.ts';
import type { ChallengeRecord, Did, JsonObject, JsonValue, OutputRef, ProtocolResult } from '../protocol/index.ts';
import { parseClaimToken } from './documents.ts';
import type { ChallengeLanded, DocumentLanded, SentNotConfirmed } from './results.ts';

/**
 * How far a job went. `started`: the evidence is about to be sent, and it may be on chain. `evidence_landed`: the evidence is on chain. `done`: the job ended, and the record says how.
 * `not_sent`: the job stopped and sent nothing, so the next call may try again.
 */
export type JobStep = 'started' | 'evidence_landed' | 'done' | 'not_sent';

/** A challenge that was filed, as JSON data. The amounts are decimal texts. */
export interface FiledRecord {
  readonly record: ChallengeRecord;
  readonly claim_token: string;
  readonly against_did: Did;
  readonly evidence_uri: string;
  readonly evidence_hash: string;
  readonly challenge_tx: string;
  readonly challenge_token: string;
  readonly stake_lovelace: string;
  readonly deadline: number;
  readonly fee_lovelace: string | null;
}

/** A job that ended with no challenge filed: the code of the step that failed, and each transaction that landed or may land. */
export interface EndedRecord {
  readonly code: string;
  readonly detail: string;
  readonly sent: SentNotConfirmed | null;
  readonly challenge: ChallengeLanded | null;
  readonly wrong_document: DocumentLanded | null;
}

/** What the journal keeps for a job. */
export interface JobRecord {
  readonly step: JobStep;
  /** The job that the record is for: the escrow that the journal stores it under. A record for another escrow is never the record of this job. */
  readonly escrow: OutputRef;
  /** The other party of the job: the claimer that the challenge is against. */
  readonly against: Did;
  /** The claim output that the evidence names, and its token. */
  readonly claim: OutputRef;
  readonly claim_token: string;
  /** The evidence document, from the step `evidence_landed` on, when it landed. */
  readonly evidence: DocumentLanded | null;
  /** How a job of the step `done` ended: with a filed challenge, or with none. Exactly one of the two is set for `done`, and none for any other step. */
  readonly filed: FiledRecord | null;
  readonly ended: EndedRecord | null;
}

export interface DisputeJournal {
  /** The record of a job, or null when the journal has none. It throws when the journal cannot be read. */
  get(escrow: OutputRef): Promise<JobRecord | null>;
  /** Stores the record of a job, and returns when it is stored for good. It throws when it is not stored. */
  put(escrow: OutputRef, record: JobRecord): Promise<void>;
}

/** A journal in memory: it holds the records for the life of the process. It keeps each record as JSON text, so a record cannot change after it is stored, and a record that is not JSON data is refused. */
export class MemoryJournal implements DisputeJournal {
  readonly #records = new Map<OutputRef, string>();

  async get(escrow: OutputRef): Promise<JobRecord | null> {
    const text = this.#records.get(escrow);
    return text === undefined ? null : (JSON.parse(text) as JobRecord);
  }

  async put(escrow: OutputRef, record: JobRecord): Promise<void> {
    this.#records.set(escrow, JSON.stringify(record));
  }
}

// --- The check of a record that a journal gave ------------------------------------------------------------------------------------------------------------------------

const HASH = /^[0-9a-f]{64}$/;
const DIGITS = /^(?:0|[1-9][0-9]{0,29})$/;
const STEPS: readonly string[] = ['started', 'evidence_landed', 'done', 'not_sent'];
const MAX_TEXT = 400;

type Reading<T> = ProtocolResult<T>;

const isObject = (value: JsonValue | undefined): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: JsonValue | undefined): value is string => typeof value === 'string' && value.length <= MAX_TEXT;
const isInteger = (value: JsonValue | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bad = (field: string): Reading<never> => refused('bad_shape', `the journal record has a wrong ${field}`);

function documentOf(value: JsonValue | undefined, field: string): Reading<DocumentLanded> {
  if (!isObject(value) || checkMembers(value, field, ['tx_hash', 'uri', 'document_hash']) !== null) return bad(field);
  const { tx_hash: tx, uri, document_hash: hash } = value;
  if (typeof tx !== 'string' || !HASH.test(tx) || !isText(uri) || typeof hash !== 'string' || !HASH.test(hash)) return bad(field);
  return accepted({ tx_hash: tx, uri, document_hash: hash });
}

function sentOf(value: JsonValue | undefined): Reading<SentNotConfirmed> {
  if (!isObject(value) || checkMembers(value, 'sent', ['tx_hash', 'valid_to', 'may_land']) !== null) return bad('sent');
  const { tx_hash: tx, valid_to: validTo, may_land: mayLand } = value;
  if (typeof tx !== 'string' || !HASH.test(tx) || !isInteger(validTo) || typeof mayLand !== 'boolean') return bad('sent');
  return accepted({ tx_hash: tx, valid_to: validTo, may_land: mayLand });
}

function landedOf(value: JsonValue | undefined): Reading<ChallengeLanded> {
  if (!isObject(value) || checkMembers(value, 'challenge', ['tx_hash', 'challenge', 'challenge_token', 'claim', 'claim_token']) !== null) return bad('challenge');
  const { tx_hash: tx, challenge_token: challengeToken } = value;
  const challenge = parseOutputRef(value.challenge, 'challenge');
  const claim = parseOutputRef(value.claim, 'claim');
  const token = parseClaimToken(value.claim_token);
  if (typeof tx !== 'string' || !HASH.test(tx) || typeof challengeToken !== 'string' || !HASH.test(challengeToken) || !challenge.ok || !claim.ok || !token.ok) return bad('challenge');
  return accepted({ tx_hash: tx, challenge: challenge.value, challenge_token: challengeToken, claim: claim.value, claim_token: token.value });
}

function filedOf(value: JsonValue | undefined): Reading<FiledRecord> {
  const members = ['record', 'claim_token', 'against_did', 'evidence_uri', 'evidence_hash', 'challenge_tx', 'challenge_token', 'stake_lovelace', 'deadline', 'fee_lovelace'];
  if (!isObject(value) || checkMembers(value, 'filed', members) !== null) return bad('filed');
  const record = value.record;
  if (!isObject(record) || checkMembers(record, 'record', ['claim', 'evidence', 'challenge']) !== null) return bad('filed');
  const claim = parseOutputRef(record.claim, 'claim');
  const challenge = parseOutputRef(record.challenge, 'challenge');
  const against = parseDid(value.against_did, 'against_did');
  const token = parseClaimToken(value.claim_token);
  const { evidence } = record;
  const { evidence_uri: uri, evidence_hash: hash, challenge_tx: tx, challenge_token: challengeToken, stake_lovelace: stake, deadline, fee_lovelace: fee } = value;
  if (!claim.ok || !challenge.ok || !against.ok || !token.ok) return bad('filed');
  if (typeof evidence !== 'string' || !HASH.test(evidence) || !isText(uri) || typeof hash !== 'string' || !HASH.test(hash) || typeof tx !== 'string' || !HASH.test(tx)) return bad('filed');
  if (typeof challengeToken !== 'string' || !HASH.test(challengeToken) || typeof stake !== 'string' || !DIGITS.test(stake) || !isInteger(deadline)) return bad('filed');
  if (fee !== null && !(typeof fee === 'string' && DIGITS.test(fee))) return bad('filed');
  return accepted({
    record: { claim: claim.value, evidence, challenge: challenge.value }, claim_token: token.value, against_did: against.value, evidence_uri: uri, evidence_hash: hash, challenge_tx: tx,
    challenge_token: challengeToken, stake_lovelace: stake, deadline, fee_lovelace: fee,
  });
}

function endedOf(value: JsonValue | undefined): Reading<EndedRecord> {
  if (!isObject(value) || checkMembers(value, 'ended', ['code', 'detail', 'sent', 'challenge', 'wrong_document']) !== null) return bad('ended');
  if (!isText(value.code) || !isText(value.detail)) return bad('ended');
  const sent = value.sent === null ? accepted(null) : sentOf(value.sent);
  const challenge = value.challenge === null ? accepted(null) : landedOf(value.challenge);
  const wrong = value.wrong_document === null ? accepted(null) : documentOf(value.wrong_document, 'wrong_document');
  if (!sent.ok || !challenge.ok || !wrong.ok) return bad('ended');
  return accepted({ code: value.code, detail: value.detail, sent: sent.value, challenge: challenge.value, wrong_document: wrong.value });
}

/**
 * The record that a journal gave, in its form, or a refusal. It reads the value one time as JSON data. A step that is not one of the four, a member that is missing or that the record does not have, a
 * value of a wrong form, and a `done` record that says neither or both of `filed` and `ended`, are refused. The code that reads the record checks that its escrow is the escrow of the call.
 */
export function parseJobRecord(value: unknown): ProtocolResult<JobRecord | null> {
  if (value === null) return accepted(null);
  const copy = parseJsonValue(value, 'the journal record');
  if (!copy.ok) return copy;
  const root = copy.value;
  if (!isObject(root)) return bad('shape');
  const members = checkMembers(root, 'the journal record', ['step', 'escrow', 'against', 'claim', 'claim_token', 'evidence', 'filed', 'ended']);
  if (members !== null) return members;
  const step = root.step;
  if (typeof step !== 'string' || !STEPS.includes(step)) return bad('step');
  const escrow = parseOutputRef(root.escrow, 'escrow');
  const against = parseDid(root.against, 'against');
  const claim = parseOutputRef(root.claim, 'claim');
  const token = parseClaimToken(root.claim_token);
  if (!escrow.ok) return bad('escrow');
  if (!against.ok || !claim.ok || !token.ok) return bad('claim');
  const evidence = root.evidence === null ? accepted(null) : documentOf(root.evidence, 'evidence');
  const filed = root.filed === null ? accepted(null) : filedOf(root.filed);
  const ended = root.ended === null ? accepted(null) : endedOf(root.ended);
  if (!evidence.ok) return evidence;
  if (!filed.ok) return filed;
  if (!ended.ok) return ended;
  if (step === 'done' ? (filed.value === null) === (ended.value === null) : filed.value !== null || ended.value !== null) return bad('end');
  return accepted({ step: step as JobStep, escrow: escrow.value, against: against.value, claim: claim.value, claim_token: token.value, evidence: evidence.value, filed: filed.value, ended: ended.value });
}
