import { koios, decodeStakeDatum, topLevelBytes, KOIOS_PAGE, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES, M6_ADDRESSES } from '@vsa/vector-read';
import type { Fetch, KoiosUtxo } from '@vsa/vector-read';
import type { Subject } from './subject.ts';
const ref = (u: KoiosUtxo) => `${u.tx_hash}#${u.tx_index}`;
// A module address is read with one call of at most KOIOS_PAGE rows, so a full page may have been cut.
// Set to true when a module page comes back full; the report turns it into a blind-spot line.
export interface ModuleScan { truncated: boolean }
async function moduleRows(address: string, f: Fetch, scan?: ModuleScan): Promise<KoiosUtxo[]> {
  const rows = await koios.addressUtxos([address], f);
  if (scan && rows.length >= KOIOS_PAGE) scan.truncated = true;
  return rows;
}
// A module datum is the subject's when one of its bytes fields, at the top level or one constructor deep, is the identifier the subject was given as:
// the asset name for a DID or asset name, the key hash for a key hash. The same rule the Module-3 stakes follow. A sibling agent (same owner key,
// other asset) therefore stays out of an asset subject's report, and an asset subject is not found through its owner key.
export function matchesSubject(fields: string[], s: Pick<Subject, 'kind' | 'asset_name' | 'controller_pkh'>): boolean {
  const id = s.kind === 'asset' ? s.asset_name : s.controller_pkh;
  return id !== null && fields.includes(id);
}
function mentions(utxos: KoiosUtxo[], s: Subject) {
  return utxos.flatMap((u) => { try { const fields = topLevelBytes(u.inline_datum!.bytes); return matchesSubject(fields, s) ? [{ utxo: ref(u), block: u.block_height ?? null, fields }] : []; } catch { return []; } });
}
export async function reputationSection(s: Subject, f: Fetch, scan?: ModuleScan) {
  const [stakeUtxos, endorseUtxos] = await Promise.all([moduleRows(M3_REPUTATION_ADDRESS, f, scan), moduleRows(M3_ENDORSEMENT_ADDRESS, f, scan)]);
  // Spec 7.2: stakes are filtered by the asset name in the datum. A subject given as an asset is joined that way only, so a stake of a
  // sibling agent (same owner, other asset) stays out; a subject given as a key hash has no asset name to join on and is joined by owner.
  const stakes = stakeUtxos.flatMap((u) => { try { const d = decodeStakeDatum(u.inline_datum!.bytes); return (s.kind === 'asset' ? d.agent_asset_name === s.asset_name : d.owner_pkh === s.controller_pkh) ? [{ utxo: ref(u), ...d, stake_lovelace: d.stake_lovelace.toString() }] : []; } catch { return []; } });
  return { stakes, endorsements: mentions(endorseUtxos, s) };
}
// All the addresses are read at the same time (Module-1 has six, Module-6 three): read one after another, a slow Koios would add its delay six times.
// The labels come out in the order the addresses were given.
export async function genericModuleSection(addresses: Record<string, string>, s: Subject, f: Fetch, scan?: ModuleScan) {
  const entries = Object.entries(addresses);
  const rows = await Promise.all(entries.map(([, address]) => moduleRows(address, f, scan)));
  const out: Record<string, ReturnType<typeof mentions>> = {};
  entries.forEach(([label], i) => { out[label] = mentions(rows[i], s); });
  return out;
}
export const disputeSection = (s: Subject, f: Fetch, scan?: ModuleScan) => genericModuleSection(M1_ADDRESSES, s, f, scan);
export const selfImprovementSection = (s: Subject, f: Fetch, scan?: ModuleScan) => genericModuleSection(M6_ADDRESSES, s, f, scan);
