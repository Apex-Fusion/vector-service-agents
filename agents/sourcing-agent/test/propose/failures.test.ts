// agents/sourcing-agent/test/propose/failures.test.ts: the steps of `propose` after the shortlist, and what each failure keeps. After the first hire every failed result keeps what was paid for: the decisions that
// were made, the quote jobs as sub-jobs, the files of the bidders and the records of the quote jobs. Each failure has an accepted twin (the golden run), and the table at the end holds the codes that the
// job gave in this file equal to `PROPOSE_FAILURES`, in both directions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Decision, JsonValue } from '@vsa/usecase-kit/protocol';
import { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES, RANKING_RESERVE_MS, SCORING_RESERVE_MS } from '../../src/propose/index.ts';
import type { QuotesInput, QuoteOutcome, SourcingFailed, SourcingResult } from '../../src/propose/index.ts';
import { failedSourcing, proposedSourcing } from '../../src/propose/result.ts';
import {
  ALFA, BRAVO, CHARLIE, DELTA, NOW, acceptedOf, arrivedWith, decisionOf, excludedOf, expectFailed, fanOf, fileOf, goldenQuotes, goldenScoring, namesOf, proposed, quoteOf, rankAnswer, recordOf, scoredOf,
  shortlistAnswer, subJobOf, viewOf, world,
} from './support.ts';
import type { World } from './support.ts';

const NAMES = ['alfa', 'bravo', 'charlie'];
const BIDDERS = [ALFA, BRAVO, CHARLIE];

afterEach(() => {
  vi.useRealTimers();
});

/** The decision of the shortlist, as the job keeps it. */
const shortlistDecision = (): Decision => shortlistAnswer([ALFA, BRAVO, CHARLIE]).decision;
/** The three golden quotes: what the fan-out paid for. */
const quoted = () => BIDDERS.map((did, index) => acceptedOf(did, index + 1, NAMES[index]!));
const scoreDecisions = (): Decision[] => BIDDERS.map((did, index) => scoredOf(did, index + 1).decision);

/** What a failed result keeps after the three golden quotes: the shortlist, the three acceptances, the three jobs and the three records, and the three files. */
function expectQuotesKept(result: SourcingFailed, more: readonly Decision[] = []): void {
  expect(result.decisions).toStrictEqual([shortlistDecision(), ...quoted().map((outcome) => outcome.decision), ...more]);
  expect(result.sub_jobs).toStrictEqual(quoted().map((outcome) => outcome.sub_job));
  expect(result.quotes).toStrictEqual(quoted().map((outcome) => outcome.record));
  expect(result.bidders.map((file) => file.did)).toStrictEqual(BIDDERS);
}

/** Runs the job with the timers of the test and moves them past the deadline: a port that never answers ends its wait at the deadline. */
async function pastDeadline(w: World): Promise<SourcingResult> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const run = w.run();
  await vi.advanceTimersByTimeAsync(PROPOSE_DEADLINE_MS);
  return run;
}

describe('the quotes', () => {
  it('fails with the code of a stopped fan-out and keeps what was paid until it stopped: the decisions, the jobs and the records of the bidders that it reached', async () => {
    const w = world();
    const [first] = quoted();
    const second = excludedOf(BRAVO, 'failed', 'decision_failed', { record: recordOf(BRAVO, 2, null, { accepted: null, result: null }) });
    w.script.quotes = async () => fanOf([first!, second], { code: 'llm_out_of_time' });
    const result = await w.run();
    expectFailed(result, 'llm_out_of_time');
    expect(result.decisions).toStrictEqual([shortlistDecision(), first!.decision]);
    expect(result.sub_jobs).toStrictEqual([first!.sub_job]);
    expect(result.quotes).toStrictEqual([first!.record, second.record]);
    expect(result.bidders).toHaveLength(3);
    expect(w.trace).not.toContain('scoring');
  });

  it('turns the words of a stopped fan-out into internal, and keeps what was paid', async () => {
    const w = world();
    w.script.quotes = async () => fanOf([quoted()[0]!], { code: 'The model said no.' });
    const result = await w.run();
    expectFailed(result, 'internal');
    expect(result.sub_jobs).toHaveLength(1);
  });

  it('fails with no_quotes when no bidder has an accepted quote, and keeps the records and the decisions of the bidders that were paid and left out: the twin has one accepted quote', async () => {
    const declined = decisionOf('accept_quote', { accept: false, mismatch: ['GLV-NIT-M'] }, 13);
    const disputed = excludedOf(CHARLIE, 'disputed', 'no_open_claim', { decision: declined, record: recordOf(CHARLIE, 3, quoteOf(CHARLIE, 'charlie.example'), { accepted: 'no' }) });
    const refused = excludedOf(BRAVO, 'refused', 'duplicate_rfq', { record: recordOf(BRAVO, 2, null, { receipt: null, receipt_signature: null, verification: null, result: null, accepted: null }) });
    const w = world();
    w.script.quotes = async () => fanOf([excludedOf(ALFA, 'not_active', 'suspended'), refused, disputed]);
    const result = await w.run();
    expectFailed(result, 'no_quotes');
    expect(result.decisions).toStrictEqual([shortlistDecision(), declined]);
    expect(result.sub_jobs).toStrictEqual([]);
    expect(result.quotes).toStrictEqual([refused.record, disputed.record]);
    expect(w.trace).not.toContain('scoring');
    const twin = world();
    twin.script.quotes = async () => fanOf([quoted()[0]!, refused, disputed]);
    proposed(await twin.run());
  });

  const alfa = (over: Parameters<typeof acceptedOf>[3]): QuoteOutcome => acceptedOf(ALFA, 1, 'alfa', over);
  const WRONG: [string, (input: QuotesInput) => unknown][] = [
    ['nothing', () => undefined],
    ['a text', () => 'a text'],
    ['outcomes that are no list', () => ({ outcomes: 'x', stopped: null })],
    ['no member `stopped`', (input) => ({ outcomes: goldenQuotes(input).outcomes })],
    ['a `stopped` that is a text', (input) => ({ outcomes: goldenQuotes(input).outcomes, stopped: 'x' })],
    ['no outcome at all', () => fanOf([])],
    ['an outcome that is missing', (input) => fanOf(goldenQuotes(input).outcomes.slice(0, 2))],
    ['an outcome too many', (input) => fanOf([...goldenQuotes(input).outcomes, excludedOf(DELTA, 'failed', 'deadline')])],
    ['the outcomes in another order', (input) => fanOf([...goldenQuotes(input).outcomes].reverse())],
    ['one bidder two times', () => fanOf([alfa({}), alfa({}), quoted()[2]!])],
    ['a bidder that was not invited', () => fanOf([alfa({}), quoted()[1]!, acceptedOf(DELTA, 4, 'delta')])],
    ['an outcome of no kind', () => fanOf([{ ...alfa({}), kind: 'maybe' } as never, quoted()[1]!, quoted()[2]!])],
    ['an accepted outcome with no sub-job', () => fanOf([{ ...alfa({}), sub_job: undefined } as never, quoted()[1]!, quoted()[2]!])],
    ['an excluded outcome with the reason not_invited', () => fanOf([alfa({}), excludedOf(BRAVO, 'not_invited' as never, null), quoted()[2]!])],
    ['an excluded outcome with a code that is no text', () => fanOf([alfa({}), excludedOf(BRAVO, 'failed', 7 as never), quoted()[2]!])],
    ['a quote of another bidder', () => fanOf([alfa({ quote: quoteOf(BRAVO, 'bravo.example') }), quoted()[1]!, quoted()[2]!])],
    ['a record of another bidder', () => fanOf([alfa({ record: recordOf(BRAVO, 1, quoteOf(ALFA, 'alfa.example')) }), quoted()[1]!, quoted()[2]!])],
    ['a record whose escrow is not the escrow of the sub-job', () => fanOf([alfa({ record: recordOf(ALFA, 7, quoteOf(ALFA, 'alfa.example')) }), quoted()[1]!, quoted()[2]!])],
    ['a record that says that the Accept was not made', () => fanOf([alfa({ record: recordOf(ALFA, 1, quoteOf(ALFA, 'alfa.example'), { accepted: 'no' }) }), quoted()[1]!, quoted()[2]!])],
    ['a record of a hire that the wallet paid', () => fanOf([alfa({ record: recordOf(ALFA, 1, quoteOf(ALFA, 'alfa.example'), { paid_from_vault: false }) }), quoted()[1]!, quoted()[2]!])],
    ['a record with no receipt', () => fanOf([alfa({ record: recordOf(ALFA, 1, quoteOf(ALFA, 'alfa.example'), { receipt: null }) }), quoted()[1]!, quoted()[2]!])],
    ['a record with no signature', () => fanOf([alfa({ record: recordOf(ALFA, 1, quoteOf(ALFA, 'alfa.example'), { receipt_signature: null }) }), quoted()[1]!, quoted()[2]!])],
    ['a quote for another request', () => {
      const other = { ...quoteOf(ALFA, 'alfa.example'), rfq_sha256: 'd7'.repeat(32) };
      return fanOf([alfa({ quote: other, record: recordOf(ALFA, 1, other) }), quoted()[1]!, quoted()[2]!]);
    }],
    ['a quote that is not the signed result of its record', () => fanOf([alfa({ quote: { ...quoteOf(ALFA, 'alfa.example'), total: 1 } }), quoted()[1]!, quoted()[2]!])],
    ['a record with no result', () => fanOf([alfa({ record: recordOf(ALFA, 1, null) }), quoted()[1]!, quoted()[2]!])],
  ];
  it.each(WRONG)('fails with internal when the fan-out gives %s, and scores nothing', async (_name, answer) => {
    const w = world();
    w.script.quotes = async (input) => answer(input) as never;
    expectFailed(await w.run(), 'internal');
    expect(w.trace).not.toContain('scoring');
    expect(w.trace).not.toContain('rank');
  });

  it('keeps what the good outcomes paid for when another outcome breaks the contract: the decision, the record and the job of each', async () => {
    const w = world();
    w.script.quotes = async () => fanOf([quoted()[0]!, { ...quoted()[1]!, quote: quoteOf(CHARLIE, 'charlie.example') }, quoted()[2]!]);
    const result = await w.run();
    expectFailed(result, 'internal');
    expect(result.decisions).toStrictEqual([shortlistDecision(), ...quoted().map((outcome) => outcome.decision)]);
    expect(result.sub_jobs).toHaveLength(3);
    expect(result.quotes).toHaveLength(3);
  });

  it('fails with ranking_invalid before it pays for a scorer when the ranking cannot cite an accepted quote: the kit refuses the escrow reference, and the quotes stay', async () => {
    const w = world();
    const reference = 'not a reference';
    const broken = alfa({ record: recordOf(ALFA, 1, quoteOf(ALFA, 'alfa.example'), { escrow_ref: reference }), sub_job: { ...subJobOf('supplychain.rfq.quote.v1', 1), escrow_ref: reference } });
    w.script.quotes = async () => fanOf([broken, quoted()[1]!, quoted()[2]!]);
    const result = await w.run();
    expectFailed(result, 'ranking_invalid');
    expect(result.sub_jobs).toHaveLength(3);
    expect(result.quotes).toHaveLength(3);
    expect(w.trace).not.toContain('scoring');
  });

  it('fails with ranking_invalid before the scorers when the code of an excluded bidder is no code, and goes on for a code: the twin', async () => {
    const w = world();
    w.script.quotes = async () => fanOf([quoted()[0]!, excludedOf(BRAVO, 'failed', 'Not a code'), quoted()[2]!]);
    expectFailed(await w.run(), 'ranking_invalid');
    expect(w.trace).not.toContain('scoring');
    const twin = world();
    twin.script.quotes = async () => fanOf([quoted()[0]!, excludedOf(BRAVO, 'failed', 'a_code'), quoted()[2]!]);
    proposed(await twin.run());
  });

  it('fails with internal when the fan-out throws, keeps the shortlist and the files, and with deadline when it never answers', async () => {
    const throwing = world();
    throwing.script.quotes = async () => {
      throw new Error('the fan-out broke');
    };
    const thrown = await throwing.run();
    expectFailed(thrown, 'internal');
    expect(thrown.decisions).toStrictEqual([shortlistDecision()]);
    expect(thrown.bidders).toHaveLength(3);
    const silent = world();
    silent.script.quotes = () => new Promise(() => undefined);
    const late = await pastDeadline(silent);
    expectFailed(late, 'deadline');
    expect(late.decisions).toStrictEqual([shortlistDecision()]);
    expect(silent.trace).not.toContain('scoring');
  });

  it('reads the signal before the fan-out: a caller that hangs up during the shortlist is `aborted`, nobody is hired, and the decision stays', async () => {
    const controller = new AbortController();
    const w = world();
    w.script.shortlist = async () => {
      controller.abort();
      return shortlistAnswer([ALFA, BRAVO, CHARLIE]);
    };
    const result = await w.run({ signal: controller.signal });
    expectFailed(result, 'aborted');
    expect(w.trace).not.toContain('quotes');
    expect(result.decisions).toStrictEqual([shortlistDecision()]);
  });

  it('reads the signal after the fan-out too: a caller that hangs up during it gets `aborted` before any scorer is paid, and every quote stays', async () => {
    const controller = new AbortController();
    const w = world();
    w.script.quotes = async (input) => {
      controller.abort();
      return goldenQuotes(input);
    };
    const result = await w.run({ signal: controller.signal });
    expectFailed(result, 'aborted');
    expect(w.trace).not.toContain('scoring');
    expectQuotesKept(result);
  });
});

describe('the scoring', () => {
  it('starts only when the time that is left is at least the reserve: with one millisecond less, the job fails with deadline, scores nothing, and keeps the quotes', async () => {
    const w = world();
    w.script.quotes = async (input) => {
      w.clock.ms = NOW + PROPOSE_DEADLINE_MS - SCORING_RESERVE_MS + 1;
      return goldenQuotes(input);
    };
    const result = await w.run();
    expectFailed(result, 'deadline');
    expect(w.trace).not.toContain('scoring');
    expectQuotesKept(result);
  });

  it('starts with exactly the reserve left: the twin of the failure above', async () => {
    const w = world();
    w.script.quotes = async (input) => {
      w.clock.ms = NOW + PROPOSE_DEADLINE_MS - SCORING_RESERVE_MS;
      return goldenQuotes(input);
    };
    proposed(await w.run());
    expect(w.trace).toContain('scoring');
  });

  it('gives the scorers the date of the clock when they start', async () => {
    const w = world();
    const later = Date.UTC(2026, 11, 1, 3, 0, 0);
    w.script.quotes = async (input) => {
      w.clock.ms = later;
      return goldenQuotes(input);
    };
    proposed(await w.run({ arrivedAt: later - 1_000_000 }));
    expect(w.calls.scoring[0]!.input.today).toBe('2026-12-01');
  });

  it('fails with the code of a failed scoring, keeps the decisions that the scorers made, and ranks nothing', async () => {
    const [first, second] = scoreDecisions();
    const w = world();
    w.script.scoring = async () => ({ ok: false, code: 'scorer_token_failed', decisions: [first!, second!] });
    const result = await w.run();
    expectFailed(result, 'scorer_token_failed');
    expectQuotesKept(result, [first!, second!]);
    expect(w.trace).not.toContain('rank');
  });

  it('keeps only the decisions that are decisions, and turns the words of a scoring into internal', async () => {
    const [first] = scoreDecisions();
    const w = world();
    w.script.scoring = async () => ({ ok: false, code: 'The scorer broke.', decisions: [first!, {} as never, 'a text' as never] });
    const result = await w.run();
    expectFailed(result, 'internal');
    expectQuotesKept(result, [first!]);
  });

  const SCORES = (): ReturnType<typeof scoredOf>[] => BIDDERS.map((did, index) => scoredOf(did, index + 1));
  const WRONG: [string, () => unknown][] = [
    ['nothing', () => undefined],
    ['a failure with no code and no decisions', () => ({ ok: false })],
    ['no scores', () => ({ ok: true })],
    ['scores that are no list', () => ({ ok: true, scores: 'x' })],
    ['one score too few', () => ({ ok: true, scores: SCORES().slice(0, 2) })],
    ['one score too many', () => ({ ok: true, scores: [...SCORES(), scoredOf(DELTA, 4)] })],
    ['the score of another bidder: the scores in another order', () => ({ ok: true, scores: [SCORES()[1], SCORES()[0], SCORES()[2]] })],
    ['the score of a bidder that was not scored', () => ({ ok: true, scores: [SCORES()[0], SCORES()[1], scoredOf(DELTA, 4)] })],
    ['a score with no decision', () => ({ ok: true, scores: [{ ...SCORES()[0], decision: undefined }, SCORES()[1], SCORES()[2]] })],
    ['a decision with no sub-job', () => ({ ok: true, scores: [{ ...SCORES()[0], decision: { ...SCORES()[0]!.decision, inference: null } }, SCORES()[1], SCORES()[2]] })],
  ];
  it.each(WRONG)('fails with internal when the scoring gives %s, and ranks nothing', async (_name, answer) => {
    const w = world();
    w.script.scoring = async () => answer() as never;
    expectFailed(await w.run(), 'internal');
    expect(w.trace).not.toContain('rank');
  });

  it('keeps the decision of every scorer when the scores are those of other bidders: each was paid for', async () => {
    const w = world();
    w.script.scoring = async () => ({ ok: true, scores: [SCORES()[1]!, SCORES()[0]!, SCORES()[2]!] });
    const result = await w.run();
    expectFailed(result, 'internal');
    expectQuotesKept(result, [SCORES()[1]!.decision, SCORES()[0]!.decision, SCORES()[2]!.decision]);
  });

  const components = { price: 90, lead_time: 90, reliability: 90, compliance: 90 };
  const NUMBERS: [string, unknown][] = [
    ['a component above 100', { components: { ...components, price: 101 }, score: 90 }],
    ['a component below 0', { components: { ...components, lead_time: -1 }, score: 90 }],
    ['a component that is a text', { components: { ...components, reliability: '90' }, score: 90 }],
    ['a missing component', { components: { price: 90, lead_time: 90, reliability: 90 }, score: 90 }],
    ['a component that is not listed', { components: { ...components, speed: 90 }, score: 90 }],
    ['a score above 100', { components, score: 100.5 }],
    ['a score that is NaN', { components, score: Number.NaN }],
    ['a score that is a text', { components, score: '90' }],
    ['no components', { score: 90 }],
    ['nothing', undefined],
  ];
  it.each(NUMBERS)('fails with ranking_invalid when a scorer gives %s, because the kit does not take the number, keeps every decision of the scorers, and ranks nothing', async (_name, choice) => {
    const w = world();
    w.script.scoring = async (input) => {
      const given = goldenScoring(input);
      if (!given.ok) throw new Error('a scripted answer');
      return { ok: true, scores: [{ ...given.scores[0]!, choice: choice as never }, ...given.scores.slice(1)] };
    };
    const result = await w.run();
    expectFailed(result, 'ranking_invalid');
    expectQuotesKept(result, scoreDecisions());
    expect(w.trace).not.toContain('rank');
  });

  it('fails with internal when the scoring throws, and with deadline when it never answers, and keeps the quotes', async () => {
    const throwing = world();
    throwing.script.scoring = async () => {
      throw new Error('the scorers broke');
    };
    const thrown = await throwing.run();
    expectFailed(thrown, 'internal');
    expectQuotesKept(thrown);
    const silent = world();
    silent.script.scoring = () => new Promise(() => undefined);
    const late = await pastDeadline(silent);
    expectFailed(late, 'deadline');
    expectQuotesKept(late);
    expect(silent.trace).not.toContain('rank');
  });

  it('reads the signal before the ranking decision: a caller that hangs up during the scoring gets `aborted`, the model is not asked, and the scores stay', async () => {
    const controller = new AbortController();
    const w = world();
    w.script.scoring = async (input) => {
      controller.abort();
      return goldenScoring(input);
    };
    const result = await w.run({ signal: controller.signal });
    expectFailed(result, 'aborted');
    expect(w.trace).not.toContain('rank');
    expectQuotesKept(result, scoreDecisions());
  });
});

describe('the ranking decision', () => {
  it('fails with the code of a failed decision, and keeps every decision and every quote that was paid for', async () => {
    const w = world();
    w.script.rank = async () => ({ ok: false, code: 'llm_out_of_time' });
    const result = await w.run();
    expectFailed(result, 'llm_out_of_time');
    expectQuotesKept(result, scoreDecisions());
  });

  it('turns the words of a decision into internal, and an answer that is no answer, and a decision with no sub-job, into internal with no decision of the ranking', async () => {
    const words = world();
    words.script.rank = async () => ({ ok: false, code: 'The model said no.' });
    expectFailed(await words.run(), 'internal');
    for (const value of [undefined, 'a text', { ok: true, decision: {}, choice: { order: [], tie_break: '' } }]) {
      const w = world();
      w.script.rank = async () => value as never;
      const result = await w.run();
      expectFailed(result, 'internal');
      expectQuotesKept(result, scoreDecisions());
    }
  });

  it('fails with decision_mismatch when the typed choice is not the recorded choice, and keeps the decision as it was recorded', async () => {
    const recorded = rankAnswer([ALFA, CHARLIE, BRAVO]);
    const w = world();
    w.script.rank = async () => ({ ok: true, decision: recorded.decision, choice: { order: [BRAVO, CHARLIE, ALFA], tie_break: '' } });
    const result = await w.run();
    expectFailed(result, 'decision_mismatch');
    expectQuotesKept(result, [...scoreDecisions(), recorded.decision]);
  });

  it('fails with bad_document when a choice is no JSON, and keeps the decision', async () => {
    const given = rankAnswer([ALFA, CHARLIE, BRAVO]);
    const w = world();
    w.script.rank = async () => ({ ok: true, decision: { ...given.decision, choice: undefined as never }, choice: given.choice });
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(namesOf(result.decisions).at(-1)).toBe('ranking');
  });

  const ORDERS: [string, unknown][] = [
    ['a bidder missing', { order: [ALFA, CHARLIE], tie_break: '' }],
    ['a bidder too many', { order: [ALFA, CHARLIE, BRAVO, DELTA], tie_break: '' }],
    ['a bidder two times and another missing', { order: [ALFA, CHARLIE, CHARLIE], tie_break: '' }],
    ['the first bidder three times', { order: [ALFA, ALFA, ALFA], tie_break: '' }],
    ['a bidder that was not scored in place of a scored one', { order: [ALFA, CHARLIE, DELTA], tie_break: '' }],
    ['no bidder', { order: [], tie_break: '' }],
    ['an order that is no list', { order: ALFA, tie_break: '' }],
    ['entries that are no DIDs', { order: [ALFA, 1, 2], tie_break: '' }],
    ['no order', { tie_break: '' }],
  ];
  it.each(ORDERS)('fails with ranking_invalid when the order has %s, and keeps the decision of the ranking', async (_name, choice) => {
    const w = world();
    w.script.rank = async () => ({ ok: true, decision: decisionOf('ranking', choice as JsonValue, 2), choice: choice as never });
    const result = await w.run();
    expectFailed(result, 'ranking_invalid');
    expect(namesOf(result.decisions).at(-1)).toBe('ranking');
    expectQuotesKept(result, [...scoreDecisions(), decisionOf('ranking', choice as JsonValue, 2)]);
  });

  it('refuses a bidder that was excluded: the order may not hold a bidder that the model did not invite', async () => {
    const w = world();
    w.script.discover = async () => ({ ok: true, value: { bidders: [...BIDDERS.map((did, index) => viewOf(fileOf(did, index + 1, NAMES[index]!), index + 1)), viewOf(fileOf(DELTA, 4, 'delta'), 4)] } });
    w.script.shortlist = async () => shortlistAnswer([ALFA, BRAVO]);
    w.script.rank = async () => rankAnswer([ALFA, DELTA]);
    expectFailed(await w.run(), 'ranking_invalid');
    const twin = world();
    twin.script.shortlist = async () => shortlistAnswer([ALFA, BRAVO]);
    twin.script.rank = async () => rankAnswer([BRAVO, ALFA]);
    proposed(await twin.run());
  });

  it('fails with internal when the decision throws, and with deadline when it never answers, and keeps every payment', async () => {
    const throwing = world();
    throwing.script.rank = async () => {
      throw new Error('the model broke');
    };
    const thrown = await throwing.run();
    expectFailed(thrown, 'internal');
    expectQuotesKept(thrown, scoreDecisions());
    const silent = world();
    silent.script.rank = () => new Promise(() => undefined);
    const late = await pastDeadline(silent);
    expectFailed(late, 'deadline');
    expectQuotesKept(late, scoreDecisions());
  });

  it('starts only when the time that is left is at least the ranking reserve: with one millisecond less, the job fails with deadline, asks the model nothing, and keeps every paid answer', async () => {
    const w = world();
    w.script.scoring = async (input) => {
      w.clock.ms = NOW + PROPOSE_DEADLINE_MS - RANKING_RESERVE_MS + 1;
      return goldenScoring(input);
    };
    const result = await w.run();
    expectFailed(result, 'deadline');
    expect(w.trace).not.toContain('rank');
    expectQuotesKept(result, scoreDecisions());
  });

  it('asks the model with exactly the ranking reserve left: the twin of the failure above', async () => {
    const w = world();
    w.script.scoring = async (input) => {
      w.clock.ms = NOW + PROPOSE_DEADLINE_MS - RANKING_RESERVE_MS;
      return goldenScoring(input);
    };
    proposed(await w.run());
    expect(w.trace).toContain('rank');
  });
});

describe('the result forms', () => {
  const held = { decisions: [shortlistDecision()], sub_jobs: [quoted()[0]!.sub_job], bidders: [fileOf(ALFA, 1, 'alfa')], quotes: [quoted()[0]!.record] };

  it('keeps what the job holds in a proposal that the kit refuses: the failed result bad_document, with the files and the records', () => {
    const result = proposedSourcing({ schema: 'a text that is no schema' }, held);
    expectFailed(result, 'bad_document');
    expect(result).toMatchObject({ decisions: held.decisions, sub_jobs: held.sub_jobs, bidders: held.bidders, quotes: held.quotes });
  });

  it('turns a reason that is no code into internal, and keeps the reason that is a code', () => {
    expectFailed(failedSourcing(held, 'The model said no.'), 'internal');
    expectFailed(failedSourcing(held, 7), 'internal');
    expectFailed(failedSourcing(held, 'a_code'), 'a_code');
  });

  it('copies the lists: a list that the job changes later changes no result', () => {
    const lists = { ...held, bidders: [fileOf(ALFA, 1, 'alfa')], quotes: [quoted()[0]!.record] };
    const result = failedSourcing(lists, 'a_code');
    lists.bidders.push(fileOf(BRAVO, 2, 'bravo'));
    lists.quotes.push(quoted()[1]!.record);
    expect(result.bidders).toHaveLength(1);
    expect(result.quotes).toHaveLength(1);
  });
});

describe('the codes', () => {
  /** One run for each code that the job gives itself. */
  const SCENARIOS: [string, () => Promise<SourcingResult>][] = [
    ['ledger_unavailable', () => failing((w) => { w.script.delegation = async () => { throw new Error('the ledger is down'); }; })],
    ['delegation_not_found', () => failing((w) => { w.script.delegation = async () => null; w.script.delegateKeyOf = async () => null; })],
    ['delegation_key_unknown', () => failing((w) => { w.script.delegateKeyOf = async () => 'ee'.repeat(28); })],
    ['bidders_unavailable', () => failing((w) => { w.script.discover = async () => ({ ok: false, code: 'bidders_unavailable', detail: 'x' }); })],
    ['no_bidders', () => failing((w) => { w.script.discover = async () => ({ ok: false, code: 'no_bidders', detail: 'x' }); })],
    ['shortlist_unknown_bidder', () => failing((w) => { w.script.shortlist = async () => shortlistAnswer([DELTA]); })],
    ['nobody_invited', () => failing((w) => { w.script.shortlist = async () => shortlistAnswer([]); })],
    ['no_quotes', () => failing((w) => { w.script.quotes = async () => fanOf([excludedOf(ALFA, 'failed', 'deadline'), excludedOf(BRAVO, 'failed', 'deadline'), excludedOf(CHARLIE, 'failed', 'deadline')]); })],
    ['deadline', () => failing((w) => w.run({ arrivedAt: arrivedWith(-1) }))],
    ['ranking_invalid', () => failing((w) => { w.script.rank = async () => rankAnswer([ALFA]); })],
    ['bad_document', () => failing((w) => { w.script.shortlist = async () => ({ ok: true, decision: decisionOf('shortlist', { not_invited: [] }, 1), choice: { not_invited: [] } as never }); })],
    ['decision_mismatch', () => failing((w) => { w.script.shortlist = async () => ({ ok: true, decision: shortlistAnswer([ALFA]).decision, choice: { invite: [BRAVO], not_invited: [] } }); })],
    ['aborted', () => { const controller = new AbortController(); controller.abort(); return world().run({ signal: controller.signal }); }],
    ['internal', () => failing((w) => { w.script.findKey = () => { throw new Error('the table is broken'); }; })],
  ];

  /** Runs a world that `change` prepares, unless `change` runs it. */
  async function failing(change: (w: World) => unknown): Promise<SourcingResult> {
    const w = world();
    const own = change(w);
    return own instanceof Promise ? (own as Promise<SourcingResult>) : w.run();
  }

  it('gives each code of its list for one failure, and no code that is not in the list', async () => {
    const seen: string[] = [];
    for (const [code, scenario] of SCENARIOS) {
      const result = await scenario();
      expect(result.reason, `the scenario of ${code}`).toBe(code);
      seen.push(result.reason as string);
    }
    expect([...seen].sort()).toStrictEqual([...PROPOSE_FAILURES].sort());
  });
});
