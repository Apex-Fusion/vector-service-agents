// packages/hire-kit/src/model.ts
// The hire of a model on the marketplace, from the service key. A model hire is a decision of the service, and the kit makes one hire for it:
//   - Model hires run one after the other from the one service key. They go through the lane of the key, so a second hire starts only when the first has ended, however it ended.
//     A hire whose turn comes at or after its deadline does not begin: it ends with the deadline error before it reads or posts anything (checkTurn, src/keys.ts).
//   - One call is one decision and one hire: one choice of a supplier, one Post, one job. The kit does not retry the call, does not try another supplier when the one it chose
//     fails, and does not fall back to a model service that is not on the marketplace.
//   - A hire that fails ends the job of the caller as a recorded failure: the call throws the error of the caller's factory once, and the escrow the hire left behind is in the
//     stranded store of the key, for its janitor.
//   - The price ceiling does not bound what a hire pays. The buyer funds the price and both bonds at the Post, an Accept pays the supplier the price and the supplier bond, and a Release
//     pays it all three. So a request carries a limit for each bond, with no default. A number refuses an advert whose bond is above it, before the Post. `null` is no limit. The kit does
//     not cap the lock of the Post: a caller that wants to know whether its wallet covers a lock reads it with plannedLockOf, before it decides.
//   - Every hire writes its terms into its record and into its log: the price, both bonds, what the Post locks, and what an Accept pays the supplier.
import type { FetchLike } from '@vsa/buyer-core';
import type { Clocked } from './budget.ts';
import { chatJob, hireOne } from './hire.ts';
import type { HireErrors, HireLedger, HireOptions, Hired } from './hire.ts';
import { checkTurn } from './keys.ts';
import type { PayingKey } from './keys.ts';
import { chooseChatSupplier, requireLimits } from './select.ts';

/** What the kit keeps of the answer of a model: its text, and the status of the response as the supplier gave it. */
export interface ModelAnswer { text: string; status: unknown }

export interface ModelRequest {
  /** The prompt: the `input` of the Responses request. */
  input: string;
  /** What the job is called in messages. */
  label?: string;
  /** The chat models the caller hires, in order of preference. */
  allowlist: readonly string[];
  /** The most the job may be priced at, in lovelace: an advert above it is not hired. */
  maxPriceLovelace: bigint;
  /** The most the supplier bond of the advert may be, in lovelace. An Accept pays it to the supplier with the price. A number refuses a dearer advert before the Post; `null` is no limit; no default. */
  maxSupplierBondLovelace: bigint | null;
  /** The most the buyer bond of the advert may be, in lovelace. The buyer funds it at the Post, and it returns at an Accept. A number refuses a dearer advert; `null` is no limit; no default. */
  maxBuyerBondLovelace: bigint | null;
  /** The setting a message names for the ceiling: 'LLM_MAX_PRICE_LOVELACE'. */
  ceilingSetting: string;
  /** To the choice of the supplier: absent, its own defaults (120 s and 6 candidates). */
  budgetMs?: number;
  maxCandidates?: number;
}

export interface ModelDeps extends Clocked {
  fetchImpl: FetchLike;
  /** The marketplace indexer; the configured one when absent. */
  indexerUrl?: string;
  /** Where the hire books what it moved. */
  ledger: HireLedger;
  /** Where the choice is logged; nowhere by default. */
  log?: (line: string) => void;
  /** The two options of hireOne that bound a hire in time. */
  options?: Pick<HireOptions<ModelAnswer>, 'firstSendBy' | 'receiptBy'>;
}

/** The kit's errors, and the one it needs to say that no model can be hired. */
export interface ModelErrors<E extends Error> extends HireErrors<E> {
  /** `why` completes the message of a call that found no supplier to hire. */
  unavailable(why: string): E;
}

/**
 * Hires one model for `request` from `key`: the answer, the record of the hire, and what the Accept came to. Refuses a limit that is not a bigint (the two limits of the bonds also take
 * null) with a TypeError, before the lane of the key is used and before anything is read. A hire whose turn in the lane comes at or after `deps.deadlineMs` rejects with the `deadline` of `errors`,
 * with the stage `lane` and no escrow, before anything is read or posted. Rejects with the error of `errors` for every other failure; the kit does not try again, does not choose another
 * supplier and does not fall back (see the head of this file).
 */
export async function hireModel<E extends Error>(key: PayingKey, deps: ModelDeps, request: ModelRequest, errors: ModelErrors<E>): Promise<Hired<ModelAnswer>> {
  requireLimits({ maxPriceLovelace: request.maxPriceLovelace }, { null: false, absent: false });
  requireLimits({ maxSupplierBondLovelace: request.maxSupplierBondLovelace, maxBuyerBondLovelace: request.maxBuyerBondLovelace }, { null: true, absent: false });
  const label = request.label ?? 'the model call';
  return key.lane.run(async () => {
    checkTurn(deps, label, errors);
    const supplier = await chooseChatSupplier(key.chain, {
      fetchImpl: deps.fetchImpl, indexerUrl: deps.indexerUrl, allowlist: request.allowlist, maxPriceLovelace: request.maxPriceLovelace, ceilingSetting: request.ceilingSetting,
      maxSupplierBondLovelace: request.maxSupplierBondLovelace, maxBuyerBondLovelace: request.maxBuyerBondLovelace, budgetMs: request.budgetMs, maxCandidates: request.maxCandidates, log: deps.log,
    }, (why) => errors.unavailable(why));
    const job = chatJob(supplier.endpoint, request.input, label, deps.fetchImpl);
    return hireOne(key.hireDeps(deps, deps.log), supplier, job, deps.ledger, errors, { ...deps.options, terms: true });
  });
}
