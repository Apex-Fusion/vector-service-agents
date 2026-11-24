// agents/prior-authorization-agent/src/insurer/insurer.ts
// The reader of the insurer. `readInsurer` takes the DID of an Insurer Intake Agent and gives the one advert of that agent. The job `propose` calls it BEFORE it sends anything. The request names the advert that
// the reader gives, and the job `execute` pays that advert and no other. The reader hires nothing and writes nothing. It reads two sources, in this order, and each step has its own failure code:
//
//   1. The indexer lists the adverts of the capability of the Insurer Intake Agent. The insurer must have exactly one Active advert in that list.                 `insurer_not_listed`
//      An insurer on hold is not in the list, so this code is also the answer for a hold. Two Active adverts are never read as one: the reader does not pick one of two.
//   2. The chain shows that advert: unspent, Active, with the capability and the model of the Insurer Intake Agent, and the insurer as its agent.                `insurer_not_listed`
//   3. A source that cannot be read is `insurer_unavailable`. The indexer, the chain and the clock are sources. A source that cannot be read is never a pass, and it is never `insurer_not_listed`.
//      A chain that answers `{ error }` for the advert that the indexer lists disagrees with the indexer as a whole. Its read is not usable: for example, it has no advert address of the deployment.
//
// The reader reads no manifest. What it takes as true is the listing of the indexer together with the state of the chain. The indexer lists an advert of the identity layout only when the advert passes the
// listing rule. The chain shows what the author of an advert wrote, the agent among it, and the advert validator does not check who the author is. So the state of the chain alone does not prove who made an
// advert. The hire reads the advert on the chain again, and checks its agent and its capability, before it pays.
//
// What the insurer says reaches the result only as the reference of the advert, which the indexer lists and the chain shows as an unspent, Active advert of this insurer. No other text of an advert goes
// anywhere. A detail names the source and the rule that failed. It never repeats an address, a reference, an agent id or a word of an answer or of an error.
//
// The ports are functions. The folder reads no file, no environment variable and no key, and it makes no network call by itself. The whole reading has a budget of time. The clock is read before each call of
// a port, and a clock that gives no time is `insurer_unavailable`, because an unknown time is never enough time.
import { rowAgentId } from '@vsa/buyer-core';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import { accepted, agentIdOf, isPlainObject, parseDid, parseOutputRef, refused } from '@vsa/usecase-kit/protocol';
import type { Did, OutputRef, ProtocolResult, Refused } from '@vsa/usecase-kit/protocol';

/** The codes of a failed reading: the insurer is not listed, or a source of the reading cannot be read. */
export const INSURER_FAILURES = ['insurer_not_listed', 'insurer_unavailable'] as const;
export type InsurerFailureCode = (typeof INSURER_FAILURES)[number];

/** The time that the whole reading has, from its start, in milliseconds: two reads, each with a limit of ten seconds in the real ports. */
export const INSURER_READ_BUDGET_MS = 20_000;

/**
 * The members of a row of the indexer that the reader uses. `fetchSuppliers` of buyer-core gives rows with more members, and each of them fits. The reader checks each member that it uses. It takes the listing
 * of the indexer, which applies the listing rule to an advert of the identity layout, together with the state of the chain. The chain shows the `agentId` that the author of the datum wrote, and the advert
 * validator does not check who the author is. The hire reads the advert on the chain again before it pays.
 */
export interface SupplierRow {
  /** The reference of the advert, as `<transaction hash>#<index>`. */
  readonly utxo_ref: string;
  readonly capability_id: string;
  /** `Active` or `Retired`. */
  readonly advert_status: string;
  /** The id of the agent that the advert names: 64 lower-case hex characters, or null for an advert of the legacy layout. */
  readonly agent_id?: string | null;
}

/**
 * What the chain shows of one advert, in the members that the reader uses. `readAdvert` of buyer-core gives this and more: either `{ error }` for a reference that is not an advert (and for every advert of the
 * identity layout, when `readAdvert` has no identity advert address), or the advert with its agent. `spent` is true for an advert that was spent, and a retired advert has the status `Retired`.
 */
export type AdvertRead =
  | { readonly error: string }
  | {
      readonly spent: boolean;
      readonly agentId: string | null;
      readonly advert: {
        readonly status: string;
        readonly capability_id: string;
        readonly model: string;
      };
    };

/** What the reader needs, as functions. A function that throws, or that gives a wrong shape, is `insurer_unavailable`. */
export interface InsurerDeps {
  /** The adverts that the indexer lists for a capability: `fetchSuppliers` of buyer-core with `capability_id`. The reader gives the capability and nothing else. */
  readonly listAdverts: (capabilityId: string) => Promise<readonly SupplierRow[]>;
  /**
   * One advert, read on the chain: `readAdvert` of buyer-core, bound to the fetch, to the Koios address and to the identity advert address of the deployment, as
   * `(ref) => readAdvert(ref, fetchImpl, koiosUrl, deployment.advert.address)`. The reader gives the reference and nothing else. Without that address, buyer-core answers `{ error }` for every advert of the
   * identity layout, and the advert of an Insurer Intake Agent has that layout. The reader gives `insurer_unavailable`, and not `insurer_not_listed`, for that answer: a port with no address must not look like
   * an insurer that the indexer does not list.
   */
  readonly readAdvert: (ref: OutputRef) => Promise<AdvertRead>;
  /** The time, in milliseconds. */
  readonly clock: () => number;
}

/** What the agent learns of the insurer: the advert that its request names and that the job `execute` pays. */
export interface InsurerView {
  readonly advert_ref: OutputRef;
}

// --- The time of the reading -----------------------------------------------------------------------------------------------------------------------

interface Budget {
  /** The milliseconds that the budget still has, or null when the clock gives no time. */
  readonly left: () => number | null;
}

/** The time that the clock gives, or null when it throws or gives a value that is not a finite number. */
function timeOf(deps: InsurerDeps): number | null {
  try {
    const now: unknown = deps.clock();
    return typeof now === 'number' && Number.isFinite(now) ? now : null;
  } catch {
    return null;
  }
}

/**
 * One call of a port, inside the budget. A budget that is spent, a clock that gives no time, and a port that throws are `insurer_unavailable`. The detail names the source and never repeats the error of the
 * port: the words of an error can come from the insurer.
 */
async function viaPort<T>(budget: Budget, source: string, call: () => Promise<T>): Promise<ProtocolResult<T, 'insurer_unavailable'>> {
  const left = budget.left();
  if (left === null) return refused('insurer_unavailable', `the clock gives no time, so the reading of ${source} does not start`);
  if (left <= 0) return refused('insurer_unavailable', `the time for the reading of the insurer is spent before the reading of ${source}`);
  try {
    return accepted(await call());
  } catch {
    return refused('insurer_unavailable', `${source} could not be read`);
  }
}

// --- Step 1: the indexer ---------------------------------------------------------------------------------------------------------------------------

/**
 * The reference of the one Active advert that the indexer lists for the insurer. A row of another agent, a row of another capability and a row that is not Active are not counted. No advert and two adverts are
 * `insurer_not_listed`: the reader never picks one of two. An advert that the indexer lists two times is one advert. An Active row of this insurer with a reference that cannot be read is a row that the
 * indexer gave wrongly, so it is `insurer_unavailable`.
 */
function refOf(rows: readonly unknown[], agent: string): ProtocolResult<OutputRef, InsurerFailureCode> {
  const found = new Set<OutputRef>();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const { capability_id: capability, advert_status: status, utxo_ref: ref } = row;
    // `rowAgentId` takes the id only when it has the shape of one: 64 lower-case hex characters.
    if (rowAgentId({ agent_id: typeof row.agent_id === 'string' ? row.agent_id : null }) !== agent) continue;
    if (capability !== PRIORAUTH_CAPABILITIES.intake || status !== 'Active') continue;
    const reference = typeof ref === 'string' ? parseOutputRef(ref.toLowerCase(), 'utxo_ref') : null;
    if (reference === null || !reference.ok) return refused('insurer_unavailable', 'the indexer lists an Active advert of this insurer with a reference that cannot be read');
    found.add(reference.value);
  }
  if (found.size === 0) return refused('insurer_not_listed', 'the indexer lists no Active advert of this insurer');
  if (found.size > 1) return refused('insurer_not_listed', 'the indexer lists more than one Active advert of this insurer');
  return accepted([...found][0]!);
}

// --- Step 2: the chain -----------------------------------------------------------------------------------------------------------------------------

/**
 * The reason to refuse the advert that the chain shows, or null when the chain shows it as an unspent, Active advert of this insurer with the capability and the model of the Insurer Intake Agent. A spent or
 * retired advert, and an advert that names another capability, another model or another agent, are `insurer_not_listed`. The answer `{ error }` and a reading of the wrong shape are `insurer_unavailable`.
 * The agent is the `agentId` that the author of the datum wrote: the reader takes it together with the listing of the indexer, and it does not say more than that.
 */
function problemWith(read: unknown, agent: string): Refused<InsurerFailureCode> | null {
  const wrong = refused('insurer_unavailable', 'the chain gave a reading of the wrong shape for the advert');
  if (!isPlainObject(read)) return wrong;
  if (typeof read.error === 'string') return refused('insurer_unavailable', 'the chain shows no advert at the reference that the indexer lists, so the chain read is not usable');
  const { spent, agentId, advert } = read;
  if (typeof spent !== 'boolean' || !(agentId === null || typeof agentId === 'string') || !isPlainObject(advert)) return wrong;
  const { status, capability_id: capability, model } = advert;
  if (typeof status !== 'string' || typeof capability !== 'string' || typeof model !== 'string') return wrong;
  if (spent) return refused('insurer_not_listed', 'the advert is spent on the chain');
  if (status !== 'Active') return refused('insurer_not_listed', 'the advert is not Active on the chain');
  if (capability !== PRIORAUTH_CAPABILITIES.intake) return refused('insurer_not_listed', 'the advert has another capability on the chain than the Insurer Intake Agent');
  if (model !== PRIORAUTH_MODELS.intake) return refused('insurer_not_listed', 'the advert names another model on the chain than the Insurer Intake Agent');
  if (agentId !== agent) return refused('insurer_not_listed', 'the advert names another agent on the chain than the insurer');
  return null;
}

// --- The reading -----------------------------------------------------------------------------------------------------------------------------------

/**
 * Reads the insurer `insurer` (see the head of this file). It always gives a typed result and never throws: a source that cannot be read is `insurer_unavailable`, and a value that is not what a step needs is
 * the code of that step. An insurer that is not a DID is `insurer_not_listed`: no advert names it.
 */
export async function readInsurer(deps: InsurerDeps, insurer: Did): Promise<ProtocolResult<InsurerView, InsurerFailureCode>> {
  const did = parseDid(insurer, 'insurer');
  if (!did.ok) return refused('insurer_not_listed', 'the insurer is not a DID, so no advert names it');
  const agent = agentIdOf(did.value);

  const startedAt = timeOf(deps);
  if (startedAt === null) return refused('insurer_unavailable', 'the clock gives no time, so the reading of the insurer does not start');
  const budget: Budget = {
    left: () => {
      const now = timeOf(deps);
      return now === null ? null : INSURER_READ_BUDGET_MS - (now - startedAt);
    },
  };

  // Step 1: the indexer.
  const listed = await viaPort(budget, 'the indexer', () => deps.listAdverts(PRIORAUTH_CAPABILITIES.intake));
  if (!listed.ok) return listed;
  const rows: unknown = listed.value;
  if (!Array.isArray(rows)) return refused('insurer_unavailable', 'the indexer gave a list of the wrong shape');
  const ref = refOf(rows, agent);
  if (!ref.ok) return ref;

  // Step 2: the chain. The reference goes to the port alone: the port of the service adds the advert address of the deployment.
  const reading = await viaPort(budget, 'the advert on the chain', () => deps.readAdvert(ref.value));
  if (!reading.ok) return reading;
  const problem = problemWith(reading.value, agent);
  if (problem !== null) return problem;

  return accepted({ advert_ref: ref.value });
}
