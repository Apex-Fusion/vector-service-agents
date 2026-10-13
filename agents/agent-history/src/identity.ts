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
export async function identitySection(s: Subject, f: Fetch): Promise<IdentitySection> {
  const empty: IdentitySection = { registered: null, record: null, updates: [], deregistered: null };
  if (!s.asset_name) return empty;
  const list = await koios.assetTxs(REGISTRY_POLICY, s.asset_name, f);
  if (list.length === 0) return empty;
  const infos = await koios.txInfo(list.map((t) => t.tx_hash), f);
  const byHash = new Map(infos.map((t) => [t.tx_hash, t]));
  const ordered = list.slice().sort((a, b) => a.block_height - b.block_height).map((t) => byHash.get(t.tx_hash)).filter((t): t is KoiosTxInfo => Boolean(t));
  const registryOutput = (tx: KoiosTxInfo) => tx.outputs.find((x) => x.payment_addr.bech32 === REGISTRY_ADDRESS && hasToken(x.asset_list, s.asset_name!));
  const refOf = (tx: KoiosTxInfo, o: { tx_index: number }) => `${tx.tx_hash}#${o.tx_index}`;
  // Registry datums are posted by hash, so tx_info shows no inline bytes for them; utxo_info (extended) resolves the bytes.
  const resolved = new Map<string, string>();
  const unread = ordered.flatMap((tx) => { const o = registryOutput(tx); return o && !o.inline_datum?.bytes ? [refOf(tx, o)] : []; });
  if (unread.length) for (const u of await koios.utxoInfo(unread, f)) if (u.inline_datum?.bytes) resolved.set(`${u.tx_hash}#${u.tx_index}`, u.inline_datum.bytes);
  let prevOwner: string | null = null; let record: RegistryDatum | null = null;
  const out: IdentitySection = { ...empty, updates: [] };
  for (const tx of ordered) {
    const o = registryOutput(tx);
    const spentToken = tx.inputs.some((i) => hasToken(i.asset_list, s.asset_name!));
    const at = { tx: tx.tx_hash, block: tx.block_height, time: tx.tx_timestamp };
    if (o) {
      const bytes = o.inline_datum?.bytes ?? resolved.get(refOf(tx, o));
      if (!bytes) throw new Error(`registry datum at ${refOf(tx, o)} could not be read`);
      const d = decodeRegistryDatum(bytes);
      if (!spentToken) out.registered = at;
      else out.updates.push({ ...at, kind: prevOwner && prevOwner !== d.owner_pkh ? 'controller_rotation' : 'update', from_pkh: prevOwner ?? d.owner_pkh, to_pkh: d.owner_pkh });
      prevOwner = d.owner_pkh; record = d;
    } else if (spentToken) { out.deregistered = at; record = null; }
  }
  out.record = record;
  return out;
}
