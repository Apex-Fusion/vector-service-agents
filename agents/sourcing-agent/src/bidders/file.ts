// agents/sourcing-agent/src/bidders/file.ts
// `readBidders` lists the Bid Desks that quote on the marketplace, reads for each one its facts through ports, and gives the FILE that the model reads and the price list that the quote check needs.
//
//   1. The candidates come from `discoverCandidates`: the adverts that the indexer lists and the chain shows. A listing that cannot be read is `bidders_unavailable`, and no candidate is `no_bidders`.
//   2. The catalog of the gateway is read one time. A catalog that cannot be read is `null`, and `in_catalog` of each file is then `null`.
//   3. Each candidate is read, at most `MAX_PARALLEL_READS` at one time: its price list, its DID resolution, its stake, its cases, its compliance attestation and its credential, one after the other.
//
// A fact is data for the model and never a filter in code: a bidder with a bad fact still has its file. The only bidders that leave no file are the ones that discovery drops. A source that cannot be read gives
// the state `unreadable` or the value `null` in its own member and never ends the read: a port that throws, does not answer within `FACT_READ_TIMEOUT_MS`, or has no time left in `BIDDER_READ_BUDGET_MS`.
// An unreadable source is never `absent`, never `valid` and never a number: a stake that cannot be read is `null` and never "0", and a catalog that cannot be read is `null` and never "not in the catalog".
// A port that answers with a value of another shape than its contract is a fault of the wiring, and the read throws a `TypeError` before it returns any file.
//
// No free text of a bidder reaches a member of a file. The members are words of a closed list, numbers, booleans, hashes, a domain, DIDs and times. `issued_at` and `valid_until` of the compliance fact are shown
// to the model and never used for a rule. The folder reads no environment variable, no file and no key, and it makes no network call by itself. Nothing is retried.
import { accepted, agentIdOf, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { Did, ProtocolResult } from '@vsa/usecase-kit/protocol';
import { discoverCandidates, readPriceList, startBudget, viaPort } from './discover.ts';
import type { Budget, Candidate } from './discover.ts';
import { factsOfResolution, timeOfIso, unreadableRecord } from './lineage.ts';
import type { RecordFacts } from './lineage.ts';
import { BIDDER_READ_BUDGET_MS, FACT_READ_TIMEOUT_MS, MAX_PARALLEL_READS } from './types.ts';
import type { BidderFile, BidderView, BiddersDeps, BiddersOptions, ComplianceFact, FactState } from './types.ts';

/** The result of a read: the bidders in the order of their advert references, or the reason that none came out. */
export type BiddersResult = ProtocolResult<{ readonly bidders: readonly BidderView[] }, 'bidders_unavailable' | 'no_bidders'>;

const PORTS = ['listAdverts', 'readAdvert', 'fetchBytes', 'resolve', 'catalog', 'stake', 'cases', 'compliance', 'credential', 'clock'] as const;
const FACT_STATES: readonly string[] = ['valid', 'invalid', 'absent', 'unreadable'];
const ATTESTATION_STATES: readonly string[] = ['active', 'revoked', 'expired', 'not_yet_valid'];
const COMPLIANCE_MEMBERS: readonly string[] = ['state', 'attestation', 'attestation_state', 'issued_at', 'valid_until', 'revoked_at', 'revoke_reason', 'contested'];
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]{1,40}$/;

const wrong = (port: string): TypeError => new TypeError(`the port ${port} gave a value of the wrong shape`);
const isFactState = (value: unknown): value is FactState => typeof value === 'string' && FACT_STATES.includes(value);

/** A port that is not a function is a fault of the wiring. It is found before any port is called. */
function checkDeps(deps: unknown): void {
  if (typeof deps !== 'object' || deps === null) throw new TypeError('the dependencies of the bidder reader are not an object');
  for (const name of PORTS) if (typeof (deps as Record<string, unknown>)[name] !== 'function') throw new TypeError(`the port ${name} of the bidder reader is not a function`);
}

/** A bound that a caller makes shorter. A value above the ceiling gives the ceiling, and a value that is not a number above 0 is a fault of the caller. */
function boundOf(value: unknown, name: string, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`the option ${name} of the bidder reader must be a number above 0`);
  return Math.min(value, ceiling);
}

// --- The facts of one bidder -------------------------------------------------------------------------------------------------------------------------

/** The DID resolution of a bidder, as the members of the file. A call that failed gives the status `unreadable`. */
async function recordOf(deps: BiddersDeps, budget: Budget, did: Did): Promise<RecordFacts> {
  const read = await viaPort(budget, () => deps.resolve(did));
  return read.ok ? factsOfResolution(read.value, did, budget.now()) : unreadableRecord();
}

/** The stake as decimal text, or null for a stake that could not be read: never 0. */
async function stakeOf(deps: BiddersDeps, budget: Budget, agentId: string): Promise<string | null> {
  const read = await viaPort(budget, () => deps.stake(agentId));
  if (!read.ok) return null;
  const answer: unknown = read.value;
  if (!isPlainObject(answer)) throw wrong('stake');
  if (answer.ok === false) return null;
  if (answer.ok !== true || typeof answer.stake_lovelace !== 'bigint' || answer.stake_lovelace < 0n) throw wrong('stake');
  return answer.stake_lovelace.toString();
}

/** The number of cases against a bidder, or null for cases that could not be read: never 0. */
async function casesOf(deps: BiddersDeps, budget: Budget, did: Did): Promise<number | null> {
  const read = await viaPort(budget, () => deps.cases(did));
  if (!read.ok) return null;
  const answer: unknown = read.value;
  if (!isPlainObject(answer)) throw wrong('cases');
  if (answer.ok === false) return null;
  if (answer.ok !== true || typeof answer.cases !== 'number' || !Number.isSafeInteger(answer.cases) || answer.cases < 0) throw wrong('cases');
  return answer.cases;
}

/** The state of the credential. A credential that could not be read is `unreadable`: never `absent`. */
async function credentialOf(deps: BiddersDeps, budget: Budget, did: Did): Promise<FactState> {
  const read = await viaPort(budget, () => deps.credential(did));
  if (!read.ok) return 'unreadable';
  const state: unknown = read.value;
  if (!isFactState(state)) throw wrong('credential');
  return state;
}

/** A compliance fact of an attestation that could not be read: only the state `unreadable`. A new object each time. */
const unreadableCompliance = (): ComplianceFact => ({ state: 'unreadable', attestation: null, attestation_state: null, issued_at: null, valid_until: null, revoked_at: null, revoke_reason: null, contested: null });

/**
 * A compliance fact that the port gave, as a new object. It has exactly the members of `ComplianceFact`: no member is missing and none is added, so a text that the port should not give (such as the address of
 * the reply of a bidder) is a fault of the wiring and never reaches a file. Each member has its form: a state of the closed lists, an id or a hash of 64 lower-case hex characters, a time, or a decimal text.
 */
function checkCompliance(value: unknown): ComplianceFact {
  if (!isPlainObject(value)) throw wrong('compliance');
  const names = Object.keys(value);
  if (names.length !== COMPLIANCE_MEMBERS.length || !COMPLIANCE_MEMBERS.every((name) => names.includes(name))) throw wrong('compliance');
  const { state, attestation, attestation_state: attestationState, issued_at: issuedAt, valid_until: validUntil, revoked_at: revokedAt, revoke_reason: revokeReason, contested } = value;
  const isTime = (item: unknown): item is string | null => item === null || timeOfIso(item) !== null;
  if (!isFactState(state)) throw wrong('compliance');
  if (!(attestation === null || (typeof attestation === 'string' && HEX64.test(attestation)))) throw wrong('compliance');
  if (!(attestationState === null || (typeof attestationState === 'string' && ATTESTATION_STATES.includes(attestationState)))) throw wrong('compliance');
  if (!isTime(issuedAt) || !isTime(validUntil) || !isTime(revokedAt)) throw wrong('compliance');
  if (!(revokeReason === null || (typeof revokeReason === 'string' && DECIMAL.test(revokeReason)))) throw wrong('compliance');
  let anchor: { sha256: string } | null = null;
  if (contested !== null) {
    if (!isPlainObject(contested) || Object.keys(contested).length !== 1 || typeof contested.sha256 !== 'string' || !HEX64.test(contested.sha256)) throw wrong('compliance');
    anchor = { sha256: contested.sha256 };
  }
  return {
    state,
    attestation,
    attestation_state: attestationState as ComplianceFact['attestation_state'],
    issued_at: issuedAt,
    valid_until: validUntil,
    revoked_at: revokedAt,
    revoke_reason: revokeReason,
    contested: anchor,
  };
}

/** The compliance attestation of a bidder. A call that failed, or a clock with no time, gives the state `unreadable`: never `absent`. */
async function complianceOf(deps: BiddersDeps, budget: Budget, did: Did): Promise<ComplianceFact> {
  const now = budget.now();
  if (now === null) return unreadableCompliance();
  const read = await viaPort(budget, () => deps.compliance(did, now));
  return read.ok ? checkCompliance(read.value) : unreadableCompliance();
}

/** The file and the view of one candidate. The sources are read one after the other, and each one that fails leaves only its own members unread. */
async function readBidder(deps: BiddersDeps, budget: Budget, catalog: ReadonlySet<Did> | null, candidate: Candidate): Promise<BidderView> {
  const { did } = candidate;
  const price = await readPriceList(deps, budget, candidate);
  const record = await recordOf(deps, budget, did);
  const stake = await stakeOf(deps, budget, agentIdOf(did));
  const cases = await casesOf(deps, budget, did);
  const compliance = await complianceOf(deps, budget, did);
  const credential = await credentialOf(deps, budget, did);
  const file: BidderFile = {
    did,
    advert_ref: candidate.advert_ref,
    status: record.status,
    status_reason: record.status_reason,
    lineage: record.lineage,
    accountable: record.accountable,
    organisation: record.organisation,
    organisation_verified: record.organisation_verified,
    in_catalog: catalog === null ? null : catalog.has(did),
    stake_lovelace: stake,
    cases_against: cases,
    price_list: price.state,
    compliance,
    credential,
  };
  return { file, supplier_pkh: candidate.supplier_pkh, price_list: price.state === 'valid' ? { list: price.list, sha256: price.sha256 } : null };
}

// --- The read ----------------------------------------------------------------------------------------------------------------------------------------

/** The DIDs of the catalog, or null for a catalog that could not be read. A value that is neither a set nor null is a fault of the wiring. */
async function readCatalog(deps: BiddersDeps, budget: Budget): Promise<ReadonlySet<Did> | null> {
  const read = await viaPort(budget, () => deps.catalog());
  if (!read.ok) return null;
  const catalog: unknown = read.value;
  if (catalog === null) return null;
  if (!(catalog instanceof Set)) throw wrong('catalog');
  return catalog as ReadonlySet<Did>;
}

/** Runs `work` for each item, at most `size` at one time, and gives the results in the order of the items. The first fault rejects the whole run, and no new item starts after it. */
async function inPool<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let faulted = false;
  const worker = async (): Promise<void> => {
    while (!faulted && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index] as T);
      } catch (error) {
        faulted = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/**
 * Reads the bidders: the Bid Desks that the indexer lists and the chain shows, each with its file and its price list (see the head of this file). `options` can only make the bounds shorter. The result is
 * `bidders_unavailable` for a listing that cannot be read, a chain that gave no usable answer, or a clock that gives no time, and `no_bidders` when every read worked and no Bid Desk passes. It throws a
 * `TypeError` for a port that is not a function, for an option that is not a number above 0, and for a port that answered with a value of the wrong shape.
 */
export async function readBidders(deps: BiddersDeps, options: BiddersOptions = {}): Promise<BiddersResult> {
  checkDeps(deps);
  if (typeof options !== 'object' || options === null) throw new TypeError('the options of the bidder reader are not an object');
  const budgetMs = boundOf(options.budgetMs, 'budgetMs', BIDDER_READ_BUDGET_MS);
  const callMs = boundOf(options.callMs, 'callMs', FACT_READ_TIMEOUT_MS);
  const budget = startBudget(deps.clock, budgetMs, callMs);
  if (budget === null) return refused('bidders_unavailable', 'the clock gives no time, so the read of the bidders does not start');
  const found = await discoverCandidates(deps, budget);
  if (!found.ok) return found;
  const catalog = await readCatalog(deps, budget);
  const bidders = await inPool(found.value, MAX_PARALLEL_READS, (candidate) => readBidder(deps, budget, catalog, candidate));
  return accepted({ bidders });
}
