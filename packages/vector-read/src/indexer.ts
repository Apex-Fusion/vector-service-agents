import { INDEXER_URL } from './constants.ts';
import type { Fetch } from './koios.ts';
export interface SupplierRow { utxo_ref: string; supplier_pkh: string; capability_id: string; model: string; price_lovelace: string; supplier_bond_lovelace: string; buyer_bond_lovelace: string; max_processing_ms: number; endpoint_url: string; detail_uri: string; status: string; advert_status: string; last_seen_iso: string | null; advertised_at: number }
export interface EscrowRow { utxo_ref: string; buyer_pkh: string; supplier_pkh: string; advert_ref: string; capability_id: string; payment_lovelace: string; deliver_by: number; posted_at: number; submitted_at: number | null; result_receipt_hash: string | null; state: string }
async function getJson<T>(url: string, f: Fetch = fetch): Promise<T> {
  const res = await f(url, { headers: { accept: 'application/json', 'user-agent': 'vector-service-agents' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`indexer ${new URL(url).pathname} answered ${res.status}`);
  return (await res.json()) as T;
}
export const indexer = {
  suppliers: (f?: Fetch) => getJson<SupplierRow[]>(`${INDEXER_URL}/suppliers`, f),
  escrows: (q: { supplier?: string; buyer?: string }, f?: Fetch) => {
    // Only filters that are set go on the wire: an undefined one must not become "supplier=undefined", and no filters means no "?".
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] != null)).toString();
    return getJson<EscrowRow[]>(`${INDEXER_URL}/escrows${qs ? `?${qs}` : ''}`, f);
  },
};
