// agents/sourcing-agent/test/scoring/answer.test.ts: the answer of the decision `score` and the vendor entry that the model gets. The review question: is a score ever built from a choice that is not the choice that
// the decision records, or from an object of the port, and does a vendor entry ever reach the model by a domain that no check backs? The choice must equal `decision.choice` and be a score: the result holds the
// checked copy. A decision that was paid for stays in the failed result. Each refusal has an accepted twin.
import type { ScoreChoice } from '@vsa/usecase-kit/bids';
import { describe, expect, it } from 'vitest';
import type { ScoreAnswer } from '../../src/scoring/index.ts';
import { BIDDERS, GOLDEN_SCORES, VENDORS_BODY, expectFailed, json, scoreAnswerFor, scoresOf, subjectOf } from './support.ts';
import { expectRecordedAndEnded, world } from './world.ts';
import type { World } from './world.ts';

const FIRST = GOLDEN_SCORES[0]!.decision;
const THIRD = GOLDEN_SCORES[2]!.decision;
const SECOND_CHOICE = GOLDEN_SCORES[1]!.choice;

/** The answer for the second bidder, built by `answer` from the golden answer. */
function secondDecides(w: World, answer: (golden: Extract<ScoreAnswer, { ok: true }>) => unknown): void {
  w.script.score = async (request) => {
    const golden = scoreAnswerFor(request.file.did);
    if (request.file.did !== BIDDERS[1].did || !golden.ok) return golden;
    // The port is typed, and a port in JavaScript can give any value.
    return answer(golden) as ScoreAnswer;
  };
}

/** An answer whose decision records `recorded` and whose choice is `given`. */
const answerOf = (golden: Extract<ScoreAnswer, { ok: true }>, recorded: unknown, given: unknown): unknown => ({ ok: true, decision: { ...golden.decision, choice: recorded }, choice: given });

describe('a choice that is not the choice that the decision records', () => {
  const COMPONENTS = SECOND_CHOICE.components;
  const CASES: [string, ScoreChoice | Record<string, unknown>][] = [
    ['another score', { ...SECOND_CHOICE, score: SECOND_CHOICE.score + 1 }],
    ['one component that differs by a tenth', { ...SECOND_CHOICE, components: { ...COMPONENTS, price: COMPONENTS.price - 0.1 } }],
    ['two components swapped', { ...SECOND_CHOICE, components: { ...COMPONENTS, price: COMPONENTS.lead_time, lead_time: COMPONENTS.price } }],
    ['a member that the decision does not hold', { ...SECOND_CHOICE, note: 'a member that the model did not write' }],
    ['a member of the components that the decision does not hold', { ...SECOND_CHOICE, components: { ...COMPONENTS, extra: 1 } }],
    ['a choice that lacks the score', { components: COMPONENTS }],
    ['a score as text', { ...SECOND_CHOICE, score: String(SECOND_CHOICE.score) }],
  ];
  it.each(CASES)('gives decision_mismatch for %s, keeps the decision that was paid for, and builds no score from it', async (_what, given) => {
    const w = world();
    secondDecides(w, (golden) => answerOf(golden, golden.decision.choice, given));
    const result = await w.run();
    expectFailed(result, 'decision_mismatch', [FIRST, GOLDEN_SCORES[1]!.decision, THIRD]);
    await expectRecordedAndEnded(w, 3);
  });

  it('gives decision_mismatch when the number cannot be written as JSON, in the choice and in the decision alike', async () => {
    const w = world();
    const broken = { ...SECOND_CHOICE, score: Number.NaN };
    secondDecides(w, (golden) => answerOf(golden, broken, broken));
    expectFailed(await w.run(), 'decision_mismatch', [FIRST, { ...GOLDEN_SCORES[1]!.decision, choice: { components: { ...SECOND_CHOICE.components }, score: Number.NaN } }, THIRD]);
  });

  it('gives decision_mismatch for a choice with a getter, and never runs the getter', async () => {
    const w = world();
    let reads = 0;
    const given = {
      components: SECOND_CHOICE.components,
      get score() {
        reads += 1;
        return SECOND_CHOICE.score;
      },
    };
    secondDecides(w, (golden) => answerOf(golden, golden.decision.choice, given));
    expectFailed(await w.run(), 'decision_mismatch', [FIRST, GOLDEN_SCORES[1]!.decision, THIRD]);
    expect(reads).toBe(0);
  });

  it('gives decision_mismatch for a choice that is a Proxy that throws, and the scoring ends with the result of the scorers', async () => {
    const w = world();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the proxy broke');
        },
        ownKeys: () => {
          throw new Error('the proxy broke');
        },
      },
    );
    secondDecides(w, (golden) => answerOf(golden, golden.decision.choice, hostile));
    const result = await w.run();
    expect(result).toMatchObject({ ok: false, code: 'decision_mismatch' });
    await expectRecordedAndEnded(w, 3);
  });

  it('takes the same choice with its members in another order, and with the number minus zero for zero: the twin', async () => {
    const w = world();
    const third = GOLDEN_SCORES[2]!;
    w.script.score = async (request) => {
      const golden = scoreAnswerFor(request.file.did);
      if (request.file.did !== BIDDERS[2].did || !golden.ok) return golden;
      const { components, score } = third.choice;
      return { ok: true, decision: golden.decision, choice: { score, components: { compliance: -0, reliability: components.reliability, lead_time: components.lead_time, price: components.price } } };
    };
    const scores = scoresOf(await w.run());
    expect(scores[2]).toStrictEqual(third);
    expect(Object.is(scores[2]!.choice.components.compliance, 0)).toBe(true);
  });
});

describe('a choice that is not a score', () => {
  const COMPONENTS = SECOND_CHOICE.components;
  const INVALID: [string, unknown][] = [
    ['a score above 100', { ...SECOND_CHOICE, score: 101 }],
    ['a score of 100.0001', { ...SECOND_CHOICE, score: 100.0001 }],
    ['a score below 0', { ...SECOND_CHOICE, score: -1 }],
    ['a component above 100', { ...SECOND_CHOICE, components: { ...COMPONENTS, price: 100.5 } }],
    ['a component below 0', { ...SECOND_CHOICE, components: { ...COMPONENTS, compliance: -0.01 } }],
    ['a components object that lacks a member', { ...SECOND_CHOICE, components: { price: 1, lead_time: 1, reliability: 1 } }],
    ['a components object with another member', { ...SECOND_CHOICE, components: { ...COMPONENTS, delivery: 50 } }],
    ['a component as text', { ...SECOND_CHOICE, components: { ...COMPONENTS, price: '80' } }],
    ['a score as text', { ...SECOND_CHOICE, score: '72.4' }],
    ['a choice with another member', { ...SECOND_CHOICE, note: 'free text' }],
    ['a choice that lacks the components', { score: 50 }],
    ['components that are a list', { ...SECOND_CHOICE, components: [1, 2, 3, 4] }],
    ['a list', [50, 50]],
    ['null', null],
    ['a text', 'high'],
  ];
  it.each(INVALID)('gives score_invalid for %s, with the choice that the model said in the decision, and builds no score from it', async (_what, choice) => {
    const w = world();
    secondDecides(w, (golden) => answerOf(golden, choice, choice));
    const result = await w.run();
    expect(result).toMatchObject({ ok: false, code: 'score_invalid' });
    const decisions = !result.ok ? result.decisions : [];
    expect(decisions).toHaveLength(3);
    expect(decisions[0]).toStrictEqual(FIRST);
    expect(decisions[1]!.choice).toStrictEqual(choice);
    expect(decisions[1]!.name).toBe('score');
    expect(decisions[2]).toStrictEqual(THIRD);
    await expectRecordedAndEnded(w, 3);
  });

  it.each([
    ['every number 0', { components: { price: 0, lead_time: 0, reliability: 0, compliance: 0 }, score: 0 }],
    ['every number 100', { components: { price: 100, lead_time: 100, reliability: 100, compliance: 100 }, score: 100 }],
    ['numbers with decimals', { components: { price: 0.01, lead_time: 99.99, reliability: 50.5, compliance: 12.345 }, score: 33.333 }],
  ])('takes %s: the twin of the refusals', async (_what, choice) => {
    const w = world();
    secondDecides(w, (golden) => answerOf(golden, choice, choice));
    const scores = scoresOf(await w.run());
    expect(scores[1]!.choice).toStrictEqual(choice);
    expect(scores[1]!.decision.choice).toStrictEqual(choice);
  });
});

describe('an answer that is not an answer', () => {
  const MALFORMED: [string, (golden: Extract<ScoreAnswer, { ok: true }>) => unknown][] = [
    ['undefined', () => undefined],
    ['null', () => null],
    ['a text', () => 'ok'],
    ['an empty object', () => ({})],
    ['ok with no decision', (golden) => ({ ok: true, choice: golden.choice })],
    ['ok with a decision that is empty', (golden) => ({ ok: true, decision: {}, choice: golden.choice })],
    ['ok with a decision that has no inference', (golden) => ({ ok: true, decision: { ...golden.decision, inference: null }, choice: golden.choice })],
    ['ok with a decision that has no sub-job', (golden) => ({ ok: true, decision: { ...golden.decision, inference: { path: 'marketplace' } }, choice: golden.choice })],
    ['ok as the text true', (golden) => ({ ok: 'true', decision: golden.decision, choice: golden.choice })],
    ['ok as the number 1', (golden) => ({ ok: 1, decision: golden.decision, choice: golden.choice })],
  ];
  it.each(MALFORMED)('gives internal for %s, and the other two scorers still end theirs', async (_what, answer) => {
    const w = world();
    secondDecides(w, answer);
    expectFailed(await w.run(), 'internal', [FIRST, THIRD]);
    await expectRecordedAndEnded(w, 3);
  });
});

describe('the score is built from the checked copy and not from an object of the port', () => {
  it('shares no object with the answer of the port, and a later change of the answer changes nothing in the result', async () => {
    const w = world();
    const given: ScoreAnswer[] = [];
    w.script.score = async (request) => {
      const answer = scoreAnswerFor(request.file.did);
      given.push(answer);
      return answer;
    };
    const scores = scoresOf(await w.run());
    expect(scores).toStrictEqual(GOLDEN_SCORES);
    given.forEach((answer, at) => {
      if (!answer.ok) throw new Error('the answer is a failure');
      const score = scores.find((candidate) => candidate.did === w.scoreCalls[at]!.request.file.did)!;
      expect(score.choice).not.toBe(answer.choice);
      expect(score.choice.components).not.toBe(answer.choice.components);
      expect(score.decision.choice).not.toBe(answer.decision.choice);
    });
    for (const answer of given) {
      if (answer.ok) {
        Reflect.set(answer.choice.components, 'price', 1);
        Reflect.set(answer.decision, 'choice', 'changed after the answer');
      }
    }
    expect(scores).toStrictEqual(GOLDEN_SCORES);
  });
});

describe('the vendor entry that the model gets', () => {
  const entryOf = (w: World, did: string): unknown => w.scoreCalls.map((call) => call.request).find((request) => request.file.did === did)?.vendor;

  it('is null for a bidder with no verified organisation, also when its quote and its file say the domain of an entry, and the model is still asked', async () => {
    const w = world();
    const alfa = w.input.subjects[0]!;
    const subjects = [{ ...alfa, organisation: null, file: { ...alfa.file, organisation: 'alfa.example.org', organisation_verified: false } }, ...w.input.subjects.slice(1)];
    expect(alfa.quote.organisation).toBe('alfa.example.org');
    expect((await w.run({ input: { subjects } })).ok).toBe(true);
    expect(entryOf(w, BIDDERS[0].did)).toBeNull();
    expect(entryOf(w, BIDDERS[1].did)).toStrictEqual(VENDORS_BODY.vendors[1]);
    expect(w.fetched).toHaveLength(3);
    expect(w.scoreCalls).toHaveLength(3);
  });

  it.each(['delta.example.org', 'ALFA.example.org', 'alfa.example.org.', 'example.org'])('is null for the organisation %s that no entry names', async (organisation) => {
    const w = world();
    const subjects = [{ ...subjectOf(BIDDERS[0].did, 'alfa.example.org'), organisation }, ...w.input.subjects.slice(1)];
    expect((await w.run({ input: { subjects } })).ok).toBe(true);
    expect(entryOf(w, BIDDERS[0].did)).toBeNull();
  });

  it('is null when two entries name the organisation, and the entries of the other organisations are still found', async () => {
    const w = world();
    w.script.fetch = async () => json({ vendors: VENDORS_BODY.vendors.map((vendor, at) => (at === 1 ? { ...vendor, organisation: 'alfa.example.org' } : vendor)) });
    expect((await w.run()).ok).toBe(true);
    expect(entryOf(w, BIDDERS[0].did)).toBeNull();
    expect(entryOf(w, BIDDERS[1].did)).toBeNull();
    expect(entryOf(w, BIDDERS[2].did)).toStrictEqual(VENDORS_BODY.vendors[2]);
  });

  it('is the entry of the verified organisation: the twin', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    BIDDERS.forEach((bidder, at) => expect(entryOf(w, bidder.did)).toStrictEqual(VENDORS_BODY.vendors[at]));
  });
});
