// packages/usecase-kit/test/bids/facts.test.ts: the facts of the evidence of a quote challenge in use case 3 (supplier bid evaluation). A challenge needs a line whose quoted unit price is not the unit price of
// the published price list. `quotePriceFacts` makes the facts only for such a line: the list gives a price for it, and the price differs from the quoted price. The bids folder does not import the dispute
// folder, so this test passes the facts to `evidenceDocument` and holds the two places to the same rule. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';
import { BID_DESK_CLAIM, lineChecks, parsePriceList, parseQuote, priceListSha256, quotePriceFacts, quoteTotals } from '@vsa/usecase-kit/bids';
import * as bids from '@vsa/usecase-kit/bids';
import type { LineCheck, PriceFacts } from '@vsa/usecase-kit/bids';
import { evidenceDocument } from '@vsa/usecase-kit/dispute';
import type { EvidenceDocumentInput, QuotePriceFacts } from '@vsa/usecase-kit/dispute';
import { PARTIES } from '../dispute/support.ts';
import { golden as inputGolden, goldenText as inputGoldenText, listAt, must } from './support.ts';
import type { Json } from './support.ts';

const quoteText = readFileSync(new URL('./golden/quote-off-list.json', import.meta.url), 'utf8');

/** The function with an input of any type: a caller in JavaScript, or a value that came from outside. */
const facts = quotePriceFacts as (input: unknown) => ProtocolResult<unknown, 'no_listed_price' | 'no_contradiction'>;

const MEMBERS = ['kind', 'sku', 'quantity', 'quoted_unit_price', 'listed_unit_price', 'price_list_sha256', 'quote_sha256'] as const;
const DIGESTS = { price_list_sha256: 'aa'.repeat(32), quote_sha256: 'bb'.repeat(32) };

/** A line check that breaks the list: the first line of the golden quote with the fault, 100 against the listed 125. `members` change it, whatever their type. */
const lineWith = (members: Record<string, unknown> = {}): LineCheck => ({ sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: 100, listed_unit_price: 125, ...members }) as LineCheck;
const factsOf = (members: Record<string, unknown> = {}) => quotePriceFacts({ line: lineWith(members), ...DIGESTS });

/** The text of a refusal: the code, and a detail that holds no value. */
function expectRefusal(result: ProtocolResult<unknown, string>, code: string, where: string): void {
  expect(result.ok, `a refusal with the code ${code}`).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.detail).toContain(where);
  expect(result.detail).not.toMatch(/[0-9a-f]{64}/);
}

const ODD_PRICES: readonly (readonly [string, unknown])[] = [
  ['undefined', undefined], ['null', null], ['a text with the number', '125'], ['the text of a price with a space', ' 125'], ['zero', 0], ['minus zero', -0], ['a negative price', -125], ['a price with a fraction', 125.5],
  ['a price above 1,000,000', 1_000_001], ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY], ['a bigint', 125n], ['true', true], ['a list', [125]], ['an object', { price: 125 }],
  ['a number that a number cannot hold exactly', 2 ** 53],
];

describe('quotePriceFacts: a line that breaks the list', () => {
  it('makes the seven members of the facts of a quote challenge, in the order of the dispute folder, for a quoted price below the listed price', () => {
    expect(factsOf()).toStrictEqual({
      ok: true,
      value: { kind: 'quote_price', sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: 100, listed_unit_price: 125, price_list_sha256: 'aa'.repeat(32), quote_sha256: 'bb'.repeat(32) },
    });
    expect(Object.keys(must(factsOf()))).toStrictEqual([...MEMBERS]);
  });

  it('makes facts for a quoted price above the listed price too: a price above the list breaks the statement as a price below it does', () => {
    expect(must(factsOf({ quoted_unit_price: 126 }))).toMatchObject({ kind: 'quote_price', quoted_unit_price: 126, listed_unit_price: 125 });
  });

  it.each([[124, 125], [126, 125], [1, 2], [2, 1], [999_999, 1_000_000], [1_000_000, 999_999], [1, 1_000_000], [1_000_000, 1]])('makes facts for the quoted price %i and the listed price %i: the least and the greatest price too', (quoted, listed) => {
    expect(must(factsOf({ quoted_unit_price: quoted, listed_unit_price: listed }))).toMatchObject({ quoted_unit_price: quoted, listed_unit_price: listed });
  });

  it('gives the SKU, the quantity and the two prices of the line, and the two digests each in its own member, as they are given', () => {
    const made = must(quotePriceFacts({ line: lineWith({ sku: 'MSK-N95', quantity: 40, quoted_unit_price: 55, listed_unit_price: 60 }), price_list_sha256: 'cc'.repeat(32), quote_sha256: 'dd'.repeat(32) }));
    expect(made).toStrictEqual({ kind: 'quote_price', sku: 'MSK-N95', quantity: 40, quoted_unit_price: 55, listed_unit_price: 60, price_list_sha256: 'cc'.repeat(32), quote_sha256: 'dd'.repeat(32) });
  });

  it('gives a new plain object with the seven members and nothing else: a member of the line or of the input beyond them is left out', () => {
    const line = { ...lineWith(), salt: 'x', credential: 'a.b.c' };
    const input = { line, ...DIGESTS, proposal_digest: 'y' };
    const made = must(quotePriceFacts(input));
    expect(Object.keys(made)).toStrictEqual([...MEMBERS]);
    expect(Object.getPrototypeOf(made)).toBe(Object.prototype);
    expect(made).not.toBe(line);
    expect(made).not.toBe(input);
  });

  it('reads each member of the line one time, and the facts hold what that read gave: a line that changes its value at each read never gives facts for equal prices', () => {
    const reads = { sku: 0, quantity: 0, quoted_unit_price: 0, listed_unit_price: 0 };
    const line: Record<string, unknown> = {};
    const flip = (name: keyof typeof reads, first: unknown, later: unknown): void => {
      Object.defineProperty(line, name, { enumerable: true, get: () => { reads[name] += 1; return reads[name] === 1 ? first : later; } });
    };
    flip('sku', 'GLV-NIT-M', 'OTHER');
    flip('quantity', 100, 7);
    flip('quoted_unit_price', 100, 125);
    flip('listed_unit_price', 125, 125);
    const made = must(quotePriceFacts({ line: line as unknown as LineCheck, ...DIGESTS }));
    expect(reads).toStrictEqual({ sku: 1, quantity: 1, quoted_unit_price: 1, listed_unit_price: 1 });
    expect(made).toMatchObject({ sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: 100, listed_unit_price: 125 });
    expect(made.quoted_unit_price).not.toBe(made.listed_unit_price);
  });

  it('has the type of the facts of the dispute folder: the seven members, and a value that the dispute folder takes as the facts of the kind quote_price, with the two codes of a refusal', () => {
    expectTypeOf<PriceFacts>().toExtend<QuotePriceFacts>();
    expectTypeOf<keyof PriceFacts>().toEqualTypeOf<keyof QuotePriceFacts>();
    expectTypeOf<PriceFacts['kind']>().toEqualTypeOf<'quote_price'>();
    expectTypeOf(quotePriceFacts).returns.toEqualTypeOf<ProtocolResult<PriceFacts, 'no_listed_price' | 'no_contradiction'>>();
    const input: EvidenceDocumentInput = { ...PARTIES, ...must(factsOf()) };
    expect(input.kind).toBe('quote_price');
  });
});

describe('quotePriceFacts: a line with no listed price', () => {
  it('refuses a line whose listed price is null, names the listed unit price, and the twin with a listed price makes facts', () => {
    const refusal = factsOf({ listed_unit_price: null });
    expectRefusal(refusal, 'no_listed_price', 'listed unit price');
    expect(factsOf({ listed_unit_price: 125 }).ok).toBe(true);
  });

  it('refuses the line of a SKU that the price list lacks, and makes facts for the line of a SKU that it lists, in the same quote', () => {
    const quote = must(parseQuote(JSON.parse(quoteText) as Json));
    const items = (listAt(inputGolden('price-list'), ['items']) as Json[]).filter((entry) => entry.sku !== 'GLV-NIT-M');
    const checks = lineChecks(quote, must(parsePriceList({ ...inputGolden('price-list'), items })));
    expect(checks.map((line) => line.listed_unit_price)).toStrictEqual([null, 60]);
    expectRefusal(quotePriceFacts({ line: checks[0]!, ...DIGESTS }), 'no_listed_price', 'listed unit price');
    expect(lineChecks(quote, must(parsePriceList(inputGolden('price-list'))))[0]!.listed_unit_price).toBe(125);
    expect(quotePriceFacts({ line: lineChecks(quote, must(parsePriceList(inputGolden('price-list'))))[0]!, ...DIGESTS }).ok).toBe(true);
  });

  it.each(ODD_PRICES)('refuses a listed price that is %s: no_listed_price, and no facts', (_what, value) => {
    expectRefusal(factsOf({ listed_unit_price: value }), 'no_listed_price', 'listed unit price');
    expect(factsOf({ listed_unit_price: 125 }).ok).toBe(true);
  });

  it('refuses a line that has no listed_unit_price member, and a member that only the prototype of the line could hold', () => {
    const { listed_unit_price: _removed, ...rest } = lineWith();
    expectRefusal(facts({ line: rest, ...DIGESTS }), 'no_listed_price', 'listed unit price');
    expectRefusal(facts({ line: Object.create(lineWith()) as unknown, ...DIGESTS }), 'no_listed_price', 'line');
  });

  it('checks the listed price before the quoted price: a line with neither gives no_listed_price', () => {
    expectRefusal(factsOf({ listed_unit_price: null, quoted_unit_price: null }), 'no_listed_price', 'listed unit price');
    expectRefusal(factsOf({ listed_unit_price: null, quoted_unit_price: 100 }), 'no_listed_price', 'listed unit price');
  });

  it.each([
    ['null', null], ['undefined', undefined], ['a text', 'line'], ['a number', 7], ['a list', [lineWith()]], ['a function', () => 1], ['an object with no member', {}], ['an object of a class', new (class Line {})()],
    ['a Proxy that throws', new Proxy({}, { getPrototypeOf: () => { throw new Error('a trap that throws'); } })],
  ])('refuses a line that is %s, and never throws', (_what, line) => {
    expect(() => facts({ line, ...DIGESTS })).not.toThrow();
    expectRefusal(facts({ line, ...DIGESTS }), 'no_listed_price', 'line');
  });

  it.each([['null', null], ['undefined', undefined], ['a text', 'input'], ['a number', 7], ['a list', []], ['an object with no member', {}], ['an object with no line', DIGESTS]])(
    'refuses an input that is %s, and never throws',
    (_what, input) => {
      expect(() => facts(input)).not.toThrow();
      expectRefusal(facts(input), 'no_listed_price', 'line');
    },
  );
});

describe('quotePriceFacts: a line that does not contradict the list', () => {
  it.each([[1], [2], [99], [125], [999_999], [1_000_000]])('refuses a quoted price that is the listed price %i: no_contradiction, and the same line with a price that differs by one makes facts', (price) => {
    expectRefusal(factsOf({ quoted_unit_price: price, listed_unit_price: price }), 'no_contradiction', 'quoted unit price');
    expect(factsOf({ quoted_unit_price: price === 1 ? 2 : price - 1, listed_unit_price: price }).ok).toBe(true);
    expect(factsOf({ quoted_unit_price: price === 1_000_000 ? 999_999 : price + 1, listed_unit_price: price }).ok).toBe(true);
  });

  it.each(ODD_PRICES)('refuses a quoted price that is %s: no_contradiction, and no facts for a value that is no price', (_what, value) => {
    expectRefusal(factsOf({ quoted_unit_price: value }), 'no_contradiction', 'quoted unit price');
    expect(factsOf({ quoted_unit_price: 100 }).ok).toBe(true);
  });

  it('never reads a text as a price: the text 125 is not the price 125, and it gives no facts against the listed price 125 or against another price', () => {
    for (const listed of [125, 100]) expectRefusal(factsOf({ quoted_unit_price: '125', listed_unit_price: listed }), 'no_contradiction', 'quoted unit price');
  });

  it('gives no facts for a quoted price that equals the listed price although the lines differ in every other member', () => {
    for (const members of [{ sku: 'MSK-N95' }, { quantity: 1 }, { quantity: 1_000_000 }]) expectRefusal(factsOf({ ...members, quoted_unit_price: 125 }), 'no_contradiction', 'quoted unit price');
  });

  it('keeps the two codes apart: no_listed_price is for a line with no price in the list, and no_contradiction is for a price that the list gives and the quote keeps', () => {
    expect(factsOf({ listed_unit_price: null })).toMatchObject({ ok: false, code: 'no_listed_price' });
    expect(factsOf({ quoted_unit_price: 125 })).toMatchObject({ ok: false, code: 'no_contradiction' });
    expect(factsOf({ listed_unit_price: null, quoted_unit_price: 125 })).toMatchObject({ ok: false, code: 'no_listed_price' });
  });
});

describe('the limits of a unit price', () => {
  const listOf = (price: number): Json => ({ schema: 'vector.usecase.price-list.v1', items: [{ sku: 'A', lead_time_days: 3, breaks: [{ min_quantity: 1, unit_price: price }] }] });

  it('are the limits of the price list and of a line of a quote: a unit price that they hold is a unit price here, and one that they refuse is not', () => {
    for (const price of [0, 1, 1_000_000, 1_000_001]) {
      expect(factsOf({ quoted_unit_price: 3, listed_unit_price: price }).ok, `listed ${price}`).toBe(parsePriceList(listOf(price)).ok);
      const quoted = quoteTotals([{ sku: 'A', quantity: 1, unit_price: price, lead_time_days: 0 }]) !== null;
      expect(factsOf({ quoted_unit_price: price, listed_unit_price: 3 }).ok, `quoted ${price}`).toBe(quoted);
    }
  });
});

describe('the facts and the evidence document of the dispute folder', () => {
  const evidenceOf = (input: object) => evidenceDocument({ ...PARTIES, ...input } as EvidenceDocumentInput);

  it('passes the object with the parties of a challenge to evidenceDocument, and gets a document of the kind evidence that states both prices, the SKU, the quantity and the two hashes', () => {
    const document = must(evidenceOf(must(factsOf())));
    expect(document.type).toBe('evidence');
    expect(document.media_type).toBe('text/plain');
    expect(document.text).toContain('quoted the unit price 100 for the SKU "GLV-NIT-M" at the quantity 100.');
    expect(document.text).toContain('gives the unit price 125 for the SKU "GLV-NIT-M" at the quantity 100.');
    expect(document.text).toContain(`SHA-256 of the published price list: ${'aa'.repeat(32)}`);
    expect(document.text).toContain(`SHA-256 of the quote: ${'bb'.repeat(32)}`);
    expect(document.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('holds the statement of the Bid Desk in the document: the first statement of the claim that the kit names, as the Sourcing Agent passes it', () => {
    const statement = BID_DESK_CLAIM.statements[0].text;
    const document = must(evidenceOf({ ...must(factsOf()), statement_text: statement }));
    expect(document.text).toContain('Statement S1 of the claim reads: ');
    expect(document.text).toContain(statement);
  });

  it('gives no_contradiction for two equal prices in both places: quotePriceFacts refuses them, and so does evidenceDocument for the same members written by hand', () => {
    const same = { kind: 'quote_price', sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: 125, listed_unit_price: 125, ...DIGESTS };
    expect(factsOf({ quoted_unit_price: 125 })).toMatchObject({ ok: false, code: 'no_contradiction' });
    expect(evidenceOf(same)).toMatchObject({ ok: false, code: 'no_contradiction' });
    expect(factsOf({ quoted_unit_price: 124 }).ok).toBe(true);
    expect(evidenceOf({ ...same, quoted_unit_price: 124 }).ok).toBe(true);
  });

  it('agrees with evidenceDocument for each pair of unit prices: the facts exist exactly when the document exists, and the two refuse the same pairs with the same code', () => {
    const prices = [1, 2, 99, 100, 124, 125, 126, 999_999, 1_000_000];
    for (const quoted of prices) {
      for (const listed of prices) {
        const made = factsOf({ quoted_unit_price: quoted, listed_unit_price: listed });
        const document = evidenceOf({ kind: 'quote_price', sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: quoted, listed_unit_price: listed, ...DIGESTS });
        expect(made.ok, `${quoted} against ${listed}`).toBe(document.ok);
        expect(made.ok, `${quoted} against ${listed}`).toBe(quoted !== listed);
        if (!made.ok && !document.ok) expect(made.code).toBe(document.code);
        if (made.ok) expect(must(evidenceOf(made.value)).type).toBe('evidence');
      }
    }
  });
});

describe('quotePriceFacts: from a quote and a price list to the evidence', () => {
  const list = must(parsePriceList(inputGolden('price-list')));
  const quote = must(parseQuote(JSON.parse(quoteText) as Json));
  const quoteSha256 = createHash('sha256').update(quoteText).digest('hex');

  it('finds the line of the golden quote with the fault, 100 against the listed 125, and makes facts that the evidence takes: the other line is at the listed price and gives no facts', () => {
    expect(quote.price_list_sha256).toBe(priceListSha256(inputGoldenText('price-list')));
    const checks = lineChecks(quote, list);
    const results = checks.map((line) => quotePriceFacts({ line, price_list_sha256: quote.price_list_sha256, quote_sha256: quoteSha256 }));
    expect(results.map((result) => (result.ok ? 'facts' : result.code))).toStrictEqual(['facts', 'no_contradiction']);
    const made = must(results[0]!);
    expect(made).toStrictEqual({
      kind: 'quote_price', sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: 100, listed_unit_price: 125, price_list_sha256: quote.price_list_sha256, quote_sha256: quoteSha256,
    });
    expect(must(evidenceDocument({ ...PARTIES, statement_text: BID_DESK_CLAIM.statements[0].text, ...made })).type).toBe('evidence');
  });

  it('makes no facts for the golden quote at the listed prices: every line gives no_contradiction', () => {
    const clean = must(parseQuote(JSON.parse(readFileSync(new URL('./golden/quote.json', import.meta.url), 'utf8')) as Json));
    const results = lineChecks(clean, list).map((line) => quotePriceFacts({ line, ...DIGESTS }));
    expect(results.map((result) => (result.ok ? 'facts' : result.code))).toStrictEqual(['no_contradiction', 'no_contradiction']);
  });
});

describe('the names of the facts', () => {
  it('are exported from the folder, and the helpers of the file are not: the folder gives the function and the type of the facts', () => {
    expect(Object.keys(bids)).toContain('quotePriceFacts');
    for (const name of ['priceOf', 'MAX_UNIT_PRICE']) expect(Object.keys(bids), name).not.toContain(name);
  });
});
