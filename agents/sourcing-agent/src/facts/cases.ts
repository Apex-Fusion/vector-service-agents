// agents/sourcing-agent/src/facts/cases.ts
// The Module-1 cases against a bidder, as a fact for the file of a bidder. The count is the number of live challenges whose claim token is the token of a live claim in the state Challenged whose claimer is the bidder.
// This is the join that the dispute code of the kit uses to find its own challenge. A challenge output that names a claim in another state is no case, because anybody can make a challenge output. The join is by the
// claim token. It is not by the output of the claim: a challenge spends the claim output and the claim moves to a new output, so the output that a challenge names is not the live output of its claim.
// A challenge whose claim token no claim holds is not counted.
//
// A resolved case leaves no output, because each resolution burns the claim. So the claim of a resolved case is in no list, and only open challenges count. The effect of a verdict shows in the status of the
// bidder (a hold) and not here.
//
// A source that cannot be read (a port throws or ends too late, a port gives no list, or a claim or a challenge has no text where the join needs one) is `{ ok: false }`. So is a text that `parseDid` refuses: it is
// no DID, and nothing is read for it. It is never 0: a count that was not read says nothing about the bidder. `casesAgainstAll` reads each list one time for all the bidders. This file reads no network, no file and
// no environment variable: the sources are ports.
import type { ChallengeView, ClaimView } from '@vsa/usecase-kit/dispute';
import { parseDid } from '@vsa/usecase-kit/protocol';
import { callPort } from './bound.ts';
import type { FactClock } from './bound.ts';

export interface CasesDeps {
  /** Every live claim of Module-1. It throws when the chain cannot be read. The `readClaims` of the Module-1 port of the kit has this shape. */
  readonly claims: () => Promise<readonly ClaimView[]>;
  /** Every live challenge of Module-1. It throws when the chain cannot be read. The `readChallenges` of the Module-1 port of the kit has this shape. */
  readonly challenges: () => Promise<readonly ChallengeView[]>;
  readonly clock: FactClock;
}

/** The number of open cases against a bidder, or the fact that a source could not be read. */
export type CasesFact = { readonly ok: true; readonly cases: number } | { readonly ok: false };

/** The text member of a record, or null when the value is no record or the member is no text. It reads an own data member, so that an accessor is never called. */
function textOf(value: unknown, member: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const text: unknown = Object.getOwnPropertyDescriptor(value, member)?.value;
  return typeof text === 'string' ? text : null;
}

/** The state of a claim that a challenge started on. Only a claim in this state has a case. */
const CHALLENGED: ClaimView['state'] = 'Challenged';

/**
 * The number of challenges against the claims of each wanted claimer, or null when a list is of a wrong shape. A claim or a challenge that has no text where the join needs one cannot be placed, so the
 * lists are not read: that is not a count of 0.
 */
function countAgainst(claims: unknown, challenges: unknown, wanted: ReadonlySet<string>): Map<string, number> | null {
  if (!Array.isArray(claims) || !Array.isArray(challenges)) return null;
  const claimersOf = new Map<string, Set<string>>();
  for (const claim of claims as readonly unknown[]) {
    const token = textOf(claim, 'token');
    const claimer = textOf(claim, 'claimer');
    const state = textOf(claim, 'state');
    if (token === null || claimer === null || state === null) return null;
    if (state !== CHALLENGED || !wanted.has(claimer)) continue;
    const known = claimersOf.get(token);
    if (known === undefined) claimersOf.set(token, new Set([claimer]));
    else known.add(claimer);
  }
  const counts = new Map<string, number>();
  for (const challenge of challenges as readonly unknown[]) {
    const token = textOf(challenge, 'claim_token');
    if (token === null) return null;
    for (const claimer of claimersOf.get(token) ?? []) counts.set(claimer, (counts.get(claimer) ?? 0) + 1);
  }
  return counts;
}

/** The number of cases of each wanted DID from one read of each list, or null when a list cannot be read or is of a wrong shape. */
async function readCounts(deps: CasesDeps, wanted: ReadonlySet<string>): Promise<Map<string, number> | null> {
  const [claims, challenges] = await Promise.all([callPort(deps.clock, () => deps.claims()), callPort(deps.clock, () => deps.challenges())]);
  return claims.ok && challenges.ok ? countAgainst(claims.value, challenges.value, wanted) : null;
}

/**
 * The cases against each of the DIDs, with one read of the claims and one read of the challenges. The answer has one entry for each text, in the order given. A text that `parseDid` refuses is no DID, so its entry
 * is `{ ok: false }` and no list is read for it. When a list cannot be read, every entry is `{ ok: false }`. With no DID, no list is read. It never throws.
 */
export async function casesAgainstAll(deps: CasesDeps, dids: readonly string[]): Promise<ReadonlyMap<string, CasesFact>> {
  const given = new Set<string>(dids);
  const wanted = new Set([...given].filter((did) => parseDid(did).ok));
  const counts = wanted.size === 0 ? null : await readCounts(deps, wanted);
  const answer = new Map<string, CasesFact>();
  for (const did of given) answer.set(did, counts === null || !wanted.has(did) ? { ok: false } : { ok: true, cases: counts.get(did) ?? 0 });
  return answer;
}

/** The cases against one bidder. It is the answer of `casesAgainstAll` for that DID, so the two give the same numbers. */
export async function casesAgainst(deps: CasesDeps, did: string): Promise<CasesFact> {
  return (await casesAgainstAll(deps, [did])).get(did) ?? { ok: false };
}
