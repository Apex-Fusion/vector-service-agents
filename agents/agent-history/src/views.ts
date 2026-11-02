import {
  keyHash, utf8FromHex, didFor, activeKey,
  PURPOSE_AUTHENTICATION, PURPOSE_ASSERTION, PURPOSE_TRANSACTION, PURPOSE_DELEGATION, RIGHT_SUSPEND, RIGHT_REVOKE, RIGHT_RECOVER,
} from '@vsa/vector-read';
import type { IdentityDatum, LegacyDatum, Key, Party, Hold, Signer, Status } from '@vsa/vector-read';
// How the report shows a record of either registry, and what changed between two versions of it. The names follow the document metadata of
// did:vector (Part 1, section 8.2) in the report's snake_case: signers, reasons, roles, rights and purposes are words, keys are key hashes.

export type RegistryKind = 'identity' | 'legacy';
/** The datum of an authentic record output, with the registry it belongs to. */
export type RecordContent = { registry: 'identity'; datum: IdentityDatum } | { registry: 'legacy'; datum: LegacyDatum };

// Part 1, section 8.2: a text field or capability item that is not valid UTF-8, or that holds a noncharacter (RFC 7493), is left out.
// U+FDD0..U+FDEF and the last two code points of every plane.
const NONCHARACTER = /[\uFDD0-\uFDEF\uFFFE\uFFFF\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/u;
/** The text of a record's bytes, or null when the bytes are not text the report shows. */
export function recordText(hex: string): string | null {
  const text = utf8FromHex(hex);
  return text === null || NONCHARACTER.test(text) ? null : text;
}
const textItems = (items: readonly string[]) => items.map(recordText).filter((t): t is string => t !== null);
// Part 2, Appendix A. A code without a name there is shown as a decimal string.
const REASONS: Readonly<Record<number, string>> = {
  0: 'unspecified', 1: 'keyCompromise', 3: 'affiliationChanged', 4: 'superseded', 5: 'cessationOfOperation', 6: 'hold', 9: 'privilegeWithdrawn',
  64: 'disputeVerdict', 65: 'legalOrder', 66: 'parentRevoked', 67: 'providerWithdrawn', 68: 'securityInvestigation', 69: 'unaccountable',
  70: 'parentRetired', 71: 'parentSuspended', 72: 'deactivationPending', 73: 'invalidated', 74: 'notAuthentic',
};
const reasonName = (code: number) => REASONS[code] ?? String(code);
/** A signer as Part 1 shows it: a key hash, script:<script hash>, or controller. */
export const signerName = (s: Signer) => (s.type === 'KeyHash' ? s.hash : s.type === 'Script' ? `script:${s.hash}` : 'controller');
const PURPOSES = [[PURPOSE_AUTHENTICATION, 'authentication'], [PURPOSE_ASSERTION, 'assertion'], [PURPOSE_TRANSACTION, 'transaction'], [PURPOSE_DELEGATION, 'delegation']] as const;
const RIGHTS = [[RIGHT_SUSPEND, 'suspend'], [RIGHT_REVOKE, 'revoke'], [RIGHT_RECOVER, 'recover']] as const;
// The words of the bits that are set, in the order of the list (a sum of powers of two, read as the library reads it).
const words = (value: number, names: ReadonlyArray<readonly [number, string]>) => names.filter(([bit]) => (BigInt(value) / BigInt(bit)) % 2n === 1n).map(([, word]) => word);
// A legacy record's self-declared registration time can be any integer: a JSON number while it is exact, else a decimal string.
const jsonInt = (n: bigint): number | string => (n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n.toString());

export interface KeyView { key_hash: string; type: 'Ed25519' | 'P-256'; purposes: string[] }
export interface PartyView { role: string; signer: string; organisation: string | null; rights: string[]; not_before: number; not_after: number | null; removal_after: number | null }
export interface HoldView { by: string; reason: string; since: number; until: number }
export type LineageView = { type: 'root' } | { type: 'subagent'; parent: string; parent_epoch: number; depth: number };
export type StatusView =
  | { status: 'active' }
  | { status: 'suspended'; holds: HoldView[] }
  | { status: 'revoked'; by: string; reason: string; at: number; invalid_from: number | null; successor: string | null }
  | { status: 'retired'; at: number; successor: string | null };
export interface IdentityRecordView {
  registry: 'identity'; controller_pkh: string; keys: KeyView[]; parties: PartyView[]; guardian_threshold: number;
  pending_recovery: { new_controller: string; effective_after: number } | null; lineage: LineageView; subagent_epoch: number;
  name: string | null; description: string | null; framework: string | null; endpoint: string | null; capabilities: string[]; created_at: number; status: StatusView;
}
export interface LegacyRecordView {
  registry: 'legacy'; controller_pkh: string; name: string | null; description: string | null; capabilities: string[]; framework: string | null; endpoint: string | null; registered_at: number | string;
}
export type RecordView = IdentityRecordView | LegacyRecordView;

const keyView = (k: Key): KeyView => ({ key_hash: keyHash(k.key), type: k.keyType === 'P256' ? 'P-256' : 'Ed25519', purposes: words(k.purposes, PURPOSES) });
const partyView = (p: Party): PartyView => ({
  role: p.role.toLowerCase(), signer: signerName(p.signer), organisation: p.organisation === null ? null : recordText(p.organisation),
  rights: words(p.rights, RIGHTS), not_before: p.notBefore, not_after: p.notAfter, removal_after: p.removalAfter,
});
const holdView = (h: Hold): HoldView => ({ by: signerName(h.by), reason: reasonName(h.reason), since: h.since, until: h.until });
function statusView(s: Status): StatusView {
  switch (s.type) {
    case 'Active': return { status: 'active' };
    case 'Suspended': return { status: 'suspended', holds: s.holds.map(holdView) };
    case 'Revoked': return { status: 'revoked', by: signerName(s.by), reason: reasonName(s.reason), at: s.at, invalid_from: s.invalidFrom, successor: s.successor === null ? null : didFor(s.successor) };
    case 'Retired': return { status: 'retired', at: s.at, successor: s.successor === null ? null : didFor(s.successor) };
  }
}
const lineageView = (d: IdentityDatum): LineageView => (d.lineage.type === 'Root' ? { type: 'root' } : { type: 'subagent', parent: didFor(d.lineage.parent), parent_epoch: d.lineage.parentEpoch, depth: d.lineage.depth });

export function recordView(c: RecordContent): RecordView {
  if (c.registry === 'legacy') {
    const d = c.datum;
    return { registry: 'legacy', controller_pkh: d.owner.hash, name: recordText(d.name), description: recordText(d.description), capabilities: textItems(d.capabilities), framework: recordText(d.framework), endpoint: recordText(d.endpoint), registered_at: jsonInt(d.registeredAt) };
  }
  const d = c.datum;
  return {
    registry: 'identity', controller_pkh: keyHash(d.controller), keys: d.keys.map(keyView), parties: d.parties.map(partyView), guardian_threshold: d.guardianThreshold,
    pending_recovery: d.pendingRecovery === null ? null : { new_controller: keyHash(d.pendingRecovery.newController), effective_after: d.pendingRecovery.effectiveAfter },
    lineage: lineageView(d), subagent_epoch: d.subagentEpoch,
    name: recordText(d.name), description: recordText(d.description), framework: recordText(d.framework), endpoint: recordText(d.endpoint), capabilities: textItems(d.capabilities),
    created_at: d.createdAt, status: statusView(d.status),
  };
}
/** The key hash of the record's controller key. A legacy record names only its owner's hash, which is that key's (Part 1, section 7.2). */
export const controllerPkh = (c: RecordContent) => (c.registry === 'legacy' ? c.datum.owner.hash : keyHash(c.datum.controller));
/** The record's endpoint, or null when it has none the report can show. */
export const endpointOf = (c: RecordContent) => recordText(c.datum.endpoint) || null;
/**
 * The keys that act for the record in the marketplace, as key hashes: the owner key of a legacy record (receipts and adverts name it), or each listed
 * key of an identity registry record for which active_key(record, key, transaction) holds (the listing rule, Part 2 section 6.2), in datum order.
 * A tombstone lists no key, so it has none.
 */
export function marketplaceKeys(c: RecordContent): string[] {
  if (c.registry === 'legacy') return [c.datum.owner.hash];
  const record = c.datum;
  return record.keys.map((k) => keyHash(k.key)).filter((kh) => activeKey(record, kh, PURPOSE_TRANSACTION));
}
/** The purposes for which active_key(record, key hash, purpose) holds, as words: what a listed key may do for the record. */
export const activePurposes = (record: IdentityDatum, kh: string) => PURPOSES.filter(([purpose]) => activeKey(record, kh, purpose)).map(([, word]) => word);

// ---- What changed between two versions of a record ----
// A member is present only when its value changed. Scalars are { from, to } (from is null for the first version); lists are what was added and
// removed, matched by key hash for keys, by role and signer for parties (Part 2 section 3.6) and by author for holds.
export interface Changes {
  controller?: { from: string | null; to: string | null };
  keys?: { added: KeyView[]; removed: KeyView[] };
  parties?: { added: PartyView[]; removed: PartyView[]; changed: PartyView[] };
  guardian_threshold?: { from: number | null; to: number };
  recovery?: { event: 'started' | 'cancelled' | 'completed'; new_controller: string; effective_after: number };
  subagent_epoch?: { from: number | null; to: number };
  lineage?: { from: LineageView | null; to: LineageView };
  created_at?: { from: number | null; to: number | null };
  name?: { from: string | null; to: string | null };
  description?: { from: string | null; to: string | null };
  framework?: { from: string | null; to: string | null };
  endpoint?: { from: string | null; to: string | null };
  registered_at?: { from: number | string | null; to: number | string | null };
  capabilities?: { added: string[]; removed: string[] };
  status?: { from: StatusView['status'] | null; to: StatusView['status'] } & Partial<Omit<Extract<StatusView, { status: 'revoked' }>, 'status'>>;
  holds?: { added: HoldView[]; renewed: HoldView[]; removed: HoldView[] };
  successor?: { from: string | null; to: string | null };
}
// One version in the terms both registries share. A legacy record has no keys, parties, recovery or subagents, and its status is active.
interface Version {
  controller: string | null; keys: KeyView[]; parties: PartyView[]; guardian_threshold: number; pending: { new_controller: string; effective_after: number } | null;
  lineage: LineageView; subagent_epoch: number; created_at: number | null; registered_at: number | string | null;
  text: Record<'name' | 'description' | 'framework' | 'endpoint', string>; capabilities: string[]; status: StatusView | null;
}
const NOTHING: Version = { controller: null, keys: [], parties: [], guardian_threshold: 0, pending: null, lineage: { type: 'root' }, subagent_epoch: 0, created_at: null, registered_at: null, text: { name: '', description: '', framework: '', endpoint: '' }, capabilities: [], status: null };
function versionOf(c: RecordContent): Version {
  if (c.registry === 'legacy') {
    const d = c.datum;
    return { ...NOTHING, controller: d.owner.hash, registered_at: jsonInt(d.registeredAt), text: { name: d.name, description: d.description, framework: d.framework, endpoint: d.endpoint }, capabilities: d.capabilities, status: { status: 'active' } };
  }
  const v = recordView(c) as IdentityRecordView, d = c.datum;
  return {
    controller: v.controller_pkh, keys: v.keys, parties: v.parties, guardian_threshold: v.guardian_threshold, pending: v.pending_recovery, lineage: v.lineage,
    subagent_epoch: v.subagent_epoch, created_at: v.created_at, registered_at: null, text: { name: d.name, description: d.description, framework: d.framework, endpoint: d.endpoint },
    capabilities: d.capabilities, status: v.status,
  };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const TEXT_FIELDS = ['name', 'description', 'framework', 'endpoint'] as const;
const holdsOf = (s: StatusView | null) => (s?.status === 'suspended' ? s.holds : []);
const successorOf = (s: StatusView | null) => (s?.status === 'revoked' || s?.status === 'retired' ? s.successor : null);
/** What a version changed against the one before it; with no version before it (`prev` null), everything it sets. */
export function changesBetween(prevContent: RecordContent | null, nextContent: RecordContent): Changes {
  const first = prevContent === null;
  const prev = first ? NOTHING : versionOf(prevContent), next = versionOf(nextContent);
  const out: Changes = {};
  if (prev.controller !== next.controller) out.controller = { from: prev.controller, to: next.controller };
  const keysAdded = next.keys.filter((k) => !prev.keys.some((p) => same(p, k))), keysRemoved = prev.keys.filter((p) => !next.keys.some((k) => same(p, k)));
  if (keysAdded.length || keysRemoved.length) out.keys = { added: keysAdded, removed: keysRemoved };
  const partyOf = (list: PartyView[], p: PartyView) => list.find((q) => q.role === p.role && q.signer === p.signer);
  const partiesAdded = next.parties.filter((p) => !partyOf(prev.parties, p)), partiesRemoved = prev.parties.filter((p) => !partyOf(next.parties, p));
  const partiesChanged = next.parties.filter((p) => { const before = partyOf(prev.parties, p); return before !== undefined && !same(before, p); });
  if (partiesAdded.length || partiesRemoved.length || partiesChanged.length) out.parties = { added: partiesAdded, removed: partiesRemoved, changed: partiesChanged };
  if (prev.guardian_threshold !== next.guardian_threshold) out.guardian_threshold = { from: first ? null : prev.guardian_threshold, to: next.guardian_threshold };
  if (!same(prev.pending, next.pending)) {
    if (next.pending !== null) out.recovery = { event: 'started', ...next.pending };
    else if (prev.pending !== null) {
      // A recovery that is completed installs its new controller key; one that ends any other way (cancelled, a threshold of 0, a controller change) is cancelled.
      const completed = next.controller === prev.pending.new_controller && prev.controller !== next.controller;
      out.recovery = { event: completed ? 'completed' : 'cancelled', ...prev.pending };
    }
  }
  if (prev.subagent_epoch !== next.subagent_epoch) out.subagent_epoch = { from: first ? null : prev.subagent_epoch, to: next.subagent_epoch };
  if (!same(prev.lineage, next.lineage)) out.lineage = { from: first ? null : prev.lineage, to: next.lineage };
  if (prev.created_at !== next.created_at) out.created_at = { from: prev.created_at, to: next.created_at };
  for (const field of TEXT_FIELDS) if (prev.text[field] !== next.text[field]) out[field] = { from: first ? null : recordText(prev.text[field]), to: recordText(next.text[field]) };
  if (prev.registered_at !== next.registered_at) out.registered_at = { from: prev.registered_at, to: next.registered_at };
  const capsAdded = next.capabilities.filter((c) => !prev.capabilities.includes(c)), capsRemoved = prev.capabilities.filter((c) => !next.capabilities.includes(c));
  if (capsAdded.length || capsRemoved.length) out.capabilities = { added: textItems(capsAdded), removed: textItems(capsRemoved) };
  if (prev.status?.status !== next.status?.status && next.status !== null) {
    const { status: to, ...detail } = next.status as Extract<StatusView, { status: 'revoked' }>;
    out.status = { from: prev.status?.status ?? null, to, ...(to === 'revoked' || to === 'retired' ? detail : {}) };
  } else if (successorOf(prev.status) !== successorOf(next.status)) out.successor = { from: successorOf(prev.status), to: successorOf(next.status) };
  const before = holdsOf(prev.status), after = holdsOf(next.status);
  const holdOf = (list: HoldView[], h: HoldView) => list.find((x) => x.by === h.by);
  const holdsAdded = after.filter((h) => !holdOf(before, h)), holdsRemoved = before.filter((h) => !holdOf(after, h));
  const holdsRenewed = after.filter((h) => { const old = holdOf(before, h); return old !== undefined && !same(old, h); });
  if (holdsAdded.length || holdsRenewed.length || holdsRemoved.length) out.holds = { added: holdsAdded, renewed: holdsRenewed, removed: holdsRemoved };
  return out;
}
/** The end of a legacy record (a legacy deregistration): the record is retired at the block time of that transaction (Part 1, section 8.2). */
export const legacyEndChanges = (atMs: number): Changes => ({ status: { from: 'active', to: 'retired', at: atMs, successor: null } });
