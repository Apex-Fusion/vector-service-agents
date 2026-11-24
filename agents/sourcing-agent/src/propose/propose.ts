// agents/sourcing-agent/src/propose/propose.ts
// The job `propose` of the Sourcing Agent (use case 3, supplier bid evaluation). It reads the bidders, lets the model shortlist them, hires the invited bidders for their quotes, scores the accepted quotes, lets
// the model rank the scores, and returns the ranking as the proposal. The model decides whom to invite, whether to accept each quote, every score and the order. This job makes the ranking from what it holds:
// the quote of each entry is the quote that the agent accepted, and never a word of the model. The hirer reads the ranking and approves its digest, and `execute` then writes it to the sourcing record.
//
// The steps, in this order. A failure of a step is a typed result: `failedSourcing` with a code, and no step reads success from a text.
//   1. The authority. A delegation that names another agent as its delegate is a refusal that the service answers with its status (`ProposeRefusal`, `delegation_not_mine`). A delegation that the ledger does not
//      show goes on, because the ledger decides when a quote is paid. A ledger that cannot be read is `failed` `ledger_unavailable`.
//   2. The delegation key: the delegate key of the delegation, found among the delegation keys of this agent. No hire and no sub-delegation is possible without it, and nothing is sent: `ledger_unavailable` for
//      a ledger that cannot be read, `delegation_not_found` for a delegation that the ledger does not show, `delegation_key_unknown` for a key that this agent does not hold.
//   3. The bidders. The signal is read, and then the discovery reads a file for each candidate. A failure is `failed` with `bidders_unavailable` or `no_bidders`.
//   4. The shortlist. The signal is read before it, because the decision is a model hire. A failed answer is `failed` with its code. The choice is used only when it EQUALS the choice that the decision records,
//      and the job reads the recorded copy: no code changes what the model chose, and a difference is `failed` `decision_mismatch`. Every invited DID must be a candidate (`shortlist_unknown_bidder`), and an
//      empty invitation is `nobody_invited`. The decision stays in the result in both cases.
//
// The organisation of a bidder is passed on only when its file says that the gateway verified it. A domain that a bidder states and no check backs never picks a vendor entry and never reaches the ranking.
//
// Every answer of a port is read one time. The job keeps what it read in constants and copies, and it never goes back to an object of a port, because a port could change its objects while the job waits for
// the next port. The files of the bidders that go to the result are copies that the job made before it handed the files out.
//
// Time. Every wait of the job is bounded by the deadline: `PROPOSE_DEADLINE_MS` after the arrival of the job. A call of a port that would start after it is not made. A caller that hangs up stops the job before
// its next step: no step starts after that, and what the job paid for stays in the result.
import { buildRanking, parseRfqDocument, parseWeights } from '@vsa/usecase-kit/bids';
import type { RfqDocument, Weights } from '@vsa/usecase-kit/bids';
import { checkAuthority } from '@vsa/usecase-kit/buyer';
import { ERROR_STATUS, canonicalJson, isPlainObject, parseDid, parseJsonValue, parseOutputRef } from '@vsa/usecase-kit/protocol';
import type { Decision, DelegationId, Did, JsonValue, SubJob, TenantId } from '@vsa/usecase-kit/protocol';
import type { BidderFile, BidderView, ProposeDeps, ProposeRequest, QuoteRecord } from './ports.ts';
import { failedSourcing } from './result.ts';
import type { Held, SourcingFailed } from './result.ts';

/** The job deadline of the Sourcing Agent: the time from the arrival of a job to the end of every wait of `propose`, in milliseconds. It is the window of 3,600,000 ms less 180,000 ms. */
export const PROPOSE_DEADLINE_MS = 3_420_000;

/** The time that the job keeps for the ranking decision and the build of the document, in milliseconds. */
export const RANKING_RESERVE_MS = 120_000;

/**
 * The time that must be left when the scoring starts, in milliseconds: the 720,000 ms that one scorer needs (the least wait for 30 confirmations, the job of the scorer and the end of its
 * sub-delegation) and the time of the ranking. The quote fan-out keeps the same time after its last hire.
 */
export const SCORING_RESERVE_MS = 720_000 + RANKING_RESERVE_MS;

/** The most bidders that one job invites: it has one scorer for each. */
const MOST_INVITED = 3;
/** The most candidates that a ranking can list as excluded: the limit of the document. */
const MOST_LISTED = 20;

const TENANT_RULE = 'request.tenant must be 1 to 48 characters: lower-case letters, digits and hyphens, and it starts with a letter or a digit';

/** The codes of the steps of this folder that are written so far. The codes of a decision, of the fan-out and of the scoring pass through, and they are not in this list. */
const FRONT_FAILURES = [
  'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'bidders_unavailable', 'no_bidders', 'shortlist_unknown_bidder', 'nobody_invited', 'decision_mismatch', 'bad_document', 'deadline',
  'aborted', 'internal',
] as const;

/**
 * Every code that `runPropose` gives as the reason of a failed proposal, except the codes that pass through from a model decision, from the quote fan-out and from the scoring. Those come from the lists of
 * the decision folder of the kit, of the quotes folder and of the scoring folder.
 */
export const PROPOSE_FAILURES: readonly string[] = Object.freeze([...FRONT_FAILURES]);

/**
 * A request that the job refuses before it does anything: a delegation that names another agent (`delegation_not_mine`), and a request that cannot make a ranking (`bad_shape`). The status is the status of
 * the code in `ERROR_STATUS`. The message names the member and never repeats a value of the request.
 */
export class ProposeRefusal extends Error {
  readonly code: 'delegation_not_mine' | 'bad_shape';
  readonly status: number;

  constructor(code: 'delegation_not_mine' | 'bad_shape', message: string) {
    super(message);
    this.name = 'ProposeRefusal';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/** A ranked entry that every request can make. The job builds a trial ranking with it before it pays for anything: a tenant that the ranking refuses would be found after the money was spent. */
const ZERO_HASH = '0'.repeat(64);
const STAND_IN_ENTRY = {
  desk_did: `did:vector:${ZERO_HASH}`,
  score: 0,
  components: { price: 0, lead_time: 0, reliability: 0, compliance: 0 },
  quote: { escrow_ref: `${ZERO_HASH}#0`, receipt_sha256: ZERO_HASH, total: 0, lead_time_days: 0 },
} as const;

/** The answer of one call of a port: its value, a throw, or the end of the time. */
type Attempt<T> = { readonly state: 'value'; readonly value: T } | { readonly state: 'threw' } | { readonly state: 'timed_out' };

const EXPIRED = Symbol('expired');

/** The time that a clock gives, or null when it throws or gives a value that is not a finite number. An unknown time is never enough time. */
function timeOf(clock: () => number): number | null {
  try {
    const now: unknown = clock();
    return typeof now === 'number' && Number.isFinite(now) ? now : null;
  } catch {
    return null;
  }
}

/** What one job knows and holds: its deps, the copies that it made of the request, its deadline, the signal of the caller, and what it paid for and read so far. */
export class Job<K> {
  readonly deps: ProposeDeps<K>;
  readonly rfq: RfqDocument;
  readonly weights: Weights;
  readonly tenant: TenantId;
  readonly delegation: DelegationId;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  /** The decisions that the job paid for, in the order of the page. */
  readonly decisions: Decision[] = [];
  /** The quote job of each accepted quote. */
  readonly subJobs: SubJob[] = [];
  /** The file of every candidate, as copies that the job made. */
  bidders: readonly BidderFile[] = [];
  /** The record of every quote job that has one. */
  readonly quotes: QuoteRecord[] = [];

  constructor(deps: ProposeDeps<K>, request: ProposeRequest, arrivedAt: number, signal: AbortSignal | undefined) {
    const rfq = parseRfqDocument(request.rfq, 'request.rfq');
    if (!rfq.ok) throw new ProposeRefusal('bad_shape', rfq.detail);
    const weights = parseWeights(request.weights, 'request.weights');
    if (!weights.ok) throw new ProposeRefusal('bad_shape', weights.detail);
    const trial = buildRanking({ rfq: rfq.value, tenant: request.tenant, weights: weights.value, entries: [STAND_IN_ENTRY], excluded: [] });
    if (!trial.ok) throw new ProposeRefusal('bad_shape', TENANT_RULE);
    this.deps = deps;
    this.rfq = rfq.value;
    this.weights = weights.value;
    this.tenant = request.tenant;
    this.delegation = request.authority.delegation;
    this.deadline = arrivedAt + PROPOSE_DEADLINE_MS;
    this.signal = signal;
  }

  /** What the job holds, for a result. */
  held(): Held {
    return { decisions: this.decisions, sub_jobs: this.subJobs, bidders: this.bidders, quotes: this.quotes };
  }

  /** Writes one line to the log of the deps. A log that throws changes no result: the line is lost, and the job goes on. */
  note(line: string): void {
    try {
      this.deps.log(line);
    } catch {
      // The line is lost. The result of the job does not depend on it.
    }
  }

  /** The failed result for a step. The reason is the code, or `internal` for any text that is not a code. What the job holds stays in the result. */
  failed(step: string, code: unknown): SourcingFailed {
    const result = failedSourcing(this.held(), code);
    this.note(`propose stopped at ${step}: ${result.reason}`);
    return result;
  }

  /** The failed result for a call that gave no value: the deadline came first, or the call threw and `threw` is the code for it. */
  lost(step: string, answer: Attempt<unknown>, threw: string): SourcingFailed {
    return this.failed(step, answer.state === 'timed_out' ? 'deadline' : threw);
  }

  /** The failed result for a job that must not start another step: the caller hung up, or the deadline came. A clock that gives no time counts as the deadline. */
  stopped(step: string): SourcingFailed | null {
    if (this.signal?.aborted === true) return this.failed(step, 'aborted');
    const now = timeOf(this.deps.clock);
    return now !== null && now < this.deadline ? null : this.failed(step, 'deadline');
  }

  /**
   * Runs a call of a port and gives its answer. The call is bounded by the time that is left until the deadline, and it is not made when no time is left. A throw is `threw`, and the words of the error are
   * dropped: they could repeat a part of a quote.
   */
  async attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
    const now = timeOf(this.deps.clock);
    if (now === null) return { state: 'timed_out' };
    const left = Math.min(this.deadline - now, PROPOSE_DEADLINE_MS);
    if (!(left >= 1)) return { state: 'timed_out' };
    let timer: NodeJS.Timeout | undefined;
    // The executor form: Promise.withResolvers is not in the types of the target of this package.
    const expired = new Promise<typeof EXPIRED>((resolve) => {
      timer = setTimeout(() => resolve(EXPIRED), left);
    });
    try {
      const outcome = await Promise.race([Promise.resolve().then(call), expired]);
      return outcome === EXPIRED ? { state: 'timed_out' } : { state: 'value', value: outcome };
    } catch {
      return { state: 'threw' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** True when a decision holds the sub-job that bought it, with the members that the result shows. */
export function isDecision(value: unknown): value is Decision {
  if (typeof value !== 'object' || value === null) return false;
  const inference: unknown = Reflect.get(value, 'inference');
  if (typeof inference !== 'object' || inference === null) return false;
  const subJob: unknown = Reflect.get(inference, 'sub_job');
  return typeof Reflect.get(value, 'name') === 'string' && typeof Reflect.get(value, 'reasoning') === 'string' && typeof subJob === 'object' && subJob !== null;
}

/**
 * The recorded choice of a decision, as a copy that the job checked, or a code. The typed choice that the port gave must be the choice that the decision records: the comparison is the comparison of the
 * canonical forms. The copy is the recorded one, each text as the model wrote it, and the job reads that copy and never an object of the port.
 */
export function checkedChoice(typed: unknown, recorded: unknown): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly code: 'bad_document' | 'decision_mismatch' } {
  const typedCopy = parseJsonValue(typed, 'choice');
  const recordedCopy = parseJsonValue(recorded, 'decision.choice');
  if (!typedCopy.ok || !recordedCopy.ok) return { ok: false, code: 'bad_document' };
  const typedText = canonicalJson(typedCopy.value, 'choice');
  const recordedText = canonicalJson(recordedCopy.value, 'decision.choice');
  if (typedText.ok !== true || recordedText.ok !== true) return { ok: false, code: 'bad_document' };
  return typedText.value === recordedText.value ? { ok: true, value: recordedCopy.value } : { ok: false, code: 'decision_mismatch' };
}

/** True when `value` is a list of texts. */
function isTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * The bidders that the discovery gave, when each has the members that this job reads: a file with a DID and an advert reference, and a price list that is an object or null. A DID that stands two times, or
 * more candidates than a ranking can list, is a port that broke its contract. The result is `null` then.
 */
function viewsOf(value: unknown): readonly BidderView[] | null {
  if (!isPlainObject(value) || !Array.isArray(value.bidders)) return null;
  const views: readonly unknown[] = value.bidders;
  if (views.length > MOST_LISTED) return null;
  const seen = new Set<string>();
  for (const view of views) {
    if (!isPlainObject(view) || !isPlainObject(view.file)) return null;
    const file = view.file;
    if (!parseDid(file.did).ok || !parseOutputRef(file.advert_ref).ok || seen.has(file.did as string)) return null;
    if (view.price_list !== null && !isPlainObject(view.price_list)) return null;
    seen.add(file.did as string);
  }
  return views as readonly BidderView[];
}

/**
 * The DIDs that the recorded choice of the shortlist invites, in its order, or the code that says why the job stops. The shape comes first: the choice must hold `invite` as a list of texts. Then every DID must
 * be a candidate (`shortlist_unknown_bidder`), no DID may stand two times and at most three may be invited, and the list may not be empty (`nobody_invited`).
 */
function inviteOf(chosen: JsonValue, known: ReadonlySet<string>): { readonly ok: true; readonly invite: readonly Did[] } | { readonly ok: false; readonly code: string } {
  const list: unknown = isPlainObject(chosen) ? chosen.invite : undefined;
  if (!isTexts(list)) return { ok: false, code: 'bad_document' };
  if (!list.every((did) => known.has(did))) return { ok: false, code: 'shortlist_unknown_bidder' };
  if (new Set(list).size !== list.length || list.length > MOST_INVITED) return { ok: false, code: 'bad_document' };
  if (list.length === 0) return { ok: false, code: 'nobody_invited' };
  return { ok: true, invite: list };
}

/** What the steps 1 to 4 give to the steps after them: the job, the delegation key, the bidders as copies, and the DIDs that the model invites, in its order. */
export interface Front<K> {
  readonly job: Job<K>;
  readonly key: K;
  /** Copies that the job made before it gave the files to a port: the candidates, in the order of the discovery. */
  readonly candidates: readonly BidderView[];
  readonly invite: readonly Did[];
}

export type Fronted<K> = { readonly ok: true; readonly front: Front<K> } | { readonly ok: false; readonly result: SourcingFailed };

/**
 * The steps 1 to 4 of `propose`: the authority, the delegation key, the bidders and the shortlist. It throws `ProposeRefusal` for a request that it refuses before it does anything. It returns the failed
 * result of the first step that fails, with the decision of the shortlist when the model made one, or what the later steps need. Nothing is paid before the shortlist.
 */
export async function runFront<K>(deps: ProposeDeps<K>, request: ProposeRequest, arrivedAt: number, signal?: AbortSignal): Promise<Fronted<K>> {
  const job = new Job(deps, request, arrivedAt, signal);
  const stop = (result: SourcingFailed): Fronted<K> => ({ ok: false, result });

  // 1. The authority.
  const beforeAuthority = job.stopped('authority');
  if (beforeAuthority !== null) return stop(beforeAuthority);
  const authority = await job.attempt(() => checkAuthority(deps.reads, deps.agent.did, job.delegation));
  if (authority.state !== 'value') return stop(job.lost('authority', authority, 'internal'));
  const checked = authority.value;
  if (checked.ok !== true) {
    if (checked.code === 'ledger_unavailable') return stop(job.failed('authority', 'ledger_unavailable'));
    job.note(`propose refused at authority: ${checked.code}`);
    throw new ProposeRefusal(checked.code, checked.detail);
  }

  // 2. The delegation key.
  const beforeKey = job.stopped('delegation_key');
  if (beforeKey !== null) return stop(beforeKey);
  const keyHash = await job.attempt(() => deps.delegateKeyOf(job.delegation));
  if (keyHash.state !== 'value') return stop(job.lost('delegation_key', keyHash, 'ledger_unavailable'));
  if (keyHash.value === null) return stop(job.failed('delegation_key', 'delegation_not_found'));
  let key: K | null;
  try {
    key = typeof keyHash.value === 'string' ? deps.delegationKeys.find(keyHash.value) : null;
  } catch {
    return stop(job.failed('delegation_key', 'internal'));
  }
  if (key === null || key === undefined) return stop(job.failed('delegation_key', 'delegation_key_unknown'));

  // 3. The bidders.
  const beforeBidders = job.stopped('bidders');
  if (beforeBidders !== null) return stop(beforeBidders);
  const discovered = await job.attempt(() => deps.discover());
  if (discovered.state !== 'value') return stop(job.lost('bidders', discovered, 'internal'));
  const found = discovered.value;
  if (typeof found !== 'object' || found === null) return stop(job.failed('bidders', 'internal'));
  if (found.ok !== true) {
    const code: string = found.code;
    return stop(job.failed('bidders', code === 'bidders_unavailable' || code === 'no_bidders' ? code : 'internal'));
  }
  const views = viewsOf(found.value);
  if (views === null) return stop(job.failed('bidders', 'internal'));
  // The files go to the shortlist as they are. The job keeps copies for itself and for the result, so a port that changes its objects changes nothing here.
  let candidates: BidderView[];
  try {
    candidates = structuredClone([...views]);
  } catch {
    return stop(job.failed('bidders', 'internal'));
  }
  job.bidders = candidates.map((candidate) => candidate.file);
  const known: ReadonlySet<string> = new Set(candidates.map((candidate) => candidate.file.did));

  // 4. The shortlist.
  const beforeShortlist = job.stopped('shortlist');
  if (beforeShortlist !== null) return stop(beforeShortlist);
  const decided = await job.attempt(() => deps.shortlist(job.rfq, views.map((view) => view.file)));
  if (decided.state !== 'value') return stop(job.lost('shortlist', decided, 'internal'));
  const answer = decided.value;
  if (typeof answer !== 'object' || answer === null) return stop(job.failed('shortlist', 'internal'));
  if (answer.ok !== true) return stop(job.failed('shortlist', answer.code));
  const decision: unknown = answer.decision;
  const typed: unknown = answer.choice;
  if (!isDecision(decision)) return stop(job.failed('shortlist', 'internal'));
  // The model was paid for this decision: it stays in the result, whatever the checks below find.
  job.decisions.push(decision);
  const recorded = checkedChoice(typed, decision.choice);
  if (!recorded.ok) return stop(job.failed('shortlist', recorded.code));
  job.decisions[0] = { ...decision, choice: recorded.value };
  const invited = inviteOf(recorded.value, known);
  if (!invited.ok) return stop(job.failed('shortlist', invited.code));
  return { ok: true, front: { job, key, candidates, invite: invited.invite } };
}
