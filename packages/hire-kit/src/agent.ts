// packages/hire-kit/src/agent.ts
// The hire of an agent of the template contract, from the choice of its advert to the Accept. The caller names what it wants (a capability and a model, or one advert, and the most the
// advert may cost in price and in bonds), the text the agent reads, where the money comes from (the wallet, or a vault that the key pays from as a delegate), and the decision it takes
// between the checked receipt and the Accept. The hire runs in the lane of the paying key it is given, so that it has the one chain and the one store of that key, and the janitor of
// the key starts no transaction while it runs. The kit says how the hire ended in one of five words, in a type that a `switch` can check:
//   completed             the receipt passed the eight checks, the decision accepted it, and the Accept was made.
//   refused_before_claim  the runtime of the agent refused the job before its Claim, and the kit can show that nothing was claimed: the answer is the envelope of the runtime with a code, its status
//                         is below 500 (or 503 with one of the three codes of a service it could not ask), the escrow was read Open after the answer, and no earlier send of the job ended
//                         without a clear answer. The same holds when the agent stayed busy until the send ran out of time. The escrow stays Open and recorded: the janitor reclaims it after
//                         its deliver_by, to the vault when a vault paid it.
//   failed_after_claim    the agent may hold the job, or the kit cannot tell that it does not, and the hire did not end well. Every end of a send that is not a refusal as above is
//                         `send_lost`: no answer, a page or a 5xx, a refusal after a send that was unclear, escrow_not_found (the view of the runtime may lag), an escrow that is not read
//                         Open. The other reasons are the agent's failure, the polls that ran out of time, an answer that cannot be used, a receipt that the kit cannot get to check
//                         (`receipt_unavailable`: the buyer did not judge the delivery, because the agent will not hand it over or its hash cannot be read on chain in time), and an Accept
//                         that failed. The escrow stays recorded for the janitor.
//   vault_refused         the vault Pay did not leave the node as a transaction: the script of the vault refused it (a limit), the node did not evaluate it, or it cannot be built. Nothing was
//                         signed, nothing was submitted, and no money moved. The evaluation error and the body of the transaction are in the result.
//   not_accepted          the delivery came and the escrow was not accepted: the receipt failed a check (the verdict says which), or the decision of the caller said no. The escrow stays as it is.
// What is not an outcome is thrown by the factory of the caller: no advert or no agent to hire (an advert above a limit of the price or of a bond among them), a Post that failed before its
// signature, the deadline, the stranded store, and a decision that throws. When a vault Pay was confirmed before the error, the error is a HireInterrupted: it carries the vault that
// continues, and the error that ended the hire as its cause. The vault that a Pay leaves has a new reference. A caller takes it from an outcome (`vaultRef`) or from a HireInterrupted,
// and a caller that keeps the old reference pays its next hire from a vault that no longer exists.
import { VaultPayImpossible, VaultPayNotEvaluated, VaultPayRefused, fetchSuppliers, indexerFetch, readCapability } from '@vsa/buyer-core';
import type { Chain, FetchLike, FleetVerification, VaultChain, VaultPayAttempt, VaultPayImpossibleReason } from '@vsa/buyer-core';
import type { Clocked } from './budget.ts';
import { canonicalRef, errorText } from './format.ts';
import { HireDeclined, hireOne, termsOf } from './hire.ts';
import type { AcceptDecision, Delivery, HireDetail, HireErrors, HireFacts, HireFailure, HireLedger, HireOptions, HireRecord, HireSupplier, HireTerms } from './hire.ts';
import type { PayingKey } from './keys.ts';
import { advertOnChain, bondProblem, choiceLine, keyOfAdvert } from './select.ts';
import { isRuntimeRefusal, templateJob } from './template-client.ts';
import type { TemplateAnswer } from './template-client.ts';

/**
 * How an agent is chosen: by what it does, or by the advert that the caller names. Either way the advert is read on chain, and every other field that the caller gives is checked against it:
 * the capability, the model and the price ceiling. An advert that does not fit is refused before anything is paid.
 */
export type AgentSelection =
  | { advertRef: string; capabilityId?: string; model?: string; maxPriceLovelace?: bigint }
  | { advertRef?: undefined; capabilityId: string; model?: string; maxPriceLovelace?: bigint };

/** A delivery that passed the eight checks, as the decision of the caller sees it. */
export interface AgentDelivery { escrowRef: string; advertRef: string; text: string; record: HireRecord; verdict: FleetVerification }

export interface AgentRequest {
  selection: AgentSelection;
  /** The text the agent reads. The escrow commits to its hash. Not empty. */
  payload: string;
  /** What the job is called in messages. */
  label?: string;
  /** The vault to pay from, as the ref of its UTxO. Absent, the wallet of the chain pays. */
  vaultRef?: string;
  /**
   * The most the supplier bond of the advert may be, in lovelace. The buyer funds the bond at the Post, and an Accept pays it to the supplier with the price, so the price ceiling does not
   * bound what the hire pays. A number refuses a dearer advert before anything is paid. `null` is the choice of no limit. There is no default: write one of the two.
   */
  maxSupplierBondLovelace: bigint | null;
  /** The most the buyer bond of the advert may be, in lovelace: the buyer funds it at the Post, and it returns at an Accept. A number refuses a dearer advert; `null` is no limit; no default. */
  maxBuyerBondLovelace: bigint | null;
  /** The decision between the checked receipt and the Accept. Absent, a delivery that passed the checks is accepted. A hook that throws stops the hire with its own error. */
  decide?: (delivery: AgentDelivery) => AcceptDecision | Promise<AcceptDecision>;
}

/** The deps of a hire of an agent. The chain and the stranded store are not here: they are the ones of the paying key the hire runs from. */
export interface AgentDeps extends Clocked {
  fetchImpl: FetchLike;
  /** The marketplace indexer for a selection by capability; the configured one when absent. */
  indexerUrl?: string;
  /** Where the hire books what it moved. */
  ledger: HireLedger;
  /** Where the choice of the agent and the terms of the hire are logged; nowhere by default. */
  log?: (line: string) => void;
}

/** The kit's errors, and the one it needs to say that no agent can be hired. */
export interface AgentErrors<E extends Error> extends HireErrors<E, 'agent'> {
  /** `why` completes "no agent to hire: ...". */
  unavailable(why: string): E;
}

/** What an outcome after a Post or a Pay says of the escrow: its ref, the advert it was posted on, the terms it was posted on, and the vault that continues after a confirmed Pay (null: the wallet paid). */
export interface AgentEscrow { advertRef: string; escrowRef: string; vaultRef: string | null; terms: HireTerms }

/** Why a vault Pay was not made: the script of the vault refused it, the node did not evaluate it, or it cannot be built. */
export type VaultRefusal =
  | { kind: 'ledger' | 'not_evaluated'; evaluationError: string; validators: VaultPayRefused['validators']; body: string; attempt: VaultPayAttempt }
  | { kind: 'impossible'; reason: VaultPayImpossibleReason };

export type AgentOutcome =
  | ({ outcome: 'completed'; paidFrom: 'wallet' | 'vault'; text: string; record: HireRecord; verdict: FleetVerification; accepted: 'confirmed' | 'pending' } & AgentEscrow)
  | ({ outcome: 'refused_before_claim'; code: string; status: number; message: string; supplierMessage: string } & AgentEscrow)
  | ({ outcome: 'failed_after_claim'; reason: HireFailure; message: string } & AgentEscrow)
  | { outcome: 'vault_refused'; advertRef: string; message: string; refusal: VaultRefusal }
  | ({ outcome: 'not_accepted'; reason: 'receipt_failed'; message: string; verdict: FleetVerification } & AgentEscrow)
  | ({ outcome: 'not_accepted'; reason: 'declined'; message: string; declined: string; delivery: AgentDelivery } & AgentEscrow);

/**
 * An error that ended a hire after a vault Pay was confirmed. The Pay spent the vault the caller held and left a new one: `vaultRef` is the reference of the vault that continues, and the
 * next Pay of the caller starts from it. `cause` is the error that ended the hire (a deadline, a failed write of the store, the decision of the caller that threw), and the message is its message.
 */
export class HireInterrupted extends Error {
  readonly vaultRef: string;
  readonly cause: unknown;
  constructor(cause: unknown, vaultRef: string) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'HireInterrupted';
    this.cause = cause;
    this.vaultRef = vaultRef;
  }
}

/** A hire that stopped with a word of the kit: the throw sites of hireOne give it to the factory below instead of an error of the caller. */
class HireStop extends Error {
  readonly hop: 'agent';
  readonly what: HireFailure;
  readonly facts: HireFacts;
  readonly detail: HireDetail | undefined;
  constructor(hop: 'agent', what: HireFailure, message: string, facts: HireFacts, detail: HireDetail | undefined) {
    super(message);
    this.name = 'HireStop';
    this.hop = hop;
    this.what = what;
    this.facts = facts;
    this.detail = detail;
  }
}

/** The factory hireOne is given: a failure is a HireStop that `hireAgent` turns into an outcome, and the deadline and the store write are the caller's errors. */
const stopping = <E extends Error>(errors: AgentErrors<E>): HireErrors<HireStop | E, 'agent'> => ({
  failure: (hop, what, message, facts, detail) => new HireStop(hop, what, message, facts, detail),
  deadline: (doing, facts) => errors.deadline(doing, facts),
  storeWrite: (message, facts) => errors.storeWrite(message, facts),
});

const canPayFromVault = (chain: Chain): chain is VaultChain => 'payFromVault' in chain && typeof chain.payFromVault === 'function';

/** What a selection asks for, in words. */
function asked(selection: AgentSelection): string {
  const parts: string[] = [];
  if (selection.capabilityId !== undefined) parts.push(`the capability ${selection.capabilityId}`);
  if (selection.model !== undefined) parts.push(`the model ${selection.model}`);
  if (selection.maxPriceLovelace !== undefined) parts.push(`a price of at most ${selection.maxPriceLovelace} lovelace`);
  return parts.length === 0 ? 'what was asked' : parts.join(', ');
}

/** The advert of the only Active listing that fits the selection. Two that fit, or none, is the caller's `unavailable`: the kit never picks one of several at random. */
async function listedAdvert<E extends Error>(deps: AgentDeps, selection: AgentSelection, unavailable: (why: string) => E): Promise<string> {
  const { capabilityId, model, maxPriceLovelace } = selection;
  if (capabilityId === undefined) throw unavailable('the selection names neither an advert nor a capability');
  let rows: Awaited<ReturnType<typeof fetchSuppliers>>;
  try {
    rows = await fetchSuppliers({ capability_id: capabilityId, onlyFree: false, fetchImpl: indexerFetch(deps.indexerUrl, deps.fetchImpl) });
  } catch (err) {
    throw unavailable(`the marketplace indexer could not be read (${errorText(err)})`);
  }
  const fit = rows.filter((row) => row.advert_status === 'Active' && (model === undefined || row.model === model) && (maxPriceLovelace === undefined || row.price_lovelace <= maxPriceLovelace));
  if (fit.length === 0) throw unavailable(`the indexer lists no Active advert for ${asked(selection)}`);
  if (fit.length > 1) throw unavailable(`the indexer lists ${fit.length} Active adverts for ${asked(selection)}; name one by its advert ref: ${fit.map((row) => row.utxo_ref).join(', ')}`);
  try { return canonicalRef(fit[0].utxo_ref); } catch (err) { throw unavailable(`the indexer lists an advert with a ref that cannot be read (${errorText(err)})`); }
}

/**
 * The agent to hire. The advert comes from the indexer's listing (one Active advert that fits) or from the caller by name, and is read on chain either way: it must be Active, it must be the
 * capability, the model and the price that were asked, and its bonds must be within the limits of the request. A named advert is not looked up in the listing of the indexer. The agent must
 * then serve, at its endpoint, its own advert and a key that hashes to the supplier key of the advert, or no receipt of it could verify.
 */
async function chooseAgent<E extends Error>(chain: Chain, deps: AgentDeps, request: AgentRequest, unavailable: (why: string) => E): Promise<HireSupplier<'agent'>> {
  const { selection } = request;
  let advertRef: string;
  if (selection.advertRef === undefined) {
    advertRef = await listedAdvert(deps, selection, unavailable);
  } else {
    try { advertRef = canonicalRef(selection.advertRef); } catch (err) { throw unavailable(errorText(err)); }
  }
  const advert = await advertOnChain(chain, advertRef, unavailable);
  if (advert.status !== 'Active') throw unavailable(`its advert ${advertRef} is ${advert.status} on chain, not Active`);
  const { capabilityId, model, maxPriceLovelace } = selection;
  if ((capabilityId !== undefined && advert.capability_id !== capabilityId) || (model !== undefined && advert.model !== model) || (maxPriceLovelace !== undefined && advert.price_lovelace > maxPriceLovelace)) {
    throw unavailable(`the advert ${advertRef} is not, on chain, an Active advert for ${asked(selection)}: it is for the capability ${advert.capability_id} with the model ${advert.model}, priced ${advert.price_lovelace} lovelace`);
  }
  const heavy = bondProblem(advertRef, advert, request);
  if (heavy !== null) throw unavailable(heavy);
  let capability: Awaited<ReturnType<typeof readCapability>>;
  try { capability = await readCapability(advert.endpoint_url, deps.fetchImpl); } catch (err) {
    throw unavailable(`the agent of ${advertRef} did not serve its capability (${errorText(err)})`);
  }
  let served = '';
  try { served = canonicalRef(capability.advert_ref); } catch { /* no ref: compared as nothing, below */ }
  if (served !== advertRef || capability.capability_id !== advert.capability_id) throw unavailable(`the agent at the endpoint of ${advertRef} serves another advert or another capability than the advert names`);
  if (!keyOfAdvert(capability, advert)) throw unavailable(`the key the agent of ${advertRef} serves is not the key of its advert, so no receipt of it could verify`);
  const supplier: HireSupplier<'agent'> = {
    hop: 'agent', advertRef, advert, capabilityId: advert.capability_id, model: advert.model, endpoint: advert.endpoint_url, pubKeyHex: capability.pub_key_hex, windowMs: advert.max_processing_ms,
  };
  deps.log?.(choiceLine(supplier));
  return supplier;
}

/** How a stop of hireOne ends the hire: an outcome, or the error of the caller's factory for a failure that no outcome names. */
function ended<E extends Error>(stop: HireStop, advertRef: string, vaultRef: string | null, terms: HireTerms, errors: AgentErrors<E>): AgentOutcome {
  const { what, facts, detail } = stop;
  const other = (): E => errors.failure(stop.hop, what, stop.message, facts, detail);
  if (what === 'post_failed') {
    const cause = detail?.cause;
    if (cause instanceof VaultPayRefused || cause instanceof VaultPayNotEvaluated) {
      return {
        outcome: 'vault_refused', advertRef, message: stop.message,
        refusal: { kind: cause instanceof VaultPayRefused ? 'ledger' : 'not_evaluated', evaluationError: cause.evaluationError, validators: cause.validators, body: cause.draftTx, attempt: cause.attempt },
      };
    }
    if (cause instanceof VaultPayImpossible) return { outcome: 'vault_refused', advertRef, message: stop.message, refusal: { kind: 'impossible', reason: cause.reason } };
    throw other();
  }
  if (facts.escrowRef === null) throw other();
  const escrow: AgentEscrow = { advertRef, escrowRef: facts.escrowRef, vaultRef, terms };
  if (what === 'busy' || what === 'refused') {
    if (detail?.refusal === undefined) throw other();
    const { code, status, message } = detail.refusal;
    // A refusal before the Claim only when the runtime said it in its own envelope, the escrow was read Open after it, and no earlier send of the job was left unclear. Any other end of a
    // send may come after a Claim, so a caller that believes it never happened could hire again and pay twice.
    if (isRuntimeRefusal(detail.refusal) && facts.escrowState === 'Open' && detail.unclearSend !== true) {
      return { outcome: 'refused_before_claim', code, status, message: stop.message, supplierMessage: message, ...escrow };
    }
    return { outcome: 'failed_after_claim', reason: 'send_lost', message: stop.message, ...escrow };
  }
  if (what === 'receipt_failed') {
    // A failed check has a verdict and is not_accepted. A hash that could not be read in time has none: the buyer did not judge the delivery.
    if (detail?.verdict === undefined) return { outcome: 'failed_after_claim', reason: 'receipt_unavailable', message: stop.message, ...escrow };
    return { outcome: 'not_accepted', reason: 'receipt_failed', message: stop.message, verdict: detail.verdict, ...escrow };
  }
  return { outcome: 'failed_after_claim', reason: what, message: stop.message, ...escrow };
}

/**
 * Hires one agent for one request from `key`, and says how the hire ended. Chooses the agent (`request.selection`, checked on chain with the limits of the bonds), pays its escrow from the wallet
 * or from the vault of `request.vaultRef`, sends the payload, polls, checks the receipt, asks `request.decide`, and accepts or does not. It runs in the lane of the key: one hire at a time for the key,
 * and the janitor of the key starts no transaction meanwhile. A vault Pay checks no limit of the vault: the node evaluates it, and the answer of the vault script is the `vault_refused` outcome
 * with the evaluation error and the body of the transaction. The error of the factory (`errors`) is thrown for what no outcome names, in a HireInterrupted after a confirmed vault Pay.
 */
export async function hireAgent<E extends Error>(key: PayingKey, deps: AgentDeps, request: AgentRequest, errors: AgentErrors<E>): Promise<AgentOutcome> {
  if (typeof request.payload !== 'string' || request.payload === '') throw new TypeError('The payload must be a non-empty string.');
  return key.lane.run(() => hireInLane(key, deps, request, errors));
}

async function hireInLane<E extends Error>(key: PayingKey, deps: AgentDeps, request: AgentRequest, errors: AgentErrors<E>): Promise<AgentOutcome> {
  const { chain } = key;
  const supplier = await chooseAgent(chain, deps, request, (why) => errors.unavailable(why));
  const job = templateJob(supplier.endpoint, request.payload, request.label ?? 'the agent job', deps.fetchImpl);
  /** The vault after a confirmed Pay: the next Pay of the caller starts from it. */
  const vault: { vaultRef: string | null } = { vaultRef: null };
  const { vaultRef, decide } = request;
  if (vaultRef !== undefined) {
    if (!canPayFromVault(chain)) throw errors.unavailable('the chain of this run cannot pay from a vault');
    job.payment = {
      what: 'Vault Pay',
      run: async () => {
        const paid = await chain.payFromVault({ vaultRef, advertRef: supplier.advertRef, payload: request.payload });
        vault.vaultRef = paid.vaultRef;
        return paid;
      },
    };
  }
  // The lock of the Post, which the terms of the hire say beside the price and the bonds.
  let locked = 0n;
  const ledger: HireLedger = {
    posted: (post) => { locked = post.lockLovelace; deps.ledger.posted(post); },
    accepted: (accept) => { deps.ledger.accepted(accept); },
  };
  const deliveryOf = (d: Delivery<TemplateAnswer>): AgentDelivery => ({ escrowRef: d.record.escrow_ref, advertRef: supplier.advertRef, text: d.value.text, record: d.record, verdict: d.verdict });
  const options: HireOptions<TemplateAnswer> = { terms: true };
  if (decide !== undefined) options.decide = (d) => decide(deliveryOf(d));
  /** How the hire ended: an outcome, or the error of the factory or of the caller for what no outcome names. */
  const run = async (): Promise<AgentOutcome> => {
    try {
      const hired = await hireOne(key.hireDeps(deps, deps.log), supplier, job, ledger, stopping(errors), options);
      return {
        outcome: 'completed', paidFrom: vaultRef === undefined ? 'wallet' : 'vault', advertRef: supplier.advertRef, escrowRef: hired.record.escrow_ref, vaultRef: vault.vaultRef,
        terms: termsOf(supplier.advert, locked), text: hired.value.text, record: hired.record, verdict: hired.verdict, accepted: hired.accepted,
      };
    } catch (err) {
      if (err instanceof HireStop) return ended(err, supplier.advertRef, vault.vaultRef, termsOf(supplier.advert, locked), errors);
      if (err instanceof HireDeclined) {
        const delivery = deliveryOf(err.delivery);
        return {
          outcome: 'not_accepted', reason: 'declined', message: err.message, declined: err.reason, delivery, advertRef: supplier.advertRef, escrowRef: delivery.escrowRef, vaultRef: vault.vaultRef,
          terms: termsOf(supplier.advert, locked),
        };
      }
      throw err;
    }
  };
  try { return await run(); } catch (err) {
    // Every error after a confirmed Pay, the factory's and the caller's own, carries the vault that continues. Before a confirmed Pay there is none, and the error is thrown as it is.
    throw vault.vaultRef === null ? err : new HireInterrupted(err, vault.vaultRef);
  }
}
