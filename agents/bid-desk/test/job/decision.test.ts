// agents/bid-desk/test/job/decision.test.ts: the model decision of the Bid Desk, `quote`. The fixed text of its prompt is pinned as a golden file. The input holds the date, the items of the request and the
// entries of the price list for those SKUs, and nothing else: the whole list, the identifier of the request and the sender never reach the model. The parser checks the shape of the choice and the limits
// that a quote holds, and it never changes a value. A choice that the parser takes can be a line of a quote, so the job never ends `internal` for a choice after the Claim. Each refusal has an accepted twin.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, parseQuote } from '@vsa/usecase-kit/bids';
import { INPUT_CLOSE, INPUT_OPEN, MAX_PROMPT_BYTES, buildPrompt } from '@vsa/usecase-kit/decision';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { QUOTE_DECISION, quoteInput } from '../../src/job/decision.ts';
import type { QuoteChoice } from '../../src/job/decision.ts';
import { PRICE_LIST, PRICE_LIST_VALUE, RFQ, TODAY, choiceOf, priceListOf, quoteOf, rfqOf } from './samples.ts';

/** The prompt of a decision as the golden file holds it: the file ends with a line break and the prompt does not. */
function goldenPrompt(name: string): string {
  const text = readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1);
}

function promptOf(input: JsonValue): string {
  const prompt = buildPrompt(QUOTE_DECISION, input);
  if (!prompt.ok) throw new Error(prompt.detail);
  return prompt.value;
}

/** The input of the samples. */
const INPUT = quoteInput(RFQ, PRICE_LIST, TODAY);

describe('the decision quote', () => {
  it('has the name quote, and nothing can change it', () => {
    expect(QUOTE_DECISION.name).toBe('quote');
    expect(Object.isFrozen(QUOTE_DECISION)).toBe(true);
    expect(typeof QUOTE_DECISION.parse).toBe('function');
  });

  it('has an instruction that holds no mark of the input block, so that the kit can make one block', () => {
    expect(QUOTE_DECISION.instruction).not.toContain(INPUT_OPEN);
    expect(QUOTE_DECISION.instruction).not.toContain(INPUT_CLOSE);
    expect(QUOTE_DECISION.instruction.trim()).not.toBe('');
  });

  it('says what the data holds and what shape the choice has: the members of the input, of the choice and of a line', () => {
    for (const name of ['today', 'request', 'items', 'needed_by', 'price_list', 'breaks', 'min_quantity', 'choice', 'lines', 'valid_until', 'notes', 'sku', 'quantity', 'unit_price', 'lead_time_days']) {
      expect(QUOTE_DECISION.instruction, name).toContain(`"${name}"`);
    }
  });
});

describe('the prompt', () => {
  it('is the golden text for the sample request and price list', () => {
    expect(promptOf(INPUT)).toBe(goldenPrompt('quote-prompt.txt'));
  });

  it('holds the input in one block: one mark on a line of its own for each end of the block', () => {
    const lines = promptOf(INPUT).split('\n');
    expect(lines.filter((line) => line === INPUT_OPEN)).toHaveLength(1);
    expect(lines.filter((line) => line === INPUT_CLOSE)).toHaveLength(1);
  });

  it('is the same for the same input, and another for another date, quantity or price', () => {
    expect(promptOf(quoteInput(rfqOf(), priceListOf(), TODAY))).toBe(promptOf(INPUT));
    expect(promptOf(quoteInput(RFQ, PRICE_LIST, '2026-11-25'))).not.toBe(promptOf(INPUT));
    expect(promptOf(quoteInput(rfqOf({ items: [{ sku: 'GLV-NIT-M', quantity: 99 }] }), PRICE_LIST, TODAY))).not.toBe(promptOf(INPUT));
    const dearer = structuredClone(PRICE_LIST_VALUE);
    dearer.items[0]!.breaks[0]!.unit_price += 1;
    expect(promptOf(quoteInput(RFQ, priceListOf(dearer), TODAY))).not.toBe(promptOf(INPUT));
  });

  it('never holds the identifier of the request or a member of the message: the model reads the items and the date only', () => {
    const prompt = promptOf(INPUT);
    for (const text of ['run1-rfq-1', 'rfq_id', 'sender', 'delegation', 'schema', 'did:vector']) expect(prompt, text).not.toContain(text);
  });

  it('fits the limit of the kit for the largest request: 20 items, each SKU with 8 breaks', () => {
    const skus = Array.from({ length: MAX_RFQ_ITEMS }, (_, index) => `SKU-${String(index + 1).padStart(2, '0')}`);
    const list = priceListOf({
      schema: 'vector.usecase.price-list.v1',
      items: skus.map((sku) => ({ sku, lead_time_days: 365, breaks: Array.from({ length: 8 }, (_, step) => ({ min_quantity: 1 + step * 100_000, unit_price: 1_000_000 - step })) })),
    });
    const rfq = rfqOf({ items: skus.map((sku) => ({ sku, quantity: MAX_ITEM_QUANTITY })) });
    const built = buildPrompt(QUOTE_DECISION, quoteInput(rfq, list, TODAY));
    expect(built.ok).toBe(true);
    if (built.ok) expect(Buffer.byteLength(built.value, 'utf8')).toBeLessThan(MAX_PROMPT_BYTES);
  });
});

describe('quoteInput', () => {
  it('has the date, the items and the date of the request, and the entries of the list for the items, in the order of the items', () => {
    expect(INPUT).toStrictEqual({
      today: TODAY,
      request: { items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 250 }, { sku: 'MSK-N95', quantity: 40 }], needed_by: '2026-12-20' },
      price_list: [
        { sku: 'GLV-NIT-M', lead_time_days: 14, breaks: [{ min_quantity: 1, unit_price: 140 }, { min_quantity: 50, unit_price: 132 }, { min_quantity: 100, unit_price: 125 }, { min_quantity: 500, unit_price: 112 }] },
        { sku: 'SYR-10ML', lead_time_days: 9, breaks: [{ min_quantity: 1, unit_price: 40 }, { min_quantity: 250, unit_price: 35 }, { min_quantity: 1000, unit_price: 30 }] },
        { sku: 'MSK-N95', lead_time_days: 20, breaks: [{ min_quantity: 1, unit_price: 64 }, { min_quantity: 25, unit_price: 59 }, { min_quantity: 100, unit_price: 53 }, { min_quantity: 1000, unit_price: 46 }] },
      ],
    });
  });

  it('holds only the entries of the SKUs of the request: the whole list never goes to the model', () => {
    const input = quoteInput(rfqOf({ items: [{ sku: 'SYR-10ML', quantity: 10 }] }), PRICE_LIST, TODAY) as { price_list: { sku: string }[] };
    expect(input.price_list.map((entry) => entry.sku)).toStrictEqual(['SYR-10ML']);
    const text = JSON.stringify(input);
    for (const other of ['GLV-NIT-M', 'MSK-N95', '"unit_price":140', '"unit_price":64']) expect(text, other).not.toContain(other);
  });

  it('follows the order of the items of the request, and not the order of the list', () => {
    const input = quoteInput(rfqOf({ items: [{ sku: 'MSK-N95', quantity: 1 }, { sku: 'GLV-NIT-M', quantity: 1 }] }), PRICE_LIST, TODAY) as { price_list: { sku: string }[] };
    expect(input.price_list.map((entry) => entry.sku)).toStrictEqual(['MSK-N95', 'GLV-NIT-M']);
  });

  it('leaves a SKU that the list lacks out of the price list, and keeps the item in the request', () => {
    const rfq = rfqOf({ items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'NOT-LISTED-1', quantity: 5 }] });
    const input = quoteInput(rfq, PRICE_LIST, TODAY) as { request: { items: { sku: string }[] }; price_list: { sku: string }[] };
    expect(input.request.items.map((item) => item.sku)).toStrictEqual(['GLV-NIT-M', 'NOT-LISTED-1']);
    expect(input.price_list.map((entry) => entry.sku)).toStrictEqual(['GLV-NIT-M']);
  });

  it('gives an empty price list when the list carries none of the items', () => {
    const input = quoteInput(rfqOf({ items: [{ sku: 'NOT-LISTED-1', quantity: 5 }] }), PRICE_LIST, TODAY) as { price_list: unknown[] };
    expect(input.price_list).toStrictEqual([]);
  });

  it('holds only the members of an entry and of a break that the model needs', () => {
    const input = quoteInput(RFQ, PRICE_LIST, TODAY) as { price_list: { breaks: object[] }[] };
    for (const entry of input.price_list) {
      expect(Object.keys(entry).sort()).toStrictEqual(['breaks', 'lead_time_days', 'sku']);
      for (const step of entry.breaks) expect(Object.keys(step).sort()).toStrictEqual(['min_quantity', 'unit_price']);
    }
  });

  it('is JSON data, and a copy: a change of the input changes neither the request nor the list', () => {
    const rfq = rfqOf();
    const list = priceListOf();
    const input = quoteInput(rfq, list, TODAY) as { request: { items: { quantity: number }[] }; price_list: { lead_time_days: number; breaks: { unit_price: number }[] }[] };
    expect(JSON.parse(JSON.stringify(input))).toStrictEqual(input);
    input.request.items[0]!.quantity = 1;
    input.price_list[0]!.lead_time_days = 1;
    input.price_list[0]!.breaks[0]!.unit_price = 1;
    expect(rfq).toStrictEqual(rfqOf());
    expect(list).toStrictEqual(priceListOf());
  });

  it.each([
    ['a date that does not exist', '2026-02-30'],
    ['a month that does not exist', '2026-13-01'],
    ['a year before 0100', '0099-12-31'],
    ['another form of date', '24-11-2026'],
    ['a time', '2026-11-24T10:00:00Z'],
    ['a word', 'tomorrow'],
    ['the empty text', ''],
    ['a number', 20261124 as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('throws a TypeError for %s as the date of today, and the message does not repeat it', (_what, today) => {
    let error: unknown;
    try {
      quoteInput(RFQ, PRICE_LIST, today);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    if (typeof today === 'string' && today !== '') expect((error as TypeError).message).not.toContain(today);
  });

  it('twin: a real date, also the last day of a leap year, is the date of today', () => {
    expect(() => quoteInput(RFQ, PRICE_LIST, '2028-02-29')).not.toThrow();
    expect(() => quoteInput(RFQ, PRICE_LIST, '0100-01-01')).not.toThrow();
  });
});

// --- the parser of the choice ----------------------------------------------------------------------------------------------------------------------

const parse = (given: unknown) => QUOTE_DECISION.parse(given as JsonValue);

/** The refusal of the parser for a choice that it must refuse: the code and the detail. */
function refusalOf(given: unknown): { code: string; detail: string } {
  const result = parse(given);
  if (result.ok) throw new Error('the parser took a choice that it must refuse');
  return result;
}

/** The sample choice with members of its first line replaced. */
const withLine = (over: Record<string, unknown>): QuoteChoice => choiceOf({ lines: [{ ...choiceOf().lines[0]!, ...over }] });

/** An object without one member. */
const without = (value: object, name: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => key !== name));

/** `count` lines with SKUs `S01`, `S02`, and so on. */
const linesOf = (count: number): QuoteChoice['lines'] => Array.from({ length: count }, (_, index) => ({ sku: `S${String(index + 1).padStart(2, '0')}`, quantity: 1, unit_price: 10, lead_time_days: 1 }));

/** Notes that the quote refuses: a character that a reader cannot see, of each kind that the rule names, and a text that NFC makes too long. */
const HIDDEN_NOTES: ReadonlyArray<readonly [string, string]> = [
  ['a null character', 'a\u0000b'],
  ['a line feed', 'one\ntwo'],
  ['a carriage return', 'one\rtwo'],
  ['a tab', 'one\ttwo'],
  ['the delete character', 'a\u007fb'],
  ['a next line character', 'a\u0085b'],
  ['a zero width space', 'a\u200bb'],
  ['a zero width joiner', 'a\u200db'],
  ['a right to left override', 'a\u202eb'],
  ['a byte order mark', 'a\ufeffb'],
  ['a line separator', 'a\u2028b'],
  ['a paragraph separator', 'a\u2029b'],
  ['a variation selector', 'a\ufe0fb'],
  ['a combining grapheme joiner', 'a\u034fb'],
  ['a Hangul filler', 'a\u3164b'],
  ['a tag character', 'a\u{e0041}b'],
  ['a high surrogate that stands alone', 'a\ud800b'],
  ['a low surrogate that stands alone', 'a\udc00b'],
  ['a text that NFC makes longer than 500 characters', `${'x'.repeat(499)}\u0958`],
];

describe('the parser of the choice: what it takes', () => {
  it('takes the choice of a model that follows the list, and gives back the value that it was given, not a copy', () => {
    const given = choiceOf();
    const result = parse(given);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(given);
    expect(given).toStrictEqual(choiceOf());
  });

  it.each([
    ['the smallest line: quantity 1, unit price 1, lead time 0', withLine({ quantity: 1, unit_price: 1, lead_time_days: 0 })],
    ['the largest line: quantity, unit price and lead time at their limits', withLine({ quantity: MAX_ITEM_QUANTITY, unit_price: 1_000_000, lead_time_days: 365 })],
    ['20 lines', choiceOf({ lines: linesOf(MAX_RFQ_ITEMS) })],
    ['a SKU of 64 characters', withLine({ sku: `A${'b'.repeat(63)}` })],
    ['a SKU with a dot, a hyphen and an underscore', withLine({ sku: 'A.b-c_d' })],
    ['the first day that a date holds', choiceOf({ valid_until: '0100-01-01' })],
    ['the last day of a leap year', choiceOf({ valid_until: '2028-02-29' })],
    ['a date before the date of today: the model decides, and the parser holds no date to another', choiceOf({ valid_until: '2020-01-01' })],
    ['notes with no text', choiceOf({ notes: '' })],
    ['notes of 500 characters', choiceOf({ notes: 'n'.repeat(500) })],
    ['notes with letters, marks and symbols of other scripts', choiceOf({ notes: 'Preis für 100 Handschuhe: 12 500 (netto), 価格は固定です, цена 125.' })],
    ['notes with an emoji, a pair of surrogates', choiceOf({ notes: 'Fast delivery \u{1F600}' })],
  ])('takes %s', (_what, choice) => {
    const result = parse(choice);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(choice);
  });

  it('leaves the rules that need the request to the job: it takes no line, a SKU two times, a SKU that no request holds, and a price that is not the listed price', () => {
    for (const choice of [
      choiceOf({ lines: [] }),
      choiceOf({ lines: [choiceOf().lines[0]!, choiceOf().lines[0]!] }),
      withLine({ sku: 'NO-SUCH-SKU' }),
      withLine({ unit_price: 1 }),
      withLine({ unit_price: 999_999 }),
      withLine({ quantity: 3 }),
    ]) {
      expect(parse(choice).ok).toBe(true);
    }
  });
});

describe('the parser of the choice: what it refuses', () => {
  const good = choiceOf();
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ['a choice that is not an object: null', null, 'choice'],
    ['a choice that is not an object: a list', [], 'choice'],
    ['a choice that is not an object: a text', 'lines', 'choice'],
    ['a choice with no lines', without(good, 'lines'), 'lines'],
    ['a choice with no valid_until', without(good, 'valid_until'), 'valid_until'],
    ['a choice with no notes', without(good, 'notes'), 'notes'],
    ['a choice with a fourth member', { ...good, extra: 1 }, 'choice'],
    ['lines that are not a list: an object', { ...good, lines: { 0: good.lines[0] } }, 'lines'],
    ['lines that are not a list: a text', { ...good, lines: 'GLV-NIT-M' }, 'lines'],
    ['21 lines', choiceOf({ lines: linesOf(MAX_RFQ_ITEMS + 1) }), 'lines'],
    ['a line that is not an object: null', { ...good, lines: [null] }, 'lines[0]'],
    ['a line that is not an object: a list', { ...good, lines: [[]] }, 'lines[0]'],
    ['a line with a fifth member', { ...good, lines: [{ ...good.lines[0], line_total: 12_500 }] }, 'choice.lines[0]'],
    ['a line with no sku', { ...good, lines: [without(good.lines[0]!, 'sku')] }, 'sku'],
    ['a line with no quantity', { ...good, lines: [without(good.lines[0]!, 'quantity')] }, 'quantity'],
    ['a line with no unit_price', { ...good, lines: [without(good.lines[0]!, 'unit_price')] }, 'unit_price'],
    ['a line with no lead_time_days', { ...good, lines: [without(good.lines[0]!, 'lead_time_days')] }, 'lead_time_days'],
    ['a second line that is wrong: the detail names the second line', { ...good, lines: [good.lines[0], { ...good.lines[1], unit_price: 0 }] }, 'lines[1].unit_price'],
    ['a sku with a space', withLine({ sku: 'GLV NIT' }), 'sku'],
    ['a sku that starts with a hyphen', withLine({ sku: '-GLV' }), 'sku'],
    ['a sku of 65 characters', withLine({ sku: `A${'b'.repeat(64)}` }), 'sku'],
    ['the empty sku', withLine({ sku: '' }), 'sku'],
    ['a sku that is a number', withLine({ sku: 7 }), 'sku'],
    ['a sku with the Kelvin sign, which only NFC turns into a letter', withLine({ sku: '\u212a-1' }), 'sku'],
    ['a quantity of 0', withLine({ quantity: 0 }), 'quantity'],
    ['a negative quantity', withLine({ quantity: -1 }), 'quantity'],
    ['a quantity with a fraction', withLine({ quantity: 1.5 }), 'quantity'],
    ['a quantity as a text', withLine({ quantity: '100' }), 'quantity'],
    ['a quantity above the limit', withLine({ quantity: MAX_ITEM_QUANTITY + 1 }), 'quantity'],
    ['a unit_price of 0', withLine({ unit_price: 0 }), 'unit_price'],
    ['a negative unit_price', withLine({ unit_price: -5 }), 'unit_price'],
    ['a unit_price with a fraction', withLine({ unit_price: 12.5 }), 'unit_price'],
    ['a unit_price as a text', withLine({ unit_price: '125' }), 'unit_price'],
    ['a unit_price above the limit', withLine({ unit_price: 1_000_001 }), 'unit_price'],
    ['a unit_price that is not a number', withLine({ unit_price: Number.NaN }), 'unit_price'],
    ['a unit_price that a number cannot hold exactly', withLine({ unit_price: 2 ** 53 }), 'unit_price'],
    ['a lead_time_days below 0', withLine({ lead_time_days: -1 }), 'lead_time_days'],
    ['a lead_time_days above 365', withLine({ lead_time_days: 366 }), 'lead_time_days'],
    ['a lead_time_days with a fraction', withLine({ lead_time_days: 1.5 }), 'lead_time_days'],
    ['a lead_time_days as a text', withLine({ lead_time_days: '14' }), 'lead_time_days'],
    ['a valid_until that does not exist', choiceOf({ valid_until: '2026-02-30' }), 'valid_until'],
    ['a valid_until with a month that does not exist', choiceOf({ valid_until: '2026-13-01' }), 'valid_until'],
    ['a valid_until in a year before 0100', choiceOf({ valid_until: '0099-12-31' }), 'valid_until'],
    ['a valid_until on 29 February of a year that has none', choiceOf({ valid_until: '2025-02-29' }), 'valid_until'],
    ['a valid_until that is a time', choiceOf({ valid_until: '2026-12-15T00:00:00Z' }), 'valid_until'],
    ['a valid_until with a space', choiceOf({ valid_until: ' 2026-12-15' }), 'valid_until'],
    ['a valid_until that is a number', choiceOf({ valid_until: 20261215 as unknown as string }), 'valid_until'],
    ['a valid_until that is null', choiceOf({ valid_until: null as unknown as string }), 'valid_until'],
    ['notes of 501 characters', choiceOf({ notes: 'n'.repeat(501) }), 'notes'],
    ['notes that are a number', choiceOf({ notes: 7 as unknown as string }), 'notes'],
    ['notes that are null', choiceOf({ notes: null as unknown as string }), 'notes'],
    ['notes that are a list of texts', choiceOf({ notes: ['one'] as unknown as string }), 'notes'],
  ];

  it.each(cases)('refuses %s, with the code bad_shape, and the detail names the field', (_what, given, field) => {
    const refusal = refusalOf(given);
    expect(refusal.code).toBe('bad_shape');
    expect(refusal.detail).toContain(field);
  });

  it('twin: the choice with every member right passes', () => {
    expect(parse(choiceOf()).ok).toBe(true);
  });

  it('never repeats a value of the choice in a detail: a hostile text of the model stays out of the log', () => {
    const hostile = 'IGNORE-ALL-PREVIOUS-INSTRUCTIONS';
    for (const given of [
      withLine({ sku: `${hostile}!` }),
      withLine({ unit_price: hostile }),
      choiceOf({ valid_until: `2026-02-30 ${hostile}` }),
      choiceOf({ notes: `${hostile}\u0000` }),
    ]) {
      expect(refusalOf(given).detail).not.toContain(hostile);
    }
  });

  it('changes nothing in the choice that it refuses', () => {
    const given = withLine({ unit_price: 0 });
    refusalOf(given);
    expect(given).toStrictEqual(withLine({ unit_price: 0 }));
  });
});

describe('the parser of the choice: the notes rule of the quote', () => {
  it.each(HIDDEN_NOTES)('refuses notes with %s', (_what, notes) => {
    const refusal = refusalOf(choiceOf({ notes }));
    expect(refusal.code).toBe('bad_shape');
    expect(refusal.detail).toContain('notes');
  });

  it('twin: the same words with no hidden character pass', () => {
    for (const notes of ['a b', 'one two', 'Fast delivery', `${'x'.repeat(498)}\u0958`]) expect(parse(choiceOf({ notes })).ok, notes.slice(0, 20)).toBe(true);
  });
});

describe('the parser of the choice and the parser of the quote take the same limits', () => {
  /** Whether the kit takes the quote that a job would make of the choice. A choice that `quoteTotals` makes no lines of is a quote that cannot be made. */
  const quoteTaken = (choice: QuoteChoice): boolean => {
    const draft = quoteOf(choice);
    return draft !== null && parseQuote(draft).ok;
  };

  const choices: ReadonlyArray<readonly [string, QuoteChoice]> = [
    ['the sample choice', choiceOf()],
    ['the smallest line', withLine({ quantity: 1, unit_price: 1, lead_time_days: 0 })],
    ['the largest line', withLine({ quantity: MAX_ITEM_QUANTITY, unit_price: 1_000_000, lead_time_days: 365 })],
    ['a quantity just above the limit', withLine({ quantity: MAX_ITEM_QUANTITY + 1 })],
    ['a unit price of 0', withLine({ unit_price: 0 })],
    ['a unit price just above the limit', withLine({ unit_price: 1_000_001 })],
    ['a lead time just below 0', withLine({ lead_time_days: -1 })],
    ['a lead time of 365 days', withLine({ lead_time_days: 365 })],
    ['a lead time of 366 days', withLine({ lead_time_days: 366 })],
    ['20 lines', choiceOf({ lines: linesOf(MAX_RFQ_ITEMS) })],
    ['21 lines', choiceOf({ lines: linesOf(MAX_RFQ_ITEMS + 1) })],
    ['a date that exists', choiceOf({ valid_until: '2028-02-29' })],
    ['the first date that a date holds', choiceOf({ valid_until: '0100-01-01' })],
    ['a date that does not exist', choiceOf({ valid_until: '2027-02-29' })],
    ['a date before the year 0100', choiceOf({ valid_until: '0099-12-31' })],
    ['notes of 500 characters', choiceOf({ notes: 'n'.repeat(500) })],
    ['notes of 501 characters', choiceOf({ notes: 'n'.repeat(501) })],
    ['notes with no text', choiceOf({ notes: '' })],
    ...HIDDEN_NOTES.map(([what, notes]) => [`notes with ${what}`, choiceOf({ notes })] as const),
  ];

  it.each(choices)('%s: the parser of the choice takes it exactly when the parser of the quote takes the quote of it', (_what, choice) => {
    expect(parse(choice).ok).toBe(quoteTaken(choice));
  });

  it('has choices of both kinds in the table, so that the test shows a refusal and a pass', () => {
    const taken = choices.filter(([, choice]) => quoteTaken(choice));
    expect(taken.length).toBeGreaterThan(5);
    expect(choices.length - taken.length).toBeGreaterThan(10);
  });
});
