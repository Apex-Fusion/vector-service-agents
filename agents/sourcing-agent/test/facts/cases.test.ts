// agents/sourcing-agent/test/facts/cases.test.ts: the Module-1 cases against a bidder, as a fact for the file of a bidder. A case is a live challenge whose claim token is the token of a live claim of the bidder.
// A resolved case leaves no output, because each resolution burns the claim, so only open challenges count. The question: is a source that cannot be read ever a count? Does a challenge count against the
// wrong claimer, or by the wrong key? Each refusal has its accepted twin.
import { describe, expect, it } from 'vitest';
import type { ChallengeView, ClaimView } from '@vsa/usecase-kit/dispute';
import { FACT_READ_TIMEOUT_MS, casesAgainst, casesAgainstAll } from '../../src/facts/index.ts';
import type { CasesDeps, CasesFact } from '../../src/facts/index.ts';
import { BIDDER, ManualClock, OTHER, challengeView, claimView, never, settle } from './support.ts';

const THIRD = `did:vector:${'d4'.repeat(32)}`;

interface Setup {
  readonly deps: CasesDeps;
  readonly clock: ManualClock;
  /** How often each port was called. */
  readonly reads: { claims: number; challenges: number };
}

/** The ports of a test: each counts its calls and answers with its function. */
function setup(claims: () => Promise<unknown>, challenges: () => Promise<unknown>): Setup {
  const reads = { claims: 0, challenges: 0 };
  const clock = new ManualClock();
  const deps: CasesDeps = {
    claims: () => { reads.claims += 1; return claims() as Promise<readonly ClaimView[]>; },
    challenges: () => { reads.challenges += 1; return challenges() as Promise<readonly ChallengeView[]>; },
    clock,
  };
  return { deps, clock, reads };
}

/** Ports that list these claims and these challenges. */
const lists = (claims: readonly unknown[], challenges: readonly unknown[]): Setup => setup(() => Promise.resolve(claims), () => Promise.resolve(challenges));

const cases = (count: number): CasesFact => ({ ok: true, cases: count });
const UNREAD: CasesFact = { ok: false };

describe('the cases against a bidder', () => {
  it('is 1 for one challenge against one claim of the bidder', async () => {
    const mine = claimView(1);
    expect(await casesAgainst(lists([mine], [challengeView(1, mine)]).deps, BIDDER)).toStrictEqual(cases(1));
  });

  it('is 0 when no challenge stands, with a claim of the bidder or with no claim at all', async () => {
    expect(await casesAgainst(lists([claimView(1)], []).deps, BIDDER)).toStrictEqual(cases(0));
    expect(await casesAgainst(lists([], []).deps, BIDDER)).toStrictEqual(cases(0));
  });

  it('is 0 for a challenge against a claim of another claimer, and the case is the case of that claimer', async () => {
    const theirs = claimView(2, OTHER);
    const world = lists([claimView(1), theirs], [challengeView(2, theirs)]);
    expect(await casesAgainst(world.deps, BIDDER)).toStrictEqual(cases(0));
    expect(await casesAgainst(world.deps, OTHER)).toStrictEqual(cases(1));
    // The twin: the same challenge against a claim of the bidder is a case of the bidder.
    const mine = claimView(2, BIDDER);
    expect(await casesAgainst(lists([mine], [challengeView(2, mine)]).deps, BIDDER)).toStrictEqual(cases(1));
  });

  it('is 2 for two challenges against two claims of the bidder', async () => {
    const first = claimView(1);
    const second = claimView(2);
    expect(await casesAgainst(lists([first, second], [challengeView(1, first), challengeView(2, second)]).deps, BIDDER)).toStrictEqual(cases(2));
  });

  it('counts the challenged claim of a bidder that has two claims, and not the claim that nobody challenged', async () => {
    const first = claimView(1, BIDDER, { state: 'Open' });
    const second = claimView(2);
    expect(await casesAgainst(lists([first, second], [challengeView(2, second)]).deps, BIDDER)).toStrictEqual(cases(1));
  });

  it('is 0 for a challenge whose claim token no claim holds, and 1 when the claim is in the list', async () => {
    const mine = claimView(1);
    const challenge = challengeView(1, mine);
    expect(await casesAgainst(lists([claimView(2)], [challenge]).deps, BIDDER)).toStrictEqual(cases(0));
    expect(await casesAgainst(lists([], [challenge]).deps, BIDDER)).toStrictEqual(cases(0));
    expect(await casesAgainst(lists([claimView(2), mine], [challenge]).deps, BIDDER)).toStrictEqual(cases(1));
  });

  it('joins by the claim token and not by the output of the claim: the output that a challenge spent is not the live output of its claim', async () => {
    const mine = claimView(1);
    const challenge = challengeView(1, mine);
    expect(challenge.claim).not.toBe(mine.ref);
    expect(await casesAgainst(lists([mine], [challenge]).deps, BIDDER)).toStrictEqual(cases(1));
    // The twin: a challenge that names the live output of the claim, with the token of another claim, is not a case against that claim.
    const stranger = claimView(2, OTHER);
    const wrong = challengeView(1, stranger, { claim: mine.ref });
    expect(await casesAgainst(lists([mine, stranger], [wrong]).deps, BIDDER)).toStrictEqual(cases(0));
    expect(await casesAgainst(lists([mine, stranger], [wrong]).deps, OTHER)).toStrictEqual(cases(1));
  });

  it('asks each port one time, and gives each call the time of the fact reads', async () => {
    const mine = claimView(1);
    const world = lists([mine], [challengeView(1, mine)]);
    await casesAgainst(world.deps, BIDDER);
    expect(world.reads).toStrictEqual({ claims: 1, challenges: 1 });
    expect(FACT_READ_TIMEOUT_MS).toBe(20_000);
    expect(world.clock.asked).toStrictEqual([FACT_READ_TIMEOUT_MS, FACT_READ_TIMEOUT_MS]);
    expect(world.clock.open).toBe(0);
  });
});

describe('a source that cannot be read is no count', () => {
  const mine = claimView(1);
  const healthy = (): Promise<unknown>[] => [Promise.resolve([mine]), Promise.resolve([challengeView(1, mine)])];
  const UNREADABLE: Array<[what: string, claims: () => Promise<unknown>, challenges: () => Promise<unknown>]> = [
    ['a claims port that throws', () => Promise.reject(new Error('the node is down: secret words of the source')), () => healthy()[1]!],
    ['a challenges port that throws', () => healthy()[0]!, () => Promise.reject(new Error('the node is down: secret words of the source'))],
    ['two ports that throw', () => Promise.reject(new Error('down')), () => Promise.reject(new Error('down'))],
    ['a claims port that throws a text', () => Promise.reject('secret words of the source'), () => healthy()[1]!],
    ['a claims port that gives a text', () => Promise.resolve('[]'), () => healthy()[1]!],
    ['a challenges port that gives a text', () => healthy()[0]!, () => Promise.resolve('[]')],
    ['a claims port that gives an object', () => Promise.resolve({ claims: [mine] }), () => healthy()[1]!],
    ['a challenges port that gives null', () => healthy()[0]!, () => Promise.resolve(null)],
    ['a claims port that gives nothing', () => Promise.resolve(undefined), () => healthy()[1]!],
    ['a claim that is null', () => Promise.resolve([mine, null]), () => healthy()[1]!],
    ['a claim with no token', () => Promise.resolve([mine, { ...claimView(2), token: undefined }]), () => healthy()[1]!],
    ['a claim with no claimer', () => Promise.resolve([mine, { ...claimView(2), claimer: undefined }]), () => healthy()[1]!],
    ['a challenge that is a text', () => healthy()[0]!, () => Promise.resolve([challengeView(1, mine), 'challenge'])],
    ['a challenge with no claim token', () => healthy()[0]!, () => Promise.resolve([challengeView(1, mine), { ...challengeView(2, mine), claim_token: undefined }])],
  ];

  it.each(UNREADABLE)('is { ok: false }: %s', async (_what, claims, challenges) => {
    const twin = setup(() => healthy()[0]!, () => healthy()[1]!);
    expect(await casesAgainst(twin.deps, BIDDER)).toStrictEqual(cases(1));
    const world = setup(claims, challenges);
    const result = await casesAgainst(world.deps, BIDDER);
    expect(result).toStrictEqual(UNREAD);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(world.reads.claims).toBeLessThanOrEqual(1);
    expect(world.reads.challenges).toBeLessThanOrEqual(1);
  });

  it('is { ok: false } and not 0 when the claims cannot be read, although no challenge stands', async () => {
    expect(await casesAgainst(setup(() => Promise.reject(new Error('down')), () => Promise.resolve([])).deps, BIDDER)).toStrictEqual(UNREAD);
    expect(await casesAgainst(setup(() => Promise.resolve([]), () => Promise.resolve([])).deps, BIDDER)).toStrictEqual(cases(0));
  });

  it('is { ok: false } when the clock ends the wait before the claims arrive, and when it ends the wait before the challenges arrive', async () => {
    for (const late of ['claims', 'challenges'] as const) {
      const world = setup(late === 'claims' ? () => never() : () => healthy()[0]!, late === 'challenges' ? () => never() : () => healthy()[1]!);
      const result = casesAgainst(world.deps, BIDDER);
      await settle();
      expect(world.clock.open).toBe(1);
      world.clock.fire();
      expect(await result).toStrictEqual(UNREAD);
      expect(world.clock.asked).toStrictEqual([FACT_READ_TIMEOUT_MS, FACT_READ_TIMEOUT_MS]);
    }
  });

  it('drops the answer of a port that comes after the timeout: the call that timed out is still { ok: false }, and nothing is raised later', async () => {
    let answer: (value: unknown) => void = () => undefined;
    let fail: (reason: Error) => void = () => undefined;
    const world = setup(() => new Promise<unknown>((resolve) => { answer = resolve; }), () => new Promise<unknown>((_resolve, reject) => { fail = reject; }));
    const result = casesAgainst(world.deps, BIDDER);
    await settle();
    world.clock.fire();
    expect(await result).toStrictEqual(UNREAD);
    answer([mine]);
    fail(new Error('late failure'));
    await settle();
  });

  it('does not retry: a port that fails is called one time', async () => {
    const world = setup(() => Promise.reject(new Error('down')), () => Promise.reject(new Error('down')));
    await casesAgainst(world.deps, BIDDER);
    expect(world.reads).toStrictEqual({ claims: 1, challenges: 1 });
  });
});

describe('the cases of several bidders in one read', () => {
  const first = claimView(1, BIDDER);
  const second = claimView(2, BIDDER);
  const third = claimView(3, OTHER);
  const claims = [first, second, third];
  const challenges = [challengeView(1, first), challengeView(2, second), challengeView(3, third)];

  it('reads each list one time for all the DIDs, and gives for each DID the same answer as a read for that DID alone', async () => {
    const world = lists(claims, challenges);
    const all = await casesAgainstAll(world.deps, [BIDDER, OTHER, THIRD]);
    expect(world.reads).toStrictEqual({ claims: 1, challenges: 1 });
    expect(world.clock.asked).toStrictEqual([FACT_READ_TIMEOUT_MS, FACT_READ_TIMEOUT_MS]);
    expect([...all.keys()]).toStrictEqual([BIDDER, OTHER, THIRD]);
    expect(all.get(BIDDER)).toStrictEqual(cases(2));
    expect(all.get(OTHER)).toStrictEqual(cases(1));
    expect(all.get(THIRD)).toStrictEqual(cases(0));
    for (const did of [BIDDER, OTHER, THIRD]) {
      expect(await casesAgainst(lists(claims, challenges).deps, did)).toStrictEqual(all.get(did));
    }
  });

  it('has one entry for a DID that the list names twice', async () => {
    const all = await casesAgainstAll(lists(claims, challenges).deps, [BIDDER, OTHER, BIDDER]);
    expect([...all.keys()]).toStrictEqual([BIDDER, OTHER]);
    expect(all.get(BIDDER)).toStrictEqual(cases(2));
  });

  it('gives { ok: false } for every DID when one of the lists cannot be read, and 0 is not given for any of them', async () => {
    const world = setup(() => Promise.resolve(claims), () => Promise.reject(new Error('down')));
    const all = await casesAgainstAll(world.deps, [BIDDER, OTHER, THIRD]);
    expect([...all.entries()]).toStrictEqual([[BIDDER, UNREAD], [OTHER, UNREAD], [THIRD, UNREAD]]);
    expect(world.reads).toStrictEqual({ claims: 1, challenges: 1 });
  });

  it('reads nothing for no DID', async () => {
    const world = lists(claims, challenges);
    const all = await casesAgainstAll(world.deps, []);
    expect(all.size).toBe(0);
    expect(world.reads).toStrictEqual({ claims: 0, challenges: 0 });
    expect(world.clock.asked).toStrictEqual([]);
  });
});
