// packages/hire-kit/src/select.ts
// The chat supplier of a hire, chosen before its Post, and what an advert is held to before anything is locked on it. Moved from
// agents/document-pipeline/src/orchestrate.ts with its rulings and its words; what was the Pipeline's own there (its code llm_supplier_unavailable, the
// words "No chat supplier can be hired for <label>", the setting that holds the ceiling) comes in from the caller.
//
// The choice (chooseChatSupplier): the selection of packages/buyer-core (selectLlmSupplier, with the probe) takes the Active llm.text.generate.v1 adverts
// whose model is on the allowlist and whose price is at or under the ceiling, whatever the indexer says of their supplier at the moment (ruling R60), in
// the order of the allowlist, then the price, then when the supplier was last seen; it asks at most the first `maxCandidates` (6 by default) in turn, within
// `budgetMs` (120 s by default), for a /capability that serves the Responses API for its own advert and a /status that says free or working (one at work
// is waited for by the send). Null from it says none passed in time, not that none exists (ruling R22). The advert it chose is then read on chain, where it
// must be an active llm.text.generate.v1 advert of the supplier the indexer names, with a model on the allowlist, at a price at or under the ceiling
// (ruling R56), naming the endpoint the selection asked, and the key its /capability serves must hash to the supplier key of the advert, or no receipt of
// it could verify: the indexer is a guide, the chain is what an escrow settles against (ruling R31). A supplier that fails any of it is the caller's
// `unavailable`, with the reason in words; nothing was locked. The supplier chosen is logged with the host of its endpoint and never the whole URL, which
// is the supplier's to write (ruling R65).
//
// The lock (plannedLockOf): what a Post on the advert locks, planned as the Post plans it (planFleetPostEscrow), with a prompt hash of the size of every
// prompt hash; and the float a sub-job needs (subJobFloat), its lock and the fee of a Post and of an Accept at the marketplace floor (ruling R56).
import {
  LLM_SELECTION_BUDGET_MS, LLM_SELECTION_MAX_CANDIDATES, TX_FEE_BUDGET_LOVELACE, flatText, planFleetPostEscrow, selectLlmSupplier,
} from '@vsa/buyer-core';
import type { Chain, FetchLike, SupplierCapability } from '@vsa/buyer-core';
import { blake2b224Hex } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { canonicalRef, errorText } from './format.ts';
import type { HireSupplier } from './hire.ts';

/** What the choice of a chat supplier is asked with. */
export interface ChatQuery {
  fetchImpl: FetchLike;
  /** The marketplace indexer; the configured one when absent. */
  indexerUrl?: string;
  /** The chat models the caller hires, in order of preference. */
  allowlist: readonly string[];
  /** The most the chat job may be priced at, in lovelace (ruling R56): an advert above it is not hired. */
  maxPriceLovelace: bigint;
  /** The setting a message names for the ceiling: 'LLM_MAX_PRICE_LOVELACE'. */
  ceilingSetting: string;
  /** To selectLlmSupplier and into the message: absent, 120 s and 6, the selection's own defaults. */
  budgetMs?: number;
  maxCandidates?: number;
  /** Where the choice is logged (choiceLine, ruling R65); nowhere by default. */
  log?: (line: string) => void;
}

const LLM_CAPABILITY = 'llm.text.generate.v1';
const PUB_KEY = /^[0-9a-f]{64}$/i;
const withoutSlash = (url: string): string => url.replace(/\/+$/, '');
/** The prompt hash a lock is planned with: the lock depends on the size of the escrow datum, and every prompt hash is 32 bytes of it. */
const PLANNING_PROMPT_HASH = '0'.repeat(64);

/** Does the key a supplier's /capability serves hash to the supplier key of its advert? */
export const keyOfAdvert = (capability: SupplierCapability, advert: AdvertDatum): boolean =>
  PUB_KEY.test(capability.pub_key_hex) && blake2b224Hex(capability.pub_key_hex.toLowerCase()) === advert.supplier_pkh.toLowerCase();

/** The advert's datum read on chain, or the caller's `unavailable` with the reason. */
export async function advertOnChain<E>(chain: Chain, advertRef: string, unavailable: (why: string) => E): Promise<AdvertDatum> {
  try { return await chain.readAdvert(advertRef); } catch (err) { throw unavailable(`its advert ${advertRef} could not be read on chain (${errorText(err)})`); }
}

/** The host of an endpoint, for a log line: the whole URL is the supplier's to write and stays out of the log (ruling R65). */
const hostOf = (endpoint: string): string => { try { return new URL(endpoint).host; } catch { return 'unreadable'; } };

/** The line a run logs for the supplier it chose (ruling R65): its advert, the model of the chat supplier, its price and the host of its endpoint. */
export function choiceLine(supplier: HireSupplier): string {
  const model = supplier.hop === 'llm' ? `, model ${flatText(supplier.model, 100)}` : '';
  return `chosen ${supplier.hop === 'ocr' ? 'OCR' : 'chat'} supplier: advert ${supplier.advertRef}${model}, price ${supplier.advert.price_lovelace} lovelace, endpoint host ${hostOf(supplier.endpoint)}`;
}

/** What an advert above its ceiling is said to be: its price, the ceiling, and the setting that holds it. */
export const aboveCeiling = (advertRef: string, price: bigint, ceiling: bigint, setting: string): string =>
  `its advert ${advertRef} is priced ${price} lovelace, above the ceiling of ${ceiling} lovelace (${setting})`;

/** The chat supplier: the selection's choice at a price at or under the ceiling, its advert checked on chain against it. The caller's `unavailable` otherwise. */
export async function chooseChatSupplier<E extends Error>(chain: Chain, query: ChatQuery, unavailable: (why: string) => E): Promise<HireSupplier> {
  const ceiling = query.maxPriceLovelace;
  const budgetMs = query.budgetMs ?? LLM_SELECTION_BUDGET_MS;
  const maxCandidates = query.maxCandidates ?? LLM_SELECTION_MAX_CANDIDATES;
  let chosen: Awaited<ReturnType<typeof selectLlmSupplier>>;
  try { chosen = await selectLlmSupplier({ fetchImpl: query.fetchImpl, indexerUrl: query.indexerUrl, allowlist: query.allowlist, probe: true, maxPriceLovelace: ceiling, budgetMs, maxCandidates }); } catch (err) {
    throw unavailable(`the marketplace indexer could not be read (${errorText(err)})`);
  }
  if (chosen === null) {
    // Null says none passed in time, not that none exists (ruling R22): the reasons are the selection's three.
    throw unavailable(`the indexer lists no Active ${LLM_CAPABILITY} advert whose model is on the allowlist (${query.allowlist.join(', ')}) at a price at or under the ceiling of ${ceiling} lovelace (${query.ceilingSetting}), `
      + `or none of the first ${maxCandidates} such suppliers answered its /capability with the Responses API for its own advert and its /status with free or working, `
      + `or the selection ran out of its ${budgetMs / 1000} s`);
  }
  const advertRef = canonicalRef(chosen.advertRef);
  const advert = await advertOnChain(chain, advertRef, unavailable);
  if (advert.capability_id !== LLM_CAPABILITY || advert.status !== 'Active' || advert.supplier_pkh !== chosen.supplierPkh.toLowerCase() || !query.allowlist.includes(advert.model)) {
    throw unavailable(`the advert ${advertRef} the selection chose is not, on chain, an active ${LLM_CAPABILITY} advert of the supplier the indexer names with a model on the allowlist`);
  }
  if (advert.price_lovelace > ceiling) throw unavailable(`on chain, ${aboveCeiling(advertRef, advert.price_lovelace, ceiling, query.ceilingSetting)}`);
  if (withoutSlash(advert.endpoint_url) !== withoutSlash(chosen.endpoint)) throw unavailable(`the advert ${advertRef} names another endpoint on chain than the one the selection asked`);
  if (!keyOfAdvert(chosen.capability, advert)) throw unavailable(`the key the supplier of ${advertRef} serves is not the key of its advert, so no receipt of it could verify`);
  const supplier: HireSupplier = { hop: 'llm', advertRef, advert, capabilityId: advert.capability_id, model: advert.model, endpoint: advert.endpoint_url, pubKeyHex: chosen.capability.pub_key_hex, windowMs: advert.max_processing_ms };
  query.log?.(choiceLine(supplier));
  return supplier;
}

/** The lock a Post on the supplier's advert takes, planned as the Post plans it (planFleetPostEscrow); the planner's Error passes through for an advert no Post can be planned on. */
export function plannedLockOf(supplier: HireSupplier, buyerPkh: string, nowMs: number): bigint {
  return planFleetPostEscrow(supplier.advert, supplier.advertRef, buyerPkh, PLANNING_PROMPT_HASH, nowMs).lockLovelace;
}

/** The float one sub-job needs outside the collateral: its lock and the fee of a Post and of an Accept (TX_FEE_BUDGET_LOVELACE each, ruling R56). */
export const subJobFloat = (lockLovelace: bigint): bigint => lockLovelace + 2n * TX_FEE_BUDGET_LOVELACE;
