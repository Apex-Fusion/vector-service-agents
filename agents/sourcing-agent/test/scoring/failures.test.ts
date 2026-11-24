// agents/sourcing-agent/test/scoring/failures.test.ts: a scorer that fails, and the others. The review question: is a refused or failed call ever read as a vendor entry, and is a sub-delegation ever left alive with no
// record? A Delegate that the chain refuses, a token that the gateway refuses, a vendor master that refuses or fails, a body that is no vendor list, a decision that fails, a throw and a timeout are each the code of
// that scorer. The other scorers still run to their end and end their sub-delegations, and the decisions that were paid for stay in the result. Each failure has an accepted twin.
import { DamagedLeftEntriesError } from '@vsa/usecase-kit/janitor';
import { describe, expect, it } from 'vitest';
import { SCORING_FAILURES } from '../../src/scoring/index.ts';
import type { ScoreAnswer, ScoreRequest } from '../../src/scoring/index.ts';
import { BIDDERS, GOLDEN_SCORES, NOW, VENDORS_BODY, expectFailed, gatewayDown, gatewayRefused, json, later, never, scoreAnswerFor, tooYoung } from './support.ts';
import { expectRecordedAndEnded, expectSettled, idsOf, janitorOnce, opsOf, sentKinds, world } from './world.ts';
import type { World } from './world.ts';

const FIRST = GOLDEN_SCORES[0]!.decision;
const SECOND = GOLDEN_SCORES[1]!.decision;
const THIRD = GOLDEN_SCORES[2]!.decision;
const WORDS = 'words that the system wrote';

/** True for a request of the second scorer. */
const isSecondScorer = (w: World, did: string): boolean => did === w.scorers[1].did;

/** Makes the vendor master give another answer to the second scorer only. */
function secondScorerReads(w: World, answer: () => Response | Promise<Response>): void {
  w.script.fetch = async (call) => (call.scorer === w.scorers[1].did ? answer() : json(VENDORS_BODY));
}

/** Makes the decision give another answer for the second bidder only. */
function secondBidderDecides(w: World, answer: (request: ScoreRequest) => Promise<ScoreAnswer>): void {
  w.script.score = async (request) => (request.file.did === BIDDERS[1].did ? answer(request) : scoreAnswerFor(request.file.did));
}

/** The failure of the second scorer: the code, the paid decisions of the other two, three Delegates and three ends. */
async function expectSecondFailed(w: World, code: string, listed = true): Promise<void> {
  const result = await w.run();
  expectFailed(result, code, [FIRST, THIRD]);
  if (listed) expect(SCORING_FAILURES).toContain(code);
  await expectRecordedAndEnded(w, 3);
  await expectSettled(w);
}

describe('a Delegate that the chain refuses', () => {
  it('gives sub_delegation_build_refused for the second scorer, and the other two scorers send their Delegates, read, decide, and end', async () => {
    const w = world();
    w.script.build = (number) => {
      if (number === 2) throw new Error('the parent delegation allows no further hop');
    };
    const result = await w.run();
    expectFailed(result, 'sub_delegation_build_refused', [FIRST, THIRD]);
    expect(sentKinds(w)).toStrictEqual(['delegate', 'delegate', 'undelegate', 'undelegate']);
    expect(w.tokenRequests).toHaveLength(2);
    expect(w.scoreCalls.map((call) => call.request.file.did)).toStrictEqual([BIDDERS[0].did, BIDDERS[2].did]);
    await expectRecordedAndEnded(w, 2);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain('scorer 2');
    await expectSettled(w);
  });

  it('gives the code of the first scorer when the first scorer is the one that the chain refuses, and the other two are ended', async () => {
    const w = world();
    w.script.build = (number) => {
      if (number === 1) throw new Error('the parent delegation allows no further hop');
    };
    expectFailed(await w.run(), 'sub_delegation_build_refused', [SECOND, THIRD]);
    await expectRecordedAndEnded(w, 2);
  });

  it('records nothing for a build that the chain refuses: no id, no entry, no Delegate, no token and no decision', async () => {
    const w = world();
    w.script.build = () => {
      throw new Error('the parent delegation allows no further hop');
    };
    expectFailed(await w.run(), 'sub_delegation_build_refused');
    expect(w.steps).toStrictEqual([]);
    expect(w.chain.submitted).toStrictEqual([]);
    expect(w.tokenRequests).toStrictEqual([]);
    expect(w.scoreCalls).toStrictEqual([]);
  });
});

describe('the token of a scorer', () => {
  const REFUSALS = [
    ['the gateway refuses', () => gatewayRefused(403, 'access_denied', WORDS), 'gateway_refused'],
    ['the gateway is not available', () => gatewayDown('gateway.unavailable', 503), 'gateway_unavailable'],
    ['the gateway cannot be reached', () => gatewayDown('gateway.unreachable', 0), 'gateway_unreachable'],
    ['the gateway gives an answer that is not a token answer', () => gatewayDown('gateway.bad_response', 200), 'gateway_bad_response'],
  ] as const;

  it.each(REFUSALS)('gives scorer_token_failed when %s, asks once for that scorer, reads nothing for it, and ends its sub-delegation', async (_what, refusal, kitCode) => {
    const w = world();
    w.script.requestToken = (request) => (isSecondScorer(w, request.subject.did) ? Promise.resolve(refusal()) : null);
    await expectSecondFailed(w, 'scorer_token_failed');
    expect(w.tokenRequests.filter((request) => isSecondScorer(w, request.subject.did))).toHaveLength(1);
    expect(w.fetched.filter((call) => call.scorer === w.scorers[1].did)).toStrictEqual([]);
    expect(w.scoreCalls).toHaveLength(2);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain(kitCode);
    expect(w.logs.join('\n')).not.toContain(WORDS);
  });

  it('does not use a token that grants more than the one route that was asked for', async () => {
    const w = world();
    w.script.requestToken = (request) =>
      isSecondScorer(w, request.subject.did)
        ? Promise.resolve({
            ok: true as const,
            value: {
              accessToken: 'aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc',
              tokenType: 'DPoP' as const,
              issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token' as const,
              expiresIn: 300,
              expiresAt: w.clock.now() + 300_000,
              authorizationDetails: [],
            },
          })
        : null;
    await expectSecondFailed(w, 'scorer_token_failed');
    expect(w.fetched.filter((call) => call.scorer === w.scorers[1].did)).toStrictEqual([]);
    expect(w.logs[0]).toContain('gateway_bad_response');
  });

  it('asks again while the gateway says that the delegation is too young, for two minutes, and then gives scorer_token_failed', async () => {
    const w = world();
    w.script.requestToken = (request) => (isSecondScorer(w, request.subject.did) ? Promise.resolve(tooYoung()) : null);
    await expectSecondFailed(w, 'scorer_token_failed');
    const second = w.tokenRequests.map((request, at) => ({ request, at: w.tokenTimes[at]! })).filter((one) => isSecondScorer(w, one.request.subject.did));
    expect(second.at(-1)!.at - second[0]!.at).toBe(120_000);
    expect(second.length).toBeGreaterThan(20);
    expect(w.logs[0]).toContain('delegation_too_young');
  });

  it('goes on when the gateway sees the 30 confirmations a little later: the twin', async () => {
    const w = world();
    let asked = 0;
    w.script.requestToken = (request) => {
      if (!isSecondScorer(w, request.subject.did)) return null;
      asked += 1;
      return asked < 3 ? Promise.resolve(tooYoung()) : null;
    };
    expect(await w.run()).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    expect(asked).toBe(3);
    await expectRecordedAndEnded(w, 3);
  });
});

describe('the call to the vendor master', () => {
  const REFUSED: [string, () => Response, string][] = [
    ['a 403 with a code', () => json({ error: 'not_covered', message: WORDS }, 403), 'not_covered'],
    ['a 401 with a code', () => json({ error: 'token_invalid', message: WORDS }, 401), 'token_invalid'],
    ['a 403 with no code', () => json({ message: WORDS }, 403), 'refusal_without_code'],
    ['a 403 with a body that says ok', () => json({ ok: true, error: 'not_covered', vendors: [] }, 403), 'not_covered'],
    ['a 403 whose body is a complete vendor list', () => json(VENDORS_BODY, 403), 'refusal_without_code'],
    ['a 401 whose body is a complete vendor list with a code', () => json({ ...VENDORS_BODY, error: 'delegation_ended' }, 401), 'delegation_ended'],
  ];
  it.each(REFUSED)('gives vendors_refused for %s, with the code of the system in the log only, and never a vendor entry', async (_what, answer, systemCode) => {
    const w = world();
    secondScorerReads(w, answer);
    await expectSecondFailed(w, 'vendors_refused');
    expect(w.scoreCalls.map((call) => call.request.file.did)).not.toContain(BIDDERS[1].did);
    expect(w.fetched.filter((call) => call.scorer === w.scorers[1].did)).toHaveLength(1);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain(systemCode);
    expect(w.logs.join('\n')).not.toContain(WORDS);
  });

  const FAILED: [string, () => Response, string][] = [
    ['a 404 with a code', () => json({ error: 'not_found', message: WORDS }, 404), 'not_found'],
    ['a 500 with no code', () => json({}, 500), 'status 500'],
    ['a 500 with a body that is not JSON', () => new Response(WORDS, { status: 500 }), 'status 500'],
    ['a 200 with a body that is not JSON', () => new Response(`<p>${WORDS}</p>`, { status: 200 }), 'status 200'],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }), 'status 302'],
    ['a 500 whose body is a complete vendor list', () => json(VENDORS_BODY, 500), 'status 500'],
    ['a 429 whose body is a complete vendor list', () => json(VENDORS_BODY, 429), 'status 429'],
  ];
  it.each(FAILED)('gives vendors_failed for %s, with one call and no second try, and never a vendor entry', async (_what, answer, cause) => {
    const w = world();
    secondScorerReads(w, answer);
    await expectSecondFailed(w, 'vendors_failed');
    expect(w.scoreCalls.map((call) => call.request.file.did)).not.toContain(BIDDERS[1].did);
    expect(w.fetched.filter((call) => call.scorer === w.scorers[1].did)).toHaveLength(1);
    expect(w.logs[0]).toContain(cause);
    expect(w.logs.join('\n')).not.toContain(WORDS);
  });

  it('gives vendors_failed when the request gets no answer, with one call', async () => {
    const w = world();
    secondScorerReads(w, () => {
      throw new TypeError(WORDS);
    });
    await expectSecondFailed(w, 'vendors_failed');
    expect(w.fetched.filter((call) => call.scorer === w.scorers[1].did)).toHaveLength(1);
    expect(w.logs.join('\n')).not.toContain(WORDS);
  });

  it('gives vendors_failed when the vendor master does not answer within the bound of a call, and the time of the job is not used up', async () => {
    const w = world();
    secondScorerReads(w, () => never<Response>());
    await expectSecondFailed(w, 'vendors_failed');
    const second = w.fetched.find((call) => call.scorer === w.scorers[1].did)!;
    expect(w.clock.now() - second.at).toBeLessThan(420_000);
  });

  it('takes the vendor list when the system answers 200 with it: the twin', async () => {
    const w = world();
    secondScorerReads(w, () => json(VENDORS_BODY, 200));
    expect(await w.run()).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    expect(w.fetched).toHaveLength(3);
  });
});

describe('the body of the vendor master', () => {
  const [ALFA, BRAVO] = VENDORS_BODY.vendors;
  const NOT_A_LIST: [string, unknown, string][] = [
    ['an empty list', { vendors: [] }, 'vendors'],
    ['a text', { vendors: 'V-1001' }, 'vendors'],
    ['null', null, 'vendor list'],
    ['a list', [ALFA], 'vendor list'],
    ['another member next to vendors', { ...VENDORS_BODY, total: 3 }, 'total'],
    ['an entry with a missing member', { vendors: [{ ...ALFA, last_audit: undefined }] }, 'last_audit'],
    ['an entry with another member', { vendors: [{ ...ALFA, rating: 5 }] }, 'rating'],
    ['a rate of 1.5', { vendors: [{ ...ALFA, defect_rate: 1.5 }] }, 'defect_rate'],
    ['two entries with one vendor_id', { vendors: [ALFA, { ...BRAVO, vendor_id: ALFA!.vendor_id }] }, 'vendor_id'],
    ['an organisation in upper case', { vendors: [{ ...ALFA, organisation: 'Alfa.example.org' }] }, 'organisation'],
    ['a name with a hidden character', { vendors: [{ ...ALFA, name: 'Supplier\u200bAlfa' }] }, 'name'],
  ];
  it.each(NOT_A_LIST)('gives vendors_invalid for %s, with the member in the log and never a value, and asks no model for that scorer', async (_what, body, member) => {
    const w = world();
    secondScorerReads(w, () => json(body));
    await expectSecondFailed(w, 'vendors_invalid');
    expect(w.scoreCalls.map((call) => call.request.file.did)).not.toContain(BIDDERS[1].did);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain(member);
    expect(w.logs.join('\n')).not.toContain('Supplier');
  });
});

describe('the decision score of a scorer', () => {
  it.each([
    ['a failure of the model hire', 'llm_timeout'],
    ['an invalid answer of the model', 'model_output_invalid'],
    ['a store that cannot be written', 'store_write_failed'],
  ])('gives the code of the port for %s, and keeps the decisions of the other two scorers', async (_what, code) => {
    const w = world();
    secondBidderDecides(w, async () => ({ ok: false, code }));
    await expectSecondFailed(w, code, false);
    expect(w.scoreCalls.filter((call) => call.request.file.did === BIDDERS[1].did)).toHaveLength(1);
  });

  it.each([
    ['the words of a model', 'The model said: no!'],
    ['a code of 65 characters', 'x'.repeat(65)],
    ['a code in upper case', 'LLM_TIMEOUT'],
    ['an empty code', ''],
    ['a code that is not a text', 7],
    ['no code', undefined],
  ])('gives internal, and never the words of the port, for a failed answer with %s', async (_what, code) => {
    const w = world();
    // The port is typed, and a port in JavaScript can give any value.
    secondBidderDecides(w, async () => ({ ok: false, code }) as unknown as ScoreAnswer);
    const result = await w.run();
    expectFailed(result, 'internal', [FIRST, THIRD]);
    expect(JSON.stringify(result)).not.toContain('The model said');
    await expectRecordedAndEnded(w, 3);
  });

  it('gives scorer_threw when the decision throws, and writes the kind of the error to the log and never its message', async () => {
    const w = world();
    secondBidderDecides(w, async () => {
      throw new RangeError(WORDS);
    });
    await expectSecondFailed(w, 'scorer_threw');
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain('RangeError');
    expect(w.logs.join('\n')).not.toContain(WORDS);
  });

  it('gives scorer_threw when the decision throws a value that is not an error', async () => {
    const w = world();
    secondBidderDecides(w, () => Promise.reject(WORDS));
    await expectSecondFailed(w, 'scorer_threw');
    expect(w.logs.join('\n')).not.toContain(WORDS);
  });

  it('gives scorer_timed_out when the decision does not end within the 420 seconds of the job, and ends the sub-delegation after the timeout, with one call', async () => {
    const w = world();
    secondBidderDecides(w, () => never<ScoreAnswer>());
    await expectSecondFailed(w, 'scorer_timed_out');
    const second = w.scoreCalls.find((call) => call.request.file.did === BIDDERS[1].did)!;
    expect(w.clock.now() - second.at).toBeGreaterThanOrEqual(420_000);
    expect(w.scoreCalls.filter((call) => call.request.file.did === BIDDERS[1].did)).toHaveLength(1);
  });

  it('uses nothing after the time of the job: a decision that answers late is not used', async () => {
    const w = world();
    const gate = later<ScoreAnswer>();
    secondBidderDecides(w, () => gate.promise);
    await expectSecondFailed(w, 'scorer_timed_out');
    gate.resolve(scoreAnswerFor(BIDDERS[1].did));
    await w.clock.advance(1_000);
    expect(w.scoreCalls).toHaveLength(3);
    expect(w.sink.entries.size).toBe(0);
  });

  it('takes the decision that the model gave: the twin', async () => {
    const w = world();
    secondBidderDecides(w, async () => scoreAnswerFor(BIDDERS[1].did));
    expect(await w.run()).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
  });
});

describe('the code of the first scorer that failed', () => {
  it('is the code of the second scorer when the second and the third fail with other codes', async () => {
    const w = world();
    w.script.fetch = async (call) => (call.scorer === w.scorers[1].did ? json({ error: 'not_covered' }, 403) : json(VENDORS_BODY));
    w.script.requestToken = (request) => (request.subject.did === w.scorers[2].did ? Promise.resolve(gatewayRefused(403, 'access_denied', 'no')) : null);
    expectFailed(await w.run(), 'vendors_refused', [FIRST]);
    await expectRecordedAndEnded(w, 3);
  });

  it('is the code of the second scorer, and not the code that came first in time, when the third fails earlier', async () => {
    const w = world();
    w.script.fetch = async (call) => {
      if (call.scorer !== w.scorers[1].did) return json(VENDORS_BODY);
      await w.clock.sleep(30_000);
      return json({}, 500);
    };
    w.script.requestToken = (request) => (request.subject.did === w.scorers[2].did ? Promise.resolve(gatewayRefused(403, 'access_denied', 'no')) : null);
    expectFailed(await w.run(), 'vendors_failed', [FIRST]);
    expect(w.logs).toHaveLength(2);
    await expectRecordedAndEnded(w, 3);
  });

  it('is the code of the first scorer when it fails last, and the decisions that were paid for are kept in the order of the subjects', async () => {
    const w = world();
    w.script.score = async (request) => {
      if (request.file.did === BIDDERS[0].did) {
        await w.clock.sleep(100_000);
        return { ok: false, code: 'llm_failed' };
      }
      return scoreAnswerFor(request.file.did);
    };
    w.script.fetch = async (call) => (call.scorer === w.scorers[1].did ? json({}, 500) : json(VENDORS_BODY));
    expectFailed(await w.run(), 'llm_failed', [THIRD]);
    await expectRecordedAndEnded(w, 3);
  });

  it('is the code of the scorers, with no decision, when every scorer fails', async () => {
    const w = world();
    w.script.fetch = async () => json({ error: 'not_covered' }, 403);
    expectFailed(await w.run(), 'vendors_refused');
    await expectRecordedAndEnded(w, 3);
    expect(w.scoreCalls).toStrictEqual([]);
  });
});

describe('a sub-delegation that is not ended', () => {
  it('leaves the entry with the Undelegate that was tried, still gives the scores, and the janitor then ends each sub-delegation', async () => {
    const w = world();
    w.chain.faults.submitUndelegateThrows = true;
    expect(await w.run()).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    const ids = idsOf(w);
    expect(w.sink.entries.size).toBe(3);
    for (const id of ids) {
      expect(opsOf(w, id)).toStrictEqual(['add', 'put', 'put', 'delete']);
      const tried = w.chain.builtUndelegates.find((built) => built.id === id)!;
      expect(w.sink.entries.get(id)).toMatchObject({ signer_key_hash: w.deps.agentKey.signer.keyHash, left: { id, endTxHash: tried.txHash, action: 'vendor.read' } });
      expect(w.sink.stored.find((entry) => entry.left.id === id && entry.left.endTxHash === null)).toBeDefined();
    }
    expect(w.live.size).toBe(0);
    w.chain.faults.submitUndelegateThrows = false;
    expect((await janitorOnce(w)).entries.map((entry) => entry.state)).toStrictEqual(['ended', 'ended', 'ended']);
    expect(w.sink.entries.size).toBe(0);
    for (const id of ids) expect(await w.chain.readDelegation(id)).toBeNull();
  });

  it('leaves the entry of the last scorer, whose Undelegate never lands, and removes the entries of the scorers that were ended, also when that scorer failed', async () => {
    const w = world();
    w.script.score = async (request) => {
      if (request.file.did === BIDDERS[2].did) throw new Error(WORDS);
      return scoreAnswerFor(request.file.did);
    };
    // The Undelegate of a scorer that does not land keeps the turn of the wallet until the end step of that scorer gives up, so the scorer that ends last is the one that can be left.
    let undelegating: string | null = null;
    const buildUndelegate = w.chain.buildUndelegate.bind(w.chain);
    w.chain.buildUndelegate = async (params) => {
      undelegating = params.id;
      return buildUndelegate(params);
    };
    const submit = w.chain.submit.bind(w.chain);
    w.chain.submit = async (cbor) => {
      w.chain.faults.undelegateNeverLands = undelegating === idsOf(w)[2];
      return submit(cbor);
    };
    expectFailed(await w.run(), 'scorer_threw', [FIRST, SECOND]);
    const last = idsOf(w)[2]!;
    expect([...w.sink.entries.keys()]).toStrictEqual([last]);
    expect(w.sink.entries.get(last)).toMatchObject({ left: { id: last, endTxHash: w.chain.builtUndelegates.find((built) => built.id === last)!.txHash } });
    expect(opsOf(w, last)).toStrictEqual(['add', 'put', 'put', 'delete']);
    for (const id of idsOf(w).slice(0, 2)) expect(opsOf(w, id)).toStrictEqual(['add', 'put', 'remove', 'delete']);
    expect(w.live.size).toBe(0);
  });

  it('keeps the entry that was stored before the send when its update fails, and the run still gives the scores and takes the id out of use', async () => {
    const w = world();
    w.chain.faults.submitUndelegateThrows = true;
    w.sink.failPutAt.add(4);
    expect((await w.run()).ok).toBe(true);
    const kept = [...w.sink.entries.values()].filter((entry) => entry.left.endTxHash === null);
    expect(kept).toHaveLength(1);
    expect(w.sink.entries.size).toBe(3);
    expect(w.live.size).toBe(0);
  });

  it('keeps the entry when its removal fails after a clean end, and the run still gives the scores and takes the id out of use', async () => {
    const w = world();
    w.sink.failRemove = true;
    expect(await w.run()).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    for (const id of idsOf(w)) {
      expect(await w.chain.readDelegation(id)).toBeNull();
      expect(opsOf(w, id)).toStrictEqual(['add', 'put', 'remove', 'delete']);
    }
    expect(w.sink.entries.size).toBe(3);
    expect(w.live.size).toBe(0);
  });

  it('removes the entry after a clean end, and the list and the set are empty: the twin', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    await expectRecordedAndEnded(w, 3);
  });
});

describe('the list of left sub-delegations has a damaged file of another id', () => {
  it('does not block a scorer: the entries that could be read are checked', async () => {
    const w = world();
    const other = 'ab'.repeat(32);
    const entry = {
      left: { id: other, parent: 'cd'.repeat(32), action: 'vendor.read', resource: 'https://mock.example/t/run1/vendors', delegateTxHash: 'ef'.repeat(32), delegateValidTo: NOW, delegateTtlSlot: 1, notAfter: NOW, endTxHash: null },
      signer_key_hash: w.deps.agentKey.signer.keyHash,
    };
    w.sink.listFailure = () => new DamagedLeftEntriesError([entry], [{ file: `${other}x.json`, detail: 'the file is not JSON' }]);
    expect(await w.run()).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    await expectRecordedAndEnded(w, 3);
  });
});
