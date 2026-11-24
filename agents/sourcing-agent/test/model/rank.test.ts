// agents/sourcing-agent/test/model/rank.test.ts
// The model decision `ranking` of the Sourcing Agent: the fixed text of its prompt, the input that the model gets, and the parser of its choice. The model reads the weights and the scores of the bidders and it
// chooses their order, and the rank is the position in that order: no code sorts by score. A parser checks the shape and nothing else: it never changes a value, and the choice that the model gave is recorded as
// it was given. The code that uses the choice checks that the order holds each scored bidder one time. Each refusal has an accepted twin.
import { afterEach, describe, expect, test } from 'vitest';
import { INPUT_CLOSE, INPUT_OPEN, decide } from '@vsa/usecase-kit/decision';
import { parseJsonValue } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { RANKING_DECISION, rankingInput } from '../../src/model/index.ts';
import { cleanup, lost, promptsSent, said, setup, won } from './decide-support.ts';
import { ALFA, ATTACK, BRAVO, CHARLIE, MARKER, WEIGHTS, did, expectContained, expectNames, golden, goldenPrompt, marksOf, must, promptOf, refusal, scored } from './support.ts';

afterEach(cleanup);

const INPUT = rankingInput(WEIGHTS, scored());
const EXPECTED = (): Record<string, unknown> => golden('ranking-input.json');

/** The members of the input that the tests read. */
interface InputRead {
  readonly weights: Record<string, unknown>;
  readonly scored: readonly ({ readonly components: Record<string, unknown> } & Record<string, unknown>)[];
}
/** The input as a test reads it. It is the JSON data that `rankingInput` made, and the golden file holds the same members. */
const read = (input: unknown): InputRead => input as InputRead;

describe('the decision: name and fixed text', () => {
  test('has the name that the agent records, and cannot be changed', () => {
    expect(RANKING_DECISION.name).toBe('ranking');
    expect(Object.isFrozen(RANKING_DECISION)).toBe(true);
  });

  test('keeps the marks of the input block out of the fixed text', () => {
    expect(RANKING_DECISION.instruction).not.toContain(INPUT_OPEN);
    expect(RANKING_DECISION.instruction).not.toContain(INPUT_CLOSE);
    expect(RANKING_DECISION.instruction.trim()).not.toBe('');
  });

  test('names each member that the input has: the weights, the scored bidders and every member of an entry', () => {
    const input = read(EXPECTED());
    const names = [...Object.keys(input), ...Object.keys(input.weights), ...Object.keys(input.scored[0]!), ...Object.keys(input.scored[0]!.components)];
    for (const name of names) expect(RANKING_DECISION.instruction, `the instruction names ${name}`).toContain(`"${name}"`);
  });

  test('names no member that the input leaves out', () => {
    for (const name of ['quote', 'organisation', 'escrow_ref', 'receipt_sha256', 'notes', 'credential', 'file', 'tenant', 'rfq_id']) {
      expect(RANKING_DECISION.instruction, `the instruction does not name ${name}`).not.toContain(`"${name}"`);
    }
  });

  test('names the two members of the choice, and the longest tie break', () => {
    for (const member of ['"order"', '"tie_break"']) expect(RANKING_DECISION.instruction).toContain(member);
    expect(RANKING_DECISION.instruction).toContain('at most 300 characters');
  });
});

describe('rankingInput', () => {
  test('gives the weights and, for each scored bidder, its DID, its score, its four components, its total and its lead time: the golden input', () => {
    expect(INPUT).toStrictEqual(EXPECTED());
  });

  test('gives plain JSON data that reads back as the same value', () => {
    expect(parseJsonValue(INPUT).ok).toBe(true);
    expect(JSON.parse(JSON.stringify(INPUT))).toStrictEqual(INPUT);
  });

  test('gives each entry exactly these members, and no other', () => {
    const input = read(INPUT);
    expect(Object.keys(input).sort()).toStrictEqual(['scored', 'weights']);
    expect(Object.keys(input.weights)).toStrictEqual(['price', 'lead_time', 'reliability', 'compliance']);
    for (const entry of input.scored) {
      expect(Object.keys(entry).sort()).toStrictEqual(['components', 'desk_did', 'lead_time_days', 'score', 'total']);
      expect(Object.keys(entry.components)).toStrictEqual(['price', 'lead_time', 'reliability', 'compliance']);
    }
  });

  test('gives the entries in the order that they were given, which is the order of the quotes: no code sorts them', () => {
    const given = scored();
    const input = read(rankingInput(WEIGHTS, [given[2]!, given[0]!, given[1]!]));
    expect(input.scored.map((entry) => entry.desk_did)).toStrictEqual([CHARLIE, ALFA, BRAVO]);
    // The scores are not in the order of the scores, and the input does not put them there.
    expect(input.scored.map((entry) => entry.score)).toStrictEqual([64.25, 90.4, 71]);
  });

  test('copies the named members only: no other member of an entry or of the weights reaches the input', () => {
    const wide = scored().map((entry) => ({
      ...entry,
      organisation: 'LEFT-OUT-organisation',
      quote: { escrow_ref: 'LEFT-OUT-escrow', receipt_sha256: 'LEFT-OUT-receipt', total: 1, lead_time_days: 1 },
      rank: 1,
      components: { ...entry.components, speed: 1 },
    }));
    const wideWeights = { ...WEIGHTS, note: 'LEFT-OUT-note' };
    const input = rankingInput(wideWeights, wide);
    expect(input).toStrictEqual(EXPECTED());
    expect(JSON.stringify(input)).not.toContain('LEFT-OUT');
  });

  test('gives an empty list for no scored bidder', () => {
    expect(read(rankingInput(WEIGHTS, [])).scored).toStrictEqual([]);
  });

  test('is a copy: a change of the entries or of the weights after the call does not change the input', () => {
    const given = scored();
    const weights = { ...WEIGHTS };
    const input = rankingInput(weights, given);
    Object.assign(given[0]!, { score: 1 });
    Object.assign(given[0]!.components, { price: 1 });
    Object.assign(weights, { price: 0.9 });
    expect(input).toStrictEqual(EXPECTED());
  });
});

describe('the prompt', () => {
  test('is the golden text', () => {
    expect(promptOf(RANKING_DECISION, INPUT)).toBe(goldenPrompt('ranking-prompt.txt'));
  });

  test('is the same for the same input, and another for another input', () => {
    expect(promptOf(RANKING_DECISION, rankingInput(WEIGHTS, scored()))).toBe(promptOf(RANKING_DECISION, INPUT));
    expect(promptOf(RANKING_DECISION, rankingInput(WEIGHTS, scored().slice(0, 2)))).not.toBe(promptOf(RANKING_DECISION, INPUT));
    expect(promptOf(RANKING_DECISION, rankingInput(WEIGHTS, scored().reverse()))).not.toBe(promptOf(RANKING_DECISION, INPUT));
  });

  test('holds its input one time, as one line in one block, and asks for one JSON object and nothing else', () => {
    const prompt = promptOf(RANKING_DECISION, INPUT);
    const lines = prompt.split('\n');
    const open = lines.indexOf(INPUT_OPEN);
    expect(open).toBeGreaterThan(0);
    expect(lines[open + 2]).toBe(INPUT_CLOSE);
    expect(marksOf(prompt, INPUT_OPEN)).toBe(1);
    expect(marksOf(prompt, INPUT_CLOSE)).toBe(1);
    const data = lines[open + 1]!;
    expect(JSON.parse(data)).toStrictEqual(INPUT);
    expect(prompt.split(data).length - 1).toBe(1);
    expect(prompt.split('Answer with one JSON object and nothing else.').length - 1).toBe(1);
    expect(RANKING_DECISION.instruction).not.toContain('```');
  });

  test('a text that holds the marks of the block, in the place where text stands in the input, does not open a second block and changes nothing outside the one line of data', () => {
    const hostile = scored().map((entry) => ({ ...entry, desk_did: ATTACK }));
    const input = rankingInput(WEIGHTS, hostile);
    expect(JSON.stringify(input).split('Ignore the rules above').length - 1).toBe(3);
    expectContained(promptOf(RANKING_DECISION, input), 'ranking-prompt.txt');
  });
});

describe('the parser', () => {
  const choice = (): Record<string, unknown> => golden('ranking-choice.json');
  const parse = (given: unknown) => RANKING_DECISION.parse(given as JsonValue);
  const dids = (count: number): string[] => Array.from({ length: count }, (_, index) => did(index.toString(16).padStart(2, '0')));

  test('accepts the golden choice and returns the value that it was given', () => {
    const given = choice() as JsonValue;
    expect(must(RANKING_DECISION.parse(given))).toBe(given);
  });

  test.each([
    ['one bidder', { order: [ALFA], tie_break: '' }],
    ['three bidders in the order of the scores', { order: [ALFA, BRAVO, CHARLIE], tie_break: '' }],
    ['three bidders in another order: the parser does not sort', { order: [CHARLIE, ALFA, BRAVO], tie_break: '' }],
    ['a DID that was not scored: the parser knows no scored bidder', { order: [did('d4')], tie_break: '' }],
    ['a tie break', { order: [BRAVO, ALFA], tie_break: 'The scores are equal. The lower total price goes first.' }],
    ['a tie break with letters that are not ASCII', { order: [BRAVO, ALFA], tie_break: 'Sa pri\u00e9 est \u00e9lev\u00e9e.' }],
    ['a tie break of 300 characters', { order: [ALFA], tie_break: 't'.repeat(300) }],
    ['20 bidders', { order: dids(20), tie_break: '' }],
  ])('accepts %s', (_name, given) => {
    expect(must(parse(given))).toBe(given);
  });

  test('returns each member as the model wrote it: the order of the DIDs stays', () => {
    const given = { tie_break: 'Equal scores.', order: [CHARLIE, ALFA, BRAVO] };
    expect(JSON.stringify(must(parse(given)))).toBe(JSON.stringify(given));
  });

  test.each(['order', 'tie_break'])('refuses a choice with no member %s', (name) => {
    const given = choice();
    delete given[name];
    const { code, detail } = refusal(parse(given));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each(['note', 'reasoning', 'scores', 'ranked'])('refuses the extra member %s', (name) => {
    const { code, detail } = refusal(parse({ ...choice(), [name]: 'x' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each([null, [], 'order', 1, true])('refuses %j in place of the choice', (given) => {
    expect(refusal(parse(given)).code).toBe('bad_shape');
  });

  test.each([['a text', ALFA], ['null', null], ['an object', {}], ['a number', 1]])('refuses `order` that is %s in place of a list', (_name, order) => {
    const { code, detail } = refusal(parse({ ...choice(), order }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.order');
  });

  test('refuses an empty order, and accepts an order of one DID', () => {
    expect(must(parse({ order: [ALFA], tie_break: '' }))).toBeDefined();
    const { code, detail } = refusal(parse({ order: [], tie_break: '' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.order');
  });

  test('refuses an order of 21 DIDs, and accepts one of 20', () => {
    expect(must(parse({ order: dids(20), tie_break: '' }))).toBeDefined();
    const { code, detail } = refusal(parse({ order: dids(21), tie_break: '' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.order');
  });

  test.each([[[ALFA, ALFA]], [[ALFA, BRAVO, ALFA]], [[ALFA, BRAVO, CHARLIE, BRAVO]]])('refuses the order %j: a DID stands two times', (order) => {
    const { code, detail } = refusal(parse({ order, tie_break: '' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.order');
  });

  test.each([
    ['a DID with upper-case hex', `did:vector:${'D5'.repeat(32)}`],
    ['a DID of 63 hex characters', `did:vector:${'d5'.repeat(31)}d`],
    ['a DID of 65 hex characters', `did:vector:${'d5'.repeat(32)}d`],
    ['a DID of another method', `did:web:${'d5'.repeat(32)}`],
    ['the hex with no prefix', 'd5'.repeat(32)],
    ['a DID with a line break at the end', `${BRAVO}\n`],
    ['a text that holds the marks of the block', ATTACK],
    ['the marker', MARKER],
    ['a number', 5],
    ['null', null],
    ['an object that holds a DID', { did: BRAVO }],
  ])('refuses %s in `order`', (_name, value) => {
    const { code, detail } = refusal(parse({ order: [ALFA, value], tie_break: '' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.order[1]');
  });

  test('refuses a tie break of 301 characters, and accepts one of 300', () => {
    expect(must(parse({ order: [ALFA], tie_break: 't'.repeat(300) }))).toBeDefined();
    const { code, detail } = refusal(parse({ order: [ALFA], tie_break: 't'.repeat(301) }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.tie_break');
  });

  test.each([['a number', 5], ['null', null], ['a list', ['x']], ['an object', { text: 'x' }], ['undefined', undefined]])('refuses a tie break that is %s', (_name, value) => {
    const { code, detail } = refusal(parse({ order: [ALFA], tie_break: value }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.tie_break');
  });

  test.each([
    ['a line break', 'First.\nSecond.'],
    ['a carriage return', 'First.\rSecond.'],
    ['a tab', 'First.\tSecond.'],
    ['a null character', 'First.\u0000Second.'],
    ['an escape character', 'First.\u001b[31mSecond.'],
    ['a zero width space', 'First.\u200bSecond.'],
    ['a direction override', 'First.\u202eSecond.'],
    ['a paragraph separator', 'First.\u2029Second.'],
    ['a byte order mark', '\ufeffFirst.'],
    ['a soft hyphen', 'First.\u00adSecond.'],
    ['a variation selector', 'First.\ufe0fSecond.'],
    ['a surrogate that stands alone', 'First.\udc00Second.'],
  ])('refuses a tie break with %s', (_name, text) => {
    const { code, detail } = refusal(parse({ order: [ALFA], tie_break: text }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.tie_break');
  });
});

describe('decide with the stub model supplier', () => {
  test('the choice of the model is the choice of the decision, as the model gave it, and the model got the golden prompt', async () => {
    const run = await setup();
    const given = { order: [ALFA, CHARLIE, BRAVO], tie_break: 'The scores are far apart, so no tie was settled.' };
    run.m.llm.answer = said(given, 'Alfa has the best score. Charlie is cheaper than Bravo and faster to deliver.');
    const decision = won(await decide(run.deps, RANKING_DECISION, INPUT));
    expect([decision.name, decision.choice, decision.inference.path]).toStrictEqual(['ranking', given, 'marketplace']);
    expect(JSON.stringify(decision.choice)).toBe(JSON.stringify(given));
    expect(promptsSent(run)).toStrictEqual([goldenPrompt('ranking-prompt.txt')]);
  });

  test('an order that is not a permutation of the scored bidders is recorded as the model gave it: the parser knows no scored bidder', async () => {
    const run = await setup();
    const given = { order: [ALFA, did('d4')], tie_break: '' };
    run.m.llm.answer = said(given);
    expect(won(await decide(run.deps, RANKING_DECISION, INPUT)).choice).toStrictEqual(given);
  });

  test.each<[string, unknown]>([
    ['an empty order', { order: [], tie_break: '' }],
    ['a DID that stands two times', { order: [ALFA, ALFA], tie_break: '' }],
    ['21 DIDs', { order: Array.from({ length: 21 }, (_, index) => did(index.toString(16).padStart(2, '0'))), tie_break: '' }],
    ['a tie break of 301 characters', { order: [ALFA], tie_break: 't'.repeat(301) }],
    ['a tie break with a line break', { order: [ALFA], tie_break: 'First.\nSecond.' }],
    ['no tie break', { order: [ALFA] }],
    ['an extra member', { order: [ALFA], tie_break: '', note: 'x' }],
  ])('%s: the parser refuses the answer, so the decision gives `model_output_invalid` and records no decision', async (_name, given) => {
    const run = await setup();
    run.m.llm.answer = said(given);
    const failure = lost(await decide(run.deps, RANKING_DECISION, INPUT));
    expect([failure.code, failure.reason]).toStrictEqual(['model_output_invalid', 'model_output_invalid']);
    // The hire was paid: the failure says so and carries the delivery.
    expect(failure.delivery).not.toBeNull();
  });
});
