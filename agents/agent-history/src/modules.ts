import { koios, decodeStakeDatum, topLevelBytes, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES, M6_ADDRESSES } from '@vsa/vector-read';
import type { Fetch, KoiosUtxo } from '@vsa/vector-read';
import type { Subject } from './subject.ts';
const ref = (u: KoiosUtxo) => `${u.tx_hash}#${u.tx_index}`;
// Koios answers with at most this many rows per call, and a module address is read with one call: a full page may have been cut.
const KOIOS_PAGE = 1_000;
// Set to true when a module page comes back full; the report turns it into a blind-spot line.
export interface ModuleScan { truncated: boolean }
async function moduleRows(address: string, f: Fetch, scan?: ModuleScan): Promise<KoiosUtxo[]> {
  const rows = await koios.addressUtxos([address], f);
  if (scan && rows.length >= KOIOS_PAGE) scan.truncated = true;
  return rows;
}
// A module datum is the subject's when one of its bytes fields, at the top level or one constructor deep, is the asset name or the controller key hash.
export function matchesSubject(fields: string[], s: Pick<Subject, 'asset_name' | 'controller_pkh'>): boolean {
  return (s.asset_name !== null && fields.includes(s.asset_name)) || (s.controller_pkh !== null && fields.includes(s.controller_pkh));
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
export async function genericModuleSection(addresses: Record<string, string>, s: Subject, f: Fetch, scan?: ModuleScan) {
  const out: Record<string, ReturnType<typeof mentions>> = {};
  for (const [label, address] of Object.entries(addresses)) out[label] = mentions(await moduleRows(address, f, scan), s);
  return out;
}
export const disputeSection = (s: Subject, f: Fetch, scan?: ModuleScan) => genericModuleSection(M1_ADDRESSES, s, f, scan);
export const selfImprovementSection = (s: Subject, f: Fetch, scan?: ModuleScan) => genericModuleSection(M6_ADDRESSES, s, f, scan);
