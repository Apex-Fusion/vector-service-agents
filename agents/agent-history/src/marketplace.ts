import { koios, indexer } from '@vsa/vector-read';
import type { Fetch, EscrowRow } from '@vsa/vector-read';
export interface MarketplaceSide { adverts: Array<{ advert_ref: string; capability_id: string; model: string; price_lovelace: string; status: string; advertised_at: number }>; escrows: { total: number; by_indexer_state: Record<string, number>; latest_checked: number; latest_spent: number; first: EscrowRow | null; last: EscrowRow | null } }
const VERIFY_LATEST = 50;
async function side(rows: EscrowRow[], f: Fetch): Promise<MarketplaceSide['escrows']> {
  const sorted = rows.slice().sort((a, b) => a.posted_at - b.posted_at);
  const by: Record<string, number> = {};
  for (const r of rows) by[r.state] = (by[r.state] ?? 0) + 1;
  const latest = sorted.slice(-VERIFY_LATEST);
  let spent = 0;
  if (latest.length) {
    const info = await koios.utxoInfo(latest.map((r) => r.utxo_ref), f);
    spent = info.filter((u) => u.is_spent).length;
  }
  return { total: rows.length, by_indexer_state: by, latest_checked: latest.length, latest_spent: spent, first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null };
}
export async function marketplaceSection(pkh: string | null, f: Fetch): Promise<{ as_supplier: MarketplaceSide; as_buyer: MarketplaceSide; outcome_verification: string } | null> {
  if (!pkh) return null;
  const [suppliers, asSup, asBuy] = await Promise.all([indexer.suppliers(f), indexer.escrows({ supplier: pkh }, f), indexer.escrows({ buyer: pkh }, f)]);
  const adverts = suppliers.filter((s) => s.supplier_pkh === pkh).map((s) => ({ advert_ref: s.utxo_ref, capability_id: s.capability_id, model: s.model, price_lovelace: s.price_lovelace, status: s.advert_status, advertised_at: s.advertised_at }));
  return { as_supplier: { adverts, escrows: await side(asSup, f) }, as_buyer: { adverts: [], escrows: await side(asBuy, f) }, outcome_verification: `indexer state for all rows; spent flags checked on the latest ${VERIFY_LATEST} per side via Koios utxo_info` };
}
