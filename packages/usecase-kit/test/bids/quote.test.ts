// packages/usecase-kit/test/bids/quote.test.ts: the quote that a Bid Desk returns and that the Sourcing Agent reads, in use case 3 (supplier bid evaluation). The golden files are the example and the same
// example with the fault of the Bid Desk. The parser takes a quote only when its numbers are the arithmetic of its lines, and `quoteTotals` is that arithmetic. The list of the checks is written out in
// the folder, and a drift test holds its first six names to the shared checks of the checks folder. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import { RECEIPT_CHECKS } from '@vsa/usecase-kit/protocol';
import {
  MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, QUOTE_CHECKS, QUOTE_SCHEMA, parsePriceList, parseQuote as parse, parseRfqDocument, priceFor, priceListSha256, quoteTotals, rfqSha256,
} from '@vsa/usecase-kit/bids';
import type { Quote, QuoteLine } from '@vsa/usecase-kit/bids';
import { MARKER, change, expectRefused, golden as inputGolden, goldenText as inputGoldenText, listAt, must, objectAt, withPrototype } from './support.ts';
import type { Json } from './support.ts';

type QuoteGolden = 'quote' | 'quote-off-list';
/** The exact text of a golden quote. The shared support of the folder reads the golden files of the other documents. */
const goldenText = (name: QuoteGolden = 'quote'): string => readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8');
/** A fresh value of a golden quote, so that a test can change a member without changing the sample. */
const golden = (name: QuoteGolden = 'quote'): Json => JSON.parse(goldenText(name)) as Json;

/** The SHA-256 of the bytes of each golden file. A change of a file shows here. */
const GOLDEN_FILE_SHA256 = '979807e3cab14a13c90770aa3838089a0e31e377b8d7957af7b6b2741cf6fbfe';
const OFF_LIST_FILE_SHA256 = 'd49967c2b4cc6d3fa82378c812afe313569a8a121a25027e2b0bebb3f2a89620';

const MEMBERS = [
  'schema', 'outcome', 'rfq_id', 'rfq_sha256', 'desk_did', 'organisation', 'lines', 'total', 'lead_time_days', 'valid_until', 'notes', 'price_list_sha256', 'credential', 'sender', 'checks', 'decisions',
  'fault_mode',
] as const;
const LINE_MEMBERS = ['sku', 'quantity', 'unit_price', 'line_total', 'lead_time_days'] as const;
const SENDER_MEMBERS = ['did', 'organisation', 'organisation_verified'] as const;
const HEX = 'ab'.repeat(32);
const DID = `did:vector:${HEX}`;
/** The path of the first line, of the second line, of the first decision, and of its sub-job. */
const FIRST = ['lines', 0] as const;
const SECOND = ['lines', 1] as const;
const DECISION = ['decisions', 0] as const;
const SUB_JOB = [...DECISION, 'inference', 'sub_job'] as const;

const NOT_TEXT = [1, 0, true, null, {}, [], ['a']];
const nest = (levels: number): unknown => Array.from({ length: levels }).reduce<unknown>((inner) => ({ a: inner }), 1);

/** `count` lines: SKU-0, SKU-1 and so on, with the quantity 1 + index, the unit price 10 + index, the right line total, and a lead time that grows and then falls. */
const linesOf = (count: number): Json[] => Array.from({ length: count }, (_, index) => ({
  sku: `SKU-${index}`, quantity: index + 1, unit_price: 10 + index, line_total: (index + 1) * (10 + index), lead_time_days: (index * 7) % 30,
}));
const sumOf = (lines: readonly Json[]): number => lines.reduce((sum, line) => sum + Number(line.line_total), 0);
/** The golden quote with other lines, and the total and the longest lead time written from them by plain arithmetic. */
const quoteOfLines = (lines: Json[]): Json => ({ ...golden(), lines, total: sumOf(lines), lead_time_days: Math.max(0, ...lines.map((line) => Number(line.lead_time_days))) });
/** The golden quote with a first line that holds `members`, and the total and the longest lead time written again. A test that wants the refusal of the line itself uses `change` and no more. */
const withFirstLine = (members: Json): Json => quoteOfLines([{ ...objectAt(golden(), FIRST), ...members }, ...(listAt(golden(), ['lines']).slice(1) as Json[])]);
/** A compact text of three parts with exactly `length` characters. */
const credentialOf = (length: number): string => `a.b.${'c'.repeat(length - 4)}`;

describe('the checks of a quote', () => {
  it('are 7, in the order that they run: the 6 shared checks of a bid desk, and then not_duplicate', () => {
    expect(QUOTE_CHECKS).toHaveLength(7);
    expect(QUOTE_CHECKS.slice(0, 6)).toStrictEqual([...SHARED_CHECK_NAMES['bid-desk']]);
    expect(QUOTE_CHECKS[6]).toBe('not_duplicate');
    expect(new Set(QUOTE_CHECKS).size).toBe(7);
  });

  it('are written out, and hold the payment check after the two checks of the delegation and no check of an approval, because a request for quotation carries none', () => {
    expect([...QUOTE_CHECKS]).toStrictEqual(['sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid', 'not_duplicate']);
    expect(QUOTE_CHECKS.filter((name) => name.startsWith('approval'))).toStrictEqual([]);
  });
});

describe('the golden quotes', () => {
  it('are the files that the hashes name, and each holds the members in their order, with the 7 checks', () => {
    expect(createHash('sha256').update(goldenText()).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    expect(createHash('sha256').update(goldenText('quote-off-list')).digest('hex')).toBe(OFF_LIST_FILE_SHA256);
    expect(QUOTE_SCHEMA).toBe('vector.usecase.quote.v1');
    for (const name of ['quote', 'quote-off-list'] as const) {
      const input = golden(name);
      expect(Object.keys(input), name).toStrictEqual([...MEMBERS]);
      expect(Object.keys(objectAt(input, ['checks'])), name).toStrictEqual([...QUOTE_CHECKS]);
      expect(Object.keys(objectAt(input, ['sender'])), name).toStrictEqual([...SENDER_MEMBERS]);
      for (const line of listAt(input, ['lines'])) expect(Object.keys(line as object), name).toStrictEqual([...LINE_MEMBERS]);
      expect(input.schema, name).toBe(QUOTE_SCHEMA);
    }
  });

  it('are the example of the page with two lines: the page line, 100 units at 125, and a second line with a longer lead time', () => {
    const quote = must(parse(golden()));
    expect(quote.lines).toStrictEqual([
      { sku: 'GLV-NIT-M', quantity: 100, unit_price: 125, line_total: 12_500, lead_time_days: 14 },
      { sku: 'MSK-N95', quantity: 40, unit_price: 60, line_total: 2400, lead_time_days: 21 },
    ]);
    expect([quote.total, quote.lead_time_days, quote.valid_until, quote.fault_mode, quote.organisation]).toStrictEqual([14_900, 21, '2026-12-15', '', 'alfa.example.org']);
  });

  it('pass the parser, and the copy holds the same members in the same order', () => {
    for (const name of ['quote', 'quote-off-list'] as const) {
      const result = parse(golden(name));
      expect(result, name).toStrictEqual({ ok: true, value: golden(name) });
      const quote = must(result);
      expect(Object.keys(quote), name).toStrictEqual([...MEMBERS]);
      expect(Object.keys(quote.sender), name).toStrictEqual([...SENDER_MEMBERS]);
      expect(Object.keys(quote.checks), name).toStrictEqual([...QUOTE_CHECKS]);
      expect(Object.values(quote.checks), name).toStrictEqual(QUOTE_CHECKS.map(() => true));
      for (const line of quote.lines) expect(Object.keys(line), name).toStrictEqual([...LINE_MEMBERS]);
    }
  });

  it('answer the golden request and come from the golden price list: the hashes are the hashes of the two documents, and the prices are the listed prices', () => {
    const rfq = must(parseRfqDocument(inputGolden('rfq')));
    const list = must(parsePriceList(inputGolden('price-list')));
    const quote = must(parse(golden()));
    expect([quote.rfq_id, quote.rfq_sha256, quote.price_list_sha256]).toStrictEqual([rfq.rfq_id, must(rfqSha256(rfq)), priceListSha256(inputGoldenText('price-list'))]);
    for (const line of quote.lines) {
      expect(rfq.items, line.sku).toContainEqual({ sku: line.sku, quantity: line.quantity });
      expect(priceFor(list, line.sku, line.quantity), line.sku).toStrictEqual({ unit_price: line.unit_price, lead_time_days: line.lead_time_days });
    }
  });

  it('differ from each other in the unit price of the first line, its line total, the total and the fault setting, and the lower price is below the listed price', () => {
    const faulty = golden('quote-off-list');
    const back = change(change(change(change(faulty, [...FIRST, 'unit_price'], 125), [...FIRST, 'line_total'], 12_500), ['total'], 14_900), ['fault_mode'], '');
    expect(back).toStrictEqual(golden());
    expect(must(parse(faulty)).fault_mode).toBe('quote_off_price_list');
    expect(must(parse(faulty)).lines[0]!.unit_price).toBeLessThan(125);
  });

  it('give a copy that shares no object with the input, and change nothing of the input', () => {
    const input = golden();
    const before = JSON.stringify(input);
    const quote = must(parse(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(quote).not.toBe(input);
    expect(quote.lines).not.toBe(input.lines);
    expect(quote.lines[0]).not.toBe(objectAt(input, FIRST));
    expect(quote.sender).not.toBe(input.sender);
    expect(quote.checks).not.toBe(input.checks);
    expect(quote.decisions).not.toBe(input.decisions);
    expect(quote.decisions[0]!.inference.sub_job.receipt).not.toBe(objectAt(input, [...SUB_JOB, 'receipt']));
    expect(Object.getPrototypeOf(quote)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(quote.lines)).toBe(Array.prototype);
  });

  it('can be written as typed values: the copy is a Quote, and its types are the types of the page', () => {
    const quote: Quote = must(parse(golden()));
    const lines: readonly QuoteLine[] = quote.lines;
    expect(lines.map((line) => line.sku)).toStrictEqual(['GLV-NIT-M', 'MSK-N95']);
    expect(quote.decisions[0]!.inference.path).toBe('marketplace');
    expectTypeOf<Quote['outcome']>().toEqualTypeOf<'done'>();
    expectTypeOf<Quote['schema']>().toEqualTypeOf<typeof QUOTE_SCHEMA>();
    expectTypeOf<Quote['fault_mode']>().toEqualTypeOf<'' | 'quote_off_price_list'>();
    expectTypeOf<Quote['organisation']>().toEqualTypeOf<string>();
    expectTypeOf<Quote['sender']['organisation']>().toEqualTypeOf<string | null>();
    expectTypeOf<Quote['checks']['vault_paid']>().toEqualTypeOf<true>();
    expectTypeOf<QuoteLine>().toEqualTypeOf<{
      readonly sku: string; readonly quantity: number; readonly unit_price: number; readonly line_total: number; readonly lead_time_days: number;
    }>();
  });
});

describe('a member that is missing or is not listed', () => {
  it.each(MEMBERS)('refuses a quote with no member %s', (name) => {
    expectRefused(parse(change(golden(), [name], undefined)), name);
  });

  it.each([
    ['the quote', []], ['a line', FIRST], ['the sender', ['sender']], ['a decision', DECISION], ['the inference of a decision', [...DECISION, 'inference']], ['a sub-job', SUB_JOB],
    ['the verification of a sub-job', [...SUB_JOB, 'verification']],
  ])('refuses a member that is not listed in %s, and the twin without it passes', (_what, path) => {
    expectRefused(parse(change(golden(), [...path, 'extra'], 1)), 'extra');
    expect(parse(golden()).ok).toBe(true);
  });

  it.each(LINE_MEMBERS)('refuses a line with no member %s, in the first line and in the last', (name) => {
    expectRefused(parse(change(golden(), [...FIRST, name], undefined)), name);
    expectRefused(parse(change(golden(), [...SECOND, name], undefined)), name);
  });

  it.each([
    ['the sender', ['sender'], SENDER_MEMBERS], ['a decision', DECISION, ['name', 'choice', 'reasoning', 'inference']], ['an inference', [...DECISION, 'inference'], ['path', 'sub_job', 'accepted']],
    ['a sub-job', SUB_JOB, ['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']], ['a verification', [...SUB_JOB, 'verification'], RECEIPT_CHECKS],
  ])('refuses %s with no member of its own', (_what, path, names) => {
    for (const name of names) expectRefused(parse(change(golden(), [...path, name], undefined)), name);
  });

  it('refuses the members that belong to another document: an order confirmation, a result of the Sourcing Agent and a request', () => {
    for (const name of ['po_number', 'po_sha256', 'sku', 'lot', 'quantity', 'approval', 'handoff', 'exit_state', 'reason', 'items', 'ranked', 'needed_by']) expectRefused(parse({ ...golden(), [name]: HEX }), name);
  });
});

describe('the order of the members', () => {
  it('is the order of the page, and the copy holds it whatever the order of the input', () => {
    const reversed = (record: object): Json => Object.fromEntries(Object.entries(record).reverse());
    expect(Object.keys(reversed(golden()))).not.toStrictEqual([...MEMBERS]);
    expect(Object.keys(must(parse(reversed(golden()))))).toStrictEqual([...MEMBERS]);
    for (const line of must(parse({ ...golden(), lines: listAt(golden(), ['lines']).map((entry) => reversed(entry as Json)) })).lines) expect(Object.keys(line)).toStrictEqual([...LINE_MEMBERS]);
    expect(Object.keys(must(parse({ ...golden(), sender: reversed(objectAt(golden(), ['sender'])) })).sender)).toStrictEqual([...SENDER_MEMBERS]);
  });
});

describe('the outcome and the schema', () => {
  it.each([
    ['failed', 'failed'], ['completed', 'completed'], ['in capital letters', 'DONE'], ['with a space', 'done '], ['with a line break', 'done\n'], ['the empty text', ''], ['null', null], ['true', true],
    ['a list', ['done']], ['the marker', MARKER],
  ])('refuses the outcome %s, and takes done', (_what, outcome) => {
    expectRefused(parse(change(golden(), ['outcome'], outcome)), 'quote.outcome');
    expect(must(parse(change(golden(), ['outcome'], 'done'))).outcome).toBe('done');
  });

  it.each([
    ['another version', 'vector.usecase.quote.v2'], ['capital letters', 'VECTOR.USECASE.QUOTE.V1'], ['the schema of the request', 'vector.usecase.rfq.v1'], ['the schema of the order confirmation', 'vector.usecase.order-confirmation.v1'],
    ['a number', 1], ['null', null], ['the marker', MARKER], ['a space at the end', 'vector.usecase.quote.v1 '],
  ])('refuses a schema that is %s', (_what, schema) => {
    expectRefused(parse(change(golden(), ['schema'], schema)), 'quote.schema');
  });
});

describe('the request, the digests, the desk and the date', () => {
  const FORMS: ReadonlyArray<readonly [string, readonly unknown[], readonly unknown[]]> = [
    ['rfq_id', ['', 'a'.repeat(65), '-1', '.a', 'a b', 'a/b', 'a\n', 'e\u0301', MARKER, ...NOT_TEXT], ['a', 'run1-rfq-1', 'a.b_c-d', '9', 'a'.repeat(64)]],
    ['rfq_sha256', [HEX.slice(2), `${HEX}ab`, HEX.toUpperCase(), `${HEX}\n`, '', MARKER, ...NOT_TEXT], [HEX, '0'.repeat(64)]],
    ['price_list_sha256', [HEX.slice(2), `${HEX}ab`, HEX.toUpperCase(), `${HEX}\n`, '', MARKER, ...NOT_TEXT], [HEX, '0'.repeat(64)]],
    [
      'desk_did',
      [`did:vector:${HEX.slice(2)}`, `did:vector:${HEX}ab`, `did:vector:${HEX.toUpperCase()}`, HEX, `did:other:${HEX}`, '', MARKER, ...NOT_TEXT],
      [DID, `did:vector:${'0'.repeat(64)}`],
    ],
    [
      'valid_until',
      ['2026-02-30', '0099-01-01', '0000-01-01', '2026-13-01', '2026-12-00', '2026-1-1', '20261215', '2026-12-15T00:00:00Z', ' 2026-12-15', '2026-12-15\n', 'soon', '', 20_261_215, MARKER, ...NOT_TEXT],
      ['2026-12-15', '0100-01-01', '2028-02-29', '9999-12-31'],
    ],
  ];

  it.each(FORMS)('%s: refuses each value that is not in its form, and takes the values that are', (name, bad, good) => {
    for (const value of bad) expectRefused(parse(change(golden(), [name], value)), `quote.${name}`);
    for (const value of good) expect(parse(change(golden(), [name], value)).ok, `${name} ${JSON.stringify(value)}`).toBe(true);
  });
});

describe('the organisation of the desk', () => {
  const LONGEST = `${'a'.repeat(60)}.org`;
  const MANY = `${'a.'.repeat(31)}ab`;

  it('takes a domain in lower case with at least two labels and at most 64 characters', () => {
    for (const organisation of ['alfa.example.org', 'a.b', 'a-b.c-d.e', 'xn--caf-dma.example.org', '1.2', LONGEST, MANY]) {
      expect(must(parse(change(golden(), ['organisation'], organisation))).organisation, organisation).toBe(organisation);
    }
    expect([LONGEST.length, MANY.length]).toStrictEqual([64, 64]);
  });

  it.each([
    ['null, because a Bid Desk always names its own organisation', null], ['the empty text', ''], ['one label', 'alfa'], ['capital letters', 'Alfa.example.org'], ['capital letters in the last label', 'alfa.example.ORG'],
    ['an empty label in the middle', 'alfa..example.org'], ['a dot at the start', '.alfa.example.org'], ['a dot at the end', 'alfa.example.org.'], ['a hyphen at the start of a label', '-alfa.example.org'],
    ['a hyphen at the end of a label', 'alfa-.example.org'], ['an underscore', 'alfa_beta.example.org'], ['a space', 'alfa example.org'], ['a space at the end', 'alfa.example.org '],
    ['a line break at the end', 'alfa.example.org\n'], ['a letter with an accent', 'caf\u00e9.example.org'], ['the NFD form of a letter with an accent', 'cafe\u0301.example.org'], ['Chinese letters', '\u4e2d\u6587.example'],
    ['the Kelvin sign', 'alfa.example.\u212A'], ['a text of 65 characters', `${'a'.repeat(61)}.org`], ['a text of 100 characters', `${'a'.repeat(96)}.org`], ['a name with a path', 'alfa.example.org/path'],
    ['a name with a port', 'alfa.example.org:8080'], ['a name with a scheme', 'https://alfa.example.org'], ['a name with an at sign', 'a@alfa.example.org'], ['the marker', MARKER],
    ['a number', 1], ['true', true], ['a list', ['alfa.example.org']], ['an object', {}],
  ])('refuses %s, and names the member', (_what, organisation) => {
    expectRefused(parse(change(golden(), ['organisation'], organisation)), 'quote.organisation');
  });

  it('is not the organisation of the sender: the two members have their own rules', () => {
    const text = 'A Text With Spaces, Unlike A Domain';
    expect(must(parse(change(golden(), ['sender', 'organisation'], text))).sender.organisation).toBe(text);
    expectRefused(parse(change(golden(), ['organisation'], text)), 'quote.organisation');
  });
});

describe('the lines', () => {
  it('takes 1 line and 20 lines, and refuses no line and 21 lines', () => {
    expect(MAX_RFQ_ITEMS).toBe(20);
    expect(parse(quoteOfLines(linesOf(1))).ok).toBe(true);
    expect(parse(quoteOfLines(linesOf(20))).ok).toBe(true);
    expectRefused(parse(change(golden(), ['lines'], [])), 'quote.lines');
    expectRefused(parse(quoteOfLines(linesOf(21))), 'quote.lines');
    expectRefused(parse(quoteOfLines(linesOf(40))), 'quote.lines');
  });

  it('refuses the same SKU two times, also when the lines are apart, and names the second line and never the SKU', () => {
    const result = parse(quoteOfLines(linesOf(3).map((line, index) => (index === 2 ? { ...line, sku: 'SKU-0' } : line))));
    expectRefused(result, 'quote.lines[2].sku');
    expect(!result.ok && result.detail).not.toContain('SKU-0');
    expectRefused(parse(quoteOfLines(linesOf(20).map((line, index) => (index === 19 ? { ...line, sku: 'SKU-0' } : line)))), 'quote.lines[19].sku');
    const line = objectAt(golden(), FIRST);
    expectRefused(parse(quoteOfLines([line, { ...line }])), 'quote.lines[1].sku');
    expect(parse(quoteOfLines(linesOf(3))).ok).toBe(true);
  });

  it('takes two SKUs that differ in the case of a letter, the same numbers on two lines with two SKUs, and the lines in any order', () => {
    expect(parse(quoteOfLines(linesOf(2).map((line, index) => (index === 1 ? { ...line, sku: 'sku-0' } : line)))).ok).toBe(true);
    const [first, second] = listAt(golden(), ['lines']) as Json[];
    expect(parse(quoteOfLines([first!, { ...first!, sku: 'OTHER' }])).ok).toBe(true);
    expect(must(parse(quoteOfLines([second!, first!]))).lines.map((line) => line.sku)).toStrictEqual(['MSK-N95', 'GLV-NIT-M']);
  });

  it.each([['a number', 1], ['null', null], ['a text', 'line'], ['a list', []], ['true', true]])('refuses a line that is %s', (_what, entry) => {
    expectRefused(parse(change(golden(), [...FIRST], entry)), 'quote.lines[0]');
  });

  it.each([['an object', {}], ['a text', 'lines'], ['null', null], ['a number', 2], ['an object with an index', { 0: {} }]])('refuses lines that are %s', (_what, lines) => {
    expectRefused(parse(change(golden(), ['lines'], lines)), 'quote.lines');
  });

  it('sku: refuses each value that is not in its form, and takes the values that are', () => {
    for (const value of ['', 'A'.repeat(65), 'A B', 'A#B', 'A\n', '-A', 'e\u0301', MARKER, ...NOT_TEXT]) expectRefused(parse(change(golden(), [...FIRST, 'sku'], value)), 'quote.lines[0].sku');
    for (const value of ['A', 'GLV-NIT-M', 'A'.repeat(64), 'a.b_c-d']) expect(parse(withFirstLine({ sku: value })).ok, value).toBe(true);
  });

  it.each([
    ['quantity', [0, -1, 1_000_001, 1.5, '100', null, true, [], {}, 2 ** 53, MARKER], [1, 50, 1_000_000], (value: number) => ({ quantity: value, line_total: value * 125 })],
    ['unit_price', [0, -1, 1_000_001, 1.5, '125', null, true, [], {}, 2 ** 53, MARKER], [1, 50, 1_000_000], (value: number) => ({ unit_price: value, line_total: value * 100 })],
    ['lead_time_days', [-1, 366, 1000, 1.5, '14', null, true, [], {}, 2 ** 53, MARKER], [0, 1, 20, 365], (value: number) => ({ lead_time_days: value })],
  ])('%s: refuses each value that is not a whole number in its range, and takes the values that are', (name, bad, good, members) => {
    for (const value of bad) expectRefused(parse(change(golden(), [...FIRST, name], value)), `quote.lines[0].${name}`);
    for (const value of good) expect(parse(withFirstLine(members(value))).ok, `${name} ${value}`).toBe(true);
  });

  it('takes the largest line, and 20 such lines make a total that a number holds exactly', () => {
    const big = Array.from({ length: 20 }, (_, index) => ({ sku: `SKU-${index}`, quantity: MAX_ITEM_QUANTITY, unit_price: 1_000_000, line_total: 1_000_000_000_000, lead_time_days: 365 }));
    const quote = must(parse(quoteOfLines(big)));
    expect(quote.total).toBe(20_000_000_000_000);
    expect(Number.isSafeInteger(quote.total)).toBe(true);
  });

  it('reads minus zero as 0 for the lead time, and keeps no sign of zero in the copy', () => {
    const input = golden();
    objectAt(input, FIRST).lead_time_days = -0;
    const quote = must(parse(input));
    expect(Object.is(quote.lines[0]!.lead_time_days, 0)).toBe(true);
    expect(quote.lead_time_days).toBe(21);
  });
});

describe('the arithmetic of the lines', () => {
  it.each([[1], [-1], [100], [-12_500]])('refuses a line total that is the right total with %s added, in each line, and the twin with the right total passes', (delta) => {
    for (const path of [FIRST, SECOND]) expectRefused(parse(change(golden(), [...path, 'line_total'], Number(objectAt(golden(), path).line_total) + delta)), `quote.lines[${path[1]}].line_total`);
    expect(parse(golden()).ok).toBe(true);
  });

  it('refuses a line total that is another line total, the unit price, or not a whole number in its range', () => {
    for (const value of [2400, 125, 0, 12_500.5, '12500', null, true, [], {}, 1_000_000_000_001, MARKER]) expectRefused(parse(change(golden(), [...FIRST, 'line_total'], value)), 'quote.lines[0].line_total');
  });

  it('refuses a total that is off by one in both directions, or the sum of other numbers, and takes the sum', () => {
    for (const total of [14_901, 14_899, 12_500, 2400, 14_900 + 12_500, 14_900 + 2400, 25_000, 0, -14_900, '14900', null, true, [], {}, 14_900.5, 20_000_000_000_001, 2 ** 53, MARKER]) {
      expectRefused(parse(change(golden(), ['total'], total)), 'quote.total');
    }
    expect(must(parse(change(golden(), ['total'], 14_900))).total).toBe(14_900);
  });

  it('refuses a total that leaves out one line or counts one line again, in a quote of 5 lines, and takes the sum of the 5 lines', () => {
    const lines = linesOf(5);
    expect(parse({ ...quoteOfLines(lines), total: sumOf(lines) }).ok).toBe(true);
    for (const line of lines) {
      expectRefused(parse({ ...quoteOfLines(lines), total: sumOf(lines) - Number(line.line_total) }), 'quote.total');
      expectRefused(parse({ ...quoteOfLines(lines), total: sumOf(lines) + Number(line.line_total) }), 'quote.total');
    }
  });

  it('refuses a total that agrees with line totals that are wrong: the lines decide, and the total cannot repair them', () => {
    expectRefused(parse(change(change(golden(), [...FIRST, 'line_total'], 12_501), ['total'], 14_901)), 'quote.lines[0].line_total');
  });

  it.each([
    ['the first line is not the longest', [14, 21], [14, 20, 22, 17, 0, 365]], ['the first line is the longest', [30, 7, 14], [7, 14, 21, 51, 29, 31, 0]], ['the longest is in the middle', [5, 20, 10], [5, 10, 0, 35, 19, 21]],
    ['two lines share the longest', [20, 20, 5], [5, 0, 45, 19, 21]],
  ])('refuses a lead time that is not the longest of the lines when %s, and takes the longest', (_what, leads, wrong) => {
    const lines = linesOf(leads.length).map((line, index) => ({ ...line, lead_time_days: leads[index]! }));
    expect(must(parse(quoteOfLines(lines))).lead_time_days).toBe(Math.max(...leads));
    for (const value of wrong) expectRefused(parse({ ...quoteOfLines(lines), lead_time_days: value }), 'quote.lead_time_days');
  });

  it('refuses a lead time that is not a whole number from 0 to 365, and takes 0 when every line has 0', () => {
    for (const value of [-1, 366, 14.5, '21', null, true, [], {}, 2 ** 53, MARKER]) expectRefused(parse(change(golden(), ['lead_time_days'], value)), 'quote.lead_time_days');
    expect(must(parse(quoteOfLines(linesOf(2).map((line) => ({ ...line, lead_time_days: 0 }))))).lead_time_days).toBe(0);
  });

  it('reads the arithmetic from the lines of the quote and from nothing else, and the quote with the fault has the arithmetic of its own lines', () => {
    expect(must(parse(change(golden(), [...DECISION, 'choice', 'lines', 0, 'unit_price'], 1))).total).toBe(14_900);
    const faulty = must(parse(golden('quote-off-list')));
    expect([faulty.lines[0]!.line_total, faulty.total]).toStrictEqual([10_000, 12_400]);
    expectRefused(parse(change(golden('quote-off-list'), ['total'], 14_900)), 'quote.total');
  });
});

describe('the notes', () => {
  it('takes a text of at most 500 characters, the empty text and a text with accents, and refuses 501 characters', () => {
    for (const text of ['', 'SYR-10ML is not quoted.', 'a'.repeat(500), 'caf\u00e9 \u4e2d\u6587 \u{1F600}', ' padded ', 'a~b', 'a\u00a0b', 'a\u00a1b']) expect(must(parse(change(golden(), ['notes'], text))).notes, text).toBe(text);
    for (const text of ['a'.repeat(501), 'a'.repeat(2000)]) {
      const result = parse(change(golden(), ['notes'], text));
      expectRefused(result, 'quote.notes');
      expect(!result.ok && result.detail).not.toContain('aaaa');
    }
  });

  it('refuses a text that NFC makes longer than 500 characters, although the text has at most 500, so that a copy passes the parser again', () => {
    // U+0344 has the NFC form U+0308 U+0301, so 250 of them are 500 characters and 251 of them are 502.
    expect(must(parse(change(golden(), ['notes'], '\u0344'.repeat(250)))).notes).toHaveLength(500);
    for (const count of [251, 300]) expectRefused(parse(change(golden(), ['notes'], '\u0344'.repeat(count))), 'quote.notes');
  });

  it.each([
    ['NUL', 'a\u0000b'], ['a NUL at the end', 'note\u0000'], ['a tab', 'a\tb'], ['a line break', 'a\nb'], ['a carriage return', 'a\rb'], ['a form feed', 'a\fb'], ['an escape character', 'a\u001bb'],
    ['the last character of the first block', 'a\u001fb'], ['the delete character', 'a\u007fb'], ['the first control character of the second block', 'a\u0080b'], ['the last control character of the second block', 'a\u009fb'],
    ['the marker, which has a line break', MARKER],
  ])('refuses %s in the text, and names the member', (_what, text) => {
    expectRefused(parse(change(golden(), ['notes'], text)), 'quote.notes');
  });

  it.each([['a number', 1], ['null', null], ['true', true], ['a list', ['note']], ['an object', {}]])('refuses notes that are %s', (_what, notes) => {
    expectRefused(parse(change(golden(), ['notes'], notes)), 'quote.notes');
  });
});

describe('the credential', () => {
  it('takes a compact text of three parts of letters, digits, hyphens and underscores, up to 8,192 characters, and the text of the golden quote', () => {
    for (const text of [must(parse(golden())).credential, 'a.b.c', 'A-_9.b-_.c', credentialOf(100), credentialOf(8192), 'eyJ.eyJ.sig']) expect(must(parse(change(golden(), ['credential'], text))).credential).toBe(text);
    expect(credentialOf(8192)).toHaveLength(8192);
  });

  it.each([
    ['8,193 characters', credentialOf(8193)], ['20,000 characters', credentialOf(20_000)], ['two parts', 'a.b'], ['one part', 'abc'], ['four parts', 'a.b.c.d'], ['an empty first part', '.b.c'], ['an empty middle part', 'a..c'],
    ['an empty last part', 'a.b.'], ['two dots', '..'], ['the empty text', ''], ['a space in a part', 'a b.b.c'], ['a line break at the end', 'a.b.c\n'], ['a plus sign', 'a+.b.c'], ['a slash', 'a/.b.c'],
    ['the equals sign of the padding', 'a=.b.c'], ['a letter with an accent', 'caf\u00e9.b.c'], ['Chinese letters', '\u4e2d.b.c'], ['a colon', 'a:b.b.c'], ['the marker', MARKER], ['the marker as a part', `${MARKER}.b.c`],
    ['a number', 1], ['null', null], ['true', true], ['a list', ['a.b.c']], ['an object', {}],
  ])('refuses %s, and the detail names the member and never repeats the text', (_what, credential) => {
    const result = parse(change(golden(), ['credential'], credential));
    expectRefused(result, 'quote.credential');
    if (typeof credential === 'string' && credential.length >= 3) expect(!result.ok && result.detail).not.toContain(credential);
    expect(!result.ok && result.detail.length).toBeLessThan(500);
  });
});

describe('the sender', () => {
  it.each([
    ['a DID with a short id', `did:vector:${HEX.slice(2)}`], ['a DID with a long id', `did:vector:${HEX}ab`], ['a DID in capital letters', `did:vector:${HEX.toUpperCase()}`], ['no prefix', HEX],
    ['another prefix', `did:other:${HEX}`], ['the empty text', ''], ['null', null], ['a number', 1], ['the marker', MARKER],
  ])('refuses %s as the DID', (_what, did) => {
    expectRefused(parse(change(golden(), ['sender', 'did'], did)), 'quote.sender.did');
    expect(parse(change(golden(), ['sender', 'did'], DID)).ok).toBe(true);
  });

  it.each([
    ['the text true', 'true'], ['the text false', 'false'], ['the number 1', 1], ['the number 0', 0], ['null', null], ['a list', [true]], ['an object', {}], ['the marker', MARKER],
  ])('refuses %s as organisation_verified, and takes true and false', (_what, value) => {
    expectRefused(parse(change(golden(), ['sender', 'organisation_verified'], value)), 'quote.sender.organisation_verified');
    expect(parse(change(golden(), ['sender', 'organisation_verified'], true)).ok).toBe(true);
    expect(must(parse(change(golden(), ['sender', 'organisation_verified'], false))).sender.organisation_verified).toBe(false);
  });

  it('takes the organisation as null, and as any text of at most 1024 characters, because the shared sender check takes any text from the record of the sender', () => {
    expect(must(parse(change(golden(), ['sender', 'organisation'], null))).sender.organisation).toBeNull();
    const texts = [
      'echo.example', 'a', 'Operator Echo (demo)', 'caf\u00e9.example', '\u4e2d\u6587.example', '', ' ', '\u00a0', 'echo\u200d.example', 'a'.repeat(254), 'a'.repeat(1024), ' echo.example ',
      'echo\nexample', 'echo\texample', 'echo\u0001.example', 'echo\u2028example', MARKER,
    ];
    for (const text of texts) expect(must(parse(change(golden(), ['sender', 'organisation'], text))).sender.organisation, JSON.stringify(text)).toBe(text);
  });

  it.each([['1025 characters', 'a'.repeat(1025)], ['2000 characters', 'a'.repeat(2000)], ['a number', 1], ['true', true], ['a list', ['echo.example']], ['an object', {}]])('refuses %s as the organisation', (_what, organisation) => {
    const result = parse(change(golden(), ['sender', 'organisation'], organisation));
    expectRefused(result, 'quote.sender.organisation');
    expect(!result.ok && result.detail).not.toContain('aaaa');
  });

  it('refuses an organisation that NFC makes longer than 1024 characters, although the text has at most 1024, and takes the text that stays within the limit', () => {
    expect(must(parse(change(golden(), ['sender', 'organisation'], '\u0344'.repeat(512)))).sender.organisation).toHaveLength(1024);
    for (const count of [513, 600]) expectRefused(parse(change(golden(), ['sender', 'organisation'], '\u0344'.repeat(count))), 'quote.sender.organisation');
  });

  it.each([['a list', []], ['a text', 'echo.example'], ['null', null], ['a number', 1]])('refuses a sender that is %s', (_what, sender) => {
    expectRefused(parse(change(golden(), ['sender'], sender)), 'quote.sender');
  });
});

describe('the seven checks', () => {
  const checksOf = (checks: unknown): Json => change(golden(), ['checks'], checks);
  const all = (): Record<string, unknown> => Object.fromEntries(QUOTE_CHECKS.map((name) => [name, true]));

  it.each(QUOTE_CHECKS)('refuses a quote with 6 checks, without %s, and a quote with that check set to false', (name) => {
    expectRefused(parse(change(golden(), ['checks', name], undefined)), name);
    expectRefused(parse(change(golden(), ['checks', name], false)), `quote.checks.${name}`);
  });

  it('refuses the 6 names of the page, which have no payment check, and a quote with the fault setting and a check that is false: a fault changes no check', () => {
    const six = { ...all() };
    delete six.vault_paid;
    expectRefused(parse(checksOf(six)), 'vault_paid');
    expectRefused(parse(change(golden('quote-off-list'), ['checks', 'not_duplicate'], false)), 'quote.checks.not_duplicate');
    expect(parse(checksOf(all())).ok).toBe(true);
  });

  it('refuses 8 checks: a name that is not listed, whatever its value, and a name of another kind of agent', () => {
    for (const name of ['not_a_check', 'approval_found', 'approval_digest', 'duplicate_rfq', 'for_this_supplier', 'lot', 'Not_duplicate', 'not_duplicate ', 'constructor', 'toString']) {
      for (const value of [true, false, null, 1]) expectRefused(parse(checksOf({ ...all(), [name]: value })), name);
    }
  });

  it('refuses a name that is not listed in the place of a listed name', () => {
    expectRefused(parse(checksOf(Object.fromEntries(QUOTE_CHECKS.map((name) => [name === 'not_duplicate' ? 'not_duplicated' : name, true])))), 'not_duplicate');
  });

  it.each([['the text true', 'true'], ['the number 1', 1], ['null', null], ['the empty list', []], ['an object', { ok: true }], ['the text of the marker', MARKER], ['0', 0]])(
    'refuses a check with the value %s',
    (_what, value) => {
      for (const name of QUOTE_CHECKS) expectRefused(parse(change(golden(), ['checks', name], value)), `quote.checks.${name}`);
    },
  );

  it.each([['a list', []], ['a list of the names', [...QUOTE_CHECKS]], ['a text', 'checks'], ['null', null], ['a number', 7], ['an object with no member', {}]])('refuses checks that are %s', (_what, checks) => {
    expectRefused(parse(checksOf(checks)), 'quote.checks');
  });

  it('keeps the order of the list in the copy, whatever the order of the input', () => {
    const reversed = Object.fromEntries([...QUOTE_CHECKS].reverse().map((name) => [name, true]));
    expect(Object.keys(must(parse(checksOf(reversed))).checks)).toStrictEqual([...QUOTE_CHECKS]);
  });
});

describe('the decisions', () => {
  it.each([['an object', {}], ['a text', 'decisions'], ['null', null], ['a number', 1], ['an object with an index', { 0: {} }]])('refuses decisions that are %s', (_what, decisions) => {
    expectRefused(parse(change(golden(), ['decisions'], decisions)), 'quote.decisions');
  });

  it.each([['a text', 'decision'], ['null', null], ['a number', 1], ['a list', []], ['a list of decisions', [{}]], ['true', true]])('refuses a decision that is %s', (_what, decision) => {
    expectRefused(parse(change(golden(), ['decisions', 0], decision)), 'quote.decisions[0]');
  });

  it('takes exactly one decision, the decision named quote, with the empty setting and with the fault value', () => {
    for (const name of ['quote', 'quote-off-list'] as const) expect(must(parse(golden(name))).decisions.map((decision) => decision.name), name).toStrictEqual(['quote']);
  });

  it('refuses no decision, with the empty setting and with the fault value, and two decisions: two of the same name, and one of this name with one of another name in each order', () => {
    for (const setting of ['', 'quote_off_price_list']) expectRefused(parse(change(change(golden(), ['decisions'], []), ['fault_mode'], setting)), 'quote.decisions');
    const named = (name: string): Json => ({ ...objectAt(golden(), DECISION), name });
    for (const names of [['quote', 'quote'], ['quote', 'availability'], ['availability', 'quote'], ['accept_quote', 'quote'], ['accept_quote', 'shortlist']]) {
      expectRefused(parse(change(golden(), ['decisions'], names.map(named))), 'quote.decisions');
    }
    expect(parse(change(golden(), ['decisions'], [named('quote')])).ok).toBe(true);
  });

  it('refuses one decision of another name, among them availability, the decision of the Order Desk, and names the member', () => {
    for (const name of ['availability', 'accept_quote', 'shortlist', 'ranking', 'quot', 'quote_2', 'Quote', 'quote ', ' quote', 'quote\n', 'a', '', MARKER, ...NOT_TEXT]) {
      expectRefused(parse(change(golden(), [...DECISION, 'name'], name)), 'quote.decisions[0].name');
    }
  });

  it('refuses a reasoning that is blank or is not a text, and takes any other text', () => {
    for (const value of ['', ' ', '\n\t ', ...NOT_TEXT]) expectRefused(parse(change(golden(), [...DECISION, 'reasoning'], value)), 'quote.decisions[0].reasoning');
    for (const value of ['Both lines take the listed price.', ' padded ', 'caf\u00e9']) expect(parse(change(golden(), [...DECISION, 'reasoning'], value)).ok, value).toBe(true);
  });

  it('takes any JSON as the choice and keeps it as the model gave it, and refuses a choice that JSON cannot hold or that is nested too deep', () => {
    for (const choice of [null, true, 0, 1.5, 'text', [], [1, 'a', null], {}, { lines: [], valid_until: 'never', notes: '' }, { nested: { deep: [{ a: 1 }] } }]) {
      expect(must(parse(change(golden(), [...DECISION, 'choice'], choice))).decisions[0]!.choice, JSON.stringify(choice)).toStrictEqual(choice);
    }
    for (const choice of [Number.NaN, Number.POSITIVE_INFINITY, () => 1, 1n, Symbol('x')]) expectRefused(parse(change(golden(), [...DECISION, 'choice'], choice)), 'quote.decisions[0]');
    expectRefused(parse(change(golden(), [...DECISION, 'choice'], nest(40))), 'quote');
    expect(parse(change(golden(), [...DECISION, 'choice'], nest(20))).ok).toBe(true);
  });

  it.each([
    ['path', ['api', 'Marketplace', 'marketplace ', '', MARKER, ...NOT_TEXT], ['marketplace']],
    ['accepted', ['no', 'Confirmed', 'confirmed ', 'pending\n', '', true, null, 1, MARKER], ['confirmed', 'pending']],
  ])('inference %s: refuses each value that is not listed, and takes the values that are', (name, bad, good) => {
    for (const value of bad) expectRefused(parse(change(golden(), [...DECISION, 'inference', name], value)), `quote.decisions[0].inference.${name}`);
    for (const value of good) expect(parse(change(golden(), [...DECISION, 'inference', name], value)).ok, String(value)).toBe(true);
  });

  it.each([
    ['capability_id', ['', 'a'.repeat(65), 'llm text', 'llm/text', '-llm', MARKER, ...NOT_TEXT], ['llm.text.generate.v1', 'a', 'A'.repeat(64)]],
    ['advert_ref', [HEX, `${HEX}#`, `${HEX}#01`, `${HEX.slice(2)}#0`, `${HEX}#0\n`, '', MARKER, ...NOT_TEXT], [`${HEX}#0`, `${HEX}#12`]],
    ['escrow_ref', [HEX, `${HEX}#-1`, `${HEX.toUpperCase()}#0`, '', MARKER, ...NOT_TEXT], [`${HEX}#0`]],
    ['supplier_pkh', [HEX.slice(10), HEX, HEX.slice(8).toUpperCase(), `${HEX.slice(8)}\n`, '', MARKER, ...NOT_TEXT], [HEX.slice(8)]],
    ['receipt_signature', ['', 'a b', 'a\nb', 'a'.repeat(1025), MARKER, ...NOT_TEXT], ['8e'.repeat(64), 'abc', 'base64+/=', 'a'.repeat(1024)]],
  ])('sub-job %s: refuses each value that is not in its form, and takes the values that are', (name, bad, good) => {
    for (const value of bad) expectRefused(parse(change(golden(), [...SUB_JOB, name], value)), `quote.decisions[0].inference.sub_job.${name}`);
    for (const value of good) expect(parse(change(golden(), [...SUB_JOB, name], value)).ok, String(value)).toBe(true);
  });

  it.each([['a list', []], ['a text', '{}'], ['null', null], ['a number', 1], ['true', true]])('refuses a receipt that is %s, and takes an object with any members', (_what, receipt) => {
    expectRefused(parse(change(golden(), [...SUB_JOB, 'receipt'], receipt)), 'quote.decisions[0].inference.sub_job.receipt');
    expect(parse(change(golden(), [...SUB_JOB, 'receipt'], { anything: [1, { a: null }], 'another key': 'x' })).ok).toBe(true);
  });

  it.each(RECEIPT_CHECKS)('refuses the receipt check %s that is not a boolean, and takes true and false', (name) => {
    for (const value of ['true', 1, 0, null, [], {}, MARKER]) expectRefused(parse(change(golden(), [...SUB_JOB, 'verification', name], value)), `verification.${name}`);
    for (const value of [true, false]) expect(must(parse(change(golden(), [...SUB_JOB, 'verification', name], value))).decisions[0]!.inference.sub_job.verification[name]).toBe(value);
  });

  it('refuses a verification that is not an object, and keeps the members of a decision, an inference and a sub-job in the order of the protocol', () => {
    for (const value of [[], 'checks', null, 1, true]) expectRefused(parse(change(golden(), [...SUB_JOB, 'verification'], value)), 'verification');
    const decision = must(parse(golden())).decisions[0]!;
    expect(Object.keys(decision)).toStrictEqual(['name', 'choice', 'reasoning', 'inference']);
    expect(Object.keys(decision.inference)).toStrictEqual(['path', 'sub_job', 'accepted']);
    expect(Object.keys(decision.inference.sub_job)).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
    expect(Object.keys(decision.inference.sub_job.verification)).toStrictEqual([...RECEIPT_CHECKS]);
  });
});

describe('the fault setting', () => {
  it('takes the empty text and the one fault value of the Bid Desk', () => {
    expect(must(parse(change(golden(), ['fault_mode'], ''))).fault_mode).toBe('');
    expect(must(parse(change(golden(), ['fault_mode'], 'quote_off_price_list'))).fault_mode).toBe('quote_off_price_list');
  });

  it.each([
    ['a value of the Order Desk', 'confirm_wrong_lot'], ['a value of the Sourcing Agent', 'invert_scores'], ['a value of another agent', 'alter_after_approval'], ['capital letters', 'QUOTE_OFF_PRICE_LIST'],
    ['a space at the start', ' quote_off_price_list'], ['a space at the end', 'quote_off_price_list '], ['a line break', 'quote_off_price_list\n'], ['a space', ' '], ['a name of the prototype', 'constructor'],
    ['null', null], ['a number', 0], ['false', false], ['a list', []], ['the marker', MARKER],
  ])('refuses %s as the fault setting, and takes the twins', (_what, value) => {
    expectRefused(parse(change(golden(), ['fault_mode'], value)), 'quote.fault_mode');
  });
});

describe('the Unicode form of a text', () => {
  it('writes the organisation of the sender and the notes in the NFC form, and keeps the texts of the decision as they came', () => {
    let sample = change(golden(), ['sender', 'organisation'], 'cafe\u0301.example');
    sample = change(sample, ['notes'], 'cafe\u0301 is not quoted');
    sample = change(sample, [...DECISION, 'reasoning'], 'cafe\u0301 is open');
    sample = change(sample, [...SUB_JOB, 'receipt', 'model'], 'cafe\u0301');
    sample = change(sample, [...DECISION, 'choice', 'notes'], 'cafe\u0301');
    const quote = must(parse(sample));
    expect(quote.sender.organisation).toBe('caf\u00e9.example');
    expect(quote.notes).toBe('caf\u00e9 is not quoted');
    expect(quote.decisions[0]!.reasoning).toBe('cafe\u0301 is open');
    expect(quote.decisions[0]!.inference.sub_job.receipt).toMatchObject({ model: 'cafe\u0301' });
    expect(quote.decisions[0]!.choice).toMatchObject({ notes: 'cafe\u0301' });
    expect(must(parse(change(golden(), ['notes'], 'caf\u00e9'))).notes).toBe('caf\u00e9');
  });

  it('gives a copy that passes the parser again, and gives the same copy', () => {
    const sample = change(change(golden(), ['sender', 'organisation'], 'cafe\u0301.example'), ['notes'], 'cafe\u0301 is not quoted');
    for (const input of [golden(), golden('quote-off-list'), sample]) {
      const once = must(parse(input));
      expect(parse(once)).toStrictEqual({ ok: true, value: once });
    }
  });

  it('checks each identifier as it is written: the Kelvin sign is refused, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    // The Kelvin sign (U+212A) is not an ASCII letter. The stores of the mock service refuse it, and so does this parser.
    const places: ReadonlyArray<readonly [string, readonly (string | number)[]]> = [
      ['quote.rfq_id', ['rfq_id']], ['quote.lines[0].sku', [...FIRST, 'sku']], ['quote.decisions[0].inference.sub_job.capability_id', [...SUB_JOB, 'capability_id']],
    ];
    for (const [where, path] of places) {
      for (const text of ['\u212AO-1', 'SO-\u212A', 'x\u212Ay']) {
        const result = parse(change(golden(), path, text));
        expectRefused(result, where);
        expect(!result.ok && result.detail).not.toContain('\u212A');
      }
      expect(parse(change(golden(), path, 'KO-1')).ok, where).toBe(true);
    }
  });

  it('refuses a key of a decision that is not in the NFC form, because a receipt is signed with the keys that it has', () => {
    expectRefused(parse(change(golden(), [...SUB_JOB, 'receipt'], JSON.parse('{"e\\u0301":1}') as Json)), 'quote.decisions[0].inference.sub_job.receipt');
    expect(parse(change(golden(), [...SUB_JOB, 'receipt'], { '\u00e9': 1 })).ok).toBe(true);
  });
});

describe('a value that is not plain JSON data', () => {
  const PLACES: ReadonlyArray<readonly [string, readonly (string | number)[], string]> = [
    ['the quote', [], 'schema'], ['a line', FIRST, 'sku'], ['the sender', ['sender'], 'did'], ['the checks', ['checks'], 'vault_paid'], ['a decision', DECISION, 'name'],
    ['an inference', [...DECISION, 'inference'], 'accepted'], ['a sub-job', SUB_JOB, 'capability_id'], ['a receipt', [...SUB_JOB, 'receipt'], 'model'], ['a verification', [...SUB_JOB, 'verification'], 'fields_match'],
    ['a choice', [...DECISION, 'choice'], 'notes'],
  ];

  it.each(PLACES)('refuses a member of %s that is an accessor, and never runs the getter', (_place, path, member) => {
    let reads = 0;
    const input = golden();
    const holder = objectAt(input, path);
    const value = holder[member];
    Object.defineProperty(holder, member, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
    expectRefused(parse(input), member);
    expect(reads).toBe(0);
    expect(parse(golden()).ok).toBe(true);
  });

  it.each(PLACES)('refuses the key __proto__ in %s, with a value that looks right', (_place, path) => {
    const input = golden();
    Object.defineProperty(objectAt(input, path), '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expectRefused(parse(input), '__proto__');
  });

  it('refuses an accessor in a list of lines and in a list of decisions, a list with a hole, a list with a member that is not an index, and a list of another kind', () => {
    for (const name of ['lines', 'decisions']) {
      const input = golden();
      const list = listAt(input, [name]);
      const first = list[0];
      let reads = 0;
      Object.defineProperty(list, 0, { get() { reads += 1; return first; }, enumerable: true, configurable: true });
      expectRefused(parse(input), `quote.${name}[0]`);
      expect(reads).toBe(0);
    }
    const sparse = golden();
    delete listAt(sparse, ['lines'])[0];
    expectRefused(parse(sparse), 'quote.lines[0]');
    const named = golden();
    Object.defineProperty(listAt(named, ['lines']), 'extra', { value: 1, enumerable: true, configurable: true });
    expectRefused(parse(named), 'quote.lines');
    class Lines extends Array<unknown> {}
    const other = golden();
    other.lines = Lines.from(listAt(other, ['lines']));
    expectRefused(parse(other), 'quote.lines');
  });

  it('refuses a key that is not a string, a key that is not enumerable, and a value that JSON cannot hold', () => {
    expectRefused(parse({ ...golden(), [Symbol('x')]: 1 }), 'quote');
    const hidden = golden();
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parse(hidden), 'quote');
    for (const total of [undefined, 10n, Number.NaN, Number.POSITIVE_INFINITY]) expectRefused(parse({ ...golden(), total }), 'total');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, a value that is not an object and an object of another kind, and never throws', () => {
    const throws = new Proxy(golden(), { ownKeys() { throw new Error('the Proxy refuses'); } });
    const { proxy, revoke } = Proxy.revocable(golden(), {});
    revoke();
    class NotAQuote { schema = QUOTE_SCHEMA; }
    for (const value of [throws, proxy, undefined, null, 1, 'quote', true, [], [golden()], new NotAQuote(), new Date(0), () => golden()]) {
      expect(() => parse(value)).not.toThrow();
      expectRefused(parse(value), 'quote');
    }
  });

  it('takes an object with no prototype, and it gives a plain object', () => {
    const quote = must(parse(Object.assign(Object.create(null) as Json, golden())));
    expect(quote).toStrictEqual(golden());
    expect(Object.getPrototypeOf(quote)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(quote.decisions)).toBe(Array.prototype);
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parse(golden());

  it.each([
    ['lines on Object.prototype', Object.prototype, 'lines'], ['sku on Object.prototype', Object.prototype, 'sku'], ['checks on Object.prototype', Object.prototype, 'checks'],
    ['name on Object.prototype', Object.prototype, 'name'], ['the index 0 on Array.prototype', Array.prototype, '0'], ['the index 0 on Object.prototype', Object.prototype, '0'],
  ] as const)('with a setter for %s, the result is the result of the plain twin, and no setter runs', (_what, target, key) => {
    let calls = 0;
    const input = golden();
    const seen = withPrototype(target, { [key]: { set() { calls += 1; } } }, () => parse(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: a quote with no own member is refused, although the prototype holds every member', () => {
    const inherited = Object.fromEntries(Object.entries(golden()).map(([name, value]) => [name, { value, writable: true, enumerable: true }]));
    expect(withPrototype(Object.prototype, inherited, () => parse({})).ok).toBe(false);
    expectRefused(withPrototype(Object.prototype, { sender: inherited.sender! }, () => parse(change(golden(), ['sender'], undefined))), 'sender');
  });
});

describe('quoteTotals', () => {
  type Totals = { lines: QuoteLine[]; total: number; lead_time_days: number } | null;
  const PAGE = [{ sku: 'GLV-NIT-M', quantity: 100, unit_price: 125, lead_time_days: 14 }];
  const GOLDEN_INPUT = [PAGE[0]!, { sku: 'MSK-N95', quantity: 40, unit_price: 60, lead_time_days: 21 }];
  /** The function with an input of any type: a caller in JavaScript, or a value that a model made. */
  const totalsOf = quoteTotals as (lines: unknown) => Totals;
  const lineOf = (members: Json): Json => ({ ...GOLDEN_INPUT[0], ...members });
  const lineWith = (sku: string, lead = 0): { sku: string; quantity: number; unit_price: number; lead_time_days: number } => ({ sku, quantity: 1, unit_price: 1, lead_time_days: lead });
  const many = (count: number): { sku: string; quantity: number; unit_price: number; lead_time_days: number }[] => Array.from({ length: count }, (_, index) => lineWith(`SKU-${index}`));

  it('gives the arithmetic of the page example: the line total 12,500, the total 12,500 and the lead time 14', () => {
    expect(quoteTotals(PAGE)).toStrictEqual({ lines: [{ sku: 'GLV-NIT-M', quantity: 100, unit_price: 125, line_total: 12_500, lead_time_days: 14 }], total: 12_500, lead_time_days: 14 });
  });

  it('gives the lines, the total and the lead time of the golden quote, with the five members in the order of the page, and the golden quote passes the parser with them', () => {
    const totals = quoteTotals(GOLDEN_INPUT)!;
    expect(totals).toStrictEqual({ lines: listAt(golden(), ['lines']), total: 14_900, lead_time_days: 21 });
    for (const line of totals.lines) expect(Object.keys(line)).toStrictEqual([...LINE_MEMBERS]);
    expect(parse({ ...golden(), lines: totals.lines, total: totals.total, lead_time_days: totals.lead_time_days }).ok).toBe(true);
  });

  it('takes the longest lead time, and not the first: the first is the longest, the last is, the middle is, and two share it', () => {
    const leads = (values: readonly number[]): number | undefined => quoteTotals(values.map((lead, index) => lineWith(`SKU-${index}`, lead)))?.lead_time_days;
    expect([leads([30, 5, 7]), leads([5, 7, 30]), leads([5, 30, 7]), leads([5, 30, 30]), leads([0]), leads([0, 0]), leads([365, 0]), leads([14, 21])]).toStrictEqual([30, 30, 30, 30, 0, 0, 365, 21]);
  });

  it('adds every line to the total: 1, 2, 3 and 20 lines, with no line left out and none counted twice', () => {
    for (const count of [1, 2, 3, 20]) {
      const input = linesOf(count).map((line) => ({ sku: line.sku as string, quantity: line.quantity as number, unit_price: line.unit_price as number, lead_time_days: 1 }));
      expect(quoteTotals(input)?.total, String(count)).toBe(sumOf(linesOf(count)));
    }
  });

  it('keeps the order of the lines, gives new objects, changes nothing of the input, and drops every member that is not one of the four', () => {
    const input = [...GOLDEN_INPUT].reverse().map((line) => ({ ...line, line_total: 1, note: 'x', credential: 'a.b.c' }));
    const before = JSON.stringify(input);
    const totals = quoteTotals(input)!;
    expect(JSON.stringify(input)).toBe(before);
    expect(totals.lines.map((line) => line.sku)).toStrictEqual(['MSK-N95', 'GLV-NIT-M']);
    expect(totals.lines[0]).not.toBe(input[0]);
    expect(totals.lines[1]).toStrictEqual(quoteTotals(GOLDEN_INPUT)!.lines[0]);
  });

  it('takes a lead time of minus zero as 0', () => {
    expect(Object.is(quoteTotals([lineOf({ lead_time_days: -0 })] as never)!.lines[0]!.lead_time_days, 0)).toBe(true);
  });

  it('reads no member that a prototype holds: a line with no own member gives null, although the prototype holds the four members', () => {
    const inherited = Object.fromEntries(Object.entries(GOLDEN_INPUT[0]!).map(([name, value]) => [name, { value, writable: true, enumerable: true }]));
    expect(withPrototype(Object.prototype, inherited, () => totalsOf([{}]))).toBeNull();
    expect(withPrototype(Object.prototype, { quantity: inherited.quantity! }, () => totalsOf([{ sku: 'A', unit_price: 1, lead_time_days: 0 }]))).toBeNull();
    expect(totalsOf([{ sku: 'A', quantity: 1, unit_price: 1, lead_time_days: 0 }])).not.toBeNull();
  });

  it('gives null for an empty list, and for 21 lines and more, and takes 1 line and 20 lines', () => {
    expect(quoteTotals([])).toBeNull();
    expect(quoteTotals(many(21))).toBeNull();
    expect(quoteTotals(many(100))).toBeNull();
    expect(quoteTotals(many(20))).not.toBeNull();
    expect(quoteTotals(many(1))).not.toBeNull();
  });

  it('gives null for a SKU two times, also when the two lines are apart, and takes two SKUs that differ in the case of a letter', () => {
    expect(quoteTotals([lineWith('A'), lineWith('A')])).toBeNull();
    expect(quoteTotals([lineWith('A'), lineWith('B'), lineWith('A')])).toBeNull();
    expect(quoteTotals([lineWith('A'), lineWith('B'), lineWith('C'), lineWith('D'), lineWith('C')])).toBeNull();
    expect(quoteTotals([lineWith('A'), lineWith('B')])).not.toBeNull();
    expect(quoteTotals([lineWith('A'), lineWith('a')])).not.toBeNull();
  });

  it('gives null for a product above Number.MAX_SAFE_INTEGER, and takes 20 lines of the largest product, which make a total that a number holds exactly', () => {
    for (const [quantity, unit_price] of [[2 ** 27, 2 ** 27], [2 ** 30, 2 ** 30], [Number.MAX_SAFE_INTEGER, 2], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]] as const) {
      expect(quoteTotals([{ sku: 'A', quantity, unit_price, lead_time_days: 0 }]), `${quantity} ${unit_price}`).toBeNull();
    }
    const huge = Array.from({ length: 20 }, (_, index) => ({ sku: `SKU-${index}`, quantity: 1_000_000, unit_price: 1_000_000, lead_time_days: 0 }));
    expect(quoteTotals(huge)?.total).toBe(20_000_000_000_000);
  });

  it.each([
    ['a quantity of 0', { quantity: 0 }], ['a negative quantity', { quantity: -1 }], ['a quantity above 1,000,000', { quantity: 1_000_001 }], ['a quantity with a fraction', { quantity: 1.5 }],
    ['a quantity that is a text', { quantity: '100' }], ['a quantity that is null', { quantity: null }], ['a quantity that is NaN', { quantity: Number.NaN }], ['a quantity that is infinite', { quantity: Number.POSITIVE_INFINITY }],
    ['a unit price of 0', { unit_price: 0 }], ['a negative unit price', { unit_price: -125 }], ['a unit price above 1,000,000', { unit_price: 1_000_001 }], ['a unit price with a fraction', { unit_price: 0.5 }],
    ['a unit price that is a text', { unit_price: '125' }], ['a unit price that is undefined', { unit_price: undefined }], ['a unit price that is NaN', { unit_price: Number.NaN }],
    ['a negative lead time', { lead_time_days: -1 }], ['a lead time above 365', { lead_time_days: 366 }], ['a lead time with a fraction', { lead_time_days: 1.5 }], ['a lead time that is a text', { lead_time_days: '14' }],
    ['a lead time that is a bigint', { lead_time_days: 14n }], ['a SKU that is not in the form', { sku: 'A B' }], ['a SKU that is the empty text', { sku: '' }], ['a SKU that is a number', { sku: 5 }],
    ['a SKU with the Kelvin sign', { sku: '\u212A' }],
  ])('gives null for %s, and the same line with the right member gives the totals', (_what, members) => {
    expect(totalsOf([lineOf(members)])).toBeNull();
    expect(totalsOf([lineOf({})])).not.toBeNull();
  });

  it.each([['null', null], ['undefined', undefined], ['a text', 'lines'], ['a number', 1], ['an object', {}], ['a list with a null', [null]], ['a list with a number', [1]], ['a list with a text', ['line']], ['a list with a list', [[]]]])(
    'gives null for lines that are %s, and never throws',
    (_what, lines) => {
      expect(() => totalsOf(lines)).not.toThrow();
      expect(totalsOf(lines)).toBeNull();
    },
  );

  it('gives lines that the parser takes, for every size from 1 to 20, and gives null for exactly the lines that the parser refuses: the limits of a line are the limits of the parser', () => {
    for (let count = 1; count <= 20; count += 1) {
      const input = linesOf(count).map((line) => ({ sku: line.sku as string, quantity: line.quantity as number, unit_price: line.unit_price as number, lead_time_days: line.lead_time_days as number }));
      const totals = quoteTotals(input)!;
      expect(parse({ ...golden(), lines: totals.lines, total: totals.total, lead_time_days: totals.lead_time_days }).ok, String(count)).toBe(true);
    }
    for (const [name, values] of [['quantity', [0, 1, 1_000_000, 1_000_001]], ['unit_price', [0, 1, 1_000_000, 1_000_001]], ['lead_time_days', [-1, 0, 365, 366]]] as const) {
      for (const value of values) {
        const input = lineOf({ [name]: value });
        const quoted = parse(withFirstLine({ [name]: value, line_total: Number(input.quantity) * Number(input.unit_price) })).ok;
        expect(totalsOf([input]) !== null, `${name} ${value}`).toBe(quoted);
      }
    }
  });
});

describe('the limits of a line and of a price list', () => {
  it('are the same: a unit price and a lead time that a price list takes are the ones that a quote line takes', () => {
    const listOf = (price: number, lead: number): Json => ({ schema: 'vector.usecase.price-list.v1', items: [{ sku: 'A', lead_time_days: lead, breaks: [{ min_quantity: 1, unit_price: price }] }] });
    for (const price of [0, 1, 1_000_000, 1_000_001]) expect(parsePriceList(listOf(price, 3)).ok, `unit price ${price}`).toBe(parse(withFirstLine({ unit_price: price, line_total: 100 * price })).ok);
    for (const lead of [-1, 0, 365, 366]) expect(parsePriceList(listOf(10, lead)).ok, `lead time ${lead}`).toBe(parse(withFirstLine({ lead_time_days: lead })).ok);
  });
});
