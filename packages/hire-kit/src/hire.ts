// packages/hire-kit/src/hire.ts
// One hire of a fleet supplier, the part every sub-job shares, an OCR page or a chat job: post the escrow and record it as stranded, hand the job to
// the supplier, poll it, read and check what it returns, accept, and only then forget the escrow. Every way it can end before the Accept is an error of
// the caller's factory (HireErrors): failure(hop, what), written <hop>_<what> below, deadline, or storeWrite, each with the facts of the moment it was
// thrown (HireFacts). The kit writes every message; the factory chooses the class, the code and the status. The escrow is left in the stranded store
// for the janitor (src/janitor.ts), which reclaims it after its deliver_by when it is Open or Claimed and keeps it when it is Submitted. The supplier's
// own endpoint, key and model were established before the Post (src/select.ts for a chat supplier); nothing a supplier says here moves value but its
// signed receipt, checked against the hash its Submit put on chain. A write of the stranded store that fails after an escrow was posted is the factory's
// storeWrite, naming the escrow, never a plain error; the one exception is the removal of an entry after its Accept is confirmed, which is logged and
// does not fail a job that is settled and verified (ruling R62). Moved from agents/document-pipeline/src/hire.ts with its rulings and its words; the
// Pipeline's factory makes PipelineError <hop>_<what> (422), deadline (422) and store_write_failed (500), as before.
//
// The Post. Confirmed: it is recorded in the stranded store before anything else, and then booked in the ledger of the caller. A ledger that throws leaves the escrow in the store, and a
// store that cannot be written still gets the lock booked. Failed after its signature: recorded too, with the end of its
// validity, whether it may still land or the submit API refused it (ruling R59), and <hop>_post_failed. Failed before its signature: nothing was locked.
//
// The send (75 s at most each). Accepted: there is a job id to poll. Busy (409 supplier_busy): sent again every 15 s, on the same escrow, until 90 s
// before its deliver_by (<hop>_busy). Not found (404 escrow_not_found, ruling R32): the supplier looks the Post output up before anything else, and
// does not find it either because it does not see the Post yet or because its own Claim, after an earlier send whose answer was lost, has spent it.
// So the escrow is read: Open, and the job is sent again like a busy one (<hop>_refused for a supplier that never sees it); anything else means the
// supplier may hold the job with no job id to ask it for (<hop>_send_lost). Only a 404 is a not-found: the same reason on a 5xx is handled as any 5xx.
// Any other 4xx in the supplier's own envelope is the supplier turning the job down (<hop>_refused); a 4xx whose body is no JSON object (bad_response)
// is a page of something in front of the supplier and is handled like no answer (ruling R57). No answer, a 5xx, a 4xx page, or a 202 without a job id
// may come after the supplier's Claim, so the escrow is read before anything else: Open allows one more send (a second unknown outcome is
// <hop>_send_lost, a second 5xx or page <hop>_refused); anything else means the supplier may hold the escrow with no job id to ask it for
// (<hop>_send_lost). A state that cannot be read is no verdict: it is read again every 15 s, until 90 s before the deliver_by, and only a state still
// unreadable then is <hop>_send_lost (ruling R58). A send is never repeated blindly, and every message that gives the escrow up says the state it was
// read in.
//
// The poll, every 3 s until deliver_by (<hop>_timeout). A poll that gets no answer of the supplier's own rejects and is made again (ruling R21); a 404
// is gone only in the supplier's own envelope, with the reason job_not_found (ruling R57, packages/buyer-core/src/fleet-clients.ts). A failed or gone answer
// is final only when the escrow is not Submitted: a gateway can answer a JSON error with a reason, and a supplier can fail its job after its Submit
// landed (ruling R23). So the escrow is read: Submitted, or a state that cannot be read, and the polls go on; anything else is <hop>_failed. One case is
// final at once (ruling R34): a supplier that failed its own Submit step (submit_timeout, submit_failed) while the escrow reads Submitted has put the
// receipt on chain and will not hand it over, which no poll changes (<hop>_receipt_unavailable).
//
// The answer. The hop's `read` checks the shape of the finished body and recomputes the response hash; a body it cannot use, and a hash that throws
// on it (a body nested past the stack), is <hop>_bad_result (ruling R25). The receipt is checked twice: first without the chain, where a failed check
// is final (<hop>_receipt_failed) and the chain is not asked; then with the hash on chain, read again every 3 s for up to 120 s while it is not
// listed or cannot be read (ruling R16; the supplier answers only after its Submit, but the indexer can lag). Only VERIFIED is accepted.
//
// The Accept. Confirmed: its fee and its hash are booked and the escrow leaves the store. Sent but not seen confirmed, so that it may still land (ruling R33): the job
// stands, verified, its fee is not booked, and the escrow stays in the store marked accept_pending, for the janitor to confirm. Failed in a way that
// cannot land (a build that did not complete, a submit the API refused): made again every 15 s, until the planner says the accept window has closed or
// 600 s have passed since the supplier's answer, and only then <hop>_accept_failed (ruling R54). The hire says which of the first two it came to
// (Hired.accepted: confirmed or pending).
//
// The deadline of the run (`deadline`) cuts the waits of this file that are its own: the repeats of a send, the polls, the repeats of a read of the receipt
// hash, the reads of an escrow state that could not be read, and the pauses between them. It does not cut the confirmation of a Post or of an Accept,
// which the chain waits for (up to 180 s each; no deadline is passed to it), nor the repeats of an Accept (ruling R54): a hire in its Accept at the
// deadline runs on. Nor does it cut a call already under way: a send in flight (up to 75 s), a poll in flight (up to 20 s) and a read of the chain
// each end when they end, after the deadline if it came meanwhile. See the head of src/budget.ts.
//
// Four options a caller may set (HireOptions), all absent for the Pipeline, which keeps the behaviour above exactly: firstSendBy, past which no first send
// is made, so that a Post confirmed late stays Open for the janitor and the hire fails with the factory's deadline; receiptBy, at which the repeats
// of a read of the receipt hash stop instead of at the deadline; terms, which writes what the hire locks and what an Accept pays into the record and the log; and decide, the decision of the
// caller between the checked receipt and the Accept, which has until DECISION_WINDOW_MS after the answer of the supplier (a HireDecisionTimeout when it has not answered by then).
// The hire takes no abort signal: once its Post is made it ends on its own terms, settled or recorded for the janitor.
import {
  ACCEPT_WINDOW_MS, AcceptWindowClosedError, BUILD_TIMEOUT_MS, DELIVER_BY_BUFFER_MS, TxNotConfirmedError, pollResponsesJob, responsesOutputText, responsesPromptHash,
  responsesResponseHash, sendResponsesJob, verifyFleetReceipt,
} from '@vsa/buyer-core';
import type { Chain, ChainEscrowState, FetchLike, FleetVerification, FleetVerifyInput, PollResult, PostResult, Receipt, SendResult } from '@vsa/buyer-core';
import type { AdvertDatum } from '@vsa/vector-read';
import { BUSY_RETRY_MS, POLL_INTERVAL_MS, RECEIPT_HASH_WAIT_MS, SEND_CUTOFF_MS, checkWithin, fit, waitWithin } from './budget.ts';
import type { Clocked } from './budget.ts';
import { errorText, iso } from './format.ts';
import type { StrandedKind, StrandedStore } from './janitor.ts';

/** The hop of a hire of the Pipeline, in the words of the stranded file's `kind` (src/janitor.ts): an OCR page or a chat job. The hire of an agent is a hop of its own, `'agent'`: its factory is a HireErrors<E, 'agent'>. */
export type HireKind = 'ocr' | 'llm';
/** How a hire fails before its Accept, the <what> of <hop>_<what>: see the head of this file. */
export type HireFailure = 'post_failed' | 'busy' | 'refused' | 'send_lost' | 'failed' | 'timeout' | 'bad_result' | 'receipt_failed' | 'receipt_unavailable' | 'accept_failed';
/**
 * Where a hire was when it ended: the lane of its key, the Post, the send, the polls, the reading of the answer, the check of the receipt, or the Accept. `lane` is a hire whose turn in the lane
 * came at or after its deadline: it ended before it read an advert or paid anything, and its facts name no escrow (checkTurn, src/keys.ts).
 */
export type HireStage = 'lane' | 'post' | 'send' | 'poll' | 'answer' | 'receipt' | 'accept';
/** What the throw site knows: the caller decides from it whether an escrow is still in play. The Pipeline ignores it. */
export interface HireFacts {
  stage: HireStage;
  /** null: nothing was signed. */
  escrowRef: string | null;
  /** The state of the escrow as the throw site last read it; null when that read failed; absent when it read nothing. */
  escrowState?: ChainEscrowState | null;
  /** A send was accepted: the supplier claimed and gave a job id. */
  handedOver: boolean;
}
/**
 * What a throw site knows besides its facts: a caller that turns a failure into a result reads it, and the factory of the Pipeline ignores it. It is a second argument and not a part of
 * the facts, so the facts of every site stay what they were.
 */
export interface HireDetail {
  /**
   * The supplier's own word when it turned the send down: the status and the code of its envelope, and its message. A supplier that stays busy, or keeps answering escrow_not_found,
   * until the send is out of time gives its last word.
   */
  refusal?: { status: number; code: string; message: string };
  /**
   * An earlier send of this job ended with no clear answer (none at all, a page, or a 5xx), so the supplier may have claimed the escrow, whatever its last answer says. It goes with a
   * refusal or a busy answer.
   */
  unclearSend?: boolean;
  /** The error that ended a Post before its signature: a typed refusal of a vault Pay, for example. */
  cause?: unknown;
  /** The checks of a receipt that failed one. */
  verdict?: FleetVerification;
}
/** The kit writes every message; the factory chooses the class, the code and the status. */
export interface HireErrors<E extends Error, K extends StrandedKind = HireKind> {
  failure(kind: K, what: HireFailure, message: string, facts: HireFacts, detail?: HireDetail): E;
  /** `doing` completes "the deadline came while ...": "the brief was being polled". */
  deadline(doing: string, facts: HireFacts): E;
  storeWrite(message: string, facts: HireFacts): E;
}

/** The supplier of a hire, as established before its Post: the advert on chain, the endpoint it names, the key /capability serves. */
export interface HireSupplier<K extends StrandedKind = HireKind> {
  hop: K;
  /** Canonical. */
  advertRef: string;
  /** The advert's datum as read on chain before the Post (ruling R31): what the escrow is planned from and settles against. */
  advert: AdvertDatum;
  capabilityId: string;
  /** The advert's model: the receipt must name it. */
  model: string;
  endpoint: string;
  pubKeyHex: string;
  /** The advert's max_processing_ms: deliver_by is posted_at + this + 180 s. */
  windowMs: number;
}

/** One job for that supplier. */
export interface HireJob<T> {
  /** What the job is, in messages: "page 2", "the summary". */
  label: string;
  /** The prompt hash of exactly the request `send` sends. */
  promptHash: string;
  send: (escrowRef: string) => Promise<SendResult>;
  poll: (jobId: string, escrowRef: string) => Promise<PollResult>;
  /** The response hash recomputed from the finished body, and what the run keeps of it. Throws for a body it cannot use. */
  read: (body: Record<string, unknown>) => { responseHash: string; value: T };
  /**
   * How the escrow of this job is paid: the Post of the chain, unless this says otherwise. `what` names the payment in the messages ("Post" by default), and `run` makes it and
   * gives its result. A payment that throws before its signature locked nothing, and one that throws a TxNotConfirmedError is recorded for the janitor, as a Post is.
   */
  payment?: { what: string; run: () => Promise<PostResult> };
  /**
   * Says that a refusal whose status the kit reads as no answer (a 5xx) is the final word of the supplier: it refused before it claimed the escrow, so the job is not sent again.
   * Absent, only a 4xx in the envelope of the supplier is final, as for the Pipeline.
   */
  finalRefusal?: (refusal: { status: number; reason: string }) => boolean;
}

export interface HireDeps extends Clocked { chain: Chain; stranded: StrandedStore; log?: (line: string) => void }
/**
 * Where a hire books what it moved: the lock and the fee of its Post, the fee and the hash of its Accept seen confirmed. The hash is the one that the chain gave for the Accept, so that a caller can
 * find the booking again. A ledger that was written for the fee alone fits this type, because a function that asks for less than the kit gives is a ledger. The Pipeline's Accounting is one.
 */
export interface HireLedger { posted(post: { lockLovelace: bigint; feeLovelace: bigint }): void; accepted(accept: { feeLovelace: bigint; txHash: string }): void }
/**
 * What a hire locks and what an Accept pays, in whole lovelace as decimal text, so that the record is JSON. The buyer funds the price and both bonds at the Post. An Accept pays the
 * supplier the price and the supplier bond, and the buyer bond returns. A Release, which the supplier makes when the buyer does not accept in time, pays the supplier all three.
 */
export interface HireTerms {
  price_lovelace: string; supplier_bond_lovelace: string; buyer_bond_lovelace: string;
  /** What the Post locked: the price and both bonds, raised to the floor of the escrow. */
  locked_lovelace: string;
  /** The price and the supplier bond. */
  paid_to_supplier_at_accept_lovelace: string;
}
/** The terms of a hire of `advert` whose Post locked `lockLovelace`. */
export function termsOf(advert: AdvertDatum, lockLovelace: bigint): HireTerms {
  return {
    price_lovelace: String(advert.price_lovelace), supplier_bond_lovelace: String(advert.supplier_bond_lovelace), buyer_bond_lovelace: String(advert.buyer_bond_lovelace),
    locked_lovelace: String(lockLovelace), paid_to_supplier_at_accept_lovelace: String(advert.price_lovelace + advert.supplier_bond_lovelace),
  };
}
/** The line of the log that says what a hire locks and what an Accept pays. */
export const termsLine = (advertRef: string, terms: HireTerms): string => `hire terms: advert ${advertRef}: price ${terms.price_lovelace} lovelace, supplier bond ${terms.supplier_bond_lovelace} lovelace, `
  + `buyer bond ${terms.buyer_bond_lovelace} lovelace; locked at the Post ${terms.locked_lovelace} lovelace; paid to the supplier at an Accept ${terms.paid_to_supplier_at_accept_lovelace} lovelace `
  + '(the price and the supplier bond; the buyer bond returns)';
/**
 * One hire on the record: the advert and escrow it ran under, the receipt and its signature as the supplier gave them, and each check of
 * verifyFleetReceipt. Keys in this order, which JSON.stringify keeps: the Pipeline's SubJob is this record.
 */
export interface HireRecord {
  capability_id: string; advert_ref: string; escrow_ref: string; supplier_pkh: string;
  receipt: Receipt; receipt_signature: string; verification: Record<string, boolean>;
  /** What the hire locks and what an Accept pays. Present only when the hire asked for it (HireOptions.terms): the record of the Pipeline has no such key. */
  terms?: HireTerms;
}
/** All absent for the Pipeline, which keeps today's behaviour exactly. */
export interface HireOptions<T = unknown> {
  /** No send at all once the clock is past it: a Post confirmed late stays Open, for the janitor. */
  firstSendBy?: number;
  /** The receipt-hash re-reads stop here instead of at deps.deadlineMs. */
  receiptBy?: number;
  /** Writes what the hire locks and what an Accept pays into its record, as `terms`, and into one line of the log, once the Post is confirmed. Absent for the Pipeline, whose record and log stay as they were. */
  terms?: boolean;
  /**
   * The decision between the verified receipt and the Accept. Absent, the Accept is made. A decision that does not accept stops the hire with a HireDeclined, and a hook that throws
   * stops it with its own error: in both the escrow stays Submitted and recorded, and no Accept is made. The decision has a limit, DECISION_WINDOW_MS after the answer of the supplier:
   * a hook that has not answered by then stops the hire with a HireDecisionTimeout, and its escrow stays Submitted and recorded too. The hook is not asked at all when the limit has
   * passed already.
   */
  decide?: (delivery: Delivery<T>) => AcceptDecision | Promise<AcceptDecision>;
}
/** A hire that was verified and accepted: its record, what `read` kept of the answer, the verification, and whether the Accept was seen confirmed. */
export interface Hired<T> { record: HireRecord; value: T; verdict: FleetVerification; accepted: 'confirmed' | 'pending' }
/** What the decision of a hire is given: a delivery that passed the eight checks, and has not been accepted. */
export type Delivery<T> = Omit<Hired<T>, 'accepted'>;
/** The decision: accept, or do not, with the reason that the caller gives. */
export type AcceptDecision = { accept: true } | { accept: false; reason: string };
/** A hire whose decision was not to accept: its delivery, and the reason. Only a hire that has a `decide` throws it. */
export class HireDeclined<T = unknown> extends Error {
  readonly delivery: Delivery<T>;
  readonly reason: string;
  constructor(delivery: Delivery<T>, reason: string) {
    super(`The delivery of ${delivery.record.escrow_ref} was not accepted: ${reason}. Its escrow stays Submitted and recorded for the janitor.`);
    this.name = 'HireDeclined';
    this.delivery = delivery;
    this.reason = reason;
  }
}

/** What an Accept needs before the accept window closes: its build, which RealChain bounds by BUILD_TIMEOUT_MS, and the wait for its confirmation, which RealChain bounds by DELIVER_BY_BUFFER_MS unless a service sets another. */
export const ACCEPT_NEEDS_MS = BUILD_TIMEOUT_MS + DELIVER_BY_BUFFER_MS;
/** The decision of a hire ends this long after the answer of the supplier at the latest: the accept window, less what an Accept needs. */
export const DECISION_WINDOW_MS = ACCEPT_WINDOW_MS - ACCEPT_NEEDS_MS;
/**
 * A hire whose decision did not answer in time: its delivery, and the moment (POSIX ms of the clock of the run) by which the decision had to end. No Accept was made, and the escrow
 * stays Submitted and recorded. With no Accept in the accept window, the supplier can release the escrow, and then it takes the price and both bonds.
 */
export class HireDecisionTimeout<T = unknown> extends Error {
  readonly delivery: Delivery<T>;
  readonly decideBy: number;
  constructor(delivery: Delivery<T>, decideBy: number) {
    super(`The decision on the delivery of ${delivery.record.escrow_ref} did not answer by ${iso(decideBy)}, so no Accept was made: an Accept needs ${ACCEPT_NEEDS_MS / 1000} s before its accept window closes. `
      + 'Its escrow stays Submitted and recorded. Its supplier can release it once the window has closed, and then it takes the price and both bonds.');
    this.name = 'HireDecisionTimeout';
    this.delivery = delivery;
    this.decideBy = decideBy;
  }
}

type Done = Extract<PollResult, { kind: 'done' }>;
/** The reasons a fleet supplier fails a job with when its own Submit went wrong (agents-marketplace supplier/src/jobRunner.ts). */
const SUBMIT_FAILURES: ReadonlySet<string> = new Set(['submit_timeout', 'submit_failed']);
/** What the steps of a hire work with, whatever its hop. */
type AnySupplier = HireSupplier<StrandedKind>;
type AnyErrors<E extends Error> = HireErrors<E, StrandedKind>;
const failure = <E extends Error>(errors: AnyErrors<E>, s: AnySupplier, what: HireFailure, message: string, facts: HireFacts, detail?: HireDetail): E => (
  detail === undefined ? errors.failure(s.hop, what, message, facts) : errors.failure(s.hop, what, message, facts, detail)
);
const named = (s: AnySupplier): string => (s.hop === 'ocr' ? 'The OCR supplier' : s.hop === 'llm' ? 'The chat supplier' : 'The agent');
/** The state of the escrow, or null when it cannot be read. */
async function stateOf(chain: Chain, escrowRef: string): Promise<ChainEscrowState | null> {
  try { return await chain.escrowState(escrowRef); } catch { return null; }
}
const said = (state: ChainEscrowState | null): string => (state === null ? 'in a state that could not be read' : state);
/** The facts of a throw site: the state it last read (`seen`) only when it read one. */
function factsOf(stage: HireStage, escrowRef: string | null, handedOver: boolean, seen?: { state: ChainEscrowState | null }): HireFacts {
  return seen === undefined ? { stage, escrowRef, handedOver } : { stage, escrowRef, escrowState: seen.state, handedOver };
}

/** A write of the stranded store after an escrow was posted; one that fails is the factory's storeWrite, whose message starts with the escrow and says what follows. */
function recorded<E extends Error>(errors: AnyErrors<E>, facts: HireFacts, write: () => void, escrowRef: string, consequence: string): void {
  try { write(); } catch (err) {
    throw errors.storeWrite(`Escrow ${escrowRef} could not be recorded in the stranded store (${errorText(err)}): ${consequence}`, facts);
  }
}

/**
 * The decision of the caller, or 'late' when it has not answered by `limit` (POSIX ms of the clock of the run). The timer is a real one. It is set before the hook is asked and cleared
 * when the hook ends, so a hook that never answers does not hold the run. A hook that throws throws as it is. The hook is not asked when the limit has passed already.
 */
async function decidedBy<T>(deps: HireDeps, decide: NonNullable<HireOptions<T>['decide']>, delivery: Delivery<T>, limit: number): Promise<AcceptDecision | 'late'> {
  const remaining = limit - deps.clock();
  if (remaining <= 0) return 'late';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), remaining); });
  try { return await Promise.race([Promise.resolve(decide(delivery)), expired]); } finally { clearTimeout(timer); }
}

/**
 * Hires `supplier` for `job`: the record of the sub-job and what `read` kept of the answer, once the escrow is verified and accepted. Books what it moved
 * in `ledger`. Every failure is an error of `errors` (see the head of this file). With `options.decide` the Accept waits for the decision of the caller: a decision that
 * does not accept ends the hire with a HireDeclined, and the escrow stays Submitted and recorded.
 */
export async function hireOne<T, E extends Error, K extends StrandedKind = HireKind>(deps: HireDeps, supplier: HireSupplier<K>, job: HireJob<T>, ledger: HireLedger, errors: HireErrors<E, K>, options: HireOptions<T> = {}): Promise<Hired<T>> {
  const post = await postEscrow(deps, supplier, job, ledger, errors);
  // What the hire locks and what an Accept pays, when the caller asks: written once the Post is confirmed, so that every end after it can say it.
  const terms = options.terms === true ? termsOf(supplier.advert, post.lockLovelace) : undefined;
  if (terms !== undefined) deps.log?.(termsLine(supplier.advertRef, terms));
  // A Post confirmed past firstSendBy is not sent at all: its escrow stays Open, recorded, for the janitor.
  if (options.firstSendBy !== undefined && deps.clock() > options.firstSendBy) throw errors.deadline(`the Post for ${job.label} was being confirmed`, factsOf('send', post.escrowRef, false));
  const jobId = await handOver(deps, supplier, job, post, errors);
  const done = await finished(deps, supplier, job, post, jobId, errors);
  // The moment the supplier handed over its result: its Submit was confirmed before it answered, so the accept window ends 600 s from then at the latest.
  const answeredAt = deps.clock();
  let read: { responseHash: string; value: T };
  try { read = job.read(done.body); } catch (err) {
    throw failure(errors, supplier, 'bad_result', `${named(supplier)}'s answer for ${job.label} cannot be used (${errorText(err)}); its escrow ${post.escrowRef} is not accepted and stays with the janitor.`, factsOf('answer', post.escrowRef, true));
  }
  const verification = await verified(deps, supplier, job, post, done, read.responseHash, errors, options);
  const record: HireRecord = {
    capability_id: supplier.capabilityId, advert_ref: supplier.advertRef, escrow_ref: post.escrowRef, supplier_pkh: post.supplierPkh,
    receipt: done.receipt, receipt_signature: done.receiptSignature, verification: verificationOf(verification.checks), ...(terms === undefined ? {} : { terms }),
  };
  // The decision of the caller comes after the eight checks and before the Accept. A hook that throws, declines or does not answer in time leaves the escrow Submitted: nothing is accepted.
  if (options.decide !== undefined) {
    const delivery: Delivery<T> = { record, value: read.value, verdict: verification };
    const decideBy = answeredAt + DECISION_WINDOW_MS;
    const decision = await decidedBy(deps, options.decide, delivery, decideBy);
    if (decision === 'late') throw new HireDecisionTimeout(delivery, decideBy);
    if (!decision.accept) throw new HireDeclined(delivery, decision.reason);
  }
  const accepted = await accept(deps, supplier, job, post, ledger, answeredAt, errors);
  return { record, value: read.value, verdict: verification, accepted };
}

/**
 * The payment, recorded as stranded once it is confirmed (a Post of the chain unless the job has a `payment`). One that failed after its signature is recorded with its validity,
 * whether it may still land or the submit API refused it (ruling R59: an API can answer 4xx for a transaction it forwarded); the janitor drops an entry the chain never shows once
 * that validity has passed. One that failed before its signature locked nothing and is not recorded; the error that ended it goes to the factory as the `cause` of the failure.
 */
async function postEscrow<T, E extends Error>(deps: HireDeps, supplier: AnySupplier, job: HireJob<T>, ledger: HireLedger, errors: AnyErrors<E>): Promise<PostResult> {
  const what = job.payment?.what ?? 'Post';
  let post: PostResult;
  try {
    post = await (job.payment === undefined ? deps.chain.postEscrow({ advertRef: supplier.advertRef, promptHash: job.promptHash }) : job.payment.run());
  } catch (err) {
    if (err instanceof TxNotConfirmedError && err.deliverBy !== null) {
      const { escrowRef, deliverBy, validTo, mayLand } = err;
      const signed = factsOf('post', escrowRef, false);
      recorded(errors, signed, () => deps.stranded.add({ escrow_ref: escrowRef, deliver_by: deliverBy, posted_at: deliverBy - supplier.windowMs - DELIVER_BY_BUFFER_MS, kind: supplier.hop, valid_to: validTo }),
        escrowRef, `its ${what} for ${job.label} was ${mayLand ? 'not seen confirmed and may land' : 'refused by the submit API after it was signed, and could land all the same if the API had forwarded it,'} until ${iso(validTo)}, and then the janitor does not know of it. Read it after its deliver_by (${iso(deliverBy)}) and reclaim it by hand if it landed.`);
      if (!mayLand) {
        throw failure(errors, supplier, 'post_failed', `The submit API refused the ${what} for ${job.label} after it was signed (${errorText(err)}). Nothing should have been locked, but its escrow ${escrowRef} is recorded for the janitor in case it landed anyway: the janitor drops the record once the ${what}'s validity has ended (${iso(validTo)}) and the ledger shows nothing at it, and reclaims the escrow after its deliver_by if it is there.`, signed);
      }
      throw failure(errors, supplier, 'post_failed', `The ${what} for ${job.label} was not confirmed (${errorText(err)}). It may still land until ${iso(validTo)}: its escrow ${escrowRef} is recorded for the janitor, which reclaims it after its deliver_by if it did.`, signed);
    }
    throw failure(errors, supplier, 'post_failed', `The ${what} for ${job.label} failed (${errorText(err)}). Nothing was locked for it.`, factsOf('post', null, false), { cause: err });
  }
  // The lock is on chain whether or not anything records it. The entry of the store comes first, so that the janitor knows the escrow whatever the ledger of the caller does next. Both
  // run: a store that cannot be written still gets the lock booked, and the first error is the one that is thrown, the store's before the ledger's.
  const failures: unknown[] = [];
  try {
    recorded(errors, factsOf('post', post.escrowRef, false), () => deps.stranded.add({ escrow_ref: post.escrowRef, deliver_by: post.deliverBy, posted_at: post.postedAt, kind: supplier.hop }),
      post.escrowRef, `it locks ${post.lockLovelace} lovelace for ${job.label} and the janitor does not know of it. Reclaim it by hand after its deliver_by (${iso(post.deliverBy)}).`);
  } catch (err) { failures.push(err); }
  try { ledger.posted(post); } catch (err) { failures.push(err); }
  if (failures.length > 0) throw failures[0];
  return post;
}

/** Sends the job until the supplier accepts it, and gives back the job id. */
async function handOver<T, E extends Error>(deps: HireDeps, supplier: AnySupplier, job: HireJob<T>, post: PostResult, errors: AnyErrors<E>): Promise<string> {
  const sendUntil = post.deliverBy - SEND_CUTOFF_MS;
  const escrow = `its escrow ${post.escrowRef}`;
  /** The state the send last read the escrow in, for the facts of a throw (null: that read failed). */
  let seen: { state: ChainEscrowState | null } | undefined;
  const at = (): HireFacts => factsOf('send', post.escrowRef, false, seen);
  const readState = async (): Promise<ChainEscrowState | null> => {
    const state = await stateOf(deps.chain, post.escrowRef);
    seen = { state };
    return state;
  };
  /** What becomes of the escrow, in the words of the state it is read in now. */
  const leftTo = async (): Promise<string> => `${escrow} is ${said(await readState())} and goes to the janitor`;
  /** The supplier's own word, for a caller that turns the end of a send into a result: what a refused send said, or that the supplier stayed busy (409). */
  const wordOf = (sent: SendResult): HireDetail => ({
    refusal: sent.kind === 'refused' ? { status: sent.status, code: sent.reason, message: sent.message } : { status: 409, code: 'busy', message: '' },
    unclearSend: unknownOutcomes > 0,
  });
  /**
   * The state of the escrow after a send that did not hand the job over (ruling R58): a state that cannot be read is no verdict, so it is read again
   * every 15 s until the send cutoff. Still unreadable then, the supplier may hold the job with no job id to ask it for: <hop>_send_lost.
   */
  const stateAfter = async (answer: string): Promise<ChainEscrowState> => {
    for (;;) {
      const state = await readState();
      if (state !== null) return state;
      const next = fit(deps, deps.clock() + BUSY_RETRY_MS, sendUntil);
      if (next === 'past the deadline') throw errors.deadline(`${job.label} waited to read the state of its escrow`, at());
      if (next === 'past the limit') {
        throw failure(errors, supplier, 'send_lost', `The send of ${job.label} got ${answer === '' ? 'no answer' : `the answer ${answer}`}, and the state of ${escrow} could not be read until ${SEND_CUTOFF_MS / 1000} s before its deliver_by: `
          + 'the supplier may hold the job, but there is no job id to ask it for the result. The escrow goes to the janitor.', at());
      }
      await deps.sleep(BUSY_RETRY_MS);
    }
  };
  let sends = 0;
  let unknownOutcomes = 0;
  for (;;) {
    const sent = await job.send(post.escrowRef);
    sends += 1;
    if (sent.kind === 'accepted') return sent.jobId;
    const answer = sent.kind === 'refused' ? `${sent.status} ${sent.reason}${sent.message === '' ? '' : `: ${sent.message}`}` : '';
    const notFound = sent.kind === 'refused' && sent.status === 404 && sent.reason === 'escrow_not_found';
    if (notFound) {
      const state = await stateAfter(answer);
      if (state !== 'Open') {
        throw failure(errors, supplier, 'send_lost', `${named(supplier)} answered ${answer}, and ${escrow} is ${state}: the supplier may hold the job from an earlier send whose answer was lost, and there is no job id to ask it for the result. The escrow goes to the janitor.`, at());
      }
    }
    if (sent.kind === 'busy' || notFound) {
      const next = fit(deps, deps.clock() + BUSY_RETRY_MS, sendUntil);
      if (next === 'in time') {
        await deps.sleep(BUSY_RETRY_MS);
        continue;
      }
      if (next === 'past the deadline') throw errors.deadline(`${job.label} waited for its supplier`, at());
      const tried = `${job.label} was sent ${sends} times, ${BUSY_RETRY_MS / 1000} s apart, until ${SEND_CUTOFF_MS / 1000} s before the deliver_by of the escrow`;
      throw notFound
        ? failure(errors, supplier, 'refused', `${named(supplier)} kept answering ${answer}, as if the escrow were not on chain: ${tried}; ${await leftTo()}.`, at(), wordOf(sent))
        : failure(errors, supplier, 'busy', `${named(supplier)} stayed busy: ${tried}; ${await leftTo()}.`, at(), wordOf(sent));
    }
    // A 4xx in the supplier's own envelope is the supplier turning the job down, and so is a refusal that the job says is final. A 4xx whose body is no JSON object, or a JSON
    // object without a string reason (bad_response), is something in front of the supplier, and is handled like no answer (ruling R57).
    if (sent.kind === 'refused' && sent.reason !== 'bad_response' && ((sent.status >= 400 && sent.status < 500) || job.finalRefusal?.(sent) === true)) {
      throw failure(errors, supplier, 'refused', `${named(supplier)} refused ${job.label} (${answer}); ${await leftTo()}.`, at(), wordOf(sent));
    }
    // No answer, a 5xx, a 4xx page, or a 202 without a job id: the supplier may have claimed the escrow. Its state says whether the job can be sent again.
    const state = await stateAfter(answer);
    if (state === 'Open' && unknownOutcomes === 0) {
      unknownOutcomes += 1;
      checkWithin(deps, deps.clock(), sendUntil, () => failure(errors, supplier, 'send_lost', `The send of ${job.label} got no answer and there is no time to send it again; ${escrow} is Open and goes to the janitor.`, at()),
        () => errors.deadline(`${job.label} was being sent`, at()));
      continue;
    }
    if (state === 'Open' && sent.kind === 'refused') {
      throw failure(errors, supplier, 'refused', `${named(supplier)} refused ${job.label} twice (${answer}); ${escrow} is Open and goes to the janitor.`, at(), wordOf(sent));
    }
    throw failure(errors, supplier, 'send_lost', state === 'Open'
      ? `The send of ${job.label} got no answer twice; ${escrow} is Open and goes to the janitor.`
      : `The send of ${job.label} got ${answer === '' ? 'no answer' : `the answer ${answer}`}, and ${escrow} is ${said(state)}: the supplier may hold the job, but there is no job id to ask it for the result. The escrow goes to the janitor.`, at());
  }
}

/** Polls the job every 3 s until the supplier hands over its result, and gives back the finished answer. */
async function finished<T, E extends Error>(deps: HireDeps, supplier: AnySupplier, job: HireJob<T>, post: PostResult, jobId: string, errors: AnyErrors<E>): Promise<Done> {
  const escrow = `its escrow ${post.escrowRef}`;
  /** The state the polls last read the escrow in, for the facts of a throw (null: that read failed). */
  let seen: { state: ChainEscrowState | null } | undefined;
  const at = (): HireFacts => factsOf('poll', post.escrowRef, true, seen);
  for (;;) {
    await waitWithin(deps, POLL_INTERVAL_MS, post.deliverBy, () => failure(errors, supplier, 'timeout',
      `${named(supplier)} had not finished ${job.label} by the deliver_by of ${escrow} (${iso(post.deliverBy)}); the escrow goes to the janitor.`, at(),
    ), () => errors.deadline(`${job.label} was being polled`, at()));
    let polled: PollResult;
    // A poll that rejects got no answer of the supplier's own: not a verdict, and the job may well be running (ruling R21).
    try { polled = await job.poll(jobId, post.escrowRef); } catch { continue; }
    if (polled.kind === 'done') return polled;
    if (polled.kind === 'running') continue;
    // The supplier's word that the job failed, or is gone, is final only when its escrow is not Submitted (ruling R23).
    const state = await stateOf(deps.chain, post.escrowRef);
    seen = { state };
    const why = polled.kind === 'gone' ? 'it no longer knows the job (404)' : `${polled.reason}${polled.message === '' ? '' : `: ${polled.message}`}`;
    if (state === 'Submitted' && polled.kind === 'failed' && SUBMIT_FAILURES.has(polled.reason)) {
      throw failure(errors, supplier, 'receipt_unavailable', `${named(supplier)} failed ${job.label} at its own Submit (${why}) while ${escrow} reads Submitted: the receipt is on chain, but the supplier will not hand it over and no poll will bring it. The escrow is not accepted and stays with the janitor.`, at());
    }
    if (state === null || state === 'Submitted') continue;
    throw failure(errors, supplier, 'failed', `${named(supplier)} failed ${job.label} (${why}); ${escrow} is ${state} and goes to the janitor.`, at());
  }
}

/**
 * The receipt's eight checks, VERIFIED, or an error of the factory: first without the chain, then against the hash on chain, waiting for it up to 120 s,
 * and no later than `options.receiptBy` when it is given, in place of the deadline.
 */
async function verified<T, E extends Error>(deps: HireDeps, supplier: AnySupplier, job: HireJob<T>, post: PostResult, done: Done, responseHashHex: string, errors: AnyErrors<E>, options: Pick<HireOptions, 'receiptBy'>): Promise<FleetVerification> {
  const escrow = `its escrow ${post.escrowRef}`;
  const at = (): HireFacts => factsOf('receipt', post.escrowRef, true);
  const input: Omit<FleetVerifyInput, 'onChainReceiptHash'> = {
    escrowRef: post.escrowRef, receipt: done.receipt, receiptSignature: done.receiptSignature, responseHashHex, promptHashHex: job.promptHash,
    supplierPubKeyHex: supplier.pubKeyHex, supplierPkhExpected: post.supplierPkh, model: supplier.model, agentId: post.agentId,
  };
  const failed = (v: FleetVerification): E => {
    const checks = Object.entries(v.checks).filter(([, state]) => state === 'fail').map(([check]) => check).join(', ');
    return failure(errors, supplier, 'receipt_failed', `The receipt for ${job.label} failed ${checks}; ${escrow} is not accepted and stays with the janitor.`, at(), { verdict: v });
  };
  // The reads stop at receiptBy, when the caller gives one, instead of at the deadline (HireOptions).
  const reads: Clocked = options.receiptBy === undefined ? deps : { clock: () => deps.clock(), sleep: (ms) => deps.sleep(ms), deadlineMs: options.receiptBy };
  // A check of the receipt's own that fails is final whatever the chain holds, so the chain is not asked.
  const own = await verifyFleetReceipt({ ...input, onChainReceiptHash: async () => null });
  if (own.verdict === 'FAILED') throw failed(own);
  const until = deps.clock() + RECEIPT_HASH_WAIT_MS;
  for (;;) {
    let checked: FleetVerification | null = null;
    let why = 'no Submitted output with a receipt hash is listed for it yet';
    try { checked = await verifyFleetReceipt({ ...input, onChainReceiptHash: () => deps.chain.onChainReceiptHash(post.escrowRef) }); } catch (err) { why = `the read failed: ${errorText(err)}`; }
    if (checked?.verdict === 'VERIFIED') return checked;
    if (checked?.verdict === 'FAILED') throw failed(checked);
    await waitWithin(reads, POLL_INTERVAL_MS, until, () => failure(errors, supplier, 'receipt_failed',
      `The hash of the receipt for ${job.label} could not be read on chain within ${RECEIPT_HASH_WAIT_MS / 1000} s of the supplier's answer (${why}); ${escrow} is not accepted and stays with the janitor.`, at(),
    ), () => errors.deadline(`the receipt for ${job.label} was being checked`, at()));
  }
}

/**
 * The Accept of a verified job (ruling R54): confirmed, booked and forgotten; sent but not seen confirmed, marked for the janitor (ruling R33). Any
 * other failure cannot land (a build that did not complete, a submit the API refused), so the Accept is made again every 15 s, with fresh inputs and a
 * fresh validity range, until the planner says the accept window has closed or 600 s have passed since `answeredAt`, the moment the supplier handed
 * over its result (its Submit came before it, so the window ends then at the latest). Only then is it <hop>_accept_failed. The deadline of the run
 * is not asked: a hire in its Accept finishes late (ruling R53). Says which it came to: confirmed, or pending for the janitor.
 */
async function accept<T, E extends Error>(deps: HireDeps, supplier: AnySupplier, job: HireJob<T>, post: PostResult, ledger: HireLedger, answeredAt: number, errors: AnyErrors<E>): Promise<'confirmed' | 'pending'> {
  const at = (): HireFacts => factsOf('accept', post.escrowRef, true);
  const lastChance = answeredAt + ACCEPT_WINDOW_MS;
  let accepted: { txHash: string; feeLovelace: bigint } | undefined;
  for (let attempts = 1; accepted === undefined; attempts += 1) {
    try {
      accepted = await deps.chain.accept(post.escrowRef);
    } catch (err) {
      if (err instanceof TxNotConfirmedError && err.mayLand) {
        const { txHash, validTo } = err;
        recorded(errors, at(), () => deps.stranded.update(post.escrowRef, { accept_pending: { tx_hash: txHash, valid_to: validTo, by: 'run' } }),
          post.escrowRef, `its Accept ${txHash} for ${job.label} may land until ${iso(validTo)}, and the store does not say so: the janitor takes it for a Submitted escrow it cannot accept.`);
        return 'pending';
      }
      const closed = err instanceof AcceptWindowClosedError;
      if (closed || deps.clock() + BUSY_RETRY_MS > lastChance) {
        const why = closed ? 'the accept window has closed' : `the next one would start more than ${ACCEPT_WINDOW_MS / 1000} s after the supplier's answer, when the accept window may be over`;
        throw failure(errors, supplier, 'accept_failed', `The Accept of ${job.label} was made ${attempts} ${attempts === 1 ? 'time' : 'times'}, ${BUSY_RETRY_MS / 1000} s apart, and the last attempt failed (${errorText(err)}); ${why}. Its escrow ${post.escrowRef} stays recorded for the janitor.`, at());
      }
      await deps.sleep(BUSY_RETRY_MS);
    }
  }
  ledger.accepted(accepted);
  // The one write of the store that does not fail the run (ruling R62): the job is settled and verified, and an entry the remove left behind reads spent, which
  // the janitor drops on its own. Every other write after an escrow was posted fails closed (recorded).
  try { deps.stranded.remove(post.escrowRef); } catch (err) {
    deps.log?.(`escrow ${post.escrowRef} was accepted for ${job.label} in ${accepted.txHash} and could not be removed from the stranded store (${errorText(err)}); the janitor drops it once it reads it spent`);
  }
  return 'confirmed';
}

// --- Moved with the hire: verificationOf from src/result.ts and the chat job from src/orchestrate.ts of the Document Pipeline ---------------------------

/** The eight checks of verifyFleetReceipt as true (pass) or false, in its order. */
export function verificationOf(checks: FleetVerification['checks']): Record<string, boolean> {
  return Object.fromEntries(Object.entries(checks).map(([check, state]) => [check, state === 'pass']));
}

/**
 * The chat job of the Responses API for `input`. The body is {input} and nothing else (ruling R12), so the prompt hash the escrow commits to is the hash of
 * the request the supplier gets. The answer is hashed as received (ruling R10), and its text is read before the Accept, so the escrow of a body without
 * one is never accepted (ruling R12): `read` throws for a body whose output is not a list or holds an item that is not the assistant's (ruling R25).
 */
export function chatJob(endpoint: string, input: string, label: string, fetchImpl: FetchLike): HireJob<{ text: string; status: unknown }> {
  return {
    label,
    promptHash: responsesPromptHash({ input }),
    send: (escrowRef) => sendResponsesJob(endpoint, escrowRef, { input }, fetchImpl),
    poll: (jobId, escrowRef) => pollResponsesJob(endpoint, jobId, fetchImpl, escrowRef),
    // Hashed as received (ruling R10), and the answer text read before the Accept, so the escrow of a body without one is never accepted (ruling R12).
    read: (body) => {
      if (!Array.isArray(body.output)) throw new Error('its output is not a list');
      return { responseHash: responsesResponseHash(body), value: { text: responsesOutputText(body), status: body.status } };
    },
  };
}
