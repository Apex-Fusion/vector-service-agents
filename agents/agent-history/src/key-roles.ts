import { safeFetch, blake2b224Hex } from '@vsa/vector-read';
import type { SafeFetchOpts } from '@vsa/vector-read';
export interface KeyRoles { controller_pkh: string | null; advert_count: number | null; capability_key_matches_controller: boolean | 'unknown'; capability_endpoint: string | null }
// advert_count is null when the marketplace section was not read: "unknown" must not print as 0.
export async function keyRoles(controllerPkh: string | null, adverts: Array<{ advert_ref: string }> | null, endpoint: string | null, fetchImpl: typeof fetch, lookup?: SafeFetchOpts['lookup']): Promise<KeyRoles> {
  const out: KeyRoles = { controller_pkh: controllerPkh, advert_count: adverts ? adverts.length : null, capability_key_matches_controller: 'unknown', capability_endpoint: endpoint };
  if (!endpoint || !controllerPkh) return out;
  try {
    const r = await safeFetch(`${endpoint.replace(/\/+$/, '')}/capability`, { headers: { accept: 'application/json' } }, { timeoutMs: 20_000, maxResponseBytes: 64 * 1024, fetchImpl, lookup });
    const pub = String(JSON.parse(r.text).pub_key_hex ?? '');
    if (/^[0-9a-f]{64}$/i.test(pub)) out.capability_key_matches_controller = blake2b224Hex(pub) === controllerPkh;
  } catch { /* stays unknown */ }
  return out;
}
