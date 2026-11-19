// packages/hire-kit/src/agent.ts
// The hire of an agent of the template contract, from the choice of its advert to the Accept. The caller names what it wants (a capability and a model, or one advert), the text
// the agent reads, where the money comes from (the wallet, or a vault that the key pays from as a delegate), and the decision it takes between the checked receipt and the Accept.
// The kit does the rest and says how the hire ended in one of five words, in a type that a `switch` can check:
//   completed             the receipt passed the eight checks, the decision accepted it, and the Accept was made.
//   refused_before_claim  the agent turned the job down (or stayed busy until the send ran out of time) and never claimed the escrow. The escrow stays Open and recorded: the janitor
//                         reclaims it after its deliver_by, to the vault when a vault paid it.
//   failed_after_claim    the agent may hold the job and the hire did not end well: the send was lost, the agent failed, the polls ran out of time, the answer could not be used,
//                         the receipt could not be read, or the Accept failed. Its `reason` is the <what> of the failure.
//   vault_refused         the vault Pay did not leave the node as a transaction: the script of the vault refused it (a limit), the node did not evaluate it, or it could not be built.
//                         Nothing was signed, nothing was submitted, and no money moved. The evaluation error and the body of the transaction are in the result.
//   not_accepted          the delivery came and the escrow was not accepted: the receipt failed a check, or the decision of the caller said no. The escrow stays as it is.
// What is not an outcome is thrown by the factory of the caller: no advert or no agent to hire, a Post that failed before its signature, the deadline, the stranded store.
import { VaultPayImpossible, VaultPayNotEvaluated, VaultPayRefused, fetchSuppliers, indexerFetch, readCapability } from '@vsa/buyer-core';
import type { FetchLike, FleetVerification, VaultChain, VaultPayAttempt, VaultPayImpossibleReason } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { canonicalRef, errorText } from './format.ts';
import { HireDeclined, hireOne } from './hire.ts';
import type { AcceptDecision, Delivery, HireDeps, HireDetail, HireErrors, HireFacts, HireFailure, HireLedger, HireOptions, HireRecord, HireSupplier } from './hire.ts';
import { advertOnChain, choiceLine, keyOfAdvert } from './select.ts';
import { templateJob } from './template-client.ts';
import type { TemplateAnswer } from './template-client.ts';

/** How an agent is chosen: by what it does (and at most what it costs), or by the advert that the caller names. */
export type AgentSelection =
  | { capabilityId: string; model?: string; maxPriceLovelace?: bigint }
  | { advertRef: string };

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
  /** The decision between the checked receipt and the Accept. Absent, a delivery that passed the checks is accepted. A hook that throws stops the hire with its own error. */
  decide?: (delivery: AgentDelivery) => AcceptDecision | Promise<AcceptDecision>;
}

export interface AgentDeps extends HireDeps {
  fetchImpl: FetchLike;
  /** The marketplace indexer for a selection by capability; the configured one when absent. */
  indexerUrl?: string;
  /** Where the hire books what it moved. */
  ledger: HireLedger;
}

/** The kit's errors, and the one it needs to say that no agent can be hired. */
export interface AgentErrors<E extends Error> extends HireErrors<E, 'agent'> {
  /** `why` completes "no agent to hire: ...". */
  unavailable(why: string): E;
}

/** What an outcome after a Post or a Pay says of the escrow: its ref, the advert it was posted on, and the vault that continues after a confirmed Pay (null: the wallet paid). */
export interface AgentEscrow { advertRef: string; escrowRef: string; vaultRef: string | null }

/** Why a vault Pay was not made: the script of the vault refused it, the node did not evaluate it, or it cannot be built. */
export type VaultRefusal =
  | { kind: 'ledger' | 'not_evaluated'; evaluationError: string; validators: VaultPayRefused['validators']; body: string; attempt: VaultPayAttempt }
  | { kind: 'impossible'; reason: VaultPayImpossibleReason };

export type AgentOutcome =
  | ({ outcome: 'completed'; paidFrom: 'wallet' | 'vault'; text: string; record: HireRecord; verdict: FleetVerification; accepted: 'confirmed' | 'pending' } & AgentEscrow)
  | ({ outcome: 'refused_before_claim'; code: string; status: number; message: string; supplierMessage: string } & AgentEscrow)
  | ({ outcome: 'failed_after_claim'; reason: HireFailure; message: string } & AgentEscrow)
  | { outcome: 'vault_refused'; advertRef: string; message: string; refusal: VaultRefusal }
  | ({ outcome: 'not_accepted'; reason: 'receipt_failed'; message: string; verdict: FleetVerification | null } & AgentEscrow)
  | ({ outcome: 'not_accepted'; reason: 'declined'; message: string; declined: string; delivery: AgentDelivery } & AgentEscrow);

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

/** The advert of the only Active listing that fits the selection. Two that fit, or none, is the caller's `unavailable`: the kit never picks one of several at random. */
async function listedAdvert<E extends Error>(deps: AgentDeps, selection: { capabilityId: string; model?: string; maxPriceLovelace?: bigint }, unavailable: (why: string) => E): Promise<string> {
  const { capabilityId, model, maxPriceLovelace } = selection;
  let rows: Awaited<ReturnType<typeof fetchSuppliers>>;
  try {
    rows = await fetchSuppliers({ capability_id: capabilityId, onlyFree: false, fetchImpl: indexerFetch(deps.indexerUrl, deps.fetchImpl) });
  } catch (err) {
    throw unavailable(`the marketplace indexer could not be read (${errorText(err)})`);
  }
  const fit = rows.filter((row) => row.advert_status === 'Active' && (model === undefined || row.model === model) && (maxPriceLovelace === undefined || row.price_lovelace <= maxPriceLovelace));
  const wanted = `${capabilityId}${model === undefined ? '' : ` with the model ${model}`}${maxPriceLovelace === undefined ? '' : ` at ${maxPriceLovelace} lovelace or less`}`;
  if (fit.length === 0) throw unavailable(`the indexer lists no Active advert for ${wanted}`);
  if (fit.length > 1) throw unavailable(`the indexer lists ${fit.length} Active adverts for ${wanted}; name one by its advert ref: ${fit.map((row) => row.utxo_ref).join(', ')}`);
  return canonicalRef(fit[0].utxo_ref);
}

/**
 * The agent to hire. The advert comes from the indexer's listing (one Active advert that fits) or from the caller by name, and is read on chain either way: it must be Active,
 * and it must be the capability, the model and the price that were asked. A named advert is not looked up in the listing of the indexer. The agent must then serve, at its endpoint,
 * its own advert and a key that hashes to the supplier key of the advert, or no receipt of it could verify.
 */
async function chooseAgent<E extends Error>(deps: AgentDeps, selection: AgentSelection, unavailable: (why: string) => E): Promise<HireSupplier<'agent'>> {
  let advertRef: string;
  try {
    advertRef = 'advertRef' in selection ? canonicalRef(selection.advertRef) : await listedAdvert(deps, selection, unavailable);
  } catch (err) {
    throw err instanceof Error && err.message.startsWith('no agent to hire') ? err : unavailable(errorText(err));
  }
  const advert = await advertOnChain(deps.chain, advertRef, unavailable);
  if (advert.status !== 'Active') throw unavailable(`its advert ${advertRef} is ${advert.status} on chain, not Active`);
  if (!('advertRef' in selection)) {
    const { capabilityId, model, maxPriceLovelace } = selection;
    if (advert.capability_id !== capabilityId || (model !== undefined && advert.model !== model) || (maxPriceLovelace !== undefined && advert.price_lovelace > maxPriceLovelace)) {
      throw unavailable(`the advert ${advertRef} that the indexer lists is not, on chain, an Active ${capabilityId} advert with the model and the price that were asked`);
    }
  }
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
function ended<E extends Error>(stop: HireStop, advertRef: string, vault: { vaultRef: string | null }, errors: AgentErrors<E>): AgentOutcome {
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
  const escrow: AgentEscrow = { advertRef, escrowRef: facts.escrowRef, vaultRef: vault.vaultRef };
  if (what === 'busy' || what === 'refused') {
    if (detail?.refusal === undefined) throw other();
    const { code, status, message } = detail.refusal;
    return { outcome: 'refused_before_claim', code, status, message: stop.message, supplierMessage: message, ...escrow };
  }
  if (what === 'receipt_failed') return { outcome: 'not_accepted', reason: 'receipt_failed', message: stop.message, verdict: detail?.verdict ?? null, ...escrow };
  return { outcome: 'failed_after_claim', reason: what, message: stop.message, ...escrow };
}

/**
 * Hires one agent for one request and says how the hire ended. Chooses the agent (`request.selection`), pays its escrow from the wallet or from the vault of `request.vaultRef`,
 * sends the payload, polls, checks the receipt, asks `request.decide`, and accepts or does not. A vault Pay checks no limit of the vault: the node evaluates it, and the answer of the
 * vault script is the `vault_refused` outcome with the evaluation error and the body of the transaction. The error of the factory (`errors`) is thrown for what no outcome names.
 */
export async function hireAgent<E extends Error>(deps: AgentDeps, request: AgentRequest, errors: AgentErrors<E>): Promise<AgentOutcome> {
  if (typeof request.payload !== 'string' || request.payload === '') throw new TypeError('The payload must be a non-empty string.');
  const supplier = await chooseAgent(deps, request.selection, (why) => errors.unavailable(why));
  const job = templateJob(supplier.endpoint, request.payload, request.label ?? 'the agent job', deps.fetchImpl);
  /** The vault after a confirmed Pay: the next Pay of the caller starts from it. */
  const vault: { vaultRef: string | null } = { vaultRef: null };
  const options: HireOptions<TemplateAnswer> = {};
  const { vaultRef, decide } = request;
  if (vaultRef !== undefined) {
    const { chain } = deps;
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
  const deliveryOf = (d: Delivery<TemplateAnswer>): AgentDelivery => ({ escrowRef: d.record.escrow_ref, advertRef: supplier.advertRef, text: d.value.text, record: d.record, verdict: d.verdict });
  if (decide !== undefined) options.decide = (d) => decide(deliveryOf(d));
  try {
    const hired = await hireOne(deps, supplier, job, deps.ledger, stopping(errors), options);
    return {
      outcome: 'completed', paidFrom: vaultRef === undefined ? 'wallet' : 'vault', advertRef: supplier.advertRef, escrowRef: hired.record.escrow_ref, vaultRef: vault.vaultRef,
      text: hired.value.text, record: hired.record, verdict: hired.verdict, accepted: hired.accepted,
    };
  } catch (err) {
    if (err instanceof HireStop) return ended(err, supplier.advertRef, vault, errors);
    if (err instanceof HireDeclined) {
      const delivery = deliveryOf(err.delivery);
      return { outcome: 'not_accepted', reason: 'declined', message: err.message, declined: err.reason, delivery, advertRef: supplier.advertRef, escrowRef: delivery.escrowRef, vaultRef: vault.vaultRef };
    }
    throw err;
  }
}
