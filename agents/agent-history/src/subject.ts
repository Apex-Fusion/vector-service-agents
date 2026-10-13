import { koios, decodeRegistryDatum, REGISTRY_POLICY, REGISTRY_ADDRESS, didFor } from '@vsa/vector-read';
import type { Fetch } from '@vsa/vector-read';
export interface Subject { kind: 'asset' | 'pkh'; asset_name: string | null; did: string | null; controller_pkh: string | null; candidates: Array<{ asset_name: string; did: string; name: string }> }
const DID_RE = /^did:vector:agent:([0-9a-f]{56}):([0-9a-f]{64})$/i;
export async function resolveSubject(input: string, f: Fetch): Promise<Subject> {
  const did = DID_RE.exec(input);
  const asset = did ? did[2].toLowerCase() : /^[0-9a-f]{64}$/i.test(input) ? input.toLowerCase() : null;
  if (asset) {
    const utxos = await koios.assetUtxos(REGISTRY_POLICY, asset, f);
    const u = utxos.find((x) => x.inline_datum?.bytes);
    const owner = u ? decodeRegistryDatum(u.inline_datum!.bytes).owner_pkh : null;
    return { kind: 'asset', asset_name: asset, did: didFor(asset), controller_pkh: owner, candidates: [] };
  }
  if (!/^[0-9a-f]{56}$/i.test(input)) throw Object.assign(new Error('subject must be a DID, a 64-hex registry asset name, or a 56-hex key hash'), { status: 400 });
  const pkh = input.toLowerCase();
  const all = await koios.addressUtxos([REGISTRY_ADDRESS], f);
  const candidates: Subject['candidates'] = [];
  for (const u of all) {
    if (!u.inline_datum?.bytes) continue;
    let d; try { d = decodeRegistryDatum(u.inline_datum.bytes); } catch { continue; }
    if (d.owner_pkh !== pkh) continue;
    const tok = (u.asset_list ?? []).find((a) => a.policy_id === REGISTRY_POLICY);
    if (tok) candidates.push({ asset_name: tok.asset_name, did: didFor(tok.asset_name), name: d.name });
  }
  const first = candidates[0] ?? null;
  return { kind: 'pkh', asset_name: first?.asset_name ?? null, did: first?.did ?? null, controller_pkh: pkh, candidates };
}
