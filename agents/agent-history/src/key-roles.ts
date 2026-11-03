import { safeFetch, keyHash, activeKey, PURPOSE_TRANSACTION } from '@vsa/vector-read';
import type { SafeFetchOpts } from '@vsa/vector-read';
import type { RecordContent } from './views.ts';
export interface KeyRoles {
  /** The controller key hash of the subject's record (the owner key hash of a legacy record), or null. */
  controller_pkh: string | null;
  /** The keys the marketplace section is about. */
  marketplace_pkhs: string[];
  advert_count: number | null;
  capability_endpoint: string | null;
  /** blake2b-224 of the public key the endpoint serves at /capability, or null when it served none. */
  capability_key_pkh: string | null;
  capability_key_active: boolean | 'unknown';
}
// advert_count is null when the marketplace section was not read: "unknown" must not print as 0.
export function unknownKeyRoles(controllerPkh: string | null, marketplacePkhs: string[], adverts: unknown[] | null, endpoint: string | null): KeyRoles {
  return { controller_pkh: controllerPkh, marketplace_pkhs: marketplacePkhs, advert_count: adverts ? adverts.length : null, capability_endpoint: endpoint, capability_key_pkh: null, capability_key_active: 'unknown' };
}
// The key check (Part 2, section 10): the public key the record's endpoint serves at /capability must be a key the record lets act in a transaction.
// For an identity registry record that is active_key(record, key, transaction). A legacy record names one key, its owner, and the check is that the
// key hashes to the owner. Unknown when there is no record or no endpoint, or the endpoint does not answer with a key.
export async function keyRoles(record: RecordContent | null, controllerPkh: string | null, marketplacePkhs: string[], adverts: unknown[] | null, endpoint: string | null, fetchImpl: typeof fetch, lookup?: SafeFetchOpts['lookup']): Promise<KeyRoles> {
  const out = unknownKeyRoles(controllerPkh, marketplacePkhs, adverts, endpoint);
  if (!endpoint || !record) return out;
  try {
    const r = await safeFetch(`${endpoint.replace(/\/+$/, '')}/capability`, { headers: { accept: 'application/json' } }, { timeoutMs: 20_000, maxResponseBytes: 64 * 1024, fetchImpl, lookup });
    const pub = String(JSON.parse(r.text).pub_key_hex ?? '');
    if (/^[0-9a-f]{64}$/i.test(pub)) {
      const kh = keyHash(pub.toLowerCase());
      out.capability_key_pkh = kh;
      out.capability_key_active = record.registry === 'identity' ? activeKey(record.datum, kh, PURPOSE_TRANSACTION) : kh === record.datum.owner.hash;
    }
  } catch { /* stays unknown */ }
  return out;
}
