// packages/buyer-core/src/select-supplier.ts
// Supplier discovery: which chat supplier to hire for the summary (selectLlmSupplier) and which OCR advert to hire for a page (findOcrAdvert). Both read the
// marketplace indexer with the vendored fetchSuppliers, which lists the adverts of one capability and keeps the free ones. The indexer is the operator's
// own configuration, read with the injected fetch as it is. The suppliers it lists are reached only through safeFetch (see fleet-clients.ts).
//
// The indexer's row names the advert's UTxO `utxo_ref`: it is the `advert_ref` that the supplier's own /capability serves, and the ref the escrow's Post is
// made against. So `advertRef` below is the row's `utxo_ref`.
import { fetchSuppliers } from './vendored/mcp/marketplace-indexer.ts';
import { INDEXER_URL, indexerUrlFrom } from './vendored/mcp/marketplace-constants.ts';
import { canonicalRef } from './vendored/mcp/marketplace-supplier.ts';
import { probeStatus, readCapability } from './fleet-clients.ts';
import type { FetchLike, SupplierCapability } from './fleet-clients.ts';

const LLM_CAPABILITY = 'llm.text.generate.v1';
const OCR_CAPABILITY = 'ocr.page.extract.chandra-ocr-2.v1';

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

const byPrice = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
/** When a supplier was last seen, as a number to compare; a supplier never seen, or seen at a time that is no date, is the least recent. */
const seenAt = (iso: string | null): number => {
  const time = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};
const newerFirst = (a: number, b: number): number => (a === b ? 0 : a > b ? -1 : 1);

/** Do two refs name the same output? Compared as refs, so the spelling of the hex does not matter; text that is no ref names nothing. */
function sameRef(a: string, b: string): boolean {
  try { return canonicalRef(a) === canonicalRef(b); } catch { return false; }
}

/**
 * The chat supplier to hire, or null when none is fit. The candidates are the free `llm.text.generate.v1` adverts whose model is on `allowlist`, in this
 * order: the position of the model on the allowlist, then the price (lowest first), then when the supplier was last seen (latest first). Each candidate in
 * turn is asked for its /capability, which must carry `inference_api: "responses"` and the very `advert_ref` the indexer lists for it, and, when `probe` is
 * true, for its /status, which must be `free`. The first that passes is the answer, so the candidates after it are not contacted. A candidate whose
 * /capability or /status cannot be read is skipped, not an error. Rejects when the indexer cannot be read.
 */
export async function selectLlmSupplier(args: { fetchImpl: FetchLike; indexerUrl?: string; allowlist: readonly string[]; probe?: boolean }): Promise<{
  advertRef: string; endpoint: string; model: string; supplierPkh: string; priceLovelace: bigint; capability: SupplierCapability;
} | null> {
  const rows = await fetchSuppliers({ capability_id: LLM_CAPABILITY, onlyFree: true, fetchImpl: aimedAt(args.indexerUrl, args.fetchImpl) });
  const candidates = rows
    .map((row) => ({ row, rank: args.allowlist.indexOf(row.model) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((a, b) => a.rank - b.rank || byPrice(a.row.price_lovelace, b.row.price_lovelace) || newerFirst(seenAt(a.row.last_seen_iso), seenAt(b.row.last_seen_iso)));
  for (const { row } of candidates) {
    let capability: SupplierCapability;
    try { capability = await readCapability(row.endpoint_url, args.fetchImpl); } catch { continue; }
    if (capability.inference_api !== 'responses' || !sameRef(capability.advert_ref, row.utxo_ref)) continue;
    if (args.probe === true && (await probeStatus(row.endpoint_url, args.fetchImpl)) !== 'free') continue;
    return { advertRef: row.utxo_ref, endpoint: row.endpoint_url, model: row.model, supplierPkh: row.supplier_pkh, priceLovelace: row.price_lovelace, capability };
  }
  return null;
}

/**
 * The OCR advert to hire: the free `ocr.page.extract.chandra-ocr-2.v1` advert of the supplier key `supplierPkh`. Exactly one is expected; none (it is not
 * listed, or it is busy or offline) and more than one (the choice is not made here) are both null. No supplier is contacted. Rejects when the indexer
 * cannot be read.
 */
export async function findOcrAdvert(args: { fetchImpl: FetchLike; indexerUrl?: string; supplierPkh: string }): Promise<{
  advertRef: string; endpoint: string; priceLovelace: bigint; maxProcessingMs: number;
} | null> {
  const rows = await fetchSuppliers({ capability_id: OCR_CAPABILITY, onlyFree: true, fetchImpl: aimedAt(args.indexerUrl, args.fetchImpl) });
  const wanted = args.supplierPkh.toLowerCase();
  const ours = rows.filter((row) => row.supplier_pkh.toLowerCase() === wanted);
  if (ours.length !== 1) return null;
  const [row] = ours;
  return { advertRef: row.utxo_ref, endpoint: row.endpoint_url, priceLovelace: row.price_lovelace, maxProcessingMs: row.max_processing_ms };
}
