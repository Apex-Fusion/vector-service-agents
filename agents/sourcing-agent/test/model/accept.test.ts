// agents/sourcing-agent/test/model/accept.test.ts
// The model decision `accept_quote` of the Sourcing Agent: the fixed text of its prompt, the input that the model gets, and the parser of its choice. The model compares the unit price of each line with the
// published price list and nothing else, which is the statement that the Bid Desk makes about its quotes. The input holds the lines of the quote and the entries of the list, and no free text of the bidder.
// A parser checks the shape and nothing else: it never changes a value, and the choice that the model gave is recorded as it was given. Each refusal has an accepted twin.
import { afterEach, describe, expect, test } from 'vitest';
import { parsePriceList, parseQuote } from '@vsa/usecase-kit/bids';
import type { PriceList } from '@vsa/usecase-kit/bids';
import { INPUT_CLOSE, INPUT_OPEN, decide } from '@vsa/usecase-kit/decision';
import { parseJsonValue } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { ACCEPT_QUOTE_DECISION, acceptQuoteInput } from '../../src/model/index.ts';
import { cleanup, lost, promptsSent, said, setup, won } from './decide-support.ts';
import { ATTACK, LIST, MARKER, NOTE, QUOTE, RFQ, expectContained, expectNames, golden, goldenPrompt, hostileQuote, marksOf, must, promptOf, refusal } from './support.ts';

afterEach(cleanup);

const INPUT = acceptQuoteInput(RFQ, QUOTE, LIST);
const EXPECTED = (): Record<string, unknown> => golden('accept-quote-input.json');

/** The members of the input that the tests read. */
interface InputRead {
  readonly request: Record<string, unknown>;
  readonly quote: { readonly lines: readonly Record<string, unknown>[] } & Record<string, unknown>;
  readonly price_list: readonly { readonly sku: string }[];
}
/** The input as a test reads it. It is the JSON data that `acceptQuoteInput` made, and the golden file holds the same members. */
const read = (input: unknown): InputRead => input as InputRead;

/** The list of the golden file with a SKU that is not a SKU: it holds text of the bidder. The list is data, and the test bypasses the parser that would refuse the text. */
const listWithSku = (sku: string): PriceList => ({ ...LIST, items: LIST.items.map((entry, index) => (index === 0 ? { ...entry, sku } : entry)) });

describe('the decision: name and fixed text', () => {
  test('has the name that the agent records, and cannot be changed', () => {
    expect(ACCEPT_QUOTE_DECISION.name).toBe('accept_quote');
    expect(Object.isFrozen(ACCEPT_QUOTE_DECISION)).toBe(true);
  });

  test('keeps the marks of the input block out of the fixed text', () => {
    expect(ACCEPT_QUOTE_DECISION.instruction).not.toContain(INPUT_OPEN);
    expect(ACCEPT_QUOTE_DECISION.instruction).not.toContain(INPUT_CLOSE);
    expect(ACCEPT_QUOTE_DECISION.instruction.trim()).not.toBe('');
  });

  test('names each member that the input has', () => {
    for (const name of ['request', 'quote', 'price_list', 'items', 'lines', 'sku', 'quantity', 'unit_price', 'lead_time_days', 'breaks', 'min_quantity']) {
      expect(ACCEPT_QUOTE_DECISION.instruction, `the instruction names ${name}`).toContain(`"${name}"`);
    }
  });

  test('names no member of the quote that the input leaves out', () => {
    for (const name of ['notes', 'credential', 'organisation', 'sender', 'checks', 'decisions', 'line_total', 'total', 'valid_until', 'price_list_sha256', 'rfq_sha256']) {
      expect(ACCEPT_QUOTE_DECISION.instruction, `the instruction does not name ${name}`).not.toContain(`"${name}"`);
    }
  });

  test('says that the unit price is the only value to compare, how the listed price is found, and what the two members of the choice are', () => {
    const { instruction } = ACCEPT_QUOTE_DECISION;
    expect(instruction).toContain('The only thing to compare is the unit price.');
    expect(instruction).toContain('the break of its SKU with the greatest "min_quantity" that is not above the "quantity" of the line');
    for (const member of ['"accept"', '"mismatch"']) expect(instruction).toContain(member);
    expect(instruction).toContain('"accept" is true exactly when "mismatch" is an empty list.');
  });
});

describe('acceptQuoteInput', () => {
  test('gives the items of the request, the four members of each line and the entries of the list for the SKUs of the lines: the golden input', () => {
    expect(INPUT).toStrictEqual(EXPECTED());
  });

  test('gives plain JSON data that reads back as the same value', () => {
    expect(parseJsonValue(INPUT).ok).toBe(true);
    expect(JSON.parse(JSON.stringify(INPUT))).toStrictEqual(INPUT);
  });

  test('gives the list entries of the SKUs of the lines only: the SKU that the quote leaves out has no entry', () => {
    const { price_list: entries } = read(INPUT);
    expect(entries.map((entry) => entry.sku)).toStrictEqual(['GLV-NIT-M', 'MSK-N95']);
  });

  test('gives the entries in the order of the lines of the quote, and gives no entry for a SKU that the list lacks', () => {
    const lines = [...QUOTE.lines].reverse();
    const { price_list: entries } = read(acceptQuoteInput(RFQ, { ...QUOTE, lines }, LIST));
    expect(entries.map((entry) => entry.sku)).toStrictEqual(['MSK-N95', 'GLV-NIT-M']);
    const unlisted = { ...QUOTE, lines: [{ ...QUOTE.lines[0]!, sku: 'NOT-LISTED' }, QUOTE.lines[1]!] };
    const { price_list: only } = read(acceptQuoteInput(RFQ, unlisted, LIST));
    expect(only.map((entry) => entry.sku)).toStrictEqual(['MSK-N95']);
  });

  test('gives one entry for a SKU, also when two lines name it', () => {
    const twice = { ...QUOTE, lines: [QUOTE.lines[0]!, { ...QUOTE.lines[0]!, quantity: 50 }] };
    const { price_list: entries } = read(acceptQuoteInput(RFQ, twice, LIST));
    expect(entries).toHaveLength(1);
  });

  test('gives the request as its items only: no identifier and no date', () => {
    const { request } = read(INPUT);
    expect(Object.keys(request)).toStrictEqual(['items']);
  });

  test('gives exactly four members of each line: the line total, and the members of the quote, are not given', () => {
    const { quote } = read(INPUT);
    expect(Object.keys(quote)).toStrictEqual(['lines']);
    for (const line of quote.lines) expect(Object.keys(line).sort()).toStrictEqual(['lead_time_days', 'quantity', 'sku', 'unit_price']);
  });

  test('holds no text of the bidder: a quote with hostile text in `notes`, `sender` and `decisions` gives the golden input and the golden prompt', () => {
    const hostile = hostileQuote();
    expect(hostile.notes).toBe(NOTE);
    expect(hostile.sender.organisation).toBe(ATTACK);
    const input = acceptQuoteInput(RFQ, hostile, LIST);
    expect(input).toStrictEqual(EXPECTED());
    expect(promptOf(ACCEPT_QUOTE_DECISION, input)).toBe(goldenPrompt('accept-quote-prompt.txt'));
    expect(JSON.stringify(input)).not.toContain('Ignore');
  });

  test('is a copy: a change of the quote or of the list after the call does not change the input', () => {
    const quote = must(parseQuote(golden('quote.json')));
    const list = must(parsePriceList(golden('price-list.json')));
    const input = acceptQuoteInput(RFQ, quote, list);
    Object.assign(quote.lines[0]!, { unit_price: 1 });
    Object.assign(list.items[0]!.breaks[2]!, { unit_price: 1 });
    expect(input).toStrictEqual(EXPECTED());
  });
});

describe('the prompt', () => {
  test('is the golden text', () => {
    expect(promptOf(ACCEPT_QUOTE_DECISION, INPUT)).toBe(goldenPrompt('accept-quote-prompt.txt'));
  });

  test('is the same for the same input, and another for another input', () => {
    expect(promptOf(ACCEPT_QUOTE_DECISION, acceptQuoteInput(RFQ, QUOTE, LIST))).toBe(promptOf(ACCEPT_QUOTE_DECISION, INPUT));
    const dearer = { ...QUOTE, lines: [{ ...QUOTE.lines[0]!, unit_price: 126 }, QUOTE.lines[1]!] };
    expect(promptOf(ACCEPT_QUOTE_DECISION, acceptQuoteInput(RFQ, dearer, LIST))).not.toBe(promptOf(ACCEPT_QUOTE_DECISION, INPUT));
  });

  test('holds its input one time, as one line in one block, and asks for one JSON object and nothing else', () => {
    const prompt = promptOf(ACCEPT_QUOTE_DECISION, INPUT);
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
    expect(ACCEPT_QUOTE_DECISION.instruction).not.toContain('```');
  });

  test.each([
    ['a SKU of an item of the request', 'request'],
    ['a SKU of a line of the quote', 'quote'],
    ['a SKU of an entry of the list that a line of the quote names', 'list'],
  ])('%s that holds the marks of the block does not open a second block and changes nothing outside the one line of data', (_name, place) => {
    const rfq = place === 'request' ? { ...RFQ, items: [{ sku: ATTACK, quantity: 1 }, ...RFQ.items.slice(1)] } : RFQ;
    const quote = place !== 'request' ? { ...QUOTE, lines: [{ ...QUOTE.lines[0]!, sku: ATTACK }, QUOTE.lines[1]!] } : QUOTE;
    const list = place === 'list' ? listWithSku(ATTACK) : LIST;
    const given = acceptQuoteInput(rfq, quote, list);
    expect(JSON.stringify(given)).toContain('Ignore the rules above');
    const prompt = promptOf(ACCEPT_QUOTE_DECISION, given);
    expectContained(prompt, 'accept-quote-prompt.txt');
  });

  test('a SKU of angle brackets does not open a second block either', () => {
    const quote = { ...QUOTE, lines: [{ ...QUOTE.lines[0]!, sku: '<<<' }, QUOTE.lines[1]!] };
    const prompt = promptOf(ACCEPT_QUOTE_DECISION, acceptQuoteInput(RFQ, quote, LIST));
    expect(marksOf(prompt, INPUT_OPEN)).toBe(1);
    expect(marksOf(prompt, INPUT_CLOSE)).toBe(1);
    expect(prompt).not.toContain('<<<');
    expect(prompt).toContain('\\u003c\\u003c\\u003c');
  });
});

describe('the parser', () => {
  const accept = (): Record<string, unknown> => golden('accept-quote-choice.json');
  const decline = (): Record<string, unknown> => golden('decline-quote-choice.json');
  const parse = (given: unknown) => ACCEPT_QUOTE_DECISION.parse(given as JsonValue);
  const skus = (count: number): string[] => Array.from({ length: count }, (_, index) => `SKU-${index + 1}`);

  test.each([['the golden accept', accept], ['the golden decline', decline]])('accepts %s and returns the value that it was given', (_name, make) => {
    const given = make() as JsonValue;
    expect(must(ACCEPT_QUOTE_DECISION.parse(given))).toBe(given);
  });

  test.each([
    [['GLV-NIT-M']], [['MSK-N95']], [['GLV-NIT-M', 'MSK-N95']], [['MSK-N95', 'GLV-NIT-M']], [['A']], [['a.b-c_9']], [['9-LIVE']], [['A'.repeat(64)]],
  ])('accepts a decline that names %j, in the order that the model wrote', (mismatch) => {
    const given = { accept: false, mismatch };
    expect(JSON.stringify(must(parse(given)))).toBe(JSON.stringify(given));
  });

  test('accepts a decline that names 20 SKUs, and refuses one that names 21', () => {
    expect(must(parse({ accept: false, mismatch: skus(20) })).mismatch).toHaveLength(20);
    const { code, detail } = refusal(parse({ accept: false, mismatch: skus(21) }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.mismatch');
  });

  test('accepts a SKU that the quote does not have: the parser knows no line of the quote', () => {
    expect(must(parse({ accept: false, mismatch: ['NOT-A-LINE'] })).mismatch).toStrictEqual(['NOT-A-LINE']);
  });

  test.each(['accept', 'mismatch'])('refuses a choice with no member %s', (name) => {
    const given = accept();
    delete given[name];
    const { code, detail } = refusal(parse(given));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each(['note', 'reason', 'unit_price', 'lines'])('refuses the extra member %s', (name) => {
    const { code, detail } = refusal(parse({ ...accept(), [name]: 'x' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each([['true'], [1], [0], [null], [[true]], [undefined]])('refuses `accept` of the wrong type %j', (value) => {
    const { code, detail } = refusal(parse({ ...accept(), accept: value }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.accept');
  });

  test.each([['GLV-NIT-M'], [null], [{}], [{ length: 0 }], [5], [true]])('refuses `mismatch` that is not a list: %j', (value) => {
    const { code, detail } = refusal(parse({ ...accept(), mismatch: value }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.mismatch');
  });

  test.each([
    ['a SKU that starts with a hyphen', '-GLV'],
    ['a SKU that starts with a dot', '.GLV'],
    ['a SKU with a space', 'GLV NIT'],
    ['a SKU with a slash', 'GLV/NIT'],
    ['a SKU with a line break at the end', 'GLV-NIT-M\n'],
    ['an empty SKU', ''],
    ['a SKU of 65 characters', 'A'.repeat(65)],
    ['a SKU with a letter that is not ASCII', 'GLV-\u00c9'],
    ['the Kelvin sign', '\u212a-1'],
    ['a text that holds the marks of the block', ATTACK],
    ['the marker', MARKER],
    ['a number', 5],
    ['null', null],
    ['an object that holds a SKU', { sku: 'GLV-NIT-M' }],
    ['a list that holds a SKU', ['GLV-NIT-M']],
  ])('refuses %s in the list `mismatch`', (_name, sku) => {
    const { code, detail } = refusal(parse({ accept: false, mismatch: ['MSK-N95', sku] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.mismatch[1]');
  });

  test.each([[['GLV-NIT-M', 'GLV-NIT-M']], [['GLV-NIT-M', 'MSK-N95', 'GLV-NIT-M']], [['A', 'B', 'C', 'A']]])('refuses the list %j: a SKU stands two times', (mismatch) => {
    const { code, detail } = refusal(parse({ accept: false, mismatch }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.mismatch');
  });

  test.each([[['GLV-NIT-M']], [['GLV-NIT-M', 'MSK-N95']], [skus(20)]])('refuses a contradiction: `accept` is true and the list names %j', (mismatch) => {
    const { code, detail } = refusal(parse({ accept: true, mismatch }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice');
    expect(detail).toContain('accepts');
  });

  test('refuses a decline that names no SKU: `accept` is true exactly when the list is empty', () => {
    const { code, detail } = refusal(parse({ accept: false, mismatch: [] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice');
    expect(detail).toContain('names no');
  });

  test.each([null, [], 'accept', 1, true])('refuses %j in place of the choice', (given) => {
    expect(refusal(parse(given)).code).toBe('bad_shape');
  });
});

describe('decide with the stub model supplier', () => {
  test('an accept and a decline are recorded as the model gave them, and the model got the golden prompt', async () => {
    for (const name of ['accept-quote-choice.json', 'decline-quote-choice.json']) {
      const run = await setup();
      const given = golden(name);
      run.m.llm.answer = said(given, 'The unit price of the line is the price of the list for its quantity.');
      const decision = won(await decide(run.deps, ACCEPT_QUOTE_DECISION, INPUT));
      expect([decision.name, decision.choice, decision.inference.path]).toStrictEqual(['accept_quote', given, 'marketplace']);
      expect(promptsSent(run)).toStrictEqual([goldenPrompt('accept-quote-prompt.txt')]);
    }
  });

  test.each<[string, unknown]>([
    ['an accept that names a SKU', { accept: true, mismatch: ['GLV-NIT-M'] }],
    ['a decline that names no SKU', { accept: false, mismatch: [] }],
    ['a decline that names a SKU twice', { accept: false, mismatch: ['GLV-NIT-M', 'GLV-NIT-M'] }],
    ['a decline that names a name that is not a SKU', { accept: false, mismatch: ['GLV NIT'] }],
    ['a decline that names 21 SKUs', { accept: false, mismatch: Array.from({ length: 21 }, (_, index) => `SKU-${index + 1}`) }],
    ['an answer with an extra member', { accept: true, mismatch: [], note: 'x' }],
  ])('%s: the parser refuses the answer, so the decision gives `model_output_invalid` and records no decision', async (_name, given) => {
    const run = await setup();
    run.m.llm.answer = said(given);
    const failure = lost(await decide(run.deps, ACCEPT_QUOTE_DECISION, INPUT));
    expect([failure.code, failure.reason]).toStrictEqual(['model_output_invalid', 'model_output_invalid']);
    // The hire was paid: the failure says so and carries the delivery.
    expect(failure.delivery).not.toBeNull();
  });
});
