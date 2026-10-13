import { koios } from '@vsa/vector-read';
import type { Fetch, SafeFetchOpts } from '@vsa/vector-read';
import type { HistoryRequest } from './request.ts';
import { resolveSubject } from './subject.ts';
import { identitySection } from './identity.ts';
import { marketplaceSection } from './marketplace.ts';
import { reputationSection, disputeSection, selfImprovementSection } from './modules.ts';
import { keyRoles } from './key-roles.ts';
export interface Manifest { name: string; capability_id: string; version: string; identity: { did: string; controller_pkh: string }; keys: { supplier_pkh: string; pub_key_hex: string } }
const BLIND_SPOTS = [
  'Receipts name the supplier key hash, not the registry identifier; identity and marketplace are joined by key hash.',
  'Escrow rows come from the marketplace indexer, one per escrow UTxO version (Open, Claimed, Submitted), so one job appears up to three times and no row records how it ended: Accept, Release and Reclaim are not told apart. Whether the latest 50 rows are spent is checked on the ledger.',
  'The dispute module is deployed but not wired to the escrow contract; dispute entries, if any, are matched by asset name or key hash without a verified schema.',
  'Module-1 and Module-6 datums are matched generically (bytes fields equal to the asset name or key hash); their full layouts are not decoded.',
  'Module-3 stakes are read with the six-field stake layout and other datums at that address are skipped; endorsements are matched generically like Module-1 and Module-6.',
];
async function guarded<T>(fn: () => Promise<T>): Promise<T | { error: string }> { try { return await fn(); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } }
export async function buildReport(req: HistoryRequest, f: Fetch, opts: { manifest: Manifest; lookup?: SafeFetchOpts['lookup'] }) {
  // Every URL the report reads, once each, in the order it was first asked for.
  const sources: string[] = [];
  const seen = ((url: any, init?: RequestInit) => { const u = String(url); if (!sources.includes(u)) sources.push(u); return f(url, init); }) as Fetch;
  const subject = await resolveSubject(req.subject, seen);
  // Started only once the subject is known to be valid, so a rejected subject costs no extra Koios call.
  const tipP = koios.tip(seen).then((t) => ({ block: t[0].block_no, slot: t[0].abs_slot, time: t[0].block_time })).catch(() => null);
  const want = new Set(req.include);
  const identity = want.has('identity') ? await guarded(() => identitySection(subject, seen)) : undefined;
  const marketplace = want.has('marketplace') ? await guarded(() => marketplaceSection(subject.controller_pkh, seen)) : undefined;
  const reputation = want.has('reputation') ? await guarded(() => reputationSection(subject.asset_name, subject.controller_pkh, seen)) : undefined;
  const dispute = want.has('dispute') ? await guarded(() => disputeSection(subject.asset_name, subject.controller_pkh, seen)) : undefined;
  const self_improvement = want.has('self_improvement') ? await guarded(() => selfImprovementSection(subject.asset_name, subject.controller_pkh, seen)) : undefined;
  const record = identity && !('error' in identity) ? identity.record : null;
  const adverts = marketplace && !('error' in marketplace) ? marketplace.as_supplier.adverts : null;
  const key_roles = await keyRoles(subject.controller_pkh, adverts, record?.endpoint || null, seen, opts.lookup);
  const blind = [...BLIND_SPOTS];
  if (identity && !('error' in identity) && !identity.registered) blind.unshift('No registry record found for this subject.');
  const as_of = await tipP;
  return {
    schema: 'vector.agent-history.report.v1', generated_by: { agent: opts.manifest.name, did: opts.manifest.identity.did, version: opts.manifest.version },
    subject, as_of, identity, marketplace, reputation, dispute, self_improvement, key_roles,
    sources, blind_spots: blind,
  };
}
export type Report = Awaited<ReturnType<typeof buildReport>>;
