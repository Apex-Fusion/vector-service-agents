// packages/buyer-core/src/indexer-fetch.ts
// The marketplace indexer at the base a caller gives. The vendored indexer client (vendored/mcp/marketplace-indexer.ts) builds its URLs on
// INDEXER_URL, a constant it reads from VECTOR_MARKETPLACE_INDEXER_URL when the module loads, and takes no base of its own; a vendored file is
// never edited, so the calls made to that base are sent to the given one. select-supplier.ts and fleet-build.ts read the indexer through it.
import { INDEXER_URL, indexerUrlFrom } from './vendored/mcp/marketplace-constants.ts';
import type { FetchLike } from './fleet-clients.ts';

/** `fetchImpl` aimed at the indexer at `indexerUrl`. Without `indexerUrl`, or with the configured one, the fetch is returned as it is. */
export function indexerFetch(indexerUrl: string | undefined, fetchImpl: FetchLike): FetchLike {
  if (indexerUrl === undefined || indexerUrl === '') return fetchImpl;
  const base = indexerUrlFrom(indexerUrl);
  if (base === INDEXER_URL) return fetchImpl;
  return ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetchImpl(url.startsWith(`${INDEXER_URL}/`) ? `${base}${url.slice(INDEXER_URL.length)}` : input, init);
  }) as FetchLike;
}
