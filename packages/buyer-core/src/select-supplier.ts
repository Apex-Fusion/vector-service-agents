// packages/buyer-core/src/select-supplier.ts
// Supplier discovery: which chat supplier to hire for the summary (selectLlmSupplier) and which OCR advert to hire for a page (findOcrAdvert). Both read the
// marketplace indexer with the vendored fetchSuppliers, which lists the adverts of one capability, and keep the Active adverts whatever the indexer says of
// their supplier at the moment (free, working, offline): that word is a moment's and must not fail a job before it locks anything, and the send of a job waits for a
// supplier that is busy (ruling R60). A chat candidate is then asked for its own word at /status, which must be free or working: offline, another word or
// no answer passes it over for the next. The indexer is the operator's own configuration, read with the injected fetch as it is. The suppliers it lists are
// reached only through safeFetch (see fleet-clients.ts).
//
// The indexer's row names the advert's UTxO `utxo_ref`: it is the `advert_ref` that the supplier's own /capability serves, and the ref the escrow's Post is
// made against. So `advertRef` below is the row's `utxo_ref`.
import { fetchSuppliers } from './vendored/mcp/marketplace-indexer.ts';
import { INDEXER_URL, indexerUrlFrom } from './vendored/mcp/marketplace-constants.ts';
import { sameRef } from './guards.ts';
import { probeStatus, readCapability } from './fleet-clients.ts';
import type { FetchLike, SupplierCapability } from './fleet-clients.ts';

const LLM_CAPABILITY = 'llm.text.generate.v1';
const OCR_CAPABILITY = 'ocr.page.extract.chandra-ocr-2.v1';
/** All the selection may take, from the moment it is called: a supplier that does not answer costs up to 22 s (20 s for /capability, 2 s for /status). */
export const LLM_SELECTION_BUDGET_MS = 120_000;
/** The most suppliers the selection asks, in order, before it gives up. */
export const LLM_SELECTION_MAX_CANDIDATES = 6;
/** The words of a supplier's /status that keep it a candidate (ruling R60): free, or working, which the send waits for. */
const HIRABLE: ReadonlySet<string> = new Set(['free', 'working']);
/** The longest delay a timer takes: Node cuts a longer one to a millisecond. */
const MAX_TIMER_MS = 2_147_483_647;
const EXPIRED = Symbol('the budget of the selection ran out');

/**
 * `fetchImpl` aimed at the indexer at `indexerUrl`. The vendored fetchSuppliers builds its URLs on INDEXER_URL, a constant it reads from the environment when
 * the module loads, and takes no base; a vendored file is never edited, so the calls to that base are sent to the given one. Without `indexerUrl` the fetch
 * is returned as it is, and the indexer is the configured one.
 */
function aimedAt(indexerUrl: string | undefined, fetchImpl: FetchLike): FetchLike {
  if (indexerUrl === undefined || indexerUrl === '') return fetchImpl;
  const base = indexerUrlFrom(indexerUrl);
  if (base === INDEXER_URL) return fetchImpl;
  return ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetchImpl(url.startsWith(`${INDEXER_URL}/`) ? `${base}${url.slice(INDEXER_URL.length)}` : input, init);
  }) as FetchLike;
}

/** `fetchImpl` whose every request is also cancelled when `signal` fires. */
function cancelledBy(signal: AbortSignal, fetchImpl: FetchLike): FetchLike {
  return ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
    fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })) as FetchLike;
}

/** A limit the caller gave, whole and not below zero, or `fallback` when none was given. Infinity lifts the limit; a value that is not a number is a mistake. */
function limitOf(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError(`${name} must be a number.`);
  return Math.max(0, Math.floor(value));
}

const byPrice = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
/** Is the row priced at `max` or under it? Without a ceiling, every row is. */
const withinCeiling = (max: bigint | undefined) => (row: { price_lovelace: bigint }): boolean => max === undefined || row.price_lovelace <= max;
/** The Active adverts of one capability the indexer lists, priced at `max` or under it, whatever the indexer says of their supplier (ruling R60). */
async function listedAdverts(capabilityId: string, indexerUrl: string | undefined, fetchImpl: FetchLike, max: bigint | undefined) {
  const rows = await fetchSuppliers({ capability_id: capabilityId, onlyFree: false, fetchImpl: aimedAt(indexerUrl, fetchImpl) });
  return rows.filter((row) => row.advert_status === 'Active').filter(withinCeiling(max));
}
/** When a supplier was last seen, as a number to compare; a supplier never seen, or seen at a time that is no date, is the least recent. */
const seenAt = (iso: string | null): number => {
  const time = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};
const newerFirst = (a: number, b: number): number => (a === b ? 0 : a > b ? -1 : 1);

/**
 * The chat supplier to hire, or null when none is fit. An advert priced above `maxPriceLovelace` (when given) is taken out before anything else. The
 * candidates are the Active `llm.text.generate.v1` adverts whose model is on `allowlist`, whatever the indexer says of their supplier (ruling R60), in this
 * order: the position of the model on the allowlist, then the price (lowest first), then when the supplier was last seen (latest first; a supplier never seen,
 * or seen at a time that is no date, last). At most `maxCandidates` (LLM_SELECTION_MAX_CANDIDATES, 6 by default) are asked, each in turn for its /capability, which must carry
 * `inference_api: "responses"` and the very `advert_ref` the indexer lists for it, and, when `probe` is true, for its /status, which must say free or working
 * (ruling R60: a supplier at work is waited for by the send). The first that passes is the answer, so the candidates after it are not contacted. A candidate
 * whose /capability cannot be read or does not match, or whose /status says offline, says another word or cannot be read, is passed over, not an error.
 * The whole selection has `budgetMs` (LLM_SELECTION_BUDGET_MS, 120 s by default) from the moment it is called, the read of the indexer included: when that runs out before a
 * candidate has passed, the call in flight is cancelled and the answer is null, and a candidate that answers after that is not used. Infinity lifts either limit.
 * Rejects when the indexer cannot be read, and when a limit is not a number.
 */
export async function selectLlmSupplier(args: {
  fetchImpl: FetchLike; indexerUrl?: string; allowlist: readonly string[]; probe?: boolean; budgetMs?: number; maxCandidates?: number; maxPriceLovelace?: bigint;
}): Promise<{
  advertRef: string; endpoint: string; model: string; supplierPkh: string; priceLovelace: bigint; capability: SupplierCapability;
} | null> {
  const startedAt = performance.now();
  const budgetMs = limitOf(args.budgetMs, LLM_SELECTION_BUDGET_MS, 'budgetMs');
  const maxCandidates = limitOf(args.maxCandidates, LLM_SELECTION_MAX_CANDIDATES, 'maxCandidates');
  const rows = await listedAdverts(LLM_CAPABILITY, args.indexerUrl, args.fetchImpl, args.maxPriceLovelace);
  const candidates = rows
    .map((row) => ({ row, rank: args.allowlist.indexOf(row.model) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((a, b) => a.rank - b.rank || byPrice(a.row.price_lovelace, b.row.price_lovelace) || newerFirst(seenAt(a.row.last_seen_iso), seenAt(b.row.last_seen_iso)))
    .slice(0, maxCandidates);
  const left = budgetMs - (performance.now() - startedAt);
  if (left <= 0 || candidates.length === 0) return null;
  // From here on every request is cancelled when the budget runs out, and the wait for a candidate ends then even if it cannot be cancelled (a host lookup).
  const cutoff = AbortSignal.timeout(Math.min(Math.ceil(left), MAX_TIMER_MS));
  const reach = cancelledBy(cutoff, args.fetchImpl);
  const expired = new Promise<typeof EXPIRED>((resolve) => { cutoff.addEventListener('abort', () => resolve(EXPIRED), { once: true }); });
  // One candidate: the supplier to hire if it passes, else null. It never rejects, so one that is still running when the budget ends is left to end alone.
  const hire = async (row: (typeof rows)[number]) => {
    let capability: SupplierCapability;
    try { capability = await readCapability(row.endpoint_url, reach); } catch { return null; }
    if (capability.inference_api !== 'responses' || !sameRef(capability.advert_ref, row.utxo_ref)) return null;
    if (args.probe === true && !HIRABLE.has(await probeStatus(row.endpoint_url, reach))) return null;
    return { advertRef: row.utxo_ref, endpoint: row.endpoint_url, model: row.model, supplierPkh: row.supplier_pkh, priceLovelace: row.price_lovelace, capability };
  };
  for (const { row } of candidates) {
    const found = await Promise.race([hire(row), expired]);
    if (found === EXPIRED) return null;
    if (found !== null) return found;
  }
  return null;
}

/**
 * The OCR advert to hire: the Active `ocr.page.extract.chandra-ocr-2.v1` advert of the supplier key `supplierPkh`, whatever the indexer says of the supplier
 * (ruling R60), priced at `maxPriceLovelace` or under it when that is given. Exactly one is expected; none (it is not listed, or not Active, or priced above
 * the ceiling) and more than one (the choice is not made here) are both null. No supplier is contacted. Rejects when the indexer cannot be read.
 */
export async function findOcrAdvert(args: { fetchImpl: FetchLike; indexerUrl?: string; supplierPkh: string; maxPriceLovelace?: bigint }): Promise<{
  advertRef: string; endpoint: string; priceLovelace: bigint; maxProcessingMs: number;
} | null> {
  const rows = await listedAdverts(OCR_CAPABILITY, args.indexerUrl, args.fetchImpl, args.maxPriceLovelace);
  const wanted = args.supplierPkh.toLowerCase();
  const ours = rows.filter((row) => row.supplier_pkh.toLowerCase() === wanted);
  if (ours.length !== 1) return null;
  const [row] = ours;
  return { advertRef: row.utxo_ref, endpoint: row.endpoint_url, priceLovelace: row.price_lovelace, maxProcessingMs: row.max_processing_ms };
}
