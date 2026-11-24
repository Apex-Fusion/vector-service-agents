// agents/sourcing-agent/src/bidders/lineage.ts
// What the DID resolution of a bidder says, as the members of the file that the model reads: the status, the lineage (the end of a hold, the end of the record, the successor, a recovery that waits), the
// Accountable Party that covers the record now, and its organisation. The input is the `Resolution` of the id-kit. It has three kinds, and each kind gives a lineage:
//
//   resolved     the record is Active or Suspended (the effective status can also be revoked or retired when a parent ended). The metadata gives the lineage and the parties.
//   deactivated  the record ended (the gateway answers 410): revoked or retired. The metadata gives the time of the end, the time from which signatures are invalid, and the successor. No organisation.
//   not_found    the gateway has no record. There is no metadata, so the lineage is empty.
//
// A resolution that cannot be used gives the status `unreadable` and every member that comes from the record null or false. A call that threw gives the same (`unreadableRecord`). A port that answers with
// another shape than its contract is a fault of the wiring: it throws a `TypeError`.
//
// No free text of a record reaches a member. A reason is kept only when it is one of the reason words of the gateway. A time is kept only in the form `YYYY-MM-DDTHH:MM:SSZ` and only when it is a real time.
// A successor is kept only as a DID. An organisation is kept only as a lower-case domain. A key hash is kept only as 56 lower-case hex characters. The organisation is `verified` only when the gateway says so,
// and never for an organisation that the file does not hold.
import type { EffectiveStatus } from '@vsa/id-kit/client';
import { isKeyHash, isPlainObject, parseDid } from '@vsa/usecase-kit/protocol';
import type { Did } from '@vsa/usecase-kit/protocol';
import type { BidderLineage, BidderStatus } from './types.ts';

/** The members of the file that come from the DID resolution. */
export interface RecordFacts {
  readonly status: BidderStatus;
  readonly status_reason: string | null;
  readonly lineage: BidderLineage;
  readonly accountable: string | null;
  readonly organisation: string | null;
  readonly organisation_verified: boolean;
}

/** The reason words of the gateway for an effective status that a record does not state itself. */
export const EFFECTIVE_REASONS = ['invalidated', 'parentRevoked', 'parentRetired', 'deactivationPending', 'parentSuspended', 'notAuthentic', 'unaccountable'] as const;

const KINDS: readonly string[] = ['resolved', 'deactivated', 'not_found'];
const STATUSES: readonly string[] = ['active', 'suspended', 'revoked', 'retired'];
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const isStatus = (value: unknown): value is EffectiveStatus => typeof value === 'string' && STATUSES.includes(value);

/** The lineage of a record with no lineage: nothing ends, nothing waits. A new object each time. */
function emptyLineage(): BidderLineage {
  return { hold_until: null, ended_at: null, invalid_from: null, successor: null, recovery_pending: false };
}

/** The members of a record that the gateway did not answer for: the status `unreadable`, and nothing else is known. */
export function unreadableRecord(): RecordFacts {
  return { status: 'unreadable', status_reason: null, lineage: emptyLineage(), accountable: null, organisation: null, organisation_verified: false };
}

/** The time of a text in the form `YYYY-MM-DDTHH:MM:SSZ` in milliseconds, or null for any other value, and for a time that does not exist, such as the 30th of February or the hour 24. */
export function timeOfIso(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === `${value.slice(0, -1)}.000Z` ? ms : null;
}

/** A domain in lower case with at least two labels: letters, digits and hyphens, no trailing dot, at most 64 characters. Any other text is null. */
export function domainOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) ? value : null;
}

/** The latest end of the holds of a status, as the text of the gateway, or null. A hold with an end that cannot be read is not counted. */
function holdEnd(holds: unknown): string | null {
  if (!Array.isArray(holds)) return null;
  let latest: { text: string; ms: number } | null = null;
  for (const hold of holds as readonly unknown[]) {
    if (!isPlainObject(hold)) continue;
    const ms = timeOfIso(hold.until);
    if (ms !== null && (latest === null || ms > latest.ms)) latest = { text: hold.until as string, ms };
  }
  return latest === null ? null : latest.text;
}

/** The lineage that the metadata of a record gives. A member that is missing or has another form is null or false. */
function lineageOf(metadata: Record<string, unknown>): BidderLineage {
  const status = isPlainObject(metadata.vectorStatus) ? metadata.vectorStatus : null;
  const recovery = isPlainObject(metadata.vectorRecovery) ? metadata.vectorRecovery : null;
  const successor = status === null ? null : parseDid(status.successor);
  return {
    hold_until: status === null ? null : holdEnd(status.holds),
    ended_at: status === null || timeOfIso(status.at) === null ? null : (status.at as string),
    invalid_from: status === null || timeOfIso(status.invalidFrom) === null ? null : (status.invalidFrom as string),
    successor: successor !== null && successor.ok ? successor.value : null,
    recovery_pending: recovery !== null && typeof recovery.pendingNewController === 'string' && recovery.pendingNewController !== '',
  };
}

/**
 * The Accountable Party that covers the record at the time `nowMs`: its start is not after that time, and it has no end or its end is not before that time. The first one in the list that covers is the one.
 * A party with a time that cannot be read is not shown to cover. A clock with no time (`nowMs` null) shows no party.
 */
function coveringParty(metadata: Record<string, unknown>, nowMs: number | null): Record<string, unknown> | null {
  const parties = metadata.vectorParties;
  if (nowMs === null || !Array.isArray(parties)) return null;
  for (const party of parties as readonly unknown[]) {
    if (!isPlainObject(party) || party.role !== 'accountable') continue;
    const from = timeOfIso(party.notBefore);
    const until = party.notAfter === undefined ? null : timeOfIso(party.notAfter);
    if (from === null || (party.notAfter !== undefined && until === null)) continue;
    if (from <= nowMs && (until === null || until >= nowMs)) return party;
  }
  return null;
}

const wrong = (): TypeError => new TypeError('the port resolve gave a value that is not a DID resolution of the bidder: a wrong kind, a wrong DID or a member of another form');

/**
 * The members of the file that the resolution of `did` gives, at the time `nowMs` (null for a clock with no time). `answer` is what the port gave. A value that is not a resolution of the id-kit for this DID is
 * a fault of the wiring and throws a `TypeError`.
 */
export function factsOfResolution(answer: unknown, did: Did, nowMs: number | null): RecordFacts {
  if (!isPlainObject(answer) || typeof answer.kind !== 'string' || !KINDS.includes(answer.kind) || answer.did !== did) throw wrong();
  if (answer.kind === 'not_found') return { ...unreadableRecord(), status: 'not_found' };
  const { effectiveStatus, effectiveReason, metadata } = answer;
  if (!isStatus(effectiveStatus) || !(effectiveReason === null || typeof effectiveReason === 'string') || !isPlainObject(metadata)) throw wrong();
  const ended = answer.kind === 'deactivated';
  // A record that ended is revoked or retired. A resolution that says that it ended and is Active or Suspended contradicts itself: it gives no status.
  if (ended && (effectiveStatus === 'active' || effectiveStatus === 'suspended')) return unreadableRecord();
  const common = {
    status: effectiveStatus,
    status_reason: (EFFECTIVE_REASONS as readonly (string | null)[]).includes(effectiveReason) ? effectiveReason : null,
    lineage: lineageOf(metadata),
  };
  if (ended) return { ...common, accountable: null, organisation: null, organisation_verified: false };
  const party = coveringParty(metadata, nowMs);
  const organisation = party === null ? null : domainOf(party.organisation);
  return {
    ...common,
    accountable: party !== null && isKeyHash(party.signer) ? party.signer : null,
    organisation,
    organisation_verified: organisation !== null && party !== null && party.organisationVerified === true,
  };
}
