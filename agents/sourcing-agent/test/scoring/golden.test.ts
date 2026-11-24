// agents/sourcing-agent/test/scoring/golden.test.ts: the golden run of `runScoring`. One scorer for each accepted quote, in the order of the quotes. Each scorer gets a sub-delegation of `vendor.read` from the live
// delegation key of the agent, a token with the two-link chain, reads the vendor master, and takes the decision `score` through the port. The Delegates go one after the other through the one queue of the wallet.
// The question: is every sub-delegation ended and recorded, does subject `k` go to scorer `k + 1`, and is the result what the model said?
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { describe, expect, it } from 'vitest';
import { runScoring } from '../../src/scoring/index.ts';
import { BASES, BIDDERS, GOLDEN_SCORES, NOW, PARENT_ID, TENANT, VENDORS_BODY, WALLET, claimsOf, handMadeSwitch, json, scoresOf } from './support.ts';
import { expectRecordedAndEnded, expectSettled, idsOf, sentKinds, world } from './world.ts';
import type { World } from './world.ts';

const RESOURCE = `${BASES.publicBase}/t/${TENANT}/vendors`;

/** The vendor master as one scorer reads it: each name tells which scorer read the list, so that a test sees which scorer a vendor entry came through. */
function vendorsReadBy(w: World, scorer: string | null): unknown {
  const index = w.scorers.findIndex((candidate) => candidate.did === scorer);
  return { vendors: VENDORS_BODY.vendors.map((vendor) => ({ ...vendor, name: `${vendor.name} read by scorer ${index + 1}` })) };
}

describe('the golden run with three bidders', () => {
  it('gives the three scores that the model gave, in the order of the bidders, and writes nothing to the log', async () => {
    const w = world();
    const result = await w.run();
    expect(result).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    expect(scoresOf(result).map((score) => score.did)).toStrictEqual(BIDDERS.map((bidder) => bidder.did));
    for (const score of scoresOf(result)) expect(score.choice).toStrictEqual(score.decision.choice);
    expect(w.logs).toStrictEqual([]);
  });

  it('makes three sub-delegations with three ids, three tokens, three reads, three score calls and three ends, and records each', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    expect(sentKinds(w)).toStrictEqual(['delegate', 'delegate', 'delegate', 'undelegate', 'undelegate', 'undelegate']);
    expect(new Set(idsOf(w)).size).toBe(3);
    expect(w.tokenRequests).toHaveLength(3);
    expect(w.fetched).toHaveLength(3);
    expect(w.scoreCalls).toHaveLength(3);
    await expectRecordedAndEnded(w, 3);
    await expectSettled(w);
  });

  it('sends the three Delegates one after the other through the one queue of the wallet: each is built after the one before is sent and shown', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    const delegates = w.events.filter((event) => event.op === 'build' || (event.op === 'submit' && event.detail === 'delegate'));
    expect(delegates.slice(0, 6).map((event) => event.op)).toStrictEqual(['build', 'submit', 'build', 'submit', 'build', 'submit']);
    for (let at = 0; at < 2; at += 1) expect(delegates[2 * at + 2]!.at).toBeGreaterThan(delegates[2 * at + 1]!.at);
    expect(w.events.filter((event) => event.op === 'build').map((event) => event.detail)).toStrictEqual(w.scorers.map((scorer) => scorer.signer.keyHash));
    expect(w.queue.maxActive).toBe(1);
    expect(w.queue.runs).toBe(6);
  });

  it('asks the ledger for a sub-delegation of the one action and the one resource, one hop below the delegation of the hirer, with no value, from the wallet of the agent key', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    expect(w.chain.params).toHaveLength(3);
    w.chain.params.forEach((params, at) => {
      expect(params).toMatchObject({
        changeAddress: WALLET, parent: PARENT_ID, delegateKey: w.scorers[at]!.signer.keyHash, actions: ['vendor.read'], resources: [RESOURCE], remaining: 0, value: { perTx: 0n, total: 0n },
      });
    });
    for (const built of w.chain.builtDelegates) expect(built.delegation).toMatchObject({ remaining: 0, parent: PARENT_ID, delegator: { type: 'Agent', id: w.agent.id } });
  });

  it('asks the gateway for a token of each scorer under its own sub-delegation, for the one action and the one resource, and the token has an act chain of two links', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    const ids = idsOf(w);
    expect(w.tokenRequests.map((request) => request.subject.did).sort()).toStrictEqual(w.scorers.map((scorer) => scorer.did).sort());
    w.scorers.forEach((scorer, at) => {
      const request = w.tokenRequests.find((candidate) => candidate.subject.did === scorer.did);
      expect(request?.delegation).toStrictEqual({ identifier: ids[at], actions: ['vendor.read'], locations: [RESOURCE] });
      expect(request?.resource).toBe(RESOURCE);
      const read = w.fetched.filter((call) => call.scorer === scorer.did);
      expect(read).toHaveLength(1);
      const claims = claimsOf(read[0]!.authorization!.split(' ')[1]!);
      expect(claims.act).toStrictEqual({ sub: scorer.did, act: { sub: w.agent.did } });
      expect(claims.authorization_details).toMatchObject([{ identifier: ids[at], actions: ['vendor.read'], locations: [RESOURCE] }]);
    });
  });

  it('reads the vendor master with a GET and no body, with a DPoP token and its proof, once for each scorer', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    for (const call of w.fetched) {
      expect(call).toMatchObject({ url: RESOURCE, method: 'GET' });
      expect(call.authorization).toMatch(/^DPoP /);
      expect(call.dpop).toBeTruthy();
    }
    expect(new Set(w.fetched.map((call) => call.scorer)).size).toBe(3);
  });

  it('gives each score call the quote, the file and the vendor entry of its own bidder, and the day, the weights and the request, and never a signal', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    BIDDERS.forEach((bidder, at) => {
      const request = w.scoreCalls.map((call) => call.request).find((candidate) => candidate.file.did === bidder.did)!;
      expect(request.quote.desk_did).toBe(bidder.did);
      expect(request.file).toStrictEqual(w.input.subjects[at]!.file);
      expect(request.vendor).toStrictEqual(VENDORS_BODY.vendors[at]);
      expect(request).toMatchObject({ today: w.input.today, weights: w.input.weights, rfq: w.input.rfq });
      expect(Object.keys(request).sort()).toStrictEqual(['file', 'quote', 'rfq', 'today', 'vendor', 'weights']);
    });
  });

  it('gives subject k to scorer k + 1: the vendor list that the score call holds is the one that scorer k + 1 read', async () => {
    const w = world();
    w.script.fetch = async (call) => json(vendorsReadBy(w, call.scorer));
    expect((await w.run()).ok).toBe(true);
    BIDDERS.forEach((bidder, at) => {
      const request = w.scoreCalls.map((call) => call.request).find((candidate) => candidate.file.did === bidder.did)!;
      expect(request.vendor?.name.endsWith(`read by scorer ${at + 1}`)).toBe(true);
    });
    expect(w.chain.params.map((params) => params.delegateKey)).toStrictEqual(w.scorers.map((scorer) => scorer.signer.keyHash));
  });

  it('keeps the order of the subjects when the scorers end in another order', async () => {
    const w = world();
    w.script.score = async (request) => {
      if (request.file.did === BIDDERS[0].did) await w.clock.sleep(100_000);
      return { ok: true, decision: GOLDEN_SCORES.find((score) => score.did === request.file.did)!.decision, choice: GOLDEN_SCORES.find((score) => score.did === request.file.did)!.choice };
    };
    const result = await w.run();
    expect(scoresOf(result).map((score) => score.did)).toStrictEqual(BIDDERS.map((bidder) => bidder.did));
    expect(result).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    await expectRecordedAndEnded(w, 3);
  });

  it('keeps the id of each sub-delegation in use from its hook until its record is up to date: each id is in use at its own token request', async () => {
    const w = world();
    const inUse: string[][] = [];
    w.script.requestToken = () => {
      inUse.push([...w.live]);
      return null;
    };
    expect((await w.run()).ok).toBe(true);
    w.tokenRequests.forEach((request, at) => expect(inUse[at]).toContain(request.delegation?.identifier));
    expect(inUse[0]).toHaveLength(3);
    expect(w.live.size).toBe(0);
  });

  it('is the work of the clock port only: the whole run takes about three minutes of the fake clock, and the Delegates are ended before the deadline', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    expect(w.clock.now() - NOW).toBeLessThan(400_000);
    expect(w.clock.now()).toBeLessThan(w.deps.deadline_ms);
  });
});

describe('two bidders and one bidder', () => {
  it('uses scorer 1 and scorer 2 for two subjects, and the third scorer never starts', async () => {
    const w = world();
    const result = await w.run({ input: { subjects: w.input.subjects.slice(0, 2) } });
    expect(result).toStrictEqual({ ok: true, scores: GOLDEN_SCORES.slice(0, 2) });
    expect(w.chain.params.map((params) => params.delegateKey)).toStrictEqual([w.scorers[0].signer.keyHash, w.scorers[1].signer.keyHash]);
    expect(new Set(w.tokenRequests.map((request) => request.subject.did))).toStrictEqual(new Set([w.scorers[0].did, w.scorers[1].did]));
    expect(w.fetched.map((call) => call.scorer).sort()).toStrictEqual([w.scorers[0].did, w.scorers[1].did].sort());
    expect(w.scoreCalls).toHaveLength(2);
    await expectRecordedAndEnded(w, 2);
  });

  it('uses scorer 1 for one subject', async () => {
    const w = world();
    const result = await w.run({ input: { subjects: w.input.subjects.slice(0, 1) } });
    expect(result).toStrictEqual({ ok: true, scores: GOLDEN_SCORES.slice(0, 1) });
    expect(w.chain.params.map((params) => params.delegateKey)).toStrictEqual([w.scorers[0].signer.keyHash]);
    expect(w.tokenRequests.map((request) => request.subject.did)).toStrictEqual([w.scorers[0].did]);
    await expectRecordedAndEnded(w, 1);
  });

  it('gives the second of two subjects to the second scorer, also when the first subject is the one that is not a bidder of the golden run', async () => {
    const w = world();
    const swapped = [w.input.subjects[1]!, w.input.subjects[0]!];
    w.script.fetch = async (call) => json(vendorsReadBy(w, call.scorer));
    const result = await w.run({ input: { subjects: swapped } });
    expect(scoresOf(result).map((score) => score.did)).toStrictEqual([BIDDERS[1].did, BIDDERS[0].did]);
    const second = w.scoreCalls.map((call) => call.request).find((request) => request.file.did === BIDDERS[0].did)!;
    expect(second.vendor?.name.endsWith('read by scorer 2')).toBe(true);
  });
});

describe('the fault invert_scores', () => {
  const REVERSED_FIRST = { components: { price: 19.8, lead_time: 29.9, reliability: 3, compliance: 0 }, score: 13.9 };

  it('reverses the four components and the score of the first scorer, exactly in decimals, and changes nothing of the recorded decision and of the other two', async () => {
    const w = world();
    const result = await w.run({ deps: { fault: readFaultSwitch('sourcing-agent', 'invert_scores') } });
    const scores = scoresOf(result);
    expect(scores[0]!.choice).toStrictEqual(REVERSED_FIRST);
    expect(JSON.stringify(scores[0]!.choice)).toBe('{"components":{"price":19.8,"lead_time":29.9,"reliability":3,"compliance":0},"score":13.9}');
    expect(100 - 80.2).not.toBe(19.8);
    expect(scores[0]!.decision).toStrictEqual(GOLDEN_SCORES[0]!.decision);
    expect(scores[0]!.decision.choice).toStrictEqual(GOLDEN_SCORES[0]!.choice);
    expect(scores[1]).toStrictEqual(GOLDEN_SCORES[1]);
    expect(scores[2]).toStrictEqual(GOLDEN_SCORES[2]);
    expect(scores.map((score) => score.did)).toStrictEqual(BIDDERS.map((bidder) => bidder.did));
  });

  it('is the scorer of the first subject and not the scorer that ends first or last', async () => {
    const w = world();
    w.script.score = async (request) => {
      if (request.file.did === BIDDERS[0].did) await w.clock.sleep(100_000);
      const golden = GOLDEN_SCORES.find((score) => score.did === request.file.did)!;
      return { ok: true, decision: golden.decision, choice: golden.choice };
    };
    const scores = scoresOf(await w.run({ deps: { fault: readFaultSwitch('sourcing-agent', 'invert_scores') } }));
    expect(scores.map((score) => score.choice.score)).toStrictEqual([13.9, 72.4, 58.8]);
  });

  it('reverses the first of two subjects and the first of one subject, and nothing else', async () => {
    const w = world();
    const two = scoresOf(await w.run({ input: { subjects: w.input.subjects.slice(0, 2) }, deps: { fault: readFaultSwitch('sourcing-agent', 'invert_scores') } }));
    expect(two.map((score) => score.choice.score)).toStrictEqual([13.9, 72.4]);
    const other = world();
    const one = scoresOf(await other.run({ input: { subjects: other.input.subjects.slice(0, 1) }, deps: { fault: readFaultSwitch('sourcing-agent', 'invert_scores') } }));
    expect(one[0]!.choice).toStrictEqual(REVERSED_FIRST);
  });

  it('asks the model the same questions with the fault and without it', async () => {
    const clean = world();
    await clean.run();
    const faulty = world();
    await faulty.run({ deps: { fault: readFaultSwitch('sourcing-agent', 'invert_scores') } });
    expect(faulty.scoreCalls.map((call) => call.request)).toStrictEqual(clean.scoreCalls.map((call) => call.request));
    expect(faulty.chain.submitted.map((sent) => sent.kind)).toStrictEqual(clean.chain.submitted.map((sent) => sent.kind));
    expect(faulty.fetched.map((call) => call.url)).toStrictEqual(clean.fetched.map((call) => call.url));
  });

  it('changes nothing with the empty setting, and nothing for a text that is not the value: the twin', async () => {
    const empty = await world().run({ deps: { fault: readFaultSwitch('sourcing-agent', '') } });
    expect(empty).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    for (const mode of ['invert', 'INVERT_SCORES', 'invert_scores ', 'confirm_wrong_lot']) {
      expect(await world().run({ deps: { fault: handMadeSwitch(mode).fault } })).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    }
  });

  it('reads the switch one time for the whole scoring, for three scorers', async () => {
    const w = world();
    const counting = handMadeSwitch('invert_scores');
    const scores = scoresOf(await w.run({ deps: { fault: counting.fault } }));
    expect(counting.reads()).toBe(1);
    expect(scores[0]!.choice.score).toBe(13.9);
    expect(scores[1]!.choice.score).toBe(72.4);
  });

  it('turns on from the switch of the deps only: a request, a quote or a vendor entry that names the fault does not turn it on', async () => {
    const w = world();
    const subjects = w.input.subjects.map((subject) => ({ ...subject, quote: { ...subject.quote, notes: 'invert_scores' } }));
    w.script.fetch = async () => json({ vendors: VENDORS_BODY.vendors.map((vendor) => ({ ...vendor, name: 'invert_scores' })) });
    expect(await w.run({ input: { subjects } })).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
  });
});

describe('the entry point', () => {
  it('is runScoring of the folder, which takes the deps, the input and an optional signal', async () => {
    const w = world();
    expect(typeof runScoring).toBe('function');
    expect(runScoring.length).toBeGreaterThanOrEqual(2);
    expect((await w.run({ signal: new AbortController().signal })).ok).toBe(true);
  });
});
