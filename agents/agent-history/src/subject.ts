import { koios, decodeRegistryDatum, REGISTRY_POLICY, REGISTRY_ADDRESS, didFor } from '@vsa/vector-read';
import type { Fetch, KoiosUtxo, RegistryDatum } from '@vsa/vector-read';
import { BadRequest } from './request.ts';
export interface Subject { kind: 'asset' | 'pkh'; asset_name: string | null; did: string | null; controller_pkh: string | null; candidates: Array<{ asset_name: string; did: string; name: string }> }
const DID_RE = /^did:vector:agent:([0-9a-f]{56}):([0-9a-f]{64})$/i;
const PAGE = 1_000; // Koios answers with at most this many rows per call
const MAX_PAGES = 20; // 20,000 registry UTxOs, far above the few hundred on mainnet; past it the scan fails instead of truncating
// A registry datum, or null when the UTxO carries none or it does not decode (such a UTxO is not a usable record).
const registryRecord = (u: KoiosUtxo): RegistryDatum | null => {
  const bytes = u.inline_datum?.bytes;
  if (!bytes) return null;
  try { return decodeRegistryDatum(bytes); } catch { return null; }
};
export async function resolveSubject(input: string, f: Fetch): Promise<Subject> {
  const did = DID_RE.exec(input);
  // Checked before any Koios call: a DID under another policy names nothing in this registry.
  if (did && did[1].toLowerCase() !== REGISTRY_POLICY) throw new BadRequest('DID policy is not the Vector agent registry');
  const asset = did ? did[2].toLowerCase() : /^[0-9a-f]{64}$/i.test(input) ? input.toLowerCase() : null;
  if (asset) {
    const utxos = await koios.assetUtxos(REGISTRY_POLICY, asset, f);
    // The registry token means something only where the registry script holds it.
    const u = utxos.find((x) => x.address === REGISTRY_ADDRESS && x.inline_datum?.bytes);
    const record = u ? registryRecord(u) : null;
    return { kind: 'asset', asset_name: asset, did: didFor(asset), controller_pkh: record?.owner_pkh ?? null, candidates: [] };
  }
  if (!/^[0-9a-f]{56}$/i.test(input)) throw new BadRequest('subject must be a DID, a 64-hex registry asset name, or a 56-hex key hash');
  const pkh = input.toLowerCase();
  const found = new Map<string, Subject['candidates'][number]>();
  // Only an empty page ends the scan: a page shorter than PAGE is not known to be the last one. The next page starts
  // after the rows actually read, which is page * PAGE while pages come back full.
  let offset = 0;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`registry scan did not end within ${MAX_PAGES} pages of ${PAGE} UTxOs`);
    const rows = await koios.addressUtxos([REGISTRY_ADDRESS], f, offset);
    if (rows.length === 0) break;
    offset += rows.length;
    for (const u of rows) {
      const d = registryRecord(u);
      if (!d || d.owner_pkh !== pkh) continue;
      const tok = (u.asset_list ?? []).find((a) => a.policy_id === REGISTRY_POLICY);
      if (tok) found.set(tok.asset_name, { asset_name: tok.asset_name, did: didFor(tok.asset_name), name: d.name });
    }
  }
  // Koios gives no order guarantee, so sort: the candidate reported first must not depend on how the rows arrived.
  const candidates = [...found.values()].sort((a, b) => (a.asset_name < b.asset_name ? -1 : a.asset_name > b.asset_name ? 1 : 0));
  const first = candidates[0] ?? null;
  return { kind: 'pkh', asset_name: first?.asset_name ?? null, did: first?.did ?? null, controller_pkh: pkh, candidates };
}
