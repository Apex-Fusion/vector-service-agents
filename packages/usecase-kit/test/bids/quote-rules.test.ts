// packages/usecase-kit/test/bids/quote-rules.test.ts: the rules that tie a quote of use case 3 (supplier bid evaluation) to the request that it answers and to the price list that it was priced from. The
// Sourcing Agent runs the two checks in code before its model reads the quote, and it builds the evidence of a challenge from the line checks. The parser cannot know the request or the list, so a quote
// that passes `parseQuote` can still name a line for an item that the request lacks, or a list that the agent did not read. Each refusal has an accepted twin.
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';
import { checkQuoteAnswersRfq, checkQuoteFromList, lineChecks, parsePriceList, parseQuote, parseRfqDocument, priceListSha256, quoteTotals, rfqSha256 } from '@vsa/usecase-kit/bids';
import type { LineCheck, PriceList, Quote, RfqDocument } from '@vsa/usecase-kit/bids';
import { change, golden as inputGolden, goldenText as inputGoldenText, listAt, must, withPrototype } from './support.ts';
import type { Json } from './support.ts';

/** A fresh value of a golden quote. The shared support of the folder reads the golden files of the other documents. */
const goldenQuote = (name: 'quote' | 'quote-off-list' = 'quote'): Json => JSON.parse(readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8')) as Json;

/** The functions with an input of any type: a caller in JavaScript, or a value that came from outside. */
const answers = checkQuoteAnswersRfq as (quote: unknown, rfq: unknown) => ProtocolResult<null, 'quote_not_for_rfq'>;
const fromList = checkQuoteFromList as (quote: unknown, listSha256: unknown) => ProtocolResult<null, 'quote_not_from_list'>;

const request = (members: Json = {}): RfqDocument => must(parseRfqDocument({ ...inputGolden('rfq'), ...members }));
const hashOf = (rfq: RfqDocument): string => must(rfqSha256(rfq));
const goldenList = (): PriceList => must(parsePriceList(inputGolden('price-list')));
/** The golden quote with other members, passed through the parser. */
const quoteOf = (members: Json = {}): Quote => must(parseQuote({ ...goldenQuote(), ...members }));

interface Chosen { sku: string; quantity: number; unit_price: number; lead_time_days: number }
/** The three lines of the golden request, at the listed prices of the golden list. The golden quote holds the first and the last. */
const GLV: Chosen = { sku: 'GLV-NIT-M', quantity: 100, unit_price: 125, lead_time_days: 14 };
const SYR: Chosen = { sku: 'SYR-10ML', quantity: 250, unit_price: 36, lead_time_days: 10 };
const MSK: Chosen = { sku: 'MSK-N95', quantity: 40, unit_price: 60, lead_time_days: 21 };
/** The golden quote with other lines: the line totals, the total and the lead time come from `quoteTotals`, so the quote passes the parser. */
function quoteWithLines(chosen: readonly Chosen[], members: Json = {}): Quote {
  const totals = quoteTotals(chosen);
  if (totals === null) throw new Error('the lines of the sample must have an arithmetic');
  return quoteOf({ ...members, lines: totals.lines, total: totals.total, lead_time_days: totals.lead_time_days });
}

/** A refusal with the code, with a detail that names `where` and holds none of the values. A detail never holds a digest. */
function expectRefusal(result: ProtocolResult<unknown, string>, code: string, where: string, ...values: readonly string[]): void {
  expect(result.ok, `a refusal that names ${where}`).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.detail).toContain(where);
  expect(result.detail).not.toMatch(/[0-9a-f]{64}/);
  for (const value of values) expect(result.detail).not.toContain(value);
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
};

/** Values that no request and no quote is: a caller in JavaScript can pass any of them. */
const NOT_OBJECTS: readonly (readonly [string, unknown])[] = [
  ['null', null], ['undefined', undefined], ['a text', 'quote'], ['a number', 7], ['true', true], ['a bigint', 10n], ['a list', []], ['a function', () => 1], ['a symbol', Symbol('quote')],
];
const THROWING_PROXY = new Proxy({}, { ownKeys: () => { throw new Error('a trap that throws'); }, getPrototypeOf: () => { throw new Error('a trap that throws'); } });
const REVOKED_PROXY = (() => { const handle = Proxy.revocable({}, {}); handle.revoke(); return handle.proxy; })();

describe('checkQuoteAnswersRfq: the golden quote and its request', () => {
  it('takes the golden quote for the golden request, and gives null: the hash of the quote is the hash of the request', () => {
    expect(quoteOf().rfq_sha256).toBe(hashOf(request()));
    expect(checkQuoteAnswersRfq(quoteOf(), request())).toStrictEqual({ ok: true, value: null });
  });

  it('takes a quote that leaves an item of the request out, a quote with every item, a quote with one line, and the lines in another order than the items', () => {
    for (const [what, chosen] of [['two of three', [GLV, MSK]], ['every item', [GLV, SYR, MSK]], ['one line', [SYR]], ['the order of the items reversed', [MSK, SYR, GLV]]] as const) {
      expect(checkQuoteAnswersRfq(quoteWithLines(chosen), request()), what).toStrictEqual({ ok: true, value: null });
    }
  });

  it('is a rule of the answer and not of the form: a quote that the parser takes with a line for an item that the request lacks is refused here', () => {
    const lacking = { ...goldenQuote(), lines: [{ ...listAt(goldenQuote(), ['lines'])[0] as Json, sku: 'NOT-ASKED' }, listAt(goldenQuote(), ['lines'])[1]] };
    expect(parseQuote(lacking).ok).toBe(true);
    expectRefusal(checkQuoteAnswersRfq(must(parseQuote(lacking)), request()), 'quote_not_for_rfq', 'quote.lines[0].sku', 'NOT-ASKED');
  });
});

describe('checkQuoteAnswersRfq: the identifier of the request', () => {
  it.each([
    ['another number', 'run1-rfq-2'], ['the same text in capital letters', 'RUN1-RFQ-1'], ['a longer text that starts with the identifier', 'run1-rfq-10'], ['a shorter text', 'run1-rfq'],
    ['the identifier with a dot at the end', 'run1-rfq-1.'],
  ])('refuses a quote with %s, names rfq_id, and never repeats the value', (_what, id) => {
    expectRefusal(checkQuoteAnswersRfq(quoteOf({ rfq_id: id }), request()), 'quote_not_for_rfq', 'quote.rfq_id', id);
  });

  it('takes the quote of another request that carries that identifier and that hash: the twin of each refusal above', () => {
    for (const id of ['run1-rfq-2', 'RUN1-RFQ-1', 'run1-rfq-10', 'run1-rfq', 'run1-rfq-1.']) {
      const other = request({ rfq_id: id });
      expect(checkQuoteAnswersRfq(quoteOf({ rfq_id: id, rfq_sha256: hashOf(other) }), other), id).toStrictEqual({ ok: true, value: null });
      expect(checkQuoteAnswersRfq(quoteOf({ rfq_id: id, rfq_sha256: hashOf(other) }), request()).ok, id).toBe(false);
    }
  });
});

describe('checkQuoteAnswersRfq: the hash of the request', () => {
  const VARIANTS: readonly (readonly [string, Json])[] = [
    ['a changed date', { needed_by: '2026-12-21' }],
    ['one more item', { items: [...(listAt(inputGolden('rfq'), ['items']) as Json[]), { sku: 'GLV-NIT-L', quantity: 5 }] }],
    ['the items in another order', { items: [...(listAt(inputGolden('rfq'), ['items']) as Json[])].reverse() }],
    ['another quantity of an item that the quote does not name', { items: (listAt(inputGolden('rfq'), ['items']) as Json[]).map((item) => (item.sku === 'SYR-10ML' ? { ...item, quantity: 251 } : item)) }],
    ['one item less, an item that the quote does not name', { items: (listAt(inputGolden('rfq'), ['items']) as Json[]).filter((item) => item.sku !== 'SYR-10ML') }],
  ];

  it.each(VARIANTS)('refuses a quote of the golden request when the request is %s, and names rfq_sha256 and not rfq_id', (_what, members) => {
    const refusal = checkQuoteAnswersRfq(quoteOf(), request(members));
    expectRefusal(refusal, 'quote_not_for_rfq', 'quote.rfq_sha256');
    if (!refusal.ok) expect(refusal.detail).not.toContain('rfq_id');
  });

  it.each(VARIANTS)('takes the quote that names the hash of the request when the request is %s: the twin', (_what, members) => {
    const other = request(members);
    expect(hashOf(other)).not.toBe(hashOf(request()));
    expect(checkQuoteAnswersRfq(quoteOf({ rfq_sha256: hashOf(other) }), other)).toStrictEqual({ ok: true, value: null });
  });

  it('refuses a hash that no request has and the hash of the golden request in capital letters, and takes the golden hash: the form of a digest is 64 lower-case hex characters', () => {
    expectRefusal(answers({ ...goldenQuote(), rfq_sha256: '00'.repeat(32) }, request()), 'quote_not_for_rfq', 'quote.rfq_sha256');
    expectRefusal(answers({ ...goldenQuote(), rfq_sha256: hashOf(request()).toUpperCase() }, request()), 'quote_not_for_rfq', 'quote.rfq_sha256');
    expect(answers(goldenQuote(), request()).ok).toBe(true);
  });
});

describe('checkQuoteAnswersRfq: the lines', () => {
  it.each([
    ['a SKU that is like an item', 'GLV-NIT-L'], ['a SKU in small letters', 'glv-nit-m'], ['a SKU that an item starts', 'GLV-NIT-M2'], ['a SKU that starts an item', 'GLV-NIT'], ['a SKU that no item has', 'NOT-ASKED'],
  ])('refuses a first line with %s, names quote.lines[0].sku, and never repeats the SKU', (_what, sku) => {
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([{ ...GLV, sku }, MSK]), request()), 'quote_not_for_rfq', 'quote.lines[0].sku', sku);
  });

  it('refuses a second line and a third line for an item that the request lacks, and names that line', () => {
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([GLV, { ...MSK, sku: 'NOT-ASKED' }]), request()), 'quote_not_for_rfq', 'quote.lines[1].sku', 'NOT-ASKED');
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([GLV, MSK, { ...SYR, sku: 'NOT-ASKED' }]), request()), 'quote_not_for_rfq', 'quote.lines[2].sku', 'NOT-ASKED');
    expect(checkQuoteAnswersRfq(quoteWithLines([GLV, MSK, SYR]), request()).ok).toBe(true);
  });

  it.each([
    ['one below the item', 99], ['one above the item', 101], ['the quantity of another item', 250], ['the least quantity', 1], ['the greatest quantity', 1_000_000],
  ])('refuses a first line with %s, names quote.lines[0].quantity, and the line with the quantity of the item passes', (_what, quantity) => {
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([{ ...GLV, quantity }, MSK]), request()), 'quote_not_for_rfq', 'quote.lines[0].quantity');
    expect(checkQuoteAnswersRfq(quoteWithLines([{ ...GLV, quantity: 100 }, MSK]), request()).ok).toBe(true);
  });

  it('refuses a line of the last place whose quantity is another quantity than the item has, and checks every line and not the first only', () => {
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([GLV, SYR, { ...MSK, quantity: 41 }]), request()), 'quote_not_for_rfq', 'quote.lines[2].quantity');
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([GLV, { ...SYR, quantity: 249 }, MSK]), request()), 'quote_not_for_rfq', 'quote.lines[1].quantity');
  });

  it('holds each line to its own item: the quantity of another item does not pass for the SKU of this item, in both directions', () => {
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([{ ...GLV, quantity: 250 }, { ...SYR, quantity: 100 }]), request()), 'quote_not_for_rfq', 'quote.lines[0].quantity');
    expect(checkQuoteAnswersRfq(quoteWithLines([{ ...GLV, quantity: 100 }, { ...SYR, quantity: 250 }]), request()).ok).toBe(true);
  });

  it('reads no SKU as a member of an object: a SKU that Object.prototype holds is no item of the request, and the twin request that lists it takes it', () => {
    for (const sku of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
      const line: Chosen = { sku, quantity: 1, unit_price: 5, lead_time_days: 1 };
      expectRefusal(checkQuoteAnswersRfq(quoteWithLines([GLV, line]), request()), 'quote_not_for_rfq', 'quote.lines[1].sku', sku);
      const listed = request({ items: [...(listAt(inputGolden('rfq'), ['items']) as Json[]), { sku, quantity: 1 }] });
      expect(checkQuoteAnswersRfq(quoteWithLines([GLV, line], { rfq_sha256: hashOf(listed) }), listed), sku).toStrictEqual({ ok: true, value: null });
    }
  });
});

describe('checkQuoteAnswersRfq: the order of the three conditions', () => {
  const wrongLine = (): Json => change(change(goldenQuote(), ['lines', 0, 'sku'], 'NOT-ASKED'), ['lines', 1, 'quantity'], 41);

  it('names the identifier first, then the hash, then the lines: each refusal names the first condition that fails', () => {
    const [first, second] = [{ rfq_id: 'run1-rfq-2', rfq_sha256: '00'.repeat(32) }, { rfq_sha256: '00'.repeat(32) }];
    expectRefusal(answers({ ...wrongLine(), ...first }, request()), 'quote_not_for_rfq', 'quote.rfq_id');
    expectRefusal(answers({ ...wrongLine(), ...second }, request()), 'quote_not_for_rfq', 'quote.rfq_sha256');
    expectRefusal(answers(wrongLine(), request()), 'quote_not_for_rfq', 'quote.lines[0].sku');
  });

  it('names the first line that fails when the SKU of a later line and the quantity of an earlier line are both wrong', () => {
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([{ ...GLV, quantity: 99 }, { ...MSK, sku: 'NOT-ASKED' }]), request()), 'quote_not_for_rfq', 'quote.lines[0].quantity');
    expectRefusal(checkQuoteAnswersRfq(quoteWithLines([GLV, { ...MSK, sku: 'NOT-ASKED' }]), request()), 'quote_not_for_rfq', 'quote.lines[1].sku');
  });
});

describe('checkQuoteAnswersRfq: a value that is no request and a value that is no quote', () => {
  it.each(NOT_OBJECTS)('refuses a request that is %s, names rfq, and never throws', (_what, value) => {
    expect(() => answers(quoteOf(), value)).not.toThrow();
    expectRefusal(answers(quoteOf(), value), 'quote_not_for_rfq', 'rfq');
  });

  it.each([
    ['no items', { items: [] }], ['21 items', { items: Array.from({ length: 21 }, (_, index) => ({ sku: `SKU-${index}`, quantity: 1 })) }], ['an item twice', { items: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }] }],
    ['a quantity of 0', { items: [{ sku: 'GLV-NIT-M', quantity: 0 }] }], ['a date that does not exist', { needed_by: '2026-02-30' }], ['no date', { needed_by: undefined }],
    ['a member that is not listed', { extra: 1 }], ['an identifier with a space', { rfq_id: 'run1 rfq' }],
  ])('refuses a request with %s: the request must be a request for quotation, and the twin passes', (_what, members) => {
    const input = { ...inputGolden('rfq'), ...members };
    expect(() => answers(quoteOf(), input)).not.toThrow();
    expectRefusal(answers(quoteOf(), input), 'quote_not_for_rfq', 'rfq');
    expect(answers(quoteOf(), inputGolden('rfq')).ok).toBe(true);
  });

  it('refuses a Proxy that throws and a Proxy that was revoked as the request, and never throws', () => {
    for (const value of [THROWING_PROXY, REVOKED_PROXY]) {
      expect(() => answers(quoteOf(), value)).not.toThrow();
      expectRefusal(answers(quoteOf(), value), 'quote_not_for_rfq', 'rfq');
    }
  });

  it.each(NOT_OBJECTS)('refuses a quote that is %s, names quote, and never throws', (_what, value) => {
    expect(() => answers(value, request())).not.toThrow();
    expectRefusal(answers(value, request()), 'quote_not_for_rfq', 'quote');
  });

  it.each([
    ['an object with no member', {}], ['no identifier', change(goldenQuote(), ['rfq_id'], undefined)], ['an identifier that is a number', change(goldenQuote(), ['rfq_id'], 1)],
    ['no hash', change(goldenQuote(), ['rfq_sha256'], undefined)], ['a hash that is no digest', change(goldenQuote(), ['rfq_sha256'], 'abc')],
    ['no lines', change(goldenQuote(), ['lines'], undefined)], ['lines that are a text', change(goldenQuote(), ['lines'], 'GLV-NIT-M')], ['an empty list of lines', change(goldenQuote(), ['lines'], [])],
    ['a line that is null', change(goldenQuote(), ['lines', 0], null)], ['a line that is a list', change(goldenQuote(), ['lines', 0], ['GLV-NIT-M', 100])],
    ['a line with no SKU', change(goldenQuote(), ['lines', 0, 'sku'], undefined)], ['a line with a SKU that is a number', change(goldenQuote(), ['lines', 0, 'sku'], 5)],
    ['a line with a quantity that is a text', change(goldenQuote(), ['lines', 0, 'quantity'], '100')], ['a line with no quantity', change(goldenQuote(), ['lines', 0, 'quantity'], undefined)],
  ])('refuses %s, and never takes a value that the parser would refuse: the twin, the golden quote, passes', (_what, value) => {
    expect(() => answers(value, request())).not.toThrow();
    expectRefusal(answers(value, request()), 'quote_not_for_rfq', 'quote');
    expect(answers(goldenQuote(), request()).ok).toBe(true);
  });

  it('refuses a quote with a member that is an accessor, and never runs the getter, and the twin with a plain member passes', () => {
    let reads = 0;
    const quote = goldenQuote();
    Object.defineProperty(quote, 'rfq_id', { enumerable: true, get: () => { reads += 1; return 'run1-rfq-1'; } });
    expectRefusal(answers(quote, request()), 'quote_not_for_rfq', 'quote');
    expect(reads).toBe(0);
    expect(answers(goldenQuote(), request()).ok).toBe(true);
  });

  it('reads no member that a prototype holds: a quote with no own lines is refused, although Object.prototype holds the lines', () => {
    const inherited = { lines: { value: listAt(goldenQuote(), ['lines']), writable: true, enumerable: true } };
    expectRefusal(withPrototype(Object.prototype, inherited, () => answers(change(goldenQuote(), ['lines'], undefined), request())), 'quote_not_for_rfq', 'quote');
    expect(answers(goldenQuote(), request()).ok).toBe(true);
  });
});

describe('checkQuoteAnswersRfq: what it keeps and what it changes', () => {
  it('works on a quote and a request that nothing can change, and changes nothing of them', () => {
    const quote = deepFreeze(quoteOf());
    const rfq = deepFreeze(request());
    expect(checkQuoteAnswersRfq(quote, rfq)).toStrictEqual({ ok: true, value: null });
    expectRefusal(checkQuoteAnswersRfq(deepFreeze(quoteOf({ rfq_id: 'run1-rfq-2' })), rfq), 'quote_not_for_rfq', 'quote.rfq_id');
  });

  it('has the type of a rule: a result with null for the value and the one code quote_not_for_rfq', () => {
    expectTypeOf(checkQuoteAnswersRfq).parameters.toEqualTypeOf<[quote: Quote, rfq: RfqDocument]>();
    expectTypeOf(checkQuoteAnswersRfq).returns.toEqualTypeOf<ProtocolResult<null, 'quote_not_for_rfq'>>();
  });
});

describe('checkQuoteFromList', () => {
  const LIST_SHA = priceListSha256(inputGoldenText('price-list'));
  /** The text of the golden list with another unit price in the first break. */
  const OTHER_TEXT = inputGoldenText('price-list').replace('140', '141');

  it('takes the golden quote for the hash of the bytes of the golden list, and gives null', () => {
    expect(quoteOf().price_list_sha256).toBe(LIST_SHA);
    expect(checkQuoteFromList(quoteOf(), LIST_SHA)).toStrictEqual({ ok: true, value: null });
  });

  it.each([
    ['a list with another unit price', priceListSha256(OTHER_TEXT)], ['the list in another layout', priceListSha256(JSON.stringify(inputGolden('price-list')))],
    ['the list with one space more at the end', priceListSha256(`${inputGoldenText('price-list')} `)], ['an empty text', priceListSha256('')], ['a hash of zeros', '00'.repeat(32)],
  ])('refuses a quote of the golden list when the agent read %s, names price_list_sha256, and never repeats a hash', (_what, hash) => {
    expect(hash).not.toBe(LIST_SHA);
    expectRefusal(checkQuoteFromList(quoteOf(), hash), 'quote_not_from_list', 'quote.price_list_sha256');
  });

  it('takes the quote that names the hash of the list that the agent read, for every list above: the twin of each refusal', () => {
    for (const hash of [priceListSha256(OTHER_TEXT), priceListSha256(JSON.stringify(inputGolden('price-list'))), priceListSha256(''), '00'.repeat(32)]) {
      expect(checkQuoteFromList(quoteOf({ price_list_sha256: hash }), hash), hash).toStrictEqual({ ok: true, value: null });
    }
  });

  it('compares the hash as written: the hash in capital letters, with a space, or of another length is no hash of the list', () => {
    for (const hash of [LIST_SHA.toUpperCase(), ` ${LIST_SHA}`, `${LIST_SHA} `, LIST_SHA.slice(1), `${LIST_SHA}0`, '']) {
      expectRefusal(fromList(quoteOf(), hash), 'quote_not_from_list', 'price list');
    }
    expect(fromList(quoteOf(), LIST_SHA).ok).toBe(true);
  });

  it.each([['null', null], ['undefined', undefined], ['a number', 7], ['a list', [LIST_SHA]], ['an object', { hash: LIST_SHA }], ['a bigint', 10n]])(
    'refuses a hash of the list that is %s, and never throws',
    (_what, hash) => {
      expect(() => fromList(quoteOf(), hash)).not.toThrow();
      expectRefusal(fromList(quoteOf(), hash), 'quote_not_from_list', 'price list');
    },
  );

  it('never takes two values that are missing, or two values that are equal and are no hash: no value is a hash of the list because it equals another value', () => {
    expectRefusal(fromList({}, undefined), 'quote_not_from_list', 'price list');
    expectRefusal(fromList(change(goldenQuote(), ['price_list_sha256'], undefined), undefined), 'quote_not_from_list', 'price list');
    expectRefusal(fromList(change(goldenQuote(), ['price_list_sha256'], 'abc'), 'abc'), 'quote_not_from_list', 'price list');
    expectRefusal(fromList(change(goldenQuote(), ['price_list_sha256'], 7), 7), 'quote_not_from_list', 'price list');
    expectRefusal(fromList(change(goldenQuote(), ['price_list_sha256'], undefined), LIST_SHA), 'quote_not_from_list', 'quote');
    expect(fromList(goldenQuote(), LIST_SHA).ok).toBe(true);
  });

  it.each(NOT_OBJECTS)('refuses a quote that is %s, names quote, and never throws', (_what, value) => {
    expect(() => fromList(value, LIST_SHA)).not.toThrow();
    expectRefusal(fromList(value, LIST_SHA), 'quote_not_from_list', 'quote');
  });

  it('refuses a quote with an accessor for the hash and never runs the getter, and reads no hash from a prototype', () => {
    let reads = 0;
    const quote = goldenQuote();
    Object.defineProperty(quote, 'price_list_sha256', { enumerable: true, get: () => { reads += 1; return LIST_SHA; } });
    expectRefusal(fromList(quote, LIST_SHA), 'quote_not_from_list', 'quote');
    expect(reads).toBe(0);
    const inherited = { price_list_sha256: { value: LIST_SHA, writable: true, enumerable: true } };
    expectRefusal(withPrototype(Object.prototype, inherited, () => fromList(change(goldenQuote(), ['price_list_sha256'], undefined), LIST_SHA)), 'quote_not_from_list', 'quote');
  });

  it('asks one thing: a quote that does not answer the request still comes from the list, and a quote of another list still answers the request', () => {
    expect(checkQuoteFromList(quoteOf({ rfq_id: 'run1-rfq-2' }), LIST_SHA).ok).toBe(true);
    expect(checkQuoteAnswersRfq(quoteOf({ price_list_sha256: priceListSha256(OTHER_TEXT) }), request()).ok).toBe(true);
  });

  it('works on a quote that nothing can change, and has the type of a rule with the one code quote_not_from_list', () => {
    expect(checkQuoteFromList(deepFreeze(quoteOf()), LIST_SHA)).toStrictEqual({ ok: true, value: null });
    expectTypeOf(checkQuoteFromList).parameters.toEqualTypeOf<[quote: Quote, listSha256: string]>();
    expectTypeOf(checkQuoteFromList).returns.toEqualTypeOf<ProtocolResult<null, 'quote_not_from_list'>>();
  });
});

describe('lineChecks', () => {
  const checkOf = (chosen: Chosen, list: PriceList = goldenList()): LineCheck => lineChecks(quoteWithLines([chosen]), list)[0]!;

  it('gives one check for each line of the golden quote, in the order of the lines, with the listed price of the golden list', () => {
    expect(lineChecks(quoteOf(), goldenList())).toStrictEqual([
      { sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: 125, listed_unit_price: 125 },
      { sku: 'MSK-N95', quantity: 40, quoted_unit_price: 60, listed_unit_price: 60 },
    ]);
  });

  it('gives the quoted price of the line and the listed price of the list, and the two differ for the golden quote that has a lower price: 100 against 125', () => {
    expect(lineChecks(quoteOf(goldenQuote('quote-off-list')), goldenList())).toStrictEqual([
      { sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: 100, listed_unit_price: 125 },
      { sku: 'MSK-N95', quantity: 40, quoted_unit_price: 60, listed_unit_price: 60 },
    ]);
  });

  it('keeps the order of the lines and not the order of the list or of the request', () => {
    expect(lineChecks(quoteWithLines([MSK, SYR, GLV]), goldenList()).map((check) => check.sku)).toStrictEqual(['MSK-N95', 'SYR-10ML', 'GLV-NIT-M']);
    expect(lineChecks(quoteWithLines([GLV, SYR, MSK]), goldenList()).map((check) => check.sku)).toStrictEqual(['GLV-NIT-M', 'SYR-10ML', 'MSK-N95']);
  });

  it('gives plain objects with the four members in this order, new objects that share nothing with the quote or the list, in a new list', () => {
    const quote = quoteOf();
    const checks = lineChecks(quote, goldenList());
    for (const check of checks) {
      expect(Object.keys(check)).toStrictEqual(['sku', 'quantity', 'quoted_unit_price', 'listed_unit_price']);
      expect(Object.getPrototypeOf(check)).toBe(Object.prototype);
    }
    expect(Object.getPrototypeOf(checks)).toBe(Array.prototype);
    expect(checks).not.toBe(quote.lines);
    expect(checks[0]).not.toBe(quote.lines[0]);
    expect(lineChecks(quote, goldenList())).not.toBe(checks);
  });

  it.each([
    ['GLV-NIT-M', 1, 140], ['GLV-NIT-M', 49, 140], ['GLV-NIT-M', 50, 132], ['GLV-NIT-M', 99, 132], ['GLV-NIT-M', 100, 125], ['GLV-NIT-M', 499, 125], ['GLV-NIT-M', 500, 112], ['GLV-NIT-M', 1_000_000, 112],
    ['SYR-10ML', 1, 42], ['SYR-10ML', 249, 42], ['SYR-10ML', 250, 36], ['SYR-10ML', 999, 36], ['SYR-10ML', 1000, 31],
    ['MSK-N95', 1, 65], ['MSK-N95', 24, 65], ['MSK-N95', 25, 60], ['MSK-N95', 99, 60], ['MSK-N95', 100, 54], ['MSK-N95', 999, 54], ['MSK-N95', 1000, 47],
  ])('gives the listed price of the break for %s at the quantity %i: %i', (sku, quantity, listed) => {
    expect(checkOf({ sku, quantity, unit_price: 7, lead_time_days: 1 })).toStrictEqual({ sku, quantity, quoted_unit_price: 7, listed_unit_price: listed });
  });

  it('gives null as the listed price of a SKU that the list lacks, and the listed price of the other lines stays', () => {
    const withoutSyr = must(parsePriceList({ ...inputGolden('price-list'), items: (listAt(inputGolden('price-list'), ['items']) as Json[]).filter((entry) => entry.sku !== 'SYR-10ML') }));
    const checks = lineChecks(quoteWithLines([GLV, SYR, MSK]), withoutSyr);
    expect(checks.map((check) => check.listed_unit_price)).toStrictEqual([125, null, 60]);
    expect(checks.map((check) => check.quoted_unit_price)).toStrictEqual([125, 36, 60]);
    expect(lineChecks(quoteWithLines([GLV, SYR, MSK]), goldenList()).map((check) => check.listed_unit_price)).toStrictEqual([125, 36, 60]);
  });

  it('gives null for every line when the list lists none of the SKUs, and for a SKU that the list lists in another case or with another end', () => {
    const other = must(parsePriceList({ schema: 'vector.usecase.price-list.v1', items: [{ sku: 'glv-nit-m', lead_time_days: 1, breaks: [{ min_quantity: 1, unit_price: 5 }] }, { sku: 'MSK-N95X', lead_time_days: 1, breaks: [{ min_quantity: 1, unit_price: 5 }] }] }));
    expect(lineChecks(quoteOf(), other).map((check) => check.listed_unit_price)).toStrictEqual([null, null]);
    expect(lineChecks(quoteOf(), goldenList()).map((check) => check.listed_unit_price)).toStrictEqual([125, 60]);
  });

  it('gives equal prices for a quote at the listed prices, and prices that differ by one in both directions', () => {
    for (const unit_price of [124, 126]) {
      const check = checkOf({ ...GLV, unit_price });
      expect([check.quoted_unit_price, check.listed_unit_price]).toStrictEqual([unit_price, 125]);
    }
    const same = checkOf(GLV);
    expect(same.quoted_unit_price).toBe(same.listed_unit_price);
  });

  it('compares unit prices and nothing else: another lead time in the list, or in the quote, changes no check', () => {
    const items = (listAt(inputGolden('price-list'), ['items']) as Json[]).map((entry) => ({ ...entry, lead_time_days: 365 }));
    const slow = must(parsePriceList({ ...inputGolden('price-list'), items }));
    expect(lineChecks(quoteOf(), slow)).toStrictEqual(lineChecks(quoteOf(), goldenList()));
    expect(lineChecks(quoteWithLines([{ ...GLV, lead_time_days: 0 }, { ...MSK, lead_time_days: 0 }]), goldenList())).toStrictEqual(lineChecks(quoteOf(), goldenList()));
  });

  it('reads no SKU as a member of an object: a SKU that Object.prototype holds has no listed price', () => {
    for (const sku of ['constructor', 'toString', 'hasOwnProperty']) expect(checkOf({ sku, quantity: 1, unit_price: 5, lead_time_days: 1 }).listed_unit_price, sku).toBeNull();
  });

  it('gives one check for each of 1 and 20 lines, and a list of 200 entries gives the same checks', () => {
    for (const count of [1, 20]) {
      const chosen = Array.from({ length: count }, (_, index) => ({ sku: `SKU-${index}`, quantity: index + 1, unit_price: 10 + index, lead_time_days: 1 }));
      const entries = Array.from({ length: 200 }, (_, index) => ({ sku: `SKU-${index}`, lead_time_days: 1, breaks: [{ min_quantity: 1, unit_price: 10 + index }] }));
      const checks = lineChecks(quoteWithLines(chosen), must(parsePriceList({ schema: 'vector.usecase.price-list.v1', items: entries })));
      expect(checks.map((check) => check.sku)).toStrictEqual(chosen.map((line) => line.sku));
      expect(checks.every((check) => check.quoted_unit_price === check.listed_unit_price), String(count)).toBe(true);
    }
  });

  it('works on a quote and a list that nothing can change, and has the types of a check', () => {
    expect(lineChecks(deepFreeze(quoteOf()), deepFreeze(goldenList()))).toHaveLength(2);
    expectTypeOf(lineChecks).returns.toEqualTypeOf<readonly LineCheck[]>();
    expectTypeOf<LineCheck>().toEqualTypeOf<{ readonly sku: string; readonly quantity: number; readonly quoted_unit_price: number; readonly listed_unit_price: number | null }>();
  });
});
