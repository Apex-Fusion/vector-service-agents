import { koios } from '@vsa/vector-read';
import type { Fetch, SafeFetchOpts } from '@vsa/vector-read';
import type { HistoryRequest } from './request.ts';
import { resolveSubject } from './subject.ts';
import { identityTimeline } from './identity.ts';
import { marketplaceSection } from './marketplace.ts';
import { reputationSection, disputeSection, selfImprovementSection } from './modules.ts';
import type { ModuleScan } from './modules.ts';
import { keyRoles, unknownKeyRoles } from './key-roles.ts';
import { endpointOf, marketplaceKeys } from './views.ts';
import { DEFAULT_CONFIG } from './config.ts';
import type { ReportConfig } from './config.ts';
export interface Manifest { name: string; capability_id: string; version: string; identity: { did: string }; keys: { supplier_pkh: string; pub_key_hex: string } }
// The four gaps exported below are also in the manifest (server.ts): ESCROW_ROWS_GAP is its gaps[0], the next two joined are its gaps[1],
// CURRENT_STATE_GAP is its gaps[2] and IDENTITY_VIEW_GAP its gaps[3]. That keeps the manifest that is frozen into the advert, the spec and every
// report saying the same thing.
export const ESCROW_ROWS_GAP = 'Escrow rows come from the marketplace indexer, one per escrow UTxO version: a job appears once for each state it reached (Open, Claimed, Submitted), so up to three times, and never as Accepted, Released or Reclaimed. The report gives by_indexer_state counts and, for the latest 50 rows per side, how many are spent on the ledger (latest_checked, latest_spent). It gives no outcome counts: Accept, Release and Reclaim are not told apart.';
export const DISPUTE_MODULE_GAP = 'The dispute module is deployed but not wired to the escrow contract; dispute entries, if any, are matched without a verified schema.';
export const GENERIC_MATCH_GAP = 'Module-1 and Module-6 datums, and Module-3 endorsements, are matched generically: a datum is attributed to the subject when one of its bytes fields (top level or one constructor deep) equals the identifier the subject was given as, the asset name for a DID or asset name and the key hash for a key hash. An entry that names an agent only by its controller key is not found for a DID or asset name, and an entry that names only an asset name is not found for a key hash. Their full layouts are not decoded.';
export const CURRENT_STATE_GAP = 'The reputation, dispute and self_improvement sections list the unspent outputs at the module addresses as they are now. A withdrawn stake, a closed claim or a spent proposal no longer appears, and the report does not say that it ever existed.';
export const IDENTITY_VIEW_GAP = 'The identity section shows each version of the record as the ledger holds it: the status the version wrote, the keys as listed (the proof of a P-256 key is not checked) and the parties as named. It is not a did:vector resolution: it does not apply confirmations, holds that have run out, a missing Accountable Party, the status of a parent, the cutoff slot of the legacy registry or the not-found rules of the method. Resolve the DID for its effective status.';
export const BLIND_SPOTS: readonly string[] = [
  'Receipts and adverts name the supplier key hash; identity and marketplace are joined by key hash: the owner key of a legacy record, or the listed keys with the transaction purpose of an identity registry record. The marketplace section is therefore about those keys, not about one agent: agents that share a key show the same marketplace section.',
  ESCROW_ROWS_GAP,
  DISPUTE_MODULE_GAP,
  GENERIC_MATCH_GAP,
  'Module-3 stakes are read with the six-field stake layout and other datums at that address are skipped. A subject given as a DID or asset name keeps only the stakes whose datum names that asset, not those that share its owner key; a subject given as a key hash keeps every stake that key owns, whatever the asset.',
  CURRENT_STATE_GAP,
  IDENTITY_VIEW_GAP,
];
// Lines a report adds to the fixed ones when they apply.
export const LEGACY_ONLY = 'Only the legacy registry was read: the identity registry is not configured in this service.';
const NO_RECORD = 'No registry record found for this subject.';
const NO_MARKETPLACE_KEY = 'marketplace was not read: the subject has no live registry record that names a marketplace key (the owner key of a legacy record, or a listed key with the transaction purpose), and the identity timeline gave no earlier one.';
// The registry no longer holds a record of the subject that names a marketplace key, but the identity timeline knows the keys of the last version
// that did: those keys are used, and the line says so.
export const lastKnownKeysLine = (pkhs: readonly string[]) => `marketplace uses the last known marketplace keys ${pkhs.join(', ')}, taken from the identity timeline, because the subject has no live registry record that names one. Those keys may no longer act for the subject, and the marketplace section shows what the keys did, not necessarily what the subject did.`;
const SCAN_TRUNCATED = 'module scan may be truncated at 1,000 rows';
// The whole report has this long. The runtime gives the service SERVICE_TIMEOUT_MS = 180 s; the 30 s below that are for serialising the answer and for the
// work that follows the sections. A section that has not finished by then is reported as an error, and the rest of the report is still answered.
export const REPORT_BUDGET_MS = 150_000;
export const BUDGET_EXCEEDED = 'time budget exceeded';
const EXPIRED = Symbol('expired');
// The work, or EXPIRED when `ms` pass first. The work is not cancelled (a fetch carries its own timeout), only no longer waited for; whatever it
// settles with afterwards is dropped. The timer is always cleared.
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<typeof EXPIRED>((resolve) => { timer = setTimeout(() => resolve(EXPIRED), ms); });
  try { return await Promise.race([work, clock]); } finally { clearTimeout(timer); }
}
export async function buildReport(req: HistoryRequest, f: Fetch, opts: { manifest: Manifest; lookup?: SafeFetchOpts['lookup']; budgetMs?: number; config?: ReportConfig }) {
  const { registries, modules } = opts.config ?? DEFAULT_CONFIG;
  // One deadline for the whole report, on a monotonic clock. Every section, the subject lookup, the chain tip and the key check race against what is left of it.
  const started = performance.now();
  const remaining = () => Math.max(0, (opts.budgetMs ?? REPORT_BUDGET_MS) - (performance.now() - started));
  const guarded = async <T>(work: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      const done = await within(work(), remaining());
      return done === EXPIRED ? { error: BUDGET_EXCEEDED } : done;
    } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  };
  // Every URL the report reads, once each. The sections run at the same time, so the order they ask in is not stable: the list is sorted when it is returned.
  const sources: string[] = [];
  const seen = ((url: any, init?: RequestInit) => { const u = String(url); if (!sources.includes(u)) sources.push(u); return f(url, init); }) as Fetch;
  const resolved = await within(resolveSubject(req.subject, seen, registries), remaining());
  if (resolved === EXPIRED) throw new Error(`${BUDGET_EXCEEDED} while resolving the subject`);
  const { subject, record } = resolved;
  // Started only once the subject is known to be valid, so a rejected subject costs no extra Koios call.
  const tipP = within(koios.tip(seen).then((t) => ({ block: t[0].block_no, slot: t[0].abs_slot, time: t[0].block_time })), remaining()).then((t) => (t === EXPIRED ? null : t)).catch(() => null);
  const want = new Set(req.include);
  const scan: ModuleScan = { truncated: false };
  // The keys the marketplace section is about: the key hash given, or the keys the subject's live record lets act in the marketplace.
  const live = subject.kind === 'pkh' ? [subject.pkh!] : record ? marketplaceKeys(record) : [];
  // The identity timeline is read when the identity section is asked for, and also when the marketplace needs keys that no live record names:
  // a subject whose record is gone, or names no such key now, is then read with the keys of the last version that named one.
  const timelineP = want.has('identity') || (live.length === 0 && want.has('marketplace')) ? guarded(() => identityTimeline(subject, seen, registries)) : undefined;
  const marketplaceP = !want.has('marketplace') ? undefined
    : live.length ? guarded(() => marketplaceSection(live, seen))
    : guarded(async () => {
      const timeline = await timelineP;
      if (!timeline || 'error' in timeline) throw new Error(`the last known marketplace keys could not be read: ${timeline?.error ?? 'the identity timeline was not read'}`);
      return marketplaceSection(timeline.last_marketplace_pkhs, seen); // null when no version named one
    });
  const [timeline, marketplace, reputation, dispute, self_improvement] = await Promise.all([
    timelineP,
    marketplaceP,
    want.has('reputation') ? guarded(() => reputationSection(subject, seen, modules, scan)) : undefined,
    want.has('dispute') ? guarded(() => disputeSection(subject, seen, modules, scan)) : undefined,
    want.has('self_improvement') ? guarded(() => selfImprovementSection(subject, seen, modules, scan)) : undefined,
  ]);
  const read = timeline && !('error' in timeline) ? timeline : null; // the timeline, when it was read
  const identity = want.has('identity') ? (timeline && 'error' in timeline ? timeline : timeline?.section) : undefined;
  const known = read?.last_marketplace_pkhs ?? [];
  const keys = live.length ? live : known; // the keys the marketplace section is about
  const adverts = marketplace && !('error' in marketplace) ? marketplace.as_supplier.adverts : null;
  // The endpoint comes from the record, and the key check runs only when the identity section is asked for.
  const endpoint = want.has('identity') && record ? endpointOf(record) : null;
  const roles = await within(keyRoles(record, subject.controller_pkh, keys, adverts, endpoint, seen, opts.lookup), remaining());
  // The key check is not a section. If its time runs out the answer is the one it gives when the endpoint does not answer: unknown.
  const key_roles = roles === EXPIRED ? unknownKeyRoles(subject.controller_pkh, keys, adverts, endpoint) : roles;
  const blind = [...BLIND_SPOTS];
  if (read && read.section.origin === null) blind.unshift(NO_RECORD); // never registered; also a key hash that owns no record
  else if (live.length === 0) blind.unshift(known.length ? lastKnownKeysLine(known) : NO_MARKETPLACE_KEY); // no live key: say which keys were used, or that none was
  if (registries.identity === null) blind.unshift(LEGACY_ONLY);
  if (scan.truncated) blind.push(SCAN_TRUNCATED);
  const as_of = await tipP;
  return {
    schema: 'vector.agent-history.report.v2', generated_by: { agent: opts.manifest.name, did: opts.manifest.identity.did, version: opts.manifest.version },
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
