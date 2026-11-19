import { koios, decodeStakeDatum, stakeTokenName, outRefText, plutusAddressFromBech32, topLevelBytes, KOIOS_PAGE } from '@vsa/vector-read';
import type { Fetch, KoiosUtxo, StakeDatum } from '@vsa/vector-read';
import type { Subject } from './subject.ts';
import { DEFAULT_MODULES } from './config.ts';
import type { ModuleAddresses } from './config.ts';
import { jsonInt } from './views.ts';
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
// the identifier (the asset name) for a DID or identifier, the key hash for a key hash. The same rule the Module-3 stakes follow. A sibling agent
// (same owner key, other identifier) therefore stays out of an identifier subject's report, and an identifier subject is not found through its keys.
export function matchesSubject(fields: string[], s: Pick<Subject, 'kind' | 'asset_name' | 'pkh'>): boolean {
  const id = s.kind === 'asset' ? s.asset_name : s.pkh;
  return id !== null && fields.includes(id);
}
function mentions(utxos: KoiosUtxo[], s: Subject) {
  return utxos.flatMap((u) => { try { const fields = topLevelBytes(u.inline_datum!.bytes); return matchesSubject(fields, s) ? [{ utxo: ref(u), block: u.block_height ?? null, fields }] : []; } catch { return []; } });
}
// A staked capability as text: UTF-8 when the bytes are, else `0x` and the hex. The MCP server shows it so.
const capabilityText = (hex: string) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex')); } catch { return `0x${hex}`; } };
// An output at the stake address is a stake when two things hold. Its datum is the 8-field stake datum, and it holds one stake token of the policy,
// named for the agent that the datum names. The opening output of a stake has the datum and no token, so it is not a stake. Anybody can send an output
// with any datum to a script address, so a datum alone proves nothing. Any other datum at the address is skipped, the 6-field datum of the earlier deployment included.
function stakeOf(u: KoiosUtxo, policy: string) {
  const bytes = u.inline_datum?.bytes;
  if (!bytes) return null;
  let d: StakeDatum;
  try { d = decodeStakeDatum(bytes); } catch { return null; }
  const token = stakeTokenName(d.agent_did);
  const held = (u.asset_list ?? []).find((a) => a.policy_id === policy && a.asset_name === token);
  if (held?.quantity !== '1') return null;
  return {
    utxo: ref(u), agent_asset_name: d.agent_did, owner_pkh: d.owner_pkh, stake_lovelace: d.stake_amount.toString(), capabilities: d.staked_capabilities.map(capabilityText),
    last_updated: d.last_updated, history_points: jsonInt(d.history_points), challenge_locks: d.challenge_locks, stake_id: outRefText(d.stake_id),
  };
}
// The module addresses come from the configuration (config.ts). By default: the Module-3 deployment on the identity registry, and the Module-1 and Module-6
// deployments from before it.
export async function reputationSection(s: Subject, f: Fetch, modules: ModuleAddresses = DEFAULT_MODULES, scan?: ModuleScan) {
  // The reputation validator is the policy of its stake tokens and the script credential of its address, so the policy is the hash in the address.
  const policy = plutusAddressFromBech32(modules.m3.reputation).paymentCredential.hash;
  const [stakeUtxos, endorseUtxos] = await Promise.all([moduleRows(modules.m3.reputation, f, scan), moduleRows(modules.m3.endorsement, f, scan)]);
  // Spec 7.2: stakes are filtered by the asset name in the datum. A subject given as an identifier is joined that way only, so a stake of a
  // sibling agent (same owner, other identifier) stays out; a subject given as a key hash has no identifier to join on and is joined by owner.
  const stakes = stakeUtxos.flatMap((u) => { const stake = stakeOf(u, policy); return stake && (s.kind === 'asset' ? stake.agent_asset_name === s.asset_name : stake.owner_pkh === s.pkh) ? [stake] : []; });
  return { stakes, endorsements: mentions(endorseUtxos, s) };
}
// All the addresses are read at the same time (Module-1 has six by default, Module-6 three): read one after another, a slow Koios would add its delay
// six times. The labels come out in the order the addresses were given.
export async function genericModuleSection(addresses: Record<string, string>, s: Subject, f: Fetch, scan?: ModuleScan) {
  const entries = Object.entries(addresses);
  const rows = await Promise.all(entries.map(([, address]) => moduleRows(address, f, scan)));
  const out: Record<string, ReturnType<typeof mentions>> = {};
  entries.forEach(([label], i) => { out[label] = mentions(rows[i], s); });
  return out;
}
export const disputeSection = (s: Subject, f: Fetch, modules: ModuleAddresses = DEFAULT_MODULES, scan?: ModuleScan) => genericModuleSection(modules.m1, s, f, scan);
export const selfImprovementSection = (s: Subject, f: Fetch, modules: ModuleAddresses = DEFAULT_MODULES, scan?: ModuleScan) => genericModuleSection(modules.m6, s, f, scan);
