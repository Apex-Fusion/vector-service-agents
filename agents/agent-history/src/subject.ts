import { koios, decodeIdentityDatum, decodeLegacyDatum, keyHash, didFor, isAuthenticRecord, parseVectorDid, KOIOS_PAGE } from '@vsa/vector-read';
import type { Fetch, KoiosUtxo, Registries, Registry } from '@vsa/vector-read';
import { BadRequest } from './request.ts';
import { activePurposes, controllerPkh, recordText } from './views.ts';
import { DEFAULT_CONFIG } from './config.ts';
import type { RecordContent, RegistryKind } from './views.ts';
// A record a key acts for: whether the key is its controller, and the purposes it is listed with (active_key, Part 2 section 3.10).
// A legacy record names one key, its owner, which counts as its controller (Part 1, section 7.2).
export interface Candidate { asset_name: string; did: string; name: string | null; registry: RegistryKind; controller: boolean; purposes: string[] }
export interface Subject {
  kind: 'asset' | 'pkh';
  /** The key hash given, for a subject given as a key hash. */
  pkh: string | null;
  /** The identifier: the one given, or the first candidate of a key hash. */
  asset_name: string | null;
  /** The canonical DID of the identifier (Part 1, section 3). */
  did: string | null;
  /** The registry whose authentic record output holds the identifier now, or null when none does. */
  registry: RegistryKind | null;
  /** The controller key hash of that record (the owner key hash of a legacy record), or null. */
  controller_pkh: string | null;
  candidates: Candidate[];
}
/** The subject, and the record an authentic output holds for its identifier now (null when none does). */
export interface ResolvedSubject { subject: Subject; record: RecordContent | null }
const MAX_PAGES = 20; // 20,000 registry UTxOs at one address, far above the few hundred on mainnet; past it the scan fails instead of truncating
// The record of an authentic output for the identifier, or null when the output carries no datum or it does not decode (such an output is not a
// usable record).
function recordOf(u: KoiosUtxo, kind: RegistryKind): RecordContent | null {
  const bytes = u.inline_datum?.bytes;
  if (!bytes) return null;
  try { return kind === 'legacy' ? { registry: kind, datum: decodeLegacyDatum(bytes) } : { registry: kind, datum: decodeIdentityDatum(bytes) }; } catch { return null; }
}
// The identifier a registry output holds a record for: the asset name of its token of the registry's policy, when the output is an authentic record.
function heldId(u: KoiosUtxo, reg: Registry): string | null {
  const name = (u.asset_list ?? []).find((a) => a.policy_id === reg.policy)?.asset_name;
  return name !== undefined && isAuthenticRecord(u.address ?? '', u.asset_list, reg, name) ? name : null;
}
// Reads every record at a registry address, a page at a time. Only an empty page ends the scan: a page shorter than KOIOS_PAGE is not known to
// be the last one. The next page starts after the rows actually read, which is page * KOIOS_PAGE while pages come back full.
async function scan(reg: Registry, kind: RegistryKind, f: Fetch, keep: (c: RecordContent) => Omit<Candidate, 'asset_name' | 'did' | 'name' | 'registry'> | null) {
  const found: Array<{ candidate: Candidate; record: RecordContent }> = [];
  let offset = 0;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`registry scan did not end within ${MAX_PAGES} pages of ${KOIOS_PAGE} UTxOs`);
    const rows = await koios.addressUtxos([reg.address], f, offset);
    if (rows.length === 0) break;
    offset += rows.length;
    for (const u of rows) {
      const id = heldId(u, reg), record = id ? recordOf(u, kind) : null;
      const role = record ? keep(record) : null;
      if (id && record && role) found.push({ candidate: { asset_name: id, did: didFor(id), name: recordText(record.datum.name), registry: kind, ...role }, record });
    }
  }
  return found;
}
export async function resolveSubject(input: string, f: Fetch, registries: Registries = DEFAULT_CONFIG.registries): Promise<ResolvedSubject> {
  const { legacy, identity } = registries;
  let asset: string | null = null;
  if (input.startsWith('did:')) {
    // Part 1, section 3: did:vector:<identifier>, or the legacy form did:vector:agent:<legacy policy>:<identifier>, every character lowercase.
    // Checked before any Koios call: a DID that names no agent on Vector mainnet costs nothing.
    const did = parseVectorDid(input);
    if (!did) throw new BadRequest('a DID subject must be did:vector:<64 lowercase hex> or the legacy form did:vector:agent:<registry policy>:<64 lowercase hex>, all in lowercase');
    if (did.form === 'network') throw new BadRequest('testnet DIDs are not supported: the service reads Vector mainnet');
    if (did.form === 'legacy' && did.policyId !== legacy.policy) throw new BadRequest('DID policy is not the legacy Vector agent registry');
    asset = did.vectorId;
  } else if (/^[0-9a-f]{64}$/i.test(input)) asset = input.toLowerCase();
  if (asset) {
    const id = asset;
    const [identityRows, legacyRows] = await Promise.all([identity ? koios.assetUtxos(identity.policy, id, f) : [], koios.assetUtxos(legacy.policy, id, f)]);
    // The registry token means something only where its registry holds it: an authentic record output (Part 1, section 4). An identifier is held
    // by one registry at a time, because the adoption burns the legacy token.
    const held = (rows: KoiosUtxo[], reg: Registry, kind: RegistryKind) => rows.filter((u) => isAuthenticRecord(u.address ?? '', u.asset_list, reg, id)).map((u) => recordOf(u, kind)).find((r) => r !== null) ?? null;
    const record = (identity ? held(identityRows, identity, 'identity') : null) ?? held(legacyRows, legacy, 'legacy');
    return { subject: { kind: 'asset', pkh: null, asset_name: id, did: didFor(id), registry: record?.registry ?? null, controller_pkh: record ? controllerPkh(record) : null, candidates: [] }, record };
  }
  if (!/^[0-9a-f]{56}$/i.test(input)) throw new BadRequest('subject must be a did:vector DID, a 64-hex identifier (registry asset name), or a 56-hex key hash');
  const pkh = input.toLowerCase();
  // A key hash names every record it acts for: the legacy records it owns, and the identity registry records whose controller it is or that list it.
  const [owned, listed] = await Promise.all([
    scan(legacy, 'legacy', f, (c) => (controllerPkh(c) === pkh ? { controller: true, purposes: [] } : null)),
    identity ? scan(identity, 'identity', f, (c) => {
      if (c.registry !== 'identity') return null;
      const purposes = activePurposes(c.datum, pkh), controller = keyHash(c.datum.controller) === pkh;
      return controller || purposes.length ? { controller, purposes } : null;
    }) : [],
  ]);
  // Koios gives no order guarantee, so sort: the candidate reported first must not depend on how the rows arrived.
  const all = [...owned, ...listed].sort(({ candidate: a }, { candidate: b }) => (a.asset_name < b.asset_name ? -1 : a.asset_name > b.asset_name ? 1 : a.registry < b.registry ? -1 : a.registry > b.registry ? 1 : 0));
  const first = all[0] ?? null;
  return {
    subject: { kind: 'pkh', pkh, asset_name: first?.candidate.asset_name ?? null, did: first?.candidate.did ?? null, registry: first?.candidate.registry ?? null, controller_pkh: first ? controllerPkh(first.record) : null, candidates: all.map((x) => x.candidate) },
    record: first?.record ?? null,
  };
}
