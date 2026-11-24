// agents/sourcing-agent/src/bidders/discover.ts
// The discovery of the bidders, and the reading of the manifest and the price list of each one.
//
// Discovery. The indexer lists the adverts of the capability of the Bid Desk. A row counts when it has that capability, the model `bid-desk-v1`, the status Active and an agent id. A DID with exactly one such
// row goes on, and a DID with two rows is not a candidate: the reader never picks one of two. An advert that the indexer lists two times is one advert. The chain must show the advert of each DID: unspent,
// Active, with that capability, that model and that DID as its agent. The candidates are in the order of their advert references, as a plain string compare, and at most `MAX_CANDIDATES` stay.
//
// A listing that cannot be read is `bidders_unavailable`. So is a read of the chain that gave no usable answer for any advert, and so is an empty result when one read of the chain failed: a source that cannot
// be read never reads as "nobody quotes". `no_bidders` means that every read worked and that no DID passed.
//
// The price list. The manifest is read at the address of the advert and its bytes must have the hash of the advert BEFORE they are parsed. The manifest names the price list and its hash. The list is read at that
// address (an https address with no user and no password, else the state is `invalid` and nothing is fetched), its bytes must have the hash of the manifest BEFORE they are parsed, and then the kit must accept it.
// The state is `valid`, `invalid` (a hash that differs, a text that does not parse, a manifest without the list) or `unreadable` (a fetch that fails, answers with another status than 200 or times out).
//
// What a bidder says reaches the result only as a reference of an advert, a key hash that the chain shows, and the price list that the kit parsed. No text of an advert, of a manifest or of a price list goes
// anywhere else, and a detail never repeats a word of a bidder or an address. The folder reads no file and no environment variable, and it makes no network call by itself. Nothing is retried.
import { createHash } from 'node:crypto';
import { BID_CAPABILITIES, BID_DESK_MODEL, parsePriceList, priceListSha256 } from '@vsa/usecase-kit/bids';
import type { PriceList } from '@vsa/usecase-kit/bids';
import { MANIFEST_SCHEMA, parseFileRef } from '@vsa/usecase-kit/manifest';
import { accepted, didOfAgentId, isKeyHash, isPlainObject, parseDocument, parseJsonText, parseOutputRef, refused } from '@vsa/usecase-kit/protocol';
import type { Did, Digest, OutputRef, ProtocolResult } from '@vsa/usecase-kit/protocol';
import { BIDDER_FETCH_TIMEOUT_MS, BIDDER_FILE_MAX_BYTES, MAX_CANDIDATES } from './types.ts';
import type { BiddersDeps } from './types.ts';

// --- The time of the read ----------------------------------------------------------------------------------------------------------------------------

/** The time that the whole read has left, and the time that one call has. The clock is read before each call of a port. */
export interface Budget {
  /** The time of the clock in milliseconds, or null when it throws or gives a value that is not a finite number. */
  readonly now: () => number | null;
  /** The milliseconds that the whole read still has, or null when the clock gives no time. */
  readonly left: () => number | null;
  /** The most that one call of a port has. */
  readonly callMs: number;
}

/** The time that a clock gives, or null when it throws or gives a value that is not a finite number. */
export function timeOf(clock: () => number): number | null {
  try {
    const now: unknown = clock();
    return typeof now === 'number' && Number.isFinite(now) ? now : null;
  } catch {
    return null;
  }
}

/** Starts a budget at the time of the clock. A clock that gives no time gives null: an unknown time is never enough time, so the read does not start. */
export function startBudget(clock: () => number, budgetMs: number, callMs: number): Budget | null {
  const startedAt = timeOf(clock);
  if (startedAt === null) return null;
  return {
    now: () => timeOf(clock),
    left: () => {
      const now = timeOf(clock);
      // A clock that goes back never gives the read more than its budget.
      return now === null ? null : Math.min(budgetMs, budgetMs - (now - startedAt));
    },
    callMs,
  };
}

/** The result of one call of a port: the value, or no value for a port that threw, did not answer in time or had no time to start. */
export type Called<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const EXPIRED = Symbol('expired');

/**
 * One call of a port, inside the budget. A budget that is spent, a clock that gives no time, a port that throws and a port that does not answer within the time of one call are `{ ok: false }`. The words of
 * an error are never kept: they can come from a bidder. `call` gets the milliseconds that the call has.
 */
export async function viaPort<T>(budget: Budget, call: (limitMs: number) => Promise<T> | T): Promise<Called<T>> {
  const left = budget.left();
  if (left === null || left <= 0) return { ok: false };
  const limit = Math.min(budget.callMs, left);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The executor form: Promise.withResolvers is not in the types of the target of this package.
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), limit);
  });
  try {
    const outcome = await Promise.race([Promise.resolve().then(() => call(limit)), expired]);
    return outcome === EXPIRED ? { ok: false } : { ok: true, value: outcome };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// --- The discovery -----------------------------------------------------------------------------------------------------------------------------------

/** A bidder that the indexer lists and the chain shows. The address and the hash of the manifest are the words of its advert: they are read, and they never reach a file. */
export interface Candidate {
  readonly did: Did;
  readonly advert_ref: OutputRef;
  /** The key hash that the advert on the chain names as its supplier. */
  readonly supplier_pkh: string;
  readonly detail_uri: string;
  readonly detail_hash: string;
}

const AGENT_ID = /^[0-9a-f]{64}$/;

/** What one row of the indexer says, when the row is an Active advert of a Bid Desk: the agent id, and the reference or null for a reference that cannot be read. */
function rowOf(row: unknown): { readonly agent: string; readonly ref: string | null } | null {
  if (!isPlainObject(row)) return null;
  const { capability_id: capability, model, advert_status: status, agent_id: agent, utxo_ref: ref } = row;
  if (capability !== BID_CAPABILITIES.quote || model !== BID_DESK_MODEL || status !== 'Active') return null;
  if (typeof agent !== 'string' || !AGENT_ID.test(agent)) return null;
  const reference = typeof ref === 'string' ? parseOutputRef(ref.toLowerCase(), 'utxo_ref') : null;
  return { agent, ref: reference !== null && reference.ok ? reference.value : null };
}

type Judged =
  | { readonly kind: 'candidate'; readonly candidate: Candidate }
  | { readonly kind: 'not_listed' }
  | { readonly kind: 'no_advert' }
  | { readonly kind: 'unread' };

const UNREAD: Judged = { kind: 'unread' };
const NOT_LISTED: Judged = { kind: 'not_listed' };

/**
 * What the chain shows of one advert. `{ error }` says that the reference is no advert. A reading of the wrong shape is a source that cannot be read. An advert that is spent, not Active, of another capability, of
 * another model or of another agent than the one that the row names is not listed.
 */
function judgeAdvert(read: unknown, agent: string, ref: OutputRef): Judged {
  if (!isPlainObject(read)) return UNREAD;
  if (typeof read.error === 'string') return { kind: 'no_advert' };
  const { spent, agentId, advert } = read;
  if (typeof spent !== 'boolean' || !(agentId === null || typeof agentId === 'string') || !isPlainObject(advert)) return UNREAD;
  const { supplier_pkh: pkh, status, capability_id: capability, model, detail_uri: uri, detail_hash: hash } = advert;
  if (!isKeyHash(pkh) || typeof status !== 'string' || typeof capability !== 'string' || typeof model !== 'string' || typeof uri !== 'string' || typeof hash !== 'string') return UNREAD;
  if (spent || status !== 'Active' || capability !== BID_CAPABILITIES.quote || model !== BID_DESK_MODEL || agentId !== agent) return NOT_LISTED;
  return { kind: 'candidate', candidate: { did: didOfAgentId(agent), advert_ref: ref, supplier_pkh: pkh, detail_uri: uri, detail_hash: hash } };
}

/**
 * The bidders that the indexer lists and the chain shows, in the order of their advert references and at most `MAX_CANDIDATES`. The adverts are read one after the other, in that order, and the reader stops
 * when it has enough candidates. A DID whose advert cannot be read, or that the chain does not show, is no candidate and leaves no file.
 */
export async function discoverCandidates(
  deps: Pick<BiddersDeps, 'listAdverts' | 'readAdvert'>, budget: Budget,
): Promise<ProtocolResult<readonly Candidate[], 'bidders_unavailable' | 'no_bidders'>> {
  const listed = await viaPort(budget, () => deps.listAdverts(BID_CAPABILITIES.quote));
  if (!listed.ok) return refused('bidders_unavailable', 'the listing of the adverts could not be read');
  const rows: unknown = listed.value;
  if (!Array.isArray(rows)) return refused('bidders_unavailable', 'the listing of the adverts is not a list');

  // The adverts of each DID. A reference that cannot be read counts as a row of its own, so it can never hide a second row.
  const adverts = new Map<string, Set<string>>();
  for (const [index, row] of rows.entries()) {
    const found = rowOf(row);
    if (found === null) continue;
    const keys = adverts.get(found.agent) ?? new Set<string>();
    keys.add(found.ref ?? `?${index}`);
    adverts.set(found.agent, keys);
  }
  const singles: { agent: string; ref: string }[] = [];
  let unread = 0;
  for (const [agent, keys] of adverts) {
    if (keys.size !== 1) continue;
    const [key] = keys;
    if (key === undefined || key.startsWith('?')) unread += 1;
    else singles.push({ agent, ref: key });
  }
  // A plain string compare of the references: the index 10 comes before the index 2, as the text says.
  singles.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  const candidates: Candidate[] = [];
  let shown = 0;
  let examined = unread;
  for (const { agent, ref } of singles) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const read = await viaPort(budget, () => deps.readAdvert(ref));
    examined += 1;
    const judged = read.ok ? judgeAdvert(read.value, agent, ref) : UNREAD;
    if (judged.kind === 'candidate') candidates.push(judged.candidate);
    if (judged.kind === 'candidate' || judged.kind === 'not_listed') shown += 1;
    if (judged.kind === 'unread') unread += 1;
  }
  if (candidates.length > 0) return accepted(candidates);
  // No candidate. A chain that gave no usable answer, or a read that failed, is a source that cannot be read: it must not look like a marketplace with no bidder.
  if (examined > 0 && (shown === 0 || unread > 0)) return refused('bidders_unavailable', 'the chain gave no usable reading for the adverts of the bidders, so no bidder could be confirmed');
  return refused('no_bidders', 'no Bid Desk has an advert that the indexer lists and the chain shows');
}

// --- The manifest and the price list -----------------------------------------------------------------------------------------------------------------

/** The state of the price list of a bidder, and the list with the hash of its bytes when the state is `valid`. */
export type PriceListRead =
  | { readonly state: 'valid'; readonly list: PriceList; readonly sha256: Digest }
  | { readonly state: 'invalid' | 'unreadable' };

type Fetched = { readonly kind: 'bytes'; readonly bytes: Uint8Array } | { readonly kind: 'unreadable' } | { readonly kind: 'too_big' };

/**
 * The bytes of a file of a bidder. The port gets the address as it is written and the limits of this reader. A port that throws, does not answer in time, gives an answer of the wrong shape or an answer with
 * another status than 200 is a source that cannot be read. A body above the byte limit that the port returns is refused here, because the reader checks the size again.
 */
async function fetchFile(deps: Pick<BiddersDeps, 'fetchBytes'>, budget: Budget, url: string): Promise<Fetched> {
  const fetched = await viaPort(budget, (limit) => deps.fetchBytes(url, { maxBytes: BIDDER_FILE_MAX_BYTES, timeoutMs: Math.min(BIDDER_FETCH_TIMEOUT_MS, Math.ceil(limit)) }));
  if (!fetched.ok) return { kind: 'unreadable' };
  const answer: unknown = fetched.value;
  if (!isPlainObject(answer) || typeof answer.status !== 'number' || !(answer.bytes instanceof Uint8Array)) return { kind: 'unreadable' };
  if (answer.status !== 200) return { kind: 'unreadable' };
  if (answer.bytes.length > BIDDER_FILE_MAX_BYTES) return { kind: 'too_big' };
  return { kind: 'bytes', bytes: answer.bytes };
}

/** The text of bytes in UTF-8, or null for bytes that are not valid UTF-8. A byte order mark stays in the text, so that the text has the bytes of the file and a mark breaks the JSON. */
function textOf(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

type Text = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'invalid' | 'unreadable' };

/** The text of a file of a bidder: fetched, hashed against the hash that names it, then decoded. The hash comes first, so a body whose hash is wrong is never decoded and never parsed. */
async function textOfFile(deps: Pick<BiddersDeps, 'fetchBytes'>, budget: Budget, url: string, sha256: string): Promise<Text> {
  const file = await fetchFile(deps, budget, url);
  if (file.kind === 'unreadable') return { kind: 'unreadable' };
  if (file.kind === 'too_big' || createHash('sha256').update(file.bytes).digest('hex') !== sha256) return { kind: 'invalid' };
  const text = textOf(file.bytes);
  return text === null ? { kind: 'invalid' } : { kind: 'text', text };
}

/** The price list that a manifest names: fetched, hashed, then parsed. */
async function readList(deps: Pick<BiddersDeps, 'fetchBytes'>, budget: Budget, uri: string, sha256: string): Promise<PriceListRead> {
  const file = await textOfFile(deps, budget, uri, sha256);
  if (file.kind !== 'text') return { state: file.kind };
  const json = parseJsonText(file.text, 'price list');
  if (!json.ok) return { state: 'invalid' };
  const list = parsePriceList(json.value);
  if (!list.ok) return { state: 'invalid' };
  return { state: 'valid', list: list.value, sha256: priceListSha256(file.text) };
}

/**
 * The state of the price list of a candidate, and the list. Two files are read: the manifest at the address of the advert, and the price list at the address of the manifest. Each file has the hash that names
 * it before it is parsed. The manifest must have the schema of a manifest of the second form, the capability of the Bid Desk and a price list with an https address and a hash. It never throws.
 */
export async function readPriceList(deps: Pick<BiddersDeps, 'fetchBytes'>, budget: Budget, candidate: Candidate): Promise<PriceListRead> {
  const manifestRef = parseFileRef({ uri: candidate.detail_uri, sha256: candidate.detail_hash }, 'advert');
  if (!manifestRef.ok) return { state: 'invalid' };
  const file = await textOfFile(deps, budget, manifestRef.value.uri, manifestRef.value.sha256);
  if (file.kind !== 'text') return { state: file.kind };
  const json = parseJsonText(file.text, 'manifest');
  if (!json.ok) return { state: 'invalid' };
  const manifest = parseDocument(json.value, 'manifest');
  if (!manifest.ok) return { state: 'invalid' };
  if (manifest.value.schema !== MANIFEST_SCHEMA || manifest.value.capability_id !== BID_CAPABILITIES.quote) return { state: 'invalid' };
  const behaviour = manifest.value.behaviour;
  if (!isPlainObject(behaviour) || !Object.hasOwn(behaviour, 'price_list')) return { state: 'invalid' };
  const named = parseFileRef(behaviour.price_list, 'behaviour.price_list');
  if (!named.ok) return { state: 'invalid' };
  return readList(deps, budget, named.value.uri, named.value.sha256);
}
