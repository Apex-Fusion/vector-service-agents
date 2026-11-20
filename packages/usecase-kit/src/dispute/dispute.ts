// packages/usecase-kit/src/dispute/dispute.ts
// The Module-1 path of an agent: the claim of a run, the lookup of the claim that a challenge names, the challenge, and the withdrawal. The class holds the order of the steps and the guards. The chain,
// the queue of the service key, the clock and the journal come in as ports (ports.ts, journal.ts), so a test runs it on a scripted port and on the fixture world.
//
// The order of a challenge is fixed, and each step is checked before the next one starts:
//   0. Read the journal of the job. A job that has a record gets that state, and nothing is sent a second time. A record that is for another escrow is `journal_unavailable`: it is not this job's record.
//      A record `started` that is older than its lease gives the job back (`started_lease_ms`), and only after step 1 found no challenge of this agent on chain. The job then goes on only against the claim
//      that the record names (step 2).
//   1. Read the claims. A challenge of this agent for this job that is on chain already is found again, and it is the result. The code never files a second one.
//   2. Choose the claim. The escrow of the job is read first, when the other party has an open claim. It must be the escrow of this job: its datum has the identity layout, its capability_id is the capability of the
//      job, and its agent_id is the agent that the job hired (the counterparty for a delivery, this agent for an approval). It must be the output that the Post made: its datum has the state Open, because the block of a
//      later output (the Claim or the Submit) is later than the start of the job. Another escrow, and the output of a later step, is `bad_shape`. A claim is a target only when ALL hold: its claimer is the
//      other party; its claim document is a claim document of this kit for the capability of the job (it is on chain, its hash is the hash that the claim holds, and it is the document that `claimDocument` writes
//      for that party and that capability) and its statement S1 is the text of the statement S1 of the manifest that the job hired (the same text in NFC and in NFD is one text); it was submitted before the job
//      began (the time of the block of its escrow output: the chain port reads it from the chain, and the caller gives no time); it is Open with enough window left; and its stake is not above the challenge stake. A claim
//      that is not a target is left out and counted by its reason, so the claimer cannot choose the target or block a challenge with a claim of its own. Among the targets the one with the latest challenge deadline is
//      chosen, and with the same deadline the one with the lowest claim token. None ends the job with `no_open_claim`.
//      After a lapsed record `started`, only the claim of the record can be chosen, and it must still be a target. A claim of the record that is spent, is not Open, or has no window left ends the job with
//      `claim_changed`, and one with too little window left ends it with `claim_window_closing`. Nothing is sent then.
//   3. Make the evidence document. A document that is refused ends the job. Nothing is on chain yet.
//   4. In one job of the queue: check the window that is left, read the journal again (another call can have written its record while this job waited: a record that stops the job ends it, and so does a
//      lapsed record of another claim), write the journal with the time of the job (`started_at`), publish the evidence document, and wait for its confirmation. A document that is not confirmed ends the job.
//      The challenge is not built.
//   5. In one job of the queue: read the claim again, and build the challenge against the exact output that the evidence names. A claim that changed ends the job. After a lapsed record, the job then looks again
//      for a challenge of this agent for this job on chain (step 1): the challenge of the first try can land while the second try runs. The second try then ends with `claim_changed`, with `challenge_not_built`, or
//      with `challenge_not_confirmed` when the node refuses its challenge (`may_land` is false). That challenge is the result. The evidence document of the second try is on chain, and the challenge of the first try
//      does not name it, so the result names it in `extra_evidence`.
// A job (one escrow) gets one challenge. Once a transaction of a job landed or may land, the job takes no second attempt, also after a restart: the journal says so. Only a record `started` lapses: it says
// that the evidence may be on chain, and nothing else. After its lease the job may go on, but only against the claim that its record names. A challenge of the first try can still land after the lease, and the
// chain takes only one challenge of a claim. So the second try cannot give the job a second challenge, and a second try against another claim could. When the claim of the record cannot be used any more, the job
// ends, and nothing is sent.
//
// Every read of a port has a bound, so a read that never answers does not hold the queue of the service key: it ends with `chain_unavailable`. Every transaction runs in the queue of the service key.
// The code of a caller must not call a method of this class from inside a job of the same queue: the call would wait for itself.
import { documentHash, txHashOfUri } from '@vsa/buyer-core';
import { NO_OPEN_CLAIM, accepted, checkMembers, didOfAgentId, isKeyHash, parseDid, parseJsonValue, parseOutputRef, refused } from '../protocol/index.ts';
import type { Did, Digest, JsonObject, JsonValue, KeyHash, ManifestClaim, OutputRef, ProtocolResult, Refused, SerialQueue } from '../protocol/index.ts';
import { EVIDENCE_STATEMENT, JUROR_MEDIA_TYPE, claimDocument, evidenceDocument, evidenceReferences, parseCapabilityId, parseClaimToken, parseStatementText, readClaimDocument } from './documents.ts';
import type { ApprovalDigestFacts, EvidenceDocumentInput, OrderConfirmationFacts, QuotePriceFacts } from './documents.ts';
import { MemoryJournal, parseJobRecord } from './journal.ts';
import type { DisputeJournal, FiledRecord, JobRecord } from './journal.ts';
import { MAX_CLAIM_TYPE_BYTES, challengeDeadlineOf, withdrawableFrom } from './ports.ts';
import type { ChallengeView, ClaimView, DocumentAbsent, Module1Port, OpenedChallenge, PublishedDocument, ReadDocument, TxNotBuilt, TxNotConfirmed, TxResult } from './ports.ts';
import type {
  ChallengeCode, ChallengeFiled, ChallengeNotFiled, ChallengeResult, ClaimLookupCode, ClaimWithdrawn, DocumentLanded, RunClaimNotStaked, RunClaimResult, SentNotConfirmed, WithdrawNotDone,
  WithdrawResult,
} from './results.ts';
import { describeError } from './text.ts';

const HOUR_MS = 3_600_000;

/**
 * The least resolution deadline for which a challenge can have a jury: 6 hours and 40 minutes. The relay opens the case of a challenge only when it can do so at least 6 hours before the end of the
 * deadline (the time of the commit window, the reveal window and the margin of the jury of the deployment), and it opens the case at once when the deadline is at most 6 hours and 40 minutes away. With
 * this value the relay has 40 minutes to see the challenge and to open the case. A deadline below it gives a challenge that no jury reads: the relay resolves it as inconclusive for lack of time.
 */
export const LEAST_RESOLUTION_DEADLINE_MS = 6 * HOUR_MS + 40 * 60_000;

/** What a challenge needs besides the evidence. The caller reads the values from its own settings: the code has no default. */
export interface DisputeSettings {
  /** The stake of a challenge. A claim with a higher stake is not a target: Module-1 refuses a challenge with less stake than the claim that it challenges. */
  readonly challenge_stake_lovelace: bigint;
  /**
   * The resolution deadline of the challenges, in milliseconds. The value of a challenge is the one that the Module-1 deployment names (the `protocol` of the port), and no setting can change it.
   * A caller that keeps this setting must give the value of the deployment: another value is an error of the construction, and nothing is published.
   */
  readonly resolution_deadline_ms?: number;
  /** The least time that must be left in the challenge window of a claim when the evidence is published. Use the time that the evidence needs to confirm, and some more. At least 2,000. */
  readonly min_window_left_ms: number;
  /** The most time that one read of a port may take, in milliseconds. A read that takes longer ends with `chain_unavailable`, or `journal_unavailable` for the journal. */
  readonly read_timeout_ms: number;
  /**
   * How long a record `started` blocks the job, in milliseconds, counted from the time in the record. Such a record says that the evidence of the job may be on chain, and that the code did not write the
   * end of the job. A write that lands after its bound (`journal_unavailable`) leaves one with nothing sent, and a process that stops after the write leaves one with the evidence sent. After the lease
   * the record gives the job back: a challenge of this agent that is on chain is still the result, and if there is none, the job goes on, but only against the claim that the record names. A transaction of the
   * first try can still land after the lease, and the chain takes only one challenge of a claim, so the job files at most one challenge. When that claim is spent, is not Open, or has too little window left, the
   * job ends with `claim_changed` or `claim_window_closing`, and nothing is sent. The first try can also land while the second try runs. The second try then ends with `claim_changed` (the claim is Challenged now),
   * with `challenge_not_built` (the node builds no challenge for a claim output that is spent), or with `challenge_not_confirmed` and `may_land` false (the node refuses the challenge, which spends a claim output that
   * is spent), and it looks again for a challenge of this agent for the job on chain: that challenge is the result, and the result names the evidence document of the second try (`extra_evidence`). Two processes
   * can both go on after a lease ends, and they go on against the same claim. The default is 10 minutes, or twice `read_timeout_ms` when that is more. A value below twice `read_timeout_ms` is refused: a write ends
   * at that bound and can still land later, so the lease must be longer than that.
   */
  readonly started_lease_ms?: number;
}

export interface DisputeDeps {
  readonly port: Module1Port;
  /**
   * The queue of the service key. The key has one wallet, and a Module-1 build spends every output of it but one, so a transaction must not run beside a hire or another Module-1 step: give the queue that
   * runs the hires of the key. Every transaction of this code runs as one job of the queue.
   */
  readonly queue: SerialQueue;
  /** The time in POSIX milliseconds. */
  readonly clock: () => number;
  /** Waits `ms` milliseconds. It bounds each read of a port. Its timer is not cancelled when the read ends first, so it must not hold the process open. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly settings: DisputeSettings;
  /** The journal of the jobs. The default keeps the records in memory: a restart forgets them. A service that must not file a job twice after a restart gives a journal that keeps them on disk. */
  readonly journal?: DisputeJournal;
  /** One line for each step. A line has references of the chain and codes: it has no key and no part of a request. A function that throws changes no result. */
  readonly log?: (line: string) => void;
}

/** The job that a claim of the other party must cover to be the target of a challenge. */
export interface ClaimScope {
  /**
   * The escrow of the job: the output that its Post made, unspent or spent (Koios keeps the datum of a spent output). A job gets one challenge. The chain port reads this output. It must be the escrow of this job: its datum
   * has the identity layout, its capability_id is the `capability_id` of this scope, and its agent_id is the agent that the job hired (the counterparty of a delivery, this agent for an approval). The kit cannot tell two
   * jobs of the same two agents for the same capability apart, so the caller names the escrow of its own job. The time of the block that holds the transaction that made the output is the start of the job: a claim that was
   * submitted at or after that time does not cover the job, so it is never the target. The start comes from the chain, and the caller gives none. Name the output that the Post made. An output that a later step (Claim or
   * Submit) made is in a later block, and it would give a later start, so the state of its datum is not Open, and it is `bad_shape`.
   */
  readonly escrow_ref: OutputRef;
  /** The capability that the job hired. The caller knows it from the advert of the job. The escrow of the job names it, and the target holds a claim document of this kit for it. */
  readonly capability_id: string;
  /**
   * The text of the statement S1 of the manifest that the job hired: the statement that the job broke. The caller has the manifest of the agent that it hired. The target is a claim whose claim document has
   * this text as its statement S1: the same text in the form NFC and in the form NFD is one text, and any other difference leaves the claim out (a homoglyph is another text). A claim for the same capability with
   * another S1 is left out, because the evidence would quote a statement that the job did not break.
   */
  readonly statement_text: string;
}

/** A buyer-side agent whose model did not accept a delivery. */
export interface DeliveryChallengeInput extends ClaimScope {
  /** The agent that made the delivery. Its claim that covers the job is challenged. */
  readonly counterparty: Did;
  readonly evidence: OrderConfirmationFacts | QuotePriceFacts;
}

/** A counterparty that refused a request because the digest of the approval is not the digest of the request. */
export interface ApprovalChallengeInput extends ClaimScope {
  /** The sender of the request. Its claim that covers the job is challenged. */
  readonly sender: Did;
  readonly evidence: ApprovalDigestFacts;
}

/** The claim of a run. The caller gives the amount and the window from its own settings. */
export interface RunClaimInput {
  readonly capability_id: string;
  /** The SHA-256 of the manifest of the agent. */
  readonly manifest_sha256: Digest;
  /** The three statements of the agent. */
  readonly claim: ManifestClaim;
  /** The stake of the claim, in lovelace. Module-1 has a least stake. */
  readonly stake_lovelace: bigint;
  /** The challenge window of the claim in milliseconds. Module-1 has a least and a most. */
  readonly challenge_window_ms: number;
  /** The category tag of the claim: 1 to MAX_CLAIM_TYPE_BYTES bytes of text. */
  readonly claim_type: string;
}

export interface WithdrawClaimInput {
  readonly claim: OutputRef;
}

const LEAST_WINDOW_LEFT_MS = 2_000;

/** The default lease of a record `started`: 10 minutes. */
const STARTED_LEASE_MS = 600_000;

function requireBigint(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${name} must be a bigint`);
  if (value <= 0n) throw new RangeError(`${name} must be more than 0`);
  return value;
}

function requireMilliseconds(value: unknown, name: string, least: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${name} must be a whole number of milliseconds`);
  if (value < least) throw new RangeError(`${name} must be at least ${least}`);
  return value;
}

type Landed = Partial<Pick<ChallengeNotFiled, 'evidence' | 'sent' | 'challenge' | 'wrong_document'>>;

const notFiled = (code: ChallengeCode, detail: string, landed: Landed = {}): ChallengeNotFiled => ({
  ok: false, code, detail, evidence: null, sent: null, challenge: null, wrong_document: null, ...landed,
});

const sentOf = (result: { tx_hash: string; valid_to: number; may_land: boolean }): SentNotConfirmed => ({ tx_hash: result.tx_hash, valid_to: result.valid_to, may_land: result.may_land });

const landedDocument = (published: PublishedDocument): DocumentLanded => ({ tx_hash: published.tx_hash, uri: published.uri, document_hash: published.document_hash });

/** A transaction step that did not confirm: the port did not build it, it was sent and not seen confirmed, or the port itself failed. */
type StepFailure = TxNotBuilt | TxNotConfirmed | Refused<'port_error'>;

/** The code of the step that failed, its detail, and the transaction that was sent and not seen confirmed. `built` and `confirmed` are the codes of this step for the first two failures. */
function failed<B extends string, C extends string>(failure: StepFailure, built: B, confirmed: C): { readonly code: B | C | 'port_error'; readonly detail: string; readonly sent: SentNotConfirmed | null } {
  if (failure.code === 'not_built') return { code: built, detail: failure.detail, sent: null };
  if (failure.code === 'not_confirmed') return { code: confirmed, detail: failure.detail, sent: sentOf(failure) };
  return { code: 'port_error', detail: failure.detail, sent: null };
}

/** What a claim output that is no longer in the list says: it is spent, or it is no claim output any more. */
const CLAIM_GONE = 'the claim output is spent or is not a claim output any more';

/** Why a claim is no longer the open claim that was read before, or null when nothing changed. `before` names the claim: its token, its claimer and the hash of its claim document. */
function changeOf(before: Pick<ClaimView, 'token' | 'claimer' | 'claim_hash'>, after: ClaimView | null, now: number): string | null {
  if (after === null) return CLAIM_GONE;
  if (after.state !== 'Open') return `the claim is ${after.state} now`;
  if (after.token !== before.token || after.claimer !== before.claimer || after.claim_hash !== before.claim_hash) return 'the output holds another claim now';
  if (now >= challengeDeadlineOf(after)) return 'the challenge window of the claim ended';
  return null;
}

// --- What a port gives, checked ---------------------------------------------------------------------------------------------------------------------------------------

const CLAIM_STATES: readonly string[] = ['Open', 'Challenged', 'Validated', 'Invalidated'];
const CHALLENGE_STATES: readonly string[] = ['PendingOracle', 'PendingJury', 'Voting', 'Resolved'];
const HASH = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})*$/;
const MAX_RECORDED_DETAIL = 400;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isKeyHashOrNull = (value: unknown): value is KeyHash | null => value === null || isKeyHash(value);

/**
 * A claim view as the port must give it, or null when a member has the wrong type or form. The view that this returns is a copy: what a port changes later does not change what the code compared.
 * A claim that is left out for a view of a wrong shape would let a challenge pass it by, so the caller ends with `chain_unavailable` for a null.
 */
function claimViewOf(value: unknown): ClaimView | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ref = parseOutputRef(v.ref, 'ref');
  const token = parseClaimToken(v.token, 'token');
  const claimer = parseDid(v.claimer, 'claimer');
  if (!ref.ok || !token.ok || !claimer.ok || !isKeyHashOrNull(v.claimer_key_hash)) return null;
  if (typeof v.state !== 'string' || !CLAIM_STATES.includes(v.state)) return null;
  if (typeof v.stake_lovelace !== 'bigint' || v.stake_lovelace < 0n) return null;
  if (!isCount(v.submitted_at) || !isCount(v.challenge_window_ms) || v.challenge_window_ms < 1 || !Number.isSafeInteger(v.submitted_at + v.challenge_window_ms)) return null;
  if (typeof v.claim_hash !== 'string' || !HEX.test(v.claim_hash) || typeof v.claim_type !== 'string' || typeof v.claim_uri !== 'string') return null;
  return {
    ref: ref.value, token: token.value, claimer: claimer.value, claimer_key_hash: v.claimer_key_hash, state: v.state as ClaimView['state'], stake_lovelace: v.stake_lovelace,
    submitted_at: v.submitted_at, challenge_window_ms: v.challenge_window_ms, claim_hash: v.claim_hash, claim_type: v.claim_type, claim_uri: v.claim_uri,
  };
}

/** A challenge view as the port must give it, or null (see claimViewOf). */
function challengeViewOf(value: unknown): ChallengeView | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ref = parseOutputRef(v.ref, 'ref');
  const claim = parseOutputRef(v.claim, 'claim');
  const claimToken = parseClaimToken(v.claim_token, 'claim_token');
  const auditor = parseDid(v.auditor, 'auditor');
  if (!ref.ok || !claim.ok || !claimToken.ok || !auditor.ok || typeof v.token !== 'string' || !HASH.test(v.token) || !isKeyHashOrNull(v.auditor_key_hash)) return null;
  if (typeof v.stake_lovelace !== 'bigint' || v.stake_lovelace < 0n || typeof v.evidence_hash !== 'string' || !HEX.test(v.evidence_hash) || typeof v.evidence_uri !== 'string') return null;
  if (!isCount(v.challenged_at) || !isCount(v.resolution_deadline_ms) || !Number.isSafeInteger(v.challenged_at + v.resolution_deadline_ms)) return null;
  if (typeof v.state !== 'string' || !CHALLENGE_STATES.includes(v.state)) return null;
  return {
    ref: ref.value, token: v.token, claim: claim.value, claim_token: claimToken.value, auditor: auditor.value, auditor_key_hash: v.auditor_key_hash, stake_lovelace: v.stake_lovelace,
    evidence_hash: v.evidence_hash, evidence_uri: v.evidence_uri, challenged_at: v.challenged_at, resolution_deadline_ms: v.resolution_deadline_ms, state: v.state as ChallengeView['state'],
  };
}

/** The challenger of a challenge view: its DID and its key hash. Null when either has the wrong form, because the code cannot tell then whose the challenge is. */
function challengerOf(value: unknown): { readonly did: Did; readonly key_hash: KeyHash | null } | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const did = parseDid(v.auditor, 'auditor');
  return did.ok && isKeyHashOrNull(v.auditor_key_hash) ? { did: did.value, key_hash: v.auditor_key_hash } : null;
}

/** A document that the port read, or null when a member has the wrong type. */
function readDocumentOf(value: unknown): ReadDocument | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const fine = (member: unknown): member is string | null => member === null || typeof member === 'string';
  if (!(v.bytes instanceof Uint8Array) || !fine(v.type) || !fine(v.media_type)) return null;
  return { bytes: v.bytes, type: v.type, media_type: v.media_type };
}

/** A document that the code asked the port for, as the port answered: the document, the reason that the source has none, or no read at all for an address that is not a `vector-tx:` address. */
type Fetched =
  | { readonly kind: 'document'; readonly document: ReadDocument }
  | { readonly kind: 'absent'; readonly code: DocumentAbsent['code'] }
  | { readonly kind: 'other_address' };

/** The result of a read of a document, in its form, or null when the port gave another shape. A result that this returns is a copy. */
function documentResultOf(value: unknown): Fetched | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.ok === true) {
    const document = readDocumentOf(v.value);
    return document === null ? null : { kind: 'document', document };
  }
  if (v.ok === false && typeof v.detail === 'string' && (v.code === 'transaction_unknown' || v.code === 'no_document')) return { kind: 'absent', code: v.code };
  return null;
}

/** The result of a read of the escrow of a job, in its form, or null when the port gave another shape: the job of the escrow, or the refusal that the output is no escrow output of the deployment. */
function escrowJobOf(value: unknown):
  | { readonly kind: 'job'; readonly block_time_ms: number; readonly state: string; readonly capability_id: string; readonly agent_id: string | null }
  | { readonly kind: 'refused'; readonly detail: string }
  | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.ok === true) {
    const inner = typeof v.value === 'object' && v.value !== null ? (v.value as Record<string, unknown>) : {};
    const { block_time_ms: at, state, capability_id: capability, agent_id: agent } = inner;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 1 || typeof state !== 'string' || typeof capability !== 'string') return null;
    if (agent !== null && (typeof agent !== 'string' || !HASH.test(agent))) return null;
    return { kind: 'job', block_time_ms: at, state, capability_id: capability, agent_id: agent };
  }
  return v.ok === false && v.code === 'not_escrow' && typeof v.detail === 'string' ? { kind: 'refused', detail: v.detail } : null;
}

const LATE = Symbol('late');

/**
 * Runs a read of a port with a bound. A read that throws, and a read that is not done after `ms` milliseconds of the `sleep` port, give a refusal with `code`. The read that lost is left to end alone:
 * its answer is not used, and its error is not an unhandled one.
 */
async function bounded<T, C extends string>(sleep: (ms: number) => Promise<void>, ms: number, code: C, what: string, read: () => Promise<T>): Promise<ProtocolResult<T, C>> {
  try {
    const running = Promise.resolve().then(read);
    running.catch(() => undefined);
    const timer = sleep(ms).then(() => LATE);
    timer.catch(() => undefined);
    const result = await Promise.race([running, timer]);
    return result === LATE ? refused(code, `${what} did not answer within ${ms} ms`) : accepted(result as T);
  } catch (error) {
    return refused(code, `${what} cannot be read: ${describeError(error)}`);
  }
}

// --- The records of the journal ---------------------------------------------------------------------------------------------------------------------------------------

const recordOfFiled = (filed: ChallengeFiled): FiledRecord => ({
  record: filed.record, claim_token: filed.claim_token, against_did: filed.against_did, evidence_uri: filed.evidence_uri, evidence_hash: filed.evidence_hash, challenge_tx: filed.challenge_tx,
  challenge_token: filed.challenge_token, stake_lovelace: String(filed.stake_lovelace), deadline: filed.deadline, fee_lovelace: filed.fee_lovelace === null ? null : String(filed.fee_lovelace),
  extra_evidence: filed.extra_evidence,
});

const filedOfRecord = (record: FiledRecord): ChallengeFiled => ({
  record: record.record, claim_token: record.claim_token, against_did: record.against_did, evidence_uri: record.evidence_uri, evidence_hash: record.evidence_hash,
  challenge_tx: record.challenge_tx, challenge_token: record.challenge_token, stake_lovelace: BigInt(record.stake_lovelace), deadline: record.deadline,
  fee_lovelace: record.fee_lovelace === null ? null : BigInt(record.fee_lovelace), extra_evidence: record.extra_evidence,
});

/** The transactions that a record says landed or may land. */
const landedOf = (record: JobRecord | null): Landed => (record === null ? {} : {
  evidence: record.evidence, sent: record.ended?.sent ?? null, challenge: record.ended?.challenge ?? null, wrong_document: record.ended?.wrong_document ?? null,
});

/** What a record that stops a job says. A record `started` stops the job only until its lease ends, and the text says so. */
function earlierDetail(record: JobRecord, lease: number): string {
  const what = record.step === 'started' ? 'a challenge for this job was started before, and its evidence may be on chain'
    : record.step === 'evidence_landed' ? 'the evidence of a challenge for this job landed before, and the challenge may be on chain'
      : `a challenge for this job ended before with the code ${record.ended?.code ?? 'unknown'}`;
  const rule = record.step === 'started' ? `a job gets one challenge, and nothing is sent again until the record is ${lease} ms old` : 'a job gets one challenge, and nothing is sent a second time';
  return `${what}: ${rule}`;
}

/** The claim that a challenge names, and the text of its statement `EVIDENCE_STATEMENT`. */
interface Chosen {
  readonly claim: ClaimView;
  readonly statement_text: string;
}

/** The agents that the escrow of a job may name as the agent that the job hired, and the words for another agent in the detail of the refusal. */
interface Hired {
  readonly dids: readonly Did[];
  readonly words: string;
}

/** Why a claim of the other party is left out of the choice of the target, in the words of the detail of `no_open_claim`. The order of the members is the order of the detail. */
const SKIPS = {
  window: 'with a challenge window that ends too soon',
  began: 'submitted at or after the start of the job',
  stake: 'with a stake above the challenge stake',
  no_document: 'whose claim document is not on chain or is not a document',
  not_kit: 'without a claim document of this kit',
  capability: 'with a claim document for another capability',
  statement: 'with a claim document whose statement S1 is another text',
} as const;
type SkipReason = keyof typeof SKIPS;

/** The reasons that the claim document of a claim gives for leaving the claim out. */
type DocumentSkip = 'no_document' | 'not_kit' | 'capability' | 'statement';

/** What the code finds in the claim document of a claim that it looks at: the statement of a target, or the reason that the claim is left out. */
type Examined =
  | { readonly kind: 'target'; readonly statement_text: string }
  | { readonly kind: 'skip'; readonly reason: DocumentSkip };

/** What a challenge knows about its own transactions while it runs. */
interface Progress {
  /** True once the code is about to send a transaction of the job: from then on the job is not free for a second attempt. */
  sent: boolean;
}

export class Dispute {
  readonly #port: Module1Port;
  readonly #queue: SerialQueue;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #stake: bigint;
  readonly #windowLeft: number;
  readonly #readTimeout: number;
  /** How long a record `started` blocks the job, counted from the time in the record. */
  readonly #startedLease: number;
  readonly #resolutionDeadline: number;
  readonly #journal: DisputeJournal;
  readonly #log: (line: string) => void;
  /** The jobs of which a challenge runs now in this process. */
  readonly #running = new Set<OutputRef>();

  /**
   * Refuses settings of the wrong type before anything is read: a challenge stake that is not a bigint, or a time that is not a whole number, is an error and never "no limit". The resolution
   * deadline is the one of the Module-1 deployment, from the port. A deployment whose deadline is too short for the relay, and a setting that is not the value of the deployment, are errors: a
   * challenge with another value would have no jury. A lease of a record `started` that is below twice the read bound is an error too.
   */
  constructor(deps: DisputeDeps) {
    const settings = deps.settings;
    this.#stake = requireBigint(settings.challenge_stake_lovelace, 'settings.challenge_stake_lovelace');
    this.#windowLeft = requireMilliseconds(settings.min_window_left_ms, 'settings.min_window_left_ms', LEAST_WINDOW_LEFT_MS);
    this.#readTimeout = requireMilliseconds(settings.read_timeout_ms, 'settings.read_timeout_ms', 1);
    const leastLease = 2 * this.#readTimeout;
    this.#startedLease = settings.started_lease_ms === undefined ? Math.max(STARTED_LEASE_MS, leastLease) : requireMilliseconds(settings.started_lease_ms, 'settings.started_lease_ms', leastLease);
    const deployment = requireMilliseconds(deps.port.protocol?.resolution_deadline_ms, 'port.protocol.resolution_deadline_ms', 1);
    if (deployment < LEAST_RESOLUTION_DEADLINE_MS) {
      throw new RangeError(`the resolution deadline of the Module-1 deployment is ${deployment} ms, and a challenge needs at least ${LEAST_RESOLUTION_DEADLINE_MS} ms: the relay opens no case for less`);
    }
    if (settings.resolution_deadline_ms !== undefined) {
      const given = requireMilliseconds(settings.resolution_deadline_ms, 'settings.resolution_deadline_ms', 1);
      if (given !== deployment) throw new RangeError(`settings.resolution_deadline_ms is ${given} ms, and the Module-1 deployment has ${deployment} ms: a challenge names the value of the deployment`);
    }
    this.#resolutionDeadline = deployment;
    if (typeof deps.sleep !== 'function') throw new TypeError('sleep must be a function');
    if (deps.journal !== undefined && (typeof deps.journal.get !== 'function' || typeof deps.journal.put !== 'function')) throw new TypeError('journal must have the functions get and put');
    this.#port = deps.port;
    this.#queue = deps.queue;
    this.#clock = deps.clock;
    this.#sleep = deps.sleep;
    this.#journal = deps.journal ?? new MemoryJournal();
    const log = deps.log ?? (() => undefined);
    // A log line that fails changes no result: a transaction may have landed when the line is written, and the result must say so.
    this.#log = (line) => {
      try {
        const out: unknown = log(line);
        if (out !== undefined && out !== null) Promise.resolve(out).catch(() => undefined);
      } catch {
        // The line is lost. Nothing else changes.
      }
    };
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('the clock must give POSIX milliseconds');
    return now;
  }

  /**
   * Is `record` a record `started` that is older than its lease at `now`? Only such a record lapses. It says that the evidence may be on chain, and no later step ends it. A record of any other step says what
   * landed or how the job ended, and it stays. A transaction of the first try can still land after the lease: it is valid for 30 minutes by default, and the lease is 10 minutes by default. So a job goes on after
   * a lapse only against the claim that the record names (`#recordedClaim`, and the second read of the journal in the job of the queue). The chain takes only one challenge of a claim: when the first try lands, that
   * claim is spent, and the second try finds the claim changed, or the node refuses its build. The journal has no lock across processes, so two processes that read the same lapsed record can both go on, and both can
   * publish an evidence document. They go on against the same claim, so a job never files two challenges.
   */
  #lapsed(record: JobRecord, now: number): boolean {
    return record.step === 'started' && now - record.started_at >= this.#startedLease;
  }

  /**
   * The claim that a job with a lapsed record `started` may name: the claim of the record, and no other (`#lapsed` says why). `claim_changed` says that the claim is spent, is not Open, is another claim than the
   * record says, or has no window left. `claim_window_closing` says that less than the least window is left for the evidence to confirm. The claim is a candidate only: `#choose` checks it like any other claim.
   */
  #recordedClaim(record: JobRecord, claims: readonly ClaimView[], now: number): ProtocolResult<ClaimView, 'claim_changed' | 'claim_window_closing'> {
    const rule = `a lapsed record of this job names the claim ${record.claim}, and the job goes on only against it`;
    const named = claims.find((claim) => claim.ref === record.claim);
    if (named === undefined) return refused('claim_changed', `${rule}: ${CLAIM_GONE}`);
    // The record has the token and the claimer of the claim, and no hash of its claim document. The hash of an output cannot change, so the hash that is read now stands for it.
    const change = changeOf({ token: record.claim_token, claimer: record.against, claim_hash: named.claim_hash }, named, now);
    if (change !== null) return refused('claim_changed', `${rule}: ${change}`);
    if (challengeDeadlineOf(named) - now < this.#windowLeft) return refused('claim_window_closing', `${rule}: the challenge window of the claim ends too soon for the evidence to confirm`);
    return accepted(named);
  }

  /** The claims of the chain, each in its form. A list that cannot be read, or that has a view of a wrong shape, is `chain_unavailable`: the code never takes it for a list with no claim. */
  async #readClaims(): Promise<ProtocolResult<readonly ClaimView[], 'chain_unavailable'>> {
    const read = await bounded(this.#sleep, this.#readTimeout, 'chain_unavailable', 'the claims', () => this.#port.readClaims());
    if (!read.ok) return read;
    if (!Array.isArray(read.value)) return refused('chain_unavailable', 'the claims cannot be read: the port gave no list');
    const views: ClaimView[] = [];
    for (const value of read.value) {
      const view = claimViewOf(value);
      if (view === null) return refused('chain_unavailable', 'the claims cannot be read: the port gave a claim of a wrong shape');
      views.push(view);
    }
    return accepted(views);
  }

  /** Runs a job in the queue of the service key. A job that throws gives `port_error`: the port must describe each problem with a result, so a throw is a defect. */
  async #queued<T>(job: () => Promise<T>, mayHaveLanded: () => boolean = () => true): Promise<T | Refused<'port_error'>> {
    try {
      return await this.#queue.run(job);
    } catch (error) {
      return refused('port_error', `the chain port or the queue failed, and ${mayHaveLanded() ? 'a transaction may have landed' : 'nothing was sent'}: ${describeError(error)}`);
    }
  }

  /**
   * The document at a `vector-tx:` address, as the port answered. An address of another kind is never fetched: such a document cannot be a document of this kit. A source that answered and has no document is
   * `absent`, and the caller decides what that means. A read that fails, that is not done within the bound, or that answers in a wrong shape is `chain_unavailable`.
   */
  async #document(uri: string, what: string): Promise<ProtocolResult<Fetched, 'chain_unavailable'>> {
    let address: string | null;
    try {
      address = txHashOfUri(uri);
    } catch {
      address = null;
    }
    if (address === null) return accepted({ kind: 'other_address' });
    const read = await bounded(this.#sleep, this.#readTimeout, 'chain_unavailable', what, () => this.#port.readDocument(uri));
    if (!read.ok) return read;
    const result = documentResultOf(read.value);
    return result === null ? refused('chain_unavailable', `${what} cannot be read: the port gave a result of a wrong shape`) : accepted(result);
  }

  /** Stores a record, bounded. A failure is `journal_unavailable` with the reason. */
  async #store(escrow: OutputRef, record: JobRecord): Promise<ProtocolResult<null, 'journal_unavailable'>> {
    const stored = await bounded(this.#sleep, this.#readTimeout, 'journal_unavailable', 'the journal', () => this.#journal.put(escrow, record));
    return stored.ok ? accepted(null) : stored;
  }

  /** Stores the record of a step that landed. A failure is logged and changes no result: the transaction is on chain, and the result must say so. */
  async #remember(escrow: OutputRef, record: JobRecord): Promise<void> {
    const stored = await this.#store(escrow, record);
    if (!stored.ok) this.#log(`dispute: the journal did not store the step ${record.step} of the job ${escrow}: ${stored.detail}`);
  }

  // --- The claim that a challenge names ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * A claim whose document the source did not find, although the source answered. The kit publishes and confirms the claim document before it stakes the claim, so a source that has the claim transaction
   * has the document: the claim holds a document that is not on chain, and it is left out. A source that does not have the claim transaction is behind, and the document can be there: that is
   * `chain_unavailable`, and it is never a reason to leave the claim out.
   */
  async #missingDocument(claim: ClaimView): Promise<ProtocolResult<Examined, 'chain_unavailable'>> {
    const known = await bounded(this.#sleep, this.#readTimeout, 'chain_unavailable', 'the claim transaction', () => this.#port.isIndexed(claim.ref));
    if (!known.ok) return known;
    if (known.value === true) return accepted({ kind: 'skip', reason: 'no_document' });
    if (known.value === false) return refused('chain_unavailable', 'the claim document is not found, and the source of the documents does not have the claim transaction: the source can be behind');
    return refused('chain_unavailable', 'the claim transaction cannot be read: the port gave an answer that is not true or false');
  }

  /**
   * What the code finds in the claim document of a claim: the statement of a target, or the reason that the claim is left out. A claim is a claim of this kit when its claim document is a `vector-tx:`
   * document that is on chain and is a document, its hash is the claim hash that the claim holds, it was published as a claim with the media type of this kit, and it is the document that `claimDocument`
   * writes for the claimer. It covers the job only when the capability of the document is the capability of the job, and its statement S1 is the text that the job hired (`statement_text` of the scope). The compare
   * takes the NFC form of both texts, so a text in NFD and the same text in NFC are one statement: the evidence document writes each text in NFC. Another difference, such as a homoglyph, is another text: a claim
   * with another S1 would make the evidence quote a statement that the job did not break. A claim whose document is not on chain, is not a document, is not of this kit, is for another capability, or has another S1 is
   * left out, because the claimer makes the document. A source that cannot be read is `chain_unavailable`.
   */
  async #examine(claim: ClaimView, scope: ClaimScope): Promise<ProtocolResult<Examined, 'chain_unavailable'>> {
    const skip = (reason: DocumentSkip): ProtocolResult<Examined, 'chain_unavailable'> => accepted({ kind: 'skip', reason });
    if (!HASH.test(claim.claim_hash)) return skip('not_kit');
    const read = await this.#document(claim.claim_uri, 'the claim document');
    if (!read.ok) return read;
    const fetched = read.value;
    if (fetched.kind === 'other_address') return skip('not_kit');
    if (fetched.kind === 'absent') return fetched.code === 'no_document' ? skip('no_document') : this.#missingDocument(claim);
    const document = fetched.document;
    if (documentHash(document.bytes) !== claim.claim_hash) return skip('not_kit');
    if (document.type !== 'claim' || document.media_type !== JUROR_MEDIA_TYPE) return skip('not_kit');
    const input = readClaimDocument(document.bytes);
    if (!input.ok || input.value.agent_did !== claim.claimer) return skip('not_kit');
    if (input.value.capability_id !== scope.capability_id) return skip('capability');
    const statement = input.value.claim.statements.find((candidate) => candidate.id === EVIDENCE_STATEMENT);
    if (statement === undefined) return skip('not_kit');
    return statement.text.normalize('NFC') === scope.statement_text.normalize('NFC') ? accepted({ kind: 'target', statement_text: statement.text }) : skip('statement');
  }

  /**
   * The start of the job, after a check that the escrow that `scope` names is the escrow of this job. The escrow is read from the chain, and the caller gives no time. It is the escrow of this job only when its datum has
   * the identity layout (the legacy layout names no agent), its capability_id is the capability of the scope, and its agent_id is one of the agents in `hired`: the agent that the job hired. Any other escrow is the
   * escrow of another job, and it is `bad_shape`, so a caller cannot widen the choice of the target with the escrow of a newer job. An output that is no escrow output of the deployment is `bad_shape` too. The start is the
   * time of the block that holds the transaction that made the escrow output, so the output must be the output that the Post made: its datum has the state Open, and Koios keeps that datum after the output is spent. An
   * output that a later step made (the Claim or the Submit) is in a later block. A caller that names it would move the start of the job later, and a claim that was staked after the job began would be a target. Its datum has
   * another state, so it is `bad_shape` with a detail that says to name the output of the Post. The member `posted_at` of the datum is not used: the poster writes it and no validator checks it, so a claimer that is also
   * the poster could write a time that makes each of its claims "after the start", and so block each challenge against itself. A source that cannot be read, that does not have the output, that gives no time of the block,
   * or that answers in a wrong shape is `chain_unavailable`. So is a block that is dated after the clock: a job cannot begin after the clock, and the sender of a transaction cannot cause that, so the clock or the source is
   * wrong. The detail names the member of the datum that is wrong, and it never repeats the value: the poster writes it.
   */
  async #startOf(scope: ClaimScope, now: number, hired: Hired): Promise<ProtocolResult<number, 'bad_shape' | 'chain_unavailable'>> {
    const read = await bounded(this.#sleep, this.#readTimeout, 'chain_unavailable', 'the escrow of the job', () => this.#port.readEscrowJob(scope.escrow_ref));
    if (!read.ok) return read;
    const job = escrowJobOf(read.value);
    if (job === null) return refused('chain_unavailable', 'the escrow of the job cannot be read: the port gave a result of a wrong shape');
    if (job.kind === 'refused') return refused('bad_shape', `escrow_ref names no escrow output of the deployment: ${describeError(job.detail)}`);
    if (job.agent_id === null) return refused('bad_shape', 'escrow_ref names an escrow of the legacy layout: its datum has no agent_id, so it is not the escrow of this job');
    if (job.capability_id !== scope.capability_id) return refused('bad_shape', 'escrow_ref names the escrow of another job: the capability_id of its datum is not the capability_id of the job');
    if (!hired.dids.includes(didOfAgentId(job.agent_id))) return refused('bad_shape', `escrow_ref names the escrow of another job: the agent_id of its datum is not ${hired.words}`);
    if (job.state !== 'Open') return refused('bad_shape', 'escrow_ref names an output that a later step of the escrow made, and not the output of its Post: the state of its datum is not Open. Name the output that the Post made, because only the block of that output is the start of the job');
    if (job.block_time_ms > now) return refused('chain_unavailable', 'the block of the escrow output is dated after the clock, so the clock or the source of the chain is wrong');
    return accepted(job.block_time_ms);
  }

  /**
   * The claim that a challenge of `did` names for the job in `scope`. A claim is a target only when ALL hold: it is an Open claim of `did`; it has at least `leastLeft` milliseconds of window left at `now`;
   * it was submitted before the job began (the time of the block of its escrow output, from the chain); its stake is not above the challenge stake; and its claim document is a claim document of this kit for the
   * capability of the job, with the statement S1 of the job. A claim that is not a target is left out of the choice and counted by its reason: the detail of `no_open_claim` says how many claims were left out
   * for each reason. Among the targets the one with the latest challenge deadline is chosen, and with the same deadline the one with the lowest claim token, so the choice does not depend on the order of a list.
   * The claim documents are read in that order, and the first target ends the search. A document that cannot be read is `chain_unavailable`, and it is never taken for a claim that is not a target. The escrow
   * of the job is read only when `did` has an open claim, and it must be the escrow of this job (`#startOf`): `hired` names the agents that the job may have hired.
   */
  async #choose(did: Did, claims: readonly ClaimView[], scope: ClaimScope, now: number, leastLeft: number, hired: Hired): Promise<ProtocolResult<Chosen, ClaimLookupCode>> {
    const open = claims.filter((claim) => claim.claimer === did && claim.state === 'Open');
    if (open.length === 0) return refused(NO_OPEN_CLAIM, 'the agent has no open claim');
    const began = await this.#startOf(scope, now, hired);
    if (!began.ok) return began;
    const skipped: Record<SkipReason, number> = { window: 0, began: 0, stake: 0, no_document: 0, not_kit: 0, capability: 0, statement: 0 };
    const room = Math.max(leastLeft, 1);
    const candidates: ClaimView[] = [];
    for (const claim of open) {
      const reason: SkipReason | null = challengeDeadlineOf(claim) - now < room ? 'window' : claim.submitted_at >= began.value ? 'began' : claim.stake_lovelace > this.#stake ? 'stake' : null;
      if (reason === null) candidates.push(claim);
      else skipped[reason] += 1;
    }
    candidates.sort((a, b) => challengeDeadlineOf(b) - challengeDeadlineOf(a) || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    for (const claim of candidates) {
      const examined = await this.#examine(claim, scope);
      if (!examined.ok) return examined;
      if (examined.value.kind === 'target') return accepted({ claim, statement_text: examined.value.statement_text });
      skipped[examined.value.reason] += 1;
    }
    const counts = (Object.keys(SKIPS) as SkipReason[]).map((reason) => `${skipped[reason]} ${SKIPS[reason]}`).join(', ');
    return refused(NO_OPEN_CLAIM, `the agent has ${open.length} open claim(s), and none can be challenged: ${counts}`);
  }

  // --- The open claim of an agent -------------------------------------------------------------------------------------------------------------------------------------

  /**
   * The claim that a challenge of `did` would name for the job in `scope`: the target with the latest challenge deadline (see `#choose`). A lookup has no direction, so the escrow of the job may name `did` or this
   * agent as the agent that the job hired. `no_open_claim` says that there is none, and its detail counts the claims that were left out for each reason. `chain_unavailable` says that the claims, the escrow of the
   * job or a claim document could not be read, and it is never `no_open_claim`. `bad_shape` says that the scope is wrong, that `escrow_ref` names no escrow output of the deployment, that the escrow is not the escrow of
   * this job, or that the output is not the output that its Post made.
   */
  async findOpenClaim(did: Did, scope: ClaimScope): Promise<ProtocolResult<ClaimView, ClaimLookupCode>> {
    const checked = parseDid(did, 'did');
    if (!checked.ok) return checked;
    const job = parseScope(scope, 'scope');
    if (!job.ok) return job;
    const read = await this.#readClaims();
    if (!read.ok) return read;
    const hired: Hired = { dids: [checked.value, this.#port.agent.did], words: 'the agent of the lookup or this agent' };
    const chosen = await this.#choose(checked.value, read.value, job.value, this.#now(), 0, hired);
    return chosen.ok ? accepted(chosen.value.claim) : chosen;
  }

  /** Every claim of an agent whose state is Open, whatever its window, the newest first. An operator reads it to withdraw the claims that nobody challenged. */
  async listOpenClaims(did: Did): Promise<ProtocolResult<readonly ClaimView[], 'bad_shape' | 'chain_unavailable'>> {
    const checked = parseDid(did, 'did');
    if (!checked.ok) return checked;
    const read = await this.#readClaims();
    if (!read.ok) return read;
    const open = read.value.filter((claim) => claim.claimer === checked.value && claim.state === 'Open');
    return accepted([...open].sort((a, b) => b.submitted_at - a.submitted_at || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)));
  }

  // --- The claim of a run ---------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Stakes the claim of a run: it publishes the claim document, waits for its confirmation, and then submits the claim with the hash and the URI of that document. The claim holds `stake_lovelace`
   * until the challenge window ends. A step that fails after the document landed says so in `document`. A claim type of more than MAX_CLAIM_TYPE_BYTES bytes is refused before anything is published.
   */
  async stakeRunClaim(input: RunClaimInput): Promise<RunClaimResult> {
    const { capability_id, manifest_sha256, claim, stake_lovelace, challenge_window_ms, claim_type } = input;
    const stake = requireBigint(stake_lovelace, 'stake_lovelace');
    const window = requireMilliseconds(challenge_window_ms, 'challenge_window_ms', 1);
    if (typeof claim_type !== 'string' || claim_type.length === 0) throw new TypeError('claim_type must be a text');
    if (Buffer.byteLength(claim_type, 'utf8') > MAX_CLAIM_TYPE_BYTES) throw new RangeError(`claim_type must be at most ${MAX_CLAIM_TYPE_BYTES} bytes of text`);
    const notStaked = (code: RunClaimNotStaked['code'], detail: string, landed: Partial<Pick<RunClaimNotStaked, 'document' | 'sent' | 'wrong_document'>> = {}): RunClaimNotStaked => ({
      ok: false, code, detail, document: null, sent: null, wrong_document: null, ...landed,
    });
    const me = this.#port.agent.did;
    const document = claimDocument({ agent_did: me, capability_id, manifest_sha256, claim });
    if (!document.ok) return notStaked(document.code, document.detail);

    const published = await this.#queued(() => this.#port.publishDocument({ bytes: document.value.bytes, type: 'claim', media_type: JUROR_MEDIA_TYPE }));
    if (!published.ok) {
      const why = failed(published, 'claim_document_not_built', 'claim_document_not_confirmed');
      return notStaked(why.code, why.detail, { sent: why.sent });
    }
    const landed = landedDocument(published.value);
    if (published.value.document_hash !== document.value.hash) {
      this.#log(`dispute: the port published the document ${landed.tx_hash} with another hash than the claim document of ${me}`);
      return notStaked('port_error', 'the port published a document with another hash than the claim document', { wrong_document: landed });
    }
    this.#log(`dispute: claim document ${landed.tx_hash} confirmed for ${me}`);

    const submitted = await this.#queued(() => this.#port.submitClaim({
      claim_hash: landed.document_hash, claim_uri: landed.uri, claim_type, stake_lovelace: stake, challenge_window_ms: window,
    }));
    if (!submitted.ok) {
      const why = failed(submitted, 'claim_not_built', 'claim_not_confirmed');
      return notStaked(why.code, why.detail, { document: landed, sent: why.sent });
    }
    const claimed = submitted.value;
    this.#log(`dispute: claim ${claimed.claim} staked by ${me} with the document ${landed.tx_hash}`);
    return accepted({
      claim: claimed.claim, claim_token: claimed.claim_token, document: landed, stake_lovelace: claimed.stake_lovelace, challenge_window_ms: claimed.challenge_window_ms,
      submitted_at: claimed.submitted_at, challenge_deadline: claimed.submitted_at + claimed.challenge_window_ms, claim_tx: claimed.tx_hash,
      fee_lovelace: published.value.fee_lovelace + claimed.fee_lovelace,
    });
  }

  // --- The withdrawal -------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Withdraws an open claim of this agent after its challenge window, and gets the stake back. It refuses a claim that is not Open (`claim_not_open`), a claim of another key (`not_claimer`), and a
   * window that has not ended (`window_not_ended`). Each refusal comes before any build.
   */
  async withdrawClaim(input: WithdrawClaimInput): Promise<WithdrawResult> {
    const notDone = (code: WithdrawNotDone['code'], detail: string, sent: SentNotConfirmed | null = null): WithdrawNotDone => ({ ok: false, code, detail, sent });
    const ref = parseOutputRef(input.claim, 'claim');
    if (!ref.ok) return notDone(ref.code, ref.detail);
    const read = await bounded(this.#sleep, this.#readTimeout, 'chain_unavailable', 'the claim', () => this.#port.readClaim(ref.value));
    if (!read.ok) return notDone('chain_unavailable', read.detail);
    const claim = read.value === null ? null : claimViewOf(read.value);
    if (read.value !== null && claim === null) return notDone('chain_unavailable', 'the claim cannot be read: the port gave a claim of a wrong shape');
    if (claim === null) return notDone('claim_not_open', 'the output is spent, or it is not a claim output');
    if (claim.state !== 'Open') return notDone('claim_not_open', `the claim is ${claim.state}, and only an Open claim can be withdrawn`);
    if (claim.claimer_key_hash === null || claim.claimer_key_hash !== this.#port.agent.key_hash) return notDone('not_claimer', 'the key of this agent is not the claimer credential of the claim');
    const from = withdrawableFrom(claim);
    if (this.#now() < from) return notDone('window_not_ended', `the challenge window of the claim ends at ${new Date(challengeDeadlineOf(claim)).toISOString()}, and a withdrawal starts after it`);

    const token = claim.token;
    const withdrawn = await this.#queued(() => this.#port.withdrawClaim({ claim: ref.value, claim_token: token }));
    if (!withdrawn.ok) {
      const why = failed(withdrawn, 'withdraw_not_built', 'withdraw_not_confirmed');
      return notDone(why.code, why.detail, why.sent);
    }
    const done: ClaimWithdrawn = {
      claim: withdrawn.value.claim, claim_token: withdrawn.value.claim_token, payout: withdrawn.value.payout, stake_lovelace: withdrawn.value.stake_lovelace,
      withdraw_tx: withdrawn.value.tx_hash, fee_lovelace: withdrawn.value.fee_lovelace,
    };
    this.#log(`dispute: claim ${done.claim} withdrawn, the payout is ${done.payout}`);
    return accepted(done);
  }

  // --- The challenge --------------------------------------------------------------------------------------------------------------------------------------------------

  /** The challenge of a buyer-side agent whose model did not accept the delivery of the counterparty. */
  async challengeDelivery(input: DeliveryChallengeInput): Promise<ChallengeResult> {
    const target = parseChallengeInput(input, 'counterparty', ['order_confirmation', 'quote_price']);
    return target.ok ? this.#file(target.value) : notFiled(target.code, target.detail);
  }

  /**
   * The challenge of a counterparty that refused a request for `approval_digest_mismatch`. The refusal is answered first, and this runs after it. The reference of the challenge goes to the log and to
   * the result. A caller must not put it into the message of the refusal.
   */
  async challengeApproval(input: ApprovalChallengeInput): Promise<ChallengeResult> {
    const target = parseChallengeInput(input, 'sender', ['approval_digest']);
    return target.ok ? this.#file(target.value) : notFiled(target.code, target.detail);
  }

  async #file(target: ChallengeTarget): Promise<ChallengeResult> {
    const me = this.#port.agent.did;
    if (target.against === me) return notFiled('same_agent', 'the other party is the agent itself, and an agent cannot challenge its own claim');
    if (this.#running.has(target.escrow)) return notFiled('job_already_disputed', 'a challenge for this job is in progress');
    this.#running.add(target.escrow);
    const progress: Progress = { sent: false };
    try {
      return await this.#fileJob(target, me, progress);
    } catch (error) {
      return notFiled('port_error', `the challenge stopped with an error, and ${progress.sent ? 'a transaction may have landed' : 'nothing was sent'}: ${describeError(error)}`);
    } finally {
      this.#running.delete(target.escrow);
    }
  }

  /**
   * A challenge of this agent for this job that is on chain already, as the filed challenge, or null. The claims of the other party that are Challenged are looked at, and the challenges that name
   * one of them. Only a challenge of this agent is read: the output of another auditor can hold any claim token and any deadline, because Module-1 checks neither, so such an output is left out and
   * is never a failure. A challenge of this agent is one whose evidence document is on chain, has the hash that the challenge holds, and names this job. A document that cannot be read is
   * `chain_unavailable`, and so is a list that cannot be read or a challenge whose challenger the code cannot tell.
   */
  async #findOwn(target: ChallengeTarget, me: Did, claims: readonly ClaimView[]): Promise<ProtocolResult<ChallengeFiled | null, 'chain_unavailable'>> {
    const challenged = claims.filter((claim) => claim.claimer === target.against && claim.state === 'Challenged');
    if (challenged.length === 0) return accepted(null);
    const read = await bounded(this.#sleep, this.#readTimeout, 'chain_unavailable', 'the challenges', () => this.#port.readChallenges());
    if (!read.ok) return read;
    if (!Array.isArray(read.value)) return refused('chain_unavailable', 'the challenges cannot be read: the port gave no list');
    const mine: ChallengeView[] = [];
    for (const value of read.value) {
      const challenger = challengerOf(value);
      if (challenger === null) return refused('chain_unavailable', 'the challenges cannot be read: the port gave a challenge of a wrong shape');
      if (challenger.did !== me || challenger.key_hash !== this.#port.agent.key_hash) continue;
      const view = challengeViewOf(value);
      if (view === null) return refused('chain_unavailable', 'the challenges cannot be read: the port gave a challenge of this agent of a wrong shape');
      if (challenged.some((claim) => claim.token === view.claim_token)) mine.push(view);
    }
    mine.sort((a, b) => a.challenged_at - b.challenged_at || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    for (const challenge of mine) {
      const fetched = await this.#document(challenge.evidence_uri, 'the evidence document');
      if (!fetched.ok) return fetched;
      // The evidence document of a challenge of this agent was confirmed before the challenge was built, so a source that has the challenge has it. A source that has none is behind.
      if (fetched.value.kind === 'absent') return refused('chain_unavailable', 'the evidence document of a challenge of this agent is not found: the source of the documents can be behind');
      if (fetched.value.kind === 'other_address' || documentHash(fetched.value.document.bytes) !== challenge.evidence_hash) continue;
      const references = evidenceReferences(fetched.value.document.bytes);
      if (!references.ok || references.value.escrow_ref !== target.escrow || references.value.by_did !== me || references.value.against_did !== target.against) continue;
      const evidenceTx = txHashOfUri(challenge.evidence_uri)!;
      return accepted({
        record: { claim: challenge.claim, evidence: evidenceTx, challenge: challenge.ref }, claim_token: challenge.claim_token, against_did: target.against, evidence_uri: challenge.evidence_uri,
        evidence_hash: challenge.evidence_hash, challenge_tx: challenge.ref.split('#')[0]!, challenge_token: challenge.token, stake_lovelace: challenge.stake_lovelace,
        deadline: challenge.challenged_at + challenge.resolution_deadline_ms, fee_lovelace: null, extra_evidence: null,
      });
    }
    return accepted(null);
  }

  /**
   * The result for a challenge of this agent that is on chain already: the journal keeps it as the end of the job, and the job gives it. `published` is the transaction of the evidence document that an earlier try of this
   * job published, or null. That document is on chain, and its fee is paid. When the challenge names another document (the first try published its own), the result names the document of the earlier try in
   * `extra_evidence`, and the journal keeps it. When the challenge names that document, or the job published none, `extra_evidence` is null.
   */
  async #found(target: ChallengeTarget, found: ChallengeFiled, published: string | null): Promise<ChallengeResult> {
    const escrow = target.escrow;
    const filed: ChallengeFiled = { ...found, extra_evidence: published === found.record.evidence ? null : published };
    const base: JobRecord = {
      step: 'done', escrow, against: target.against, claim: filed.record.claim, claim_token: filed.claim_token, started_at: this.#now(),
      evidence: { tx_hash: filed.record.evidence, uri: filed.evidence_uri, document_hash: filed.evidence_hash },
      filed: recordOfFiled(filed), ended: null,
    };
    await this.#remember(escrow, base);
    this.#log(`dispute: the challenge ${filed.record.challenge} of this agent for the job ${escrow} is on chain already, with the evidence ${filed.record.evidence}${filed.extra_evidence === null ? '' : `, and the evidence ${filed.extra_evidence} of an earlier try is not used`}`);
    return accepted(filed);
  }

  /**
   * A challenge of this agent for this job that is on chain now, as the filed challenge, or null: the claims are read again, and then `#findOwn` looks at the challenges. After a lapsed record, the first try can
   * have landed its challenge while the second try ran, so the claims that the second try read are no longer the claims of the chain.
   */
  async #findOwnAgain(target: ChallengeTarget, me: Did): Promise<ProtocolResult<ChallengeFiled | null, 'chain_unavailable'>> {
    const claims = await this.#readClaims();
    return claims.ok ? this.#findOwn(target, me, claims.value) : claims;
  }

  /** Writes how a job ended to the journal, and gives the result. The write changes no result. */
  async #finish(escrow: OutputRef, base: JobRecord, result: ChallengeResult): Promise<ChallengeResult> {
    const record: JobRecord = result.ok
      ? { ...base, step: 'done', filed: recordOfFiled(result.value), ended: null }
      : {
        ...base, step: 'done', filed: null,
        ended: { code: result.code, detail: result.detail.slice(0, MAX_RECORDED_DETAIL), sent: result.sent, challenge: result.challenge, wrong_document: result.wrong_document },
      };
    await this.#remember(escrow, record);
    return result;
  }

  async #fileJob(target: ChallengeTarget, me: Did, progress: Progress): Promise<ChallengeResult> {
    const escrow = target.escrow;
    // 0. The journal of the job.
    const stored = await bounded(this.#sleep, this.#readTimeout, 'journal_unavailable', 'the journal', () => this.#journal.get(escrow));
    if (!stored.ok) return notFiled('journal_unavailable', stored.detail);
    const parsed = parseJobRecord(stored.value);
    if (!parsed.ok) return notFiled('journal_unavailable', `the journal gave a record that is not in its form: ${parsed.detail}`);
    if (parsed.value !== null && parsed.value.escrow !== escrow) return notFiled('journal_unavailable', 'the journal gave the record of another job: a record must be for the escrow that it is read for, and nothing was sent');
    const earlier = parsed.value !== null && parsed.value.step !== 'not_sent' ? parsed.value : null;
    if (earlier !== null && earlier.against !== target.against) return notFiled('job_already_disputed', 'a challenge for this job was recorded against another agent: a job has one counterparty', landedOf(earlier));
    if (earlier?.filed != null) return accepted(filedOfRecord(earlier.filed));
    // A record `started` that is older than its lease gives the job back, but only after the search of the chain below: a challenge of this agent that is on chain is still the result.
    const lapsed = earlier !== null && this.#lapsed(earlier, this.#now());

    // 1. The claims, and a challenge of this agent for this job that is on chain already.
    const claims = await this.#readClaims();
    if (!claims.ok) {
      this.#log(`dispute: no challenge for the job ${escrow}: ${claims.code}`);
      return notFiled(claims.code, claims.detail, landedOf(earlier));
    }
    const own = await this.#findOwn(target, me, claims.value);
    if (!own.ok) {
      this.#log(`dispute: no challenge for the job ${escrow}: ${own.code}`);
      return notFiled(own.code, own.detail, landedOf(earlier));
    }
    if (own.value !== null) return this.#found(target, own.value, earlier?.evidence?.tx_hash ?? null);
    if (earlier !== null) {
      if (!lapsed) return notFiled('job_already_disputed', earlierDetail(earlier, this.#startedLease), landedOf(earlier));
      this.#log(`dispute: the started record of the job ${escrow} is older than its lease of ${this.#startedLease} ms, and no challenge of this agent is on chain, so the job goes on, only against the claim ${earlier.claim}`);
    }

    // 2. The claim of the other party that the challenge names. After a lapsed record `started`, only the claim of the record can be named: a transaction of the first try can still land.
    let candidates = claims.value;
    if (earlier !== null) {
      const recorded = this.#recordedClaim(earlier, claims.value, this.#now());
      if (!recorded.ok) {
        this.#log(`dispute: no challenge for the job ${escrow}: ${recorded.code}`);
        return notFiled(recorded.code, recorded.detail);
      }
      candidates = [recorded.value];
    }
    const hired: Hired = target.party === 'counterparty'
      ? { dids: [target.against], words: 'the counterparty, which this agent hired' }
      : { dids: [me], words: 'this agent, which the sender hired' };
    const chosen = await this.#choose(target.against, candidates, target.scope, this.#now(), this.#windowLeft, hired);
    if (!chosen.ok) {
      this.#log(`dispute: no challenge for the job ${escrow}: ${chosen.code}`);
      return notFiled(chosen.code, chosen.detail);
    }
    const { claim, statement_text: statement } = chosen.value;

    // 3. The evidence document: refused here, and nothing is on chain.
    const document = evidenceDocument({
      ...target.facts, claim: claim.ref, claim_token: claim.token, against_did: claim.claimer, by_did: me, escrow_ref: escrow, statement_text: statement,
    } as unknown as EvidenceDocumentInput);
    if (!document.ok) return notFiled(document.code, document.detail);

    // 4. The evidence is published first, and the challenge waits for its confirmation. The window that is left is checked in the job, right before the publish: the wait for the queue can be long.
    type FirstJob = { readonly stop: ChallengeCode; readonly detail: string } | { readonly tx: TxResult<PublishedDocument>; readonly started: JobRecord; readonly replaced: JobRecord | null };
    const first = await this.#queued<FirstJob>(async () => {
      let at: number;
      try {
        at = this.#now();
      } catch (error) {
        return { stop: 'port_error', detail: `the clock failed, and nothing was sent: ${describeError(error)}` };
      }
      if (challengeDeadlineOf(claim) - at < this.#windowLeft) return { stop: 'claim_window_closing', detail: 'the challenge window of the claim ends too soon for the evidence to confirm' };
      // Another call for this job can have written its record while this job waited in the queue: the record is read again, in the job, right before the evidence is sent.
      const current = await bounded(this.#sleep, this.#readTimeout, 'journal_unavailable', 'the journal', () => this.#journal.get(escrow));
      if (!current.ok) return { stop: 'journal_unavailable', detail: `${current.detail}, so nothing was sent` };
      const seen = parseJobRecord(current.value);
      if (!seen.ok) return { stop: 'journal_unavailable', detail: `the journal gave a record that is not in its form, so nothing was sent: ${seen.detail}` };
      if (seen.value !== null && seen.value.escrow !== escrow) return { stop: 'journal_unavailable', detail: 'the journal gave the record of another job, so nothing was sent' };
      const recorded = seen.value !== null && seen.value.step !== 'not_sent' ? seen.value : null;
      if (recorded !== null && !this.#lapsed(recorded, at)) return { stop: 'job_already_disputed', detail: `${earlierDetail(recorded, this.#startedLease)}; nothing was sent` };
      // A record that lapsed gives the job back only for the claim that it names, also when it lapsed while this job waited in the queue.
      if (recorded !== null && (recorded.claim !== claim.ref || recorded.claim_token !== claim.token || recorded.against !== claim.claimer)) {
        return { stop: 'job_already_disputed', detail: 'a lapsed record of this job names another claim, and the job goes on only against the claim of its record; nothing was sent' };
      }
      const started: JobRecord = { step: 'started', escrow, against: claim.claimer, claim: claim.ref, claim_token: claim.token, started_at: at, evidence: null, filed: null, ended: null };
      const written = await this.#store(escrow, started);
      if (!written.ok) return { stop: 'journal_unavailable', detail: `${written.detail}, so nothing was sent` };
      progress.sent = true;
      return { tx: await this.#port.publishDocument({ bytes: document.value.bytes, type: 'evidence', media_type: JUROR_MEDIA_TYPE }), started, replaced: recorded };
    }, () => progress.sent);
    if ('code' in first) return notFiled('port_error', first.detail);
    if ('stop' in first) {
      this.#log(`dispute: no evidence for the job ${escrow}: ${first.stop}`);
      return notFiled(first.stop, first.detail);
    }
    const { tx: published, started, replaced } = first;
    if (!published.ok) {
      const why = failed(published, 'evidence_not_built', 'evidence_not_confirmed');
      if (why.code === 'evidence_not_built') {
        // Nothing was sent: the job may be tried again. A lapsed record that this try replaced comes back, because the transactions of its try may still land: the next try names its claim again, and no other.
        await this.#remember(escrow, replaced ?? { ...started, step: 'not_sent' });
        return notFiled(why.code, why.detail);
      }
      return this.#finish(escrow, started, notFiled(why.code, why.detail, { sent: why.sent }));
    }
    const evidence = landedDocument(published.value);
    if (published.value.document_hash !== document.value.hash) {
      this.#log(`dispute: the port published the document ${evidence.tx_hash} with another hash than the evidence document for the claim ${claim.ref}`);
      return this.#finish(escrow, started, notFiled('port_error', 'the port published a document with another hash than the evidence document', { wrong_document: evidence }));
    }
    const landed: JobRecord = { ...started, step: 'evidence_landed', evidence };
    await this.#remember(escrow, landed);
    this.#log(`dispute: evidence ${evidence.tx_hash} confirmed for the claim ${claim.ref} of ${claim.claimer}`);

    // 5. The challenge, against the exact output that the evidence names, in one job of the queue.
    type SecondJob = { readonly stop: ChallengeCode; readonly detail: string } | { readonly sent: TxResult<OpenedChallenge> };
    const second = await this.#queued<SecondJob>(async () => {
      const again = await bounded(this.#sleep, this.#readTimeout, 'chain_unavailable', 'the claim', () => this.#port.readClaim(claim.ref));
      if (!again.ok) return { stop: 'chain_unavailable', detail: again.detail };
      const view = again.value === null ? null : claimViewOf(again.value);
      if (again.value !== null && view === null) return { stop: 'chain_unavailable', detail: 'the claim cannot be read: the port gave a claim of a wrong shape' };
      let at: number;
      try {
        at = this.#now();
      } catch (error) {
        return { stop: 'port_error', detail: `the clock failed, and the challenge was not sent: ${describeError(error)}` };
      }
      const change = changeOf(claim, view, at);
      if (change !== null) return { stop: 'claim_changed', detail: change };
      return {
        sent: await this.#port.openChallenge({
          claim: claim.ref, claim_token: claim.token, evidence_hash: evidence.document_hash, evidence_uri: evidence.uri, stake_lovelace: this.#stake, resolution_deadline_ms: this.#resolutionDeadline,
        }),
      };
    });
    const after = (code: ChallengeCode, detail: string, more: Landed = {}): Promise<ChallengeResult> => this.#finish(escrow, landed, notFiled(code, detail, { evidence, ...more }));
    // After a lapsed record, the first try can have landed its challenge while this try ran. It spent the claim of both tries, so this try ends with `claim_changed` (the claim is Challenged now), with
    // `challenge_not_built` (the node builds no challenge for a claim output that is spent), or with `challenge_not_confirmed` when the node refuses the challenge that was built (`may_land` is false: it never reached
    // the node, and it cannot land). A challenge of this agent for this job that is on chain now is the result. A search that fails is `chain_unavailable`: nothing says that no challenge is on chain, and a later call
    // finds it. A challenge that may still land (`may_land` is true) is not searched for here: it can be the challenge of this try, and the result says that it may land.
    const lapsedBefore = earlier !== null || replaced !== null;
    const endOrFind = async (code: ChallengeCode, detail: string, more: Landed = {}): Promise<ChallengeResult> => {
      const cannotLand = code === 'claim_changed' || code === 'challenge_not_built' || (code === 'challenge_not_confirmed' && more.sent?.may_land === false);
      if (!lapsedBefore || !cannotLand) return after(code, detail, more);
      const own = await this.#findOwnAgain(target, me);
      if (!own.ok) return after('chain_unavailable', `${detail}; the search for a challenge of this agent on chain failed: ${own.detail}`, more);
      if (own.value === null) return after(code, detail, more);
      this.#log(`dispute: the evidence ${evidence.tx_hash} of this try is not used: the challenge ${own.value.record.challenge} of the first try landed while this try ran`);
      return this.#found(target, own.value, evidence.tx_hash);
    };
    if ('code' in second) return after('port_error', second.detail);
    if ('stop' in second) {
      this.#log(`dispute: the evidence ${evidence.tx_hash} landed and no challenge was filed: ${second.stop}`);
      return endOrFind(second.stop, second.detail);
    }
    const sent = second.sent;
    if (!sent.ok) {
      const why = failed(sent, 'challenge_not_built', 'challenge_not_confirmed');
      this.#log(`dispute: the evidence ${evidence.tx_hash} landed and no challenge was filed: ${why.code}`);
      return endOrFind(why.code, why.detail, { sent: why.sent });
    }
    const opened = sent.value;
    if (opened.claim !== claim.ref || opened.claim_token !== claim.token) {
      this.#log(`dispute: the challenge ${opened.challenge} spent the claim ${opened.claim}, and the evidence names the claim ${claim.ref}`);
      return after('challenge_wrong_claim', `the challenge ${opened.challenge} spent the claim output ${opened.claim}, and the evidence names the claim output ${claim.ref}`, {
        challenge: { tx_hash: opened.tx_hash, challenge: opened.challenge, challenge_token: opened.challenge_token, claim: opened.claim, claim_token: opened.claim_token },
      });
    }
    const filed: ChallengeFiled = {
      record: { claim: opened.claim, evidence: evidence.tx_hash, challenge: opened.challenge }, claim_token: opened.claim_token, against_did: claim.claimer,
      evidence_uri: evidence.uri, evidence_hash: evidence.document_hash, challenge_tx: opened.tx_hash, challenge_token: opened.challenge_token,
      stake_lovelace: opened.stake_lovelace, deadline: opened.deadline, fee_lovelace: published.value.fee_lovelace + opened.fee_lovelace, extra_evidence: null,
    };
    await this.#finish(escrow, landed, accepted(filed));
    this.#log(`dispute: challenge ${filed.record.challenge} filed against the claim ${filed.record.claim} of ${filed.against_did} with the evidence ${filed.record.evidence}`);
    return accepted(filed);
  }
}

/**
 * A challenge input that passed its checks: the other party, the job with its scope, and the facts of the evidence as a copy of plain JSON data. `party` says who the other party is: the counterparty that this
 * agent hired (a delivery), or the sender that hired this agent (an approval).
 */
interface ChallengeTarget {
  readonly party: 'counterparty' | 'sender';
  readonly against: Did;
  readonly escrow: OutputRef;
  readonly scope: ClaimScope;
  readonly facts: JsonObject;
}

const isObject = (value: JsonValue): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The party, the job and the facts of a challenge input. A member that the input must not have is refused, so no text of a request gets in by chance. */
function parseChallengeInput(input: unknown, party: 'counterparty' | 'sender', kinds: readonly string[]): ProtocolResult<ChallengeTarget, 'bad_shape'> {
  const copy = parseJsonValue(input, 'challenge');
  if (!copy.ok) return copy;
  if (!isObject(copy.value)) return refused('bad_shape', 'challenge must be a JSON object');
  const members = checkMembers(copy.value, 'challenge', [party, 'escrow_ref', 'capability_id', 'statement_text', 'evidence']);
  if (members !== null) return members;
  const against = parseDid(copy.value[party], `challenge.${party}`);
  if (!against.ok) return against;
  const scope = parseClaimScope(copy.value, 'challenge');
  if (!scope.ok) return scope;
  const facts = copy.value.evidence;
  if (!isObject(facts)) return refused('bad_shape', 'challenge.evidence must be a JSON object');
  if (typeof facts.kind !== 'string' || !kinds.includes(facts.kind)) return refused('bad_shape', `challenge.evidence.kind must be one of: ${kinds.join(', ')}`);
  return accepted({ party, against: against.value, escrow: scope.value.escrow_ref, scope: scope.value, facts });
}

/** The escrow, the capability and the statement of a job, from the members of an object that `checkMembers` passed. The detail names the member and never repeats the value. */
function parseClaimScope(record: JsonObject, field: string): ProtocolResult<ClaimScope, 'bad_shape'> {
  const escrow = parseOutputRef(record.escrow_ref, `${field}.escrow_ref`);
  if (!escrow.ok) return escrow;
  const capability = parseCapabilityId(record.capability_id, `${field}.capability_id`);
  if (!capability.ok) return capability;
  const statement = parseStatementText(record.statement_text, `${field}.statement_text`);
  if (!statement.ok) return refused('bad_shape', statement.detail);
  return accepted({ escrow_ref: escrow.value, capability_id: capability.value, statement_text: statement.value });
}

/** A scope that a caller gives alone, as a copy of plain data, or a refusal. */
function parseScope(input: unknown, field: string): ProtocolResult<ClaimScope, 'bad_shape'> {
  const copy = parseJsonValue(input, field);
  if (!copy.ok) return copy;
  if (!isObject(copy.value)) return refused('bad_shape', `${field} must be a JSON object`);
  const members = checkMembers(copy.value, field, ['escrow_ref', 'capability_id', 'statement_text']);
  return members !== null ? members : parseClaimScope(copy.value, field);
}
