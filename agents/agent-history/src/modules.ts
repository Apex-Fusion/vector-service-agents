import { koios, decodeStakeDatum, topLevelBytes, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES, M6_ADDRESSES } from '@vsa/vector-read';
import type { Fetch, KoiosUtxo } from '@vsa/vector-read';
const ref = (u: KoiosUtxo) => `${u.tx_hash}#${u.tx_index}`;
export async function reputationSection(asset: string | null, pkh: string | null, f: Fetch) {
  const [stakeUtxos, endorseUtxos] = await Promise.all([koios.addressUtxos([M3_REPUTATION_ADDRESS], f), koios.addressUtxos([M3_ENDORSEMENT_ADDRESS], f)]);
  const stakes = stakeUtxos.flatMap((u) => { try { const d = decodeStakeDatum(u.inline_datum!.bytes); return (asset && d.agent_asset_name === asset) || (pkh && d.owner_pkh === pkh) ? [{ utxo: ref(u), ...d, stake_lovelace: d.stake_lovelace.toString() }] : []; } catch { return []; } });
  const mentions = (list: KoiosUtxo[]) => list.flatMap((u) => { try { const b = topLevelBytes(u.inline_datum!.bytes); return (asset && b.includes(asset)) || (pkh && b.includes(pkh)) ? [{ utxo: ref(u), block: u.block_height ?? null, fields: b }] : []; } catch { return []; } });
  return { stakes, endorsements: mentions(endorseUtxos) };
}
export async function genericModuleSection(addresses: Record<string, string>, asset: string | null, pkh: string | null, f: Fetch) {
  const out: Record<string, Array<{ utxo: string; block: number | null; fields: string[] }>> = {};
  for (const [label, address] of Object.entries(addresses)) {
    const utxos = await koios.addressUtxos([address], f);
    out[label] = utxos.flatMap((u) => { try { const b = topLevelBytes(u.inline_datum!.bytes); return (asset && b.includes(asset)) || (pkh && b.includes(pkh)) ? [{ utxo: ref(u), block: u.block_height ?? null, fields: b }] : []; } catch { return []; } });
  }
  return out;
}
export const disputeSection = (asset: string | null, pkh: string | null, f: Fetch) => genericModuleSection(M1_ADDRESSES, asset, pkh, f);
export const selfImprovementSection = (asset: string | null, pkh: string | null, f: Fetch) => genericModuleSection(M6_ADDRESSES, asset, pkh, f);
