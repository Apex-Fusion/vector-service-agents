import { koios, decodeRegistryDatum, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import type { Fetch, KoiosTxInfo, RegistryDatum } from '@vsa/vector-read';
import type { Subject } from './subject.ts';
export interface IdentitySection {
  registered: { tx: string; block: number; time: number } | null;
  record: RegistryDatum | null;
  updates: Array<{ tx: string; block: number; time: number; kind: 'update' | 'controller_rotation'; from_pkh: string; to_pkh: string }>;
  deregistered: { tx: string; block: number; time: number } | null;
}
const hasToken = (l: Array<{ policy_id: string; asset_name: string }> | null | undefined, asset: string) => (l ?? []).some((a) => a.policy_id === REGISTRY_POLICY && a.asset_name === asset);
// The one test for "this datum has bytes": null, undefined and the empty string all mean the bytes are not there.
const bytesOf = (d: { bytes?: string | null } | null | undefined): string | null => (d?.bytes ? d.bytes : null);
const refOf = (txHash: string, index: number) => `${txHash}#${index}`;
// The identity section, and the one value the report needs that is not part of it: the key that owned the record last, whether or not the
// record is still there. It is the last to_pkh of the updates, else the owner at registration; null when the subject was never registered.
// A subject whose record is gone (deregistered, or the token left the registry) has no live controller, and this is the key the marketplace
// section is then read with.
export interface IdentityTimeline { section: IdentitySection; last_controller_pkh: string | null }
export async function identitySection(s: Subject, f: Fetch): Promise<IdentitySection> {
  return (await identityTimeline(s, f)).section;
}
export async function identityTimeline(s: Subject, f: Fetch): Promise<IdentityTimeline> {
  const empty: IdentitySection = { registered: null, record: null, updates: [], deregistered: null };
  const asset = s.asset_name;
  if (!asset) return { section: empty, last_controller_pkh: null };
  const list = await koios.assetTxs(REGISTRY_POLICY, asset, f);
  if (list.length === 0) return { section: empty, last_controller_pkh: null };
  const infos = await koios.txInfo(list.map((t) => t.tx_hash), f);
  const byHash = new Map(infos.map((t) => [t.tx_hash, t]));
  // Oldest first. Transactions of one block are told apart by their position in it (asset_txs lists newest first).
  const ordered = list.map((t) => {
    const tx = byHash.get(t.tx_hash);
    if (!tx) throw new Error(`tx ${t.tx_hash} listed by asset_txs but not returned by tx_info`);
    return tx;
  }).sort((a, b) => a.block_height - b.block_height || a.tx_block_index - b.tx_block_index);
  const registryOutput = (tx: KoiosTxInfo) => tx.outputs.find((x) => x.payment_addr.bech32 === REGISTRY_ADDRESS && hasToken(x.asset_list, asset));
  // Registry datums are posted by hash, so tx_info shows no inline bytes for them; utxo_info (extended) resolves the bytes.
  const resolved = new Map<string, string>();
  const unread = ordered.flatMap((tx) => { const o = registryOutput(tx); return o && !bytesOf(o.inline_datum) ? [refOf(tx.tx_hash, o.tx_index)] : []; });
  if (unread.length) for (const u of await koios.utxoInfo(unread, f)) { const b = bytesOf(u.inline_datum); if (b) resolved.set(refOf(u.tx_hash, u.tx_index), b); }
  let prevOwner: string | null = null; let record: RegistryDatum | null = null;
  const out: IdentitySection = { ...empty, updates: [] };
  for (const tx of ordered) {
    const o = registryOutput(tx);
    const spentToken = tx.inputs.some((i) => hasToken(i.asset_list, asset));
    const at = { tx: tx.tx_hash, block: tx.block_height, time: tx.tx_timestamp };
    if (o) {
      const ref = refOf(tx.tx_hash, o.tx_index);
      const bytes = bytesOf(o.inline_datum) ?? resolved.get(ref);
      if (!bytes) throw new Error(`registry datum at ${ref} could not be read`);
      const d = decodeRegistryDatum(bytes);
      if (!spentToken) out.registered = at;
      else out.updates.push({ ...at, kind: prevOwner && prevOwner !== d.owner_pkh ? 'controller_rotation' : 'update', from_pkh: prevOwner ?? d.owner_pkh, to_pkh: d.owner_pkh });
      prevOwner = d.owner_pkh; record = d;
    } else if (spentToken) { out.deregistered = at; record = null; }
  }
  out.record = record;
  return { section: out, last_controller_pkh: prevOwner };
}
