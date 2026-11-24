// agents/sourcing-agent/src/compliance/read.ts
// The reader of the compliance attestation of a bidder. `readCompliance` says whether the compliance registry stands behind a Bid Desk now. The registry is one key with no record. It issues one identity
// attestation (type 0) about each Bid Desk, with a `valid_until`. The resolver of the gateway does not list type 0, so the reader takes the attestations from the ledger, through the port `list`.
//
// The rules, in order:
//   1. The reader asks the list for the attestations of type 0 that the registry key made, about every subject: the key hash of the registry as issuer, the type 0, 50 to a page, and NO subject. A filter on the
//      bytes of the subject can be dodged. The controller of the subject can write the datum again, in a `Contest`, with the subject as a byte string in chunks. That datum decodes to the same subject, but a list
//      that filters on the bytes of the subject does not find it, so a bidder could hide a revoked attestation. A key hash gives no filter on the datum. The list then reads every attestation output, and the
//      reader decides on the decoded datum. The list fails when 5,000 or more attestation outputs exist, whoever made them: the fact is then `unreadable`, for every bidder.
//   2. The reader follows `nextOffset` from page to page until a page names none. The next page must start after the page that names it. All the pages together have 20 seconds, and at most 100 pages are read.
//      The attestations of all the pages take part.
//   3. The reader checks each item again, on its decoded datum: the type is 0, the key hash of the issuer is the key hash of the registry, and the subject is the agent id of the bidder. Anybody can make an
//      attestation about any subject, so the issuer rule is the guard. An item that fails one of the three is dropped and never shown. The reader does not trust the list to have applied the query.
//   4. The reader puts the kept items in order again: the newest `issued_at` first, then the lower identifier. The newest kept item decides. It is the last statement of the registry about the bidder.
//   5. `attestationState` of buyer-core gives the state of that item at `nowMs`: active, revoked, expired or not_yet_valid. Active is `valid`. Each other state is `invalid`, and `attestation_state` names it.
//      No kept item is `absent`.
//   6. A source that cannot be read is `unreadable`. It is never `absent` and never `valid`. That covers a list that throws or does not answer in 20 seconds, a page that is not an object with a list `items`,
//      a next page that does not lead on, more than 100 pages, an item whose datum cannot be read, an identifier that appears twice, and a bidder, a key hash or a time that is not in its form.
//
// What the reader reads of an item. Of every item: the identifier, and the subject, the issuer, the type and the issue time of the datum. Of the item that decides: also the dates, the status, the reason of a
// revocation and the hash of the reply. The reason is `revokeReason` of the view. It is exact, while `datum.status.reason` is NaN for a reason that a number cannot hold. The address of the reply of the bidder
// is free text of a bidder, so the reader does not read it, fetch it or return it: the reply shows as its hash only. The reader does not require the attestation to be solicited, or to have a locator, an
// envelope or links.
//
// The reader reads no file and no environment variable, holds no key and makes no network call. Its one source is `list`. It retries nothing and logs nothing. It never throws and never rejects.
import { attestationState, issuerMatches } from '@vsa/buyer-core';
import type { AttestationPage, AttestationQuery, AttestationView } from '@vsa/buyer-core';
import { agentIdOf, isKeyHash, isPlainObject, parseDid } from '@vsa/usecase-kit/protocol';
import type { Did } from '@vsa/usecase-kit/protocol';

/** The type of an identity attestation, which is the type that the compliance registry issues. */
export const COMPLIANCE_ATT_TYPE = 0;

/** The most time that one read of the list has, in milliseconds. All the pages of the list together have it. */
export const FACT_READ_TIMEOUT_MS = 20_000;

/** The attestations that one page asks for, which is the most that a list gives. The newest come first. */
const PAGE_LIMIT = 50;

/**
 * The most pages that one read follows. The list fails when 5,000 or more attestation outputs exist, so it holds 4,999 at the most, and a page holds 50 of them: no real list names a page after the 100th.
 */
const MAX_PAGES = 100;

/** The last millisecond of the year 9999. Every time in a datum is in the range from 0 to this time. */
const LAST_TIME_MS = 253_402_300_799_999;

/** What a datum holds for a key, an identifier or a hash of 32 bytes: 64 lower-case hex characters. */
const BYTES_32 = /^[0-9a-f]{64}$/;

/** The state of one fact of a bidder file. */
export type FactState = 'valid' | 'invalid' | 'absent' | 'unreadable';

/**
 * What the reader says of the compliance attestation of one bidder. `valid` means that the newest attestation of the registry is active. `invalid` means that it is not, and `attestation_state` says why. `absent`
 * means that the registry made none. `unreadable` means that the reader could not tell. The members after `state` come from the attestation that decides, and they are null when none decides. The times are texts
 * in UTC to the whole second, as `YYYY-MM-DDTHH:MM:SSZ`. The reason of a revocation is a decimal text, because a reason can be larger than a number holds. `contested` holds the hash of the reply of the bidder.
 */
export interface ComplianceFact {
  readonly state: FactState;
  readonly attestation: string | null;
  readonly attestation_state: 'active' | 'revoked' | 'expired' | 'not_yet_valid' | null;
  readonly issued_at: string | null;
  readonly valid_until: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  readonly contested: { readonly sha256: string } | null;
}

/** The clock of the reader. It bounds the wait for the list. `systemClock` of the kit is one. */
export interface ComplianceClock {
  /** Resolves after `ms` milliseconds, or at once when `signal` aborts. It never rejects. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What the reader needs, as values and functions. */
export interface ComplianceDeps {
  /**
   * One page of attestations: `listAttestations` of buyer-core, bound to its ledger environment, as `(query) => listAttestations(env, query)`. The reader asks for the attestations of type 0 that the registry key
   * made, about every subject, 50 to a page, and it follows `nextOffset`. That list reads every attestation output, so it fails when 5,000 or more exist: the fact is then `unreadable`. A function that throws, that
   * does not answer in time or that gives a page of the wrong shape makes the fact `unreadable` too.
   */
  readonly list: (query: AttestationQuery) => Promise<AttestationPage>;
  /** The key hash of the compliance registry: 56 lower-case hex characters. A value of another form makes the fact `unreadable`. */
  readonly issuerPkh: string;
  readonly clock: ComplianceClock;
}

/** The fact when no attestation decides it. */
const noAttestation = (state: 'absent' | 'unreadable'): ComplianceFact => ({
  state, attestation: null, attestation_state: null, issued_at: null, valid_until: null, revoked_at: null, revoke_reason: null, contested: null,
});

/** A whole number of at least 0. */
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** A time that a datum can hold: a whole number of milliseconds, from 0 to the last millisecond of the year 9999. */
const isTime = (value: unknown): value is number => isWhole(value) && value <= LAST_TIME_MS;
const isBytes32 = (value: unknown): value is string => typeof value === 'string' && BYTES_32.test(value);

/** A time in UTC to the whole second. The time is in the range of a datum, so the year has four digits. A part of a second is cut off. */
const isoOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/**
 * Runs `work`, and gives its value in a wrapper. It gives null when `work` throws or rejects, and when `ms` milliseconds of the clock pass first. A late answer, or a late failure, is dropped. The timer of the
 * clock is cleared when the race ends.
 */
async function bounded<T>(clock: ComplianceClock, ms: number, work: () => Promise<T>): Promise<{ readonly value: T } | null> {
  const stop = new AbortController();
  try {
    const late = clock.sleep(ms, stop.signal).then(() => null);
    const run = Promise.resolve().then(work).then((value) => ({ value }), () => null);
    return await Promise.race([run, late]);
  } finally {
    stop.abort();
  }
}

/** An item as far as the first look reads it: what it is, and where it stands in the order. `datum` is the datum as the page gave it, and `revokeReason` is the member of the view as the page gave it. */
interface Item {
  readonly id: string;
  readonly issuedAt: number;
  readonly datum: Record<string, unknown>;
  readonly revokeReason: unknown;
}

/** The datum as `AttestationDatum`. The reader gives it to `issuerMatches` and to `attestationState`, which read members that the reader has checked already. */
const asDatum = (datum: Record<string, unknown>): AttestationView['attestation'] => datum as unknown as AttestationView['attestation'];

/** The first look at an item: its identifier and the members that tell whether it counts and where it stands in the order. Null when one of them is missing or is not in its form. */
function look(item: unknown): Item | null {
  if (!isPlainObject(item) || !isBytes32(item.id)) return null;
  const datum = item.attestation;
  if (!isPlainObject(datum)) return null;
  const { subject, issuer, attType, issuedAt } = datum;
  if (!isBytes32(subject) || !isBytes32(issuer) || !isWhole(attType) || !isTime(issuedAt)) return null;
  return { id: item.id, issuedAt, datum, revokeReason: item.revokeReason };
}

/** The newest `issued_at` first, then the lower identifier: the order of `listAttestations`. */
const newestFirst = (a: Item, b: Item): number => b.issuedAt - a.issuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The fact for the item that decides, at `nowMs`. Null when a member that the fact needs is missing or is not in its form. */
function factOf(item: Item, nowMs: number): ComplianceFact | null {
  const { validFrom, validUntil, status, contested } = item.datum;
  if (validFrom !== null && !isTime(validFrom)) return null;
  if (validUntil !== null && !isTime(validUntil)) return null;
  if (!isPlainObject(status)) return null;
  let revokedAt: number | null = null;
  if (status.type === 'AttRevoked') {
    if (!isTime(status.at)) return null;
    revokedAt = status.at;
  } else if (status.type !== 'AttActive') {
    return null;
  }
  // A revoked attestation has an exact reason, and an active one has none. The reason of the view is the only one that the reader takes.
  if (revokedAt === null ? item.revokeReason !== null : typeof item.revokeReason !== 'bigint') return null;
  let reply: string | null = null;
  if (contested !== null) {
    if (!isPlainObject(contested) || !isBytes32(contested.sha256)) return null;
    reply = contested.sha256;
  }
  const word = attestationState(asDatum(item.datum), nowMs);
  return {
    state: word === 'active' ? 'valid' : 'invalid',
    attestation: item.id,
    attestation_state: word,
    issued_at: isoOf(item.issuedAt),
    valid_until: validUntil === null ? null : isoOf(validUntil),
    revoked_at: revokedAt === null ? null : isoOf(revokedAt),
    revoke_reason: typeof item.revokeReason === 'bigint' ? item.revokeReason.toString() : null,
    contested: reply === null ? null : { sha256: reply },
  };
}

/**
 * The items of every page of the list, in the order of the pages. Null when a page is not an object with a list `items`, when a page names a next page that does not start after it, and when a page after the
 * `MAX_PAGES`th is still named. The query names the key hash of the registry and the type, and no subject: see rule 1. A failure of the list is thrown to the caller.
 */
async function pagesOf(list: ComplianceDeps['list'], issuerPkh: string): Promise<unknown[] | null> {
  const items: unknown[] = [];
  let offset: number | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const query: AttestationQuery = { issuer: { type: 'key_hash', hash: issuerPkh }, attType: COMPLIANCE_ATT_TYPE, limit: PAGE_LIMIT, ...(offset === undefined ? {} : { offset }) };
    const page: unknown = await list(query);
    if (!isPlainObject(page) || !Array.isArray(page.items)) return null;
    items.push(...page.items);
    const next = page.nextOffset;
    if (next === null || next === undefined) return items;
    if (!isWhole(next) || next <= (offset ?? 0)) return null;
    offset = next;
  }
  return null;
}

async function judge(deps: ComplianceDeps, did: Did, nowMs: number): Promise<ComplianceFact> {
  const issuerPkh = deps.issuerPkh;
  if (!parseDid(did).ok || !isKeyHash(issuerPkh) || !isWhole(nowMs)) return noAttestation('unreadable');
  const answer = await bounded(deps.clock, FACT_READ_TIMEOUT_MS, () => pagesOf((query) => deps.list(query), issuerPkh));
  const items = answer?.value ?? null;
  if (items === null) return noAttestation('unreadable');
  const looked: Item[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const item = look(raw);
    // An identifier that appears twice is a stale output and a new output of one token, or a row that two pages both hold. Their place in the page would decide, so the list is not read.
    if (item === null || seen.has(item.id)) return noAttestation('unreadable');
    seen.add(item.id);
    looked.push(item);
  }
  const subject = agentIdOf(did);
  const newest: Item | undefined = looked
    .filter(({ datum }) => datum.attType === COMPLIANCE_ATT_TYPE && datum.subject === subject && issuerMatches(asDatum(datum), { type: 'key_hash', hash: issuerPkh }))
    .sort(newestFirst)[0];
  if (newest === undefined) return noAttestation('absent');
  return factOf(newest, nowMs) ?? noAttestation('unreadable');
}

/**
 * The compliance attestation of the bidder `did` at `nowMs`: whether the newest attestation of type 0 that the registry made about the bidder holds, and what it says. It never throws and never rejects. A source
 * that cannot be read gives `unreadable`, and never `absent` or `valid`.
 */
export async function readCompliance(deps: ComplianceDeps, did: Did, nowMs: number): Promise<ComplianceFact> {
  try {
    return await judge(deps, did, nowMs);
  } catch {
    return noAttestation('unreadable');
  }
}
