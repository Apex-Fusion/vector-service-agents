import { koios } from '@vsa/vector-read';
import type { Fetch, SafeFetchOpts } from '@vsa/vector-read';
import type { HistoryRequest } from './request.ts';
import { resolveSubject } from './subject.ts';
import { identitySection } from './identity.ts';
import { marketplaceSection } from './marketplace.ts';
import { reputationSection, disputeSection, selfImprovementSection } from './modules.ts';
import type { ModuleScan } from './modules.ts';
import { keyRoles } from './key-roles.ts';
export interface Manifest { name: string; capability_id: string; version: string; identity: { did: string; controller_pkh: string }; keys: { supplier_pkh: string; pub_key_hex: string } }
// The three gaps exported below are also in the manifest (server.ts): ESCROW_ROWS_GAP is its gaps[0], the other two joined are its gaps[1].
// That keeps the manifest that is frozen into the advert, the spec and every report saying the same thing.
export const ESCROW_ROWS_GAP = 'Escrow rows come from the marketplace indexer, one per escrow UTxO version: a job appears once for each state it reached (Open, Claimed, Submitted), so up to three times, and never as Accepted, Released or Reclaimed. The report gives by_indexer_state counts and, for the latest 50 rows per side, how many are spent on the ledger (latest_checked, latest_spent). It gives no outcome counts: Accept, Release and Reclaim are not told apart.';
export const DISPUTE_MODULE_GAP = 'The dispute module is deployed but not wired to the escrow contract; dispute entries, if any, are matched without a verified schema.';
export const GENERIC_MATCH_GAP = 'Module-1 and Module-6 datums, and Module-3 endorsements, are matched generically: a datum is attributed to the subject when one of its bytes fields (top level or one constructor deep) equals the identifier the subject was given as, the asset name for a DID or asset name and the key hash for a key hash. An entry that names an agent only by its controller key is not found for a DID or asset name, and an entry that names only an asset name is not found for a key hash. Their full layouts are not decoded.';
export const BLIND_SPOTS: readonly string[] = [
  'Receipts name the supplier key hash, not the registry identifier; identity and marketplace are joined by key hash.',
  ESCROW_ROWS_GAP,
  DISPUTE_MODULE_GAP,
  GENERIC_MATCH_GAP,
  'Module-3 stakes are read with the six-field stake layout and other datums at that address are skipped. A subject given as a DID or asset name keeps only the stakes whose datum names that asset, not those that share its owner key; a subject given as a key hash keeps every stake that key owns, whatever the asset.',
];
// Lines a report adds to the fixed ones when they apply.
const NO_RECORD = 'No registry record found for this subject.';
const NO_LIVE_RECORD = 'marketplace and key_roles were not read: the subject has no live registry record';
const SCAN_TRUNCATED = 'module scan may be truncated at 1,000 rows';
async function guarded<T>(fn: () => Promise<T>): Promise<T | { error: string }> { try { return await fn(); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } }
export async function buildReport(req: HistoryRequest, f: Fetch, opts: { manifest: Manifest; lookup?: SafeFetchOpts['lookup'] }) {
  // Every URL the report reads, once each. The sections run at the same time, so the order they ask in is not stable: the list is sorted when it is returned.
  const sources: string[] = [];
  const seen = ((url: any, init?: RequestInit) => { const u = String(url); if (!sources.includes(u)) sources.push(u); return f(url, init); }) as Fetch;
  const subject = await resolveSubject(req.subject, seen);
  // Started only once the subject is known to be valid, so a rejected subject costs no extra Koios call.
  const tipP = koios.tip(seen).then((t) => ({ block: t[0].block_no, slot: t[0].abs_slot, time: t[0].block_time })).catch(() => null);
  const want = new Set(req.include);
  const scan: ModuleScan = { truncated: false };
  const [identity, marketplace, reputation, dispute, self_improvement] = await Promise.all([
    want.has('identity') ? guarded(() => identitySection(subject, seen)) : undefined,
    want.has('marketplace') ? guarded(() => marketplaceSection(subject.controller_pkh, seen)) : undefined,
    want.has('reputation') ? guarded(() => reputationSection(subject, seen, scan)) : undefined,
    want.has('dispute') ? guarded(() => disputeSection(subject, seen, scan)) : undefined,
    want.has('self_improvement') ? guarded(() => selfImprovementSection(subject, seen, scan)) : undefined,
  ]);
  const record = identity && !('error' in identity) ? identity.record : null;
  const adverts = marketplace && !('error' in marketplace) ? marketplace.as_supplier.adverts : null;
  const key_roles = await keyRoles(subject.controller_pkh, adverts, record?.endpoint || null, seen, opts.lookup);
  const blind = [...BLIND_SPOTS];
  if (identity && !('error' in identity) && !identity.registered) blind.unshift(NO_RECORD);
  else if (subject.controller_pkh === null) blind.unshift(NO_LIVE_RECORD); // no key to read the marketplace with: say so instead of a bare null
  if (scan.truncated) blind.push(SCAN_TRUNCATED);
  const as_of = await tipP;
  return {
    schema: 'vector.agent-history.report.v1', generated_by: { agent: opts.manifest.name, did: opts.manifest.identity.did, version: opts.manifest.version },
    subject, as_of, identity, marketplace, reputation, dispute, self_improvement, key_roles,
    sources: [...sources].sort(), blind_spots: blind,
  };
}
export type Report = Awaited<ReturnType<typeof buildReport>>;
const SECTION_NAMES = ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] as const;
// Why a report is not the whole picture: a section that failed (it carries an error), or no chain tip. Such a report is still answered, but the server does not keep it.
export function degradedReasons(r: Report): string[] {
  const out: string[] = [];
  for (const name of SECTION_NAMES) {
    const error = (r[name] as { error?: unknown } | null | undefined)?.error;
    if (typeof error === 'string') out.push(`${name}: ${error}`);
  }
  if (r.as_of === null) out.push('as_of: the chain tip could not be read');
  return out;
}
