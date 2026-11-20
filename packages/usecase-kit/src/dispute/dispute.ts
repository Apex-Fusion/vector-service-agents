// packages/usecase-kit/src/dispute/dispute.ts
// The Module-1 path of an agent: the claim of a run, the lookup of the open claim of an agent, the challenge, and the withdrawal. The class holds the order of the steps and the guards. The chain, the queue
// of the service key and the clock come in as ports (ports.ts), so a test runs it on a scripted port and on the fixture world.
//
// The order of a challenge is fixed, and each step is checked before the next one starts:
//   1. Find the open claim of the OTHER party, and nothing else. No open claim ends the job with `no_open_claim`. More than one open claim ends it with `claim_ambiguous`: the code never guesses.
//   2. Make the evidence document. A document that is refused ends the job. Nothing is on chain yet.
//   3. Publish the evidence document, and wait for its confirmation. A document that is not confirmed ends the job. The challenge is not built.
//   4. In one job of the queue: read the claim again, and build the challenge against the exact output that the evidence names. A claim that changed ends the job.
// A job (one escrow) gets one challenge. Once a transaction of a job landed or may land, the job takes no second attempt.
//
// Every transaction runs in the queue of the service key. The code of a caller must not call a method of this class from inside a job of the same queue: the call would wait for itself.
import { NO_OPEN_CLAIM, accepted, parseDid, parseJsonValue, parseOutputRef, refused, checkMembers } from '../protocol/index.ts';
import type { Did, Digest, JsonObject, JsonValue, ManifestClaim, OutputRef, ProtocolResult, Refused } from '../protocol/index.ts';
import { JUROR_MEDIA_TYPE, claimDocument, evidenceDocument } from './documents.ts';
import type { ApprovalDigestFacts, EvidenceDocumentInput, OrderConfirmationFacts, QuotePriceFacts } from './documents.ts';
import { challengeDeadlineOf } from './ports.ts';
import type { ClaimView, Module1Port, OpenedChallenge, ServiceQueue, TxNotBuilt, TxNotConfirmed, TxResult } from './ports.ts';
import type {
  ChallengeCode, ChallengeFiled, ChallengeNotFiled, ChallengeResult, ClaimLookupCode, ClaimWithdrawn, DocumentLanded, RunClaimNotStaked, RunClaimResult, SentNotConfirmed, WithdrawNotDone,
  WithdrawResult,
} from './results.ts';
import { describeError } from './text.ts';

/** What a challenge needs besides the evidence. The caller reads the values from its own settings: the code has no default. */
export interface DisputeSettings {
  /** The stake of a challenge. It must be at least the stake of the claim that it challenges: a challenge with less is refused before anything is published. */
  readonly challenge_stake_lovelace: bigint;
  /** The time that the oracle and the jury have to resolve a challenge, counted from its start. The Module-1 deployment names its own value. */
  readonly resolution_deadline_ms: number;
  /** The least time that must be left in the challenge window of a claim when the evidence is published. Use the time that the evidence needs to confirm, and some more. At least 2,000. */
  readonly min_window_left_ms: number;
}

export interface DisputeDeps {
  readonly port: Module1Port;
  readonly queue: ServiceQueue;
  /** The time in POSIX milliseconds. */
  readonly clock: () => number;
  readonly settings: DisputeSettings;
  /** One line for each step. A line has references of the chain and codes: it has no key and no part of a request. */
  readonly log?: (line: string) => void;
}

/** A buyer-side agent whose model did not accept a delivery. */
export interface DeliveryChallengeInput {
  /** The agent that made the delivery. Its open claim is challenged. */
  readonly counterparty: Did;
  /** The escrow of the job. A job gets one challenge. */
  readonly escrow_ref: OutputRef;
  readonly evidence: OrderConfirmationFacts | QuotePriceFacts;
}

/** A counterparty that refused a request because the digest of the approval is not the digest of the request. */
export interface ApprovalChallengeInput {
  /** The sender of the request. Its open claim is challenged. */
  readonly sender: Did;
  /** The escrow of the job. A job gets one challenge. */
  readonly escrow_ref: OutputRef;
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
  /** The category tag of the claim: 1 to 64 bytes of text. */
  readonly claim_type: string;
}

export interface WithdrawClaimInput {
  readonly claim: OutputRef;
}

const LEAST_WINDOW_LEFT_MS = 2_000;

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

const notFiled = (code: ChallengeCode, detail: string, landed: Partial<Pick<ChallengeNotFiled, 'evidence' | 'sent'>> = {}): ChallengeNotFiled => ({
  ok: false, code, detail, evidence: null, sent: null, ...landed,
});

const sentOf = (result: { tx_hash: string; valid_to: number; may_land: boolean }): SentNotConfirmed => ({ tx_hash: result.tx_hash, valid_to: result.valid_to, may_land: result.may_land });

/** A transaction step that did not confirm: the port did not build it, it was sent and not seen confirmed, or the port itself failed. */
type StepFailure = TxNotBuilt | TxNotConfirmed | Refused<'port_error'>;

/** The code of the step that failed, its detail, and the transaction that was sent and not seen confirmed. `built` and `confirmed` are the codes of this step for the first two failures. */
function failed<B extends string, C extends string>(failure: StepFailure, built: B, confirmed: C): { readonly code: B | C | 'port_error'; readonly detail: string; readonly sent: SentNotConfirmed | null } {
  if (failure.code === 'not_built') return { code: built, detail: failure.detail, sent: null };
  if (failure.code === 'not_confirmed') return { code: confirmed, detail: failure.detail, sent: sentOf(failure) };
  return { code: 'port_error', detail: failure.detail, sent: null };
}

/** Why a claim is no longer the open claim that was read before, or null when nothing changed. */
function changeOf(before: ClaimView, after: ClaimView | null, now: number): string | null {
  if (after === null) return 'the claim output is spent or is not a claim output any more';
  if (after.state !== 'Open') return `the claim is ${after.state} now`;
  if (after.token !== before.token || after.claimer !== before.claimer) return 'the output holds another claim now';
  if (now >= challengeDeadlineOf(after)) return 'the challenge window of the claim ended';
  return null;
}

/** The earliest moment of a withdrawal: the first whole second after the challenge window. Module-1 needs the start of the transaction strictly after the window. */
const withdrawableFrom = (claim: ClaimView): number => Math.ceil((challengeDeadlineOf(claim) + 1) / 1000) * 1000;

/** What a challenge step knows when it ends: the result, and whether a transaction of the job landed or may land. */
interface Ended {
  readonly result: ChallengeResult;
  readonly landed: boolean;
}

export class Dispute {
  readonly #port: Module1Port;
  readonly #queue: ServiceQueue;
  readonly #clock: () => number;
  readonly #settings: DisputeSettings;
  readonly #log: (line: string) => void;
  /** The jobs that have a challenge in progress or a transaction that landed. */
  readonly #jobs = new Map<OutputRef, 'pending' | 'landed'>();

  /** Refuses settings of the wrong type before anything is read: a challenge stake that is not a bigint, or a time that is not a whole number, is an error and never "no limit". */
  constructor(deps: DisputeDeps) {
    const settings = deps.settings;
    this.#settings = {
      challenge_stake_lovelace: requireBigint(settings.challenge_stake_lovelace, 'settings.challenge_stake_lovelace'),
      resolution_deadline_ms: requireMilliseconds(settings.resolution_deadline_ms, 'settings.resolution_deadline_ms', 1),
      min_window_left_ms: requireMilliseconds(settings.min_window_left_ms, 'settings.min_window_left_ms', LEAST_WINDOW_LEFT_MS),
    };
    this.#port = deps.port;
    this.#queue = deps.queue;
    this.#clock = deps.clock;
    this.#log = deps.log ?? (() => undefined);
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('the clock must give POSIX milliseconds');
    return now;
  }

  async #readClaims(): Promise<ProtocolResult<readonly ClaimView[], 'chain_unavailable'>> {
    try {
      const claims = await this.#port.readClaims();
      return Array.isArray(claims) ? accepted(claims) : refused('chain_unavailable', 'the claims cannot be read: the port gave no list');
    } catch (error) {
      return refused('chain_unavailable', `the claims cannot be read from the chain: ${describeError(error)}`);
    }
  }

  /** Runs a job in the queue of the service key. A job that throws gives `port_error`: the port must describe each problem with a result, so a throw is a defect, and a transaction may have landed. */
  async #queued<T>(job: () => Promise<T>): Promise<T | Refused<'port_error'>> {
    try {
      return await this.#queue.run(job);
    } catch (error) {
      return refused('port_error', `the chain port or the queue failed, and a transaction may have landed: ${describeError(error)}`);
    }
  }

  // --- The open claim of an agent -------------------------------------------------------------------------------------------------------------------------------------

  /**
   * The open claim of an agent that can still be challenged: its state is Open, and its challenge window has not ended. `no_open_claim` says that there is none. `claim_ambiguous` says that there
   * are several: the code does not choose, because the wrong choice would challenge the wrong claim. `chain_unavailable` says that the claims could not be read, and it is never `no_open_claim`.
   */
  async findOpenClaim(did: Did): Promise<ProtocolResult<ClaimView, ClaimLookupCode>> {
    const checked = parseDid(did, 'did');
    if (!checked.ok) return checked;
    const read = await this.#readClaims();
    if (!read.ok) return read;
    const now = this.#now();
    const open = read.value.filter((claim) => claim.claimer === checked.value && claim.state === 'Open');
    const live = open.filter((claim) => now < challengeDeadlineOf(claim));
    if (live.length === 1) return accepted(live[0]!);
    if (live.length > 1) return refused('claim_ambiguous', `the agent has ${live.length} open claims, and the code does not choose between them`);
    return refused(NO_OPEN_CLAIM, open.length === 0 ? 'the agent has no open claim' : `the agent has ${open.length} open claim(s), and the challenge window of each has ended`);
  }

  /** Every claim of an agent whose state is Open, whatever its window, the newest first. An operator reads it to withdraw the claims that nobody challenged. */
  async listOpenClaims(did: Did): Promise<ProtocolResult<readonly ClaimView[], 'bad_shape' | 'chain_unavailable'>> {
    const checked = parseDid(did, 'did');
    if (!checked.ok) return checked;
    const read = await this.#readClaims();
    if (!read.ok) return read;
    const open = read.value.filter((claim) => claim.claimer === checked.value && claim.state === 'Open');
    return accepted([...open].sort((a, b) => b.submitted_at - a.submitted_at));
  }

  // --- The claim of a run ---------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Stakes the claim of a run: it publishes the claim document, waits for its confirmation, and then submits the claim with the hash and the URI of that document. The claim holds `stake_lovelace`
   * until the challenge window ends. A step that fails after the document landed says so in `document`.
   */
  async stakeRunClaim(input: RunClaimInput): Promise<RunClaimResult> {
    const { capability_id, manifest_sha256, claim, stake_lovelace, challenge_window_ms, claim_type } = input;
    const stake = requireBigint(stake_lovelace, 'stake_lovelace');
    const window = requireMilliseconds(challenge_window_ms, 'challenge_window_ms', 1);
    if (typeof claim_type !== 'string' || claim_type.length === 0) throw new TypeError('claim_type must be a text');
    const notStaked = (code: RunClaimNotStaked['code'], detail: string, landed: Partial<Pick<RunClaimNotStaked, 'document' | 'sent'>> = {}): RunClaimNotStaked => ({
      ok: false, code, detail, document: null, sent: null, ...landed,
    });
    const me = this.#port.agent.did;
    const document = claimDocument({ agent_did: me, capability_id, manifest_sha256, claim });
    if (!document.ok) return notStaked(document.code, document.detail);

    const published = await this.#queued(() => this.#port.publishDocument({ bytes: document.value.bytes, type: 'claim', media_type: JUROR_MEDIA_TYPE }));
    if (!published.ok) {
      const why = failed(published, 'claim_document_not_built', 'claim_document_not_confirmed');
      return notStaked(why.code, why.detail, { sent: why.sent });
    }
    if (published.value.document_hash !== document.value.hash) return notStaked('port_error', 'the port published a document with another hash than the claim document');
    const landed: DocumentLanded = { tx_hash: published.value.tx_hash, uri: published.value.uri, document_hash: published.value.document_hash };
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
    let claim: ClaimView | null;
    try {
      claim = await this.#port.readClaim(ref.value);
    } catch (error) {
      return notDone('chain_unavailable', `the claim cannot be read from the chain: ${describeError(error)}`);
    }
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
    const earlier = this.#jobs.get(target.escrow);
    if (earlier !== undefined) {
      return notFiled('job_already_disputed', earlier === 'pending' ? 'a challenge for this job is in progress' : 'a transaction of a challenge for this job landed or may land, and a job gets one challenge');
    }
    this.#jobs.set(target.escrow, 'pending');
    let ended: Ended;
    try {
      ended = await this.#fileJob(target, me);
    } catch (error) {
      ended = { result: notFiled('port_error', `the challenge stopped with an error, and a transaction may have landed: ${describeError(error)}`), landed: true };
    }
    if (ended.landed) this.#jobs.set(target.escrow, 'landed');
    else this.#jobs.delete(target.escrow);
    return ended.result;
  }

  async #fileJob(target: ChallengeTarget, me: Did): Promise<Ended> {
    const nothing = (code: ChallengeCode, detail: string): Ended => ({ result: notFiled(code, detail), landed: false });
    // 1. The open claim of the other party.
    const found = await this.findOpenClaim(target.against);
    if (!found.ok) {
      this.#log(`dispute: no challenge for the job ${target.escrow}: ${found.code}`);
      return nothing(found.code, found.detail);
    }
    const claim = found.value;
    if (claim.stake_lovelace > this.#settings.challenge_stake_lovelace) return nothing('challenge_stake_too_low', 'the challenge stake is below the stake of the claim');
    if (challengeDeadlineOf(claim) - this.#now() < this.#settings.min_window_left_ms) return nothing('claim_window_closing', 'the challenge window of the claim ends too soon for the evidence to confirm');

    // 2. The evidence document: refused here, and nothing is on chain.
    const document = evidenceDocument({
      ...target.facts, claim: claim.ref, claim_token: claim.token, against_did: claim.claimer, by_did: me, escrow_ref: target.escrow,
    } as unknown as EvidenceDocumentInput);
    if (!document.ok) return nothing(document.code, document.detail);

    // 3. The evidence is published first, and the challenge waits for its confirmation.
    const published = await this.#queued(() => this.#port.publishDocument({ bytes: document.value.bytes, type: 'evidence', media_type: JUROR_MEDIA_TYPE }));
    if (!published.ok) {
      const why = failed(published, 'evidence_not_built', 'evidence_not_confirmed');
      return { result: notFiled(why.code, why.detail, { sent: why.sent }), landed: why.code !== 'evidence_not_built' };
    }
    if (published.value.document_hash !== document.value.hash) {
      return { result: notFiled('port_error', 'the port published a document with another hash than the evidence document'), landed: true };
    }
    const evidence: DocumentLanded = { tx_hash: published.value.tx_hash, uri: published.value.uri, document_hash: published.value.document_hash };
    this.#log(`dispute: evidence ${evidence.tx_hash} confirmed for the claim ${claim.ref} of ${claim.claimer}`);

    // 4. The challenge, against the exact output that the evidence names, in one job of the queue.
    const step = await this.#queued(async (): Promise<{ readonly stop: ChallengeCode; readonly detail: string } | { readonly sent: TxResult<OpenedChallenge> }> => {
      let again: ClaimView | null;
      try {
        again = await this.#port.readClaim(claim.ref);
      } catch (error) {
        return { stop: 'chain_unavailable', detail: `the claim cannot be read from the chain: ${describeError(error)}` };
      }
      const change = changeOf(claim, again, this.#now());
      if (change !== null) return { stop: 'claim_changed', detail: change };
      return {
        sent: await this.#port.openChallenge({
          claim: claim.ref, claim_token: claim.token, evidence_hash: evidence.document_hash, evidence_uri: evidence.uri, stake_lovelace: this.#settings.challenge_stake_lovelace,
          resolution_deadline_ms: this.#settings.resolution_deadline_ms,
        }),
      };
    });
    const after = (code: ChallengeCode, detail: string, sent: SentNotConfirmed | null = null): Ended => ({ result: notFiled(code, detail, { evidence, sent }), landed: true });
    if ('code' in step) return after(step.code, step.detail);
    if ('stop' in step) {
      this.#log(`dispute: the evidence ${evidence.tx_hash} landed and no challenge was filed: ${step.stop}`);
      return after(step.stop, step.detail);
    }
    const sent = step.sent;
    if (!sent.ok) {
      const why = failed(sent, 'challenge_not_built', 'challenge_not_confirmed');
      this.#log(`dispute: the evidence ${evidence.tx_hash} landed and no challenge was filed: ${why.code}`);
      return after(why.code, why.detail, why.sent);
    }
    const opened = sent.value;
    if (opened.claim !== claim.ref || opened.claim_token !== claim.token) {
      this.#log(`dispute: the challenge ${opened.challenge} spent the claim ${opened.claim}, and the evidence names the claim ${claim.ref}`);
      return after('challenge_wrong_claim', `the challenge ${opened.challenge} spent the claim output ${opened.claim}, and the evidence names the claim output ${claim.ref}`);
    }
    const filed: ChallengeFiled = {
      record: { claim: opened.claim, evidence: evidence.tx_hash, challenge: opened.challenge }, claim_token: opened.claim_token, against_did: claim.claimer,
      evidence_uri: evidence.uri, evidence_hash: evidence.document_hash, challenge_tx: opened.tx_hash, challenge_token: opened.challenge_token,
      stake_lovelace: opened.stake_lovelace, deadline: opened.deadline, fee_lovelace: published.value.fee_lovelace + opened.fee_lovelace,
    };
    this.#log(`dispute: challenge ${filed.record.challenge} filed against the claim ${filed.record.claim} of ${filed.against_did} with the evidence ${filed.record.evidence}`);
    return { result: accepted(filed), landed: true };
  }
}

/** A challenge input that passed its checks: the other party, the job, and the facts of the evidence as a copy of plain JSON data. */
interface ChallengeTarget {
  readonly against: Did;
  readonly escrow: OutputRef;
  readonly facts: JsonObject;
}

const isObject = (value: JsonValue): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The party, the job and the facts of a challenge input. A member that the input must not have is refused, so no text of a request gets in by chance. */
function parseChallengeInput(input: unknown, party: 'counterparty' | 'sender', kinds: readonly string[]): ProtocolResult<ChallengeTarget, 'bad_shape'> {
  const copy = parseJsonValue(input, 'challenge');
  if (!copy.ok) return copy;
  if (!isObject(copy.value)) return refused('bad_shape', 'challenge must be a JSON object');
  const members = checkMembers(copy.value, 'challenge', [party, 'escrow_ref', 'evidence']);
  if (members !== null) return members;
  const against = parseDid(copy.value[party], `challenge.${party}`);
  if (!against.ok) return against;
  const escrow = parseOutputRef(copy.value.escrow_ref, 'challenge.escrow_ref');
  if (!escrow.ok) return escrow;
  const facts = copy.value.evidence;
  if (!isObject(facts)) return refused('bad_shape', 'challenge.evidence must be a JSON object');
  if (typeof facts.kind !== 'string' || !kinds.includes(facts.kind)) return refused('bad_shape', `challenge.evidence.kind must be one of: ${kinds.join(', ')}`);
  return accepted({ against: against.value, escrow: escrow.value, facts });
}
