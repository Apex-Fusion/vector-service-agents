// packages/usecase-kit/test/bids/rfq.test.ts: the request for quotation of use case 3 (supplier bid evaluation). The Sourcing Agent sends it as the `rfq` object of a message, and each Bid Desk reads it.
// The golden file is the example. The parser takes what the sourcing record of the mock service takes for a request id and what the page of the Bid Desk says, and no more. The hash of a request is
// the canonical hash of its copy. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RFQ_SCHEMA, canonicalSha256, parseRfq, proposalDigest } from '@vsa/usecase-kit/protocol';
import { MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, parseRfqDocument, rfqSha256 } from '@vsa/usecase-kit/bids';
import type { RfqDocument } from '@vsa/usecase-kit/bids';
import { MARKER, change, expectRefused, golden, goldenText, listAt, must, objectAt, withPrototype } from './support.ts';
import type { Json } from './support.ts';

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = '132eb8d17df2d4b7afed745d84ea08be7a3696bacd10eb769311b39c458a80cc';
/** The SHA-256 of the canonical text of the golden request: the `rfq_sha256` of a quote and of a ranking. */
const GOLDEN_CANONICAL_SHA256 = '42ca167e867b2e8df3a82b7dc4a5b1c2a3a96f523e1f56a3863936a5dceadf35';
const SALT = '33'.repeat(32);

const MEMBERS = ['rfq_id', 'items', 'needed_by'] as const;
const ITEM_MEMBERS = ['sku', 'quantity'] as const;

/** A request with `count` items: SKU-0, SKU-1 and so on, with the quantities 1, 2 and so on. */
const requestOf = (count: number): Json => ({ rfq_id: 'run1-rfq-1', items: Array.from({ length: count }, (_, index) => ({ sku: `SKU-${index}`, quantity: 1 + index })), needed_by: '2026-12-20' });

/** The typed request that a test hashes: the parser made it. */
const goldenRfq = (): RfqDocument => must(parseRfqDocument(golden('rfq')));

describe('the golden request', () => {
  it('is the file that the hash names, and it holds the members of the page in their order', () => {
    expect(createHash('sha256').update(goldenText('rfq')).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    expect(Object.keys(golden('rfq'))).toStrictEqual([...MEMBERS]);
    for (const item of listAt(golden('rfq'), ['items'])) expect(Object.keys(item as object)).toStrictEqual([...ITEM_MEMBERS]);
  });

  it('passes the parser, and the copy holds the same members in the same order', () => {
    const result = parseRfqDocument(golden('rfq'));
    expect(result).toStrictEqual({ ok: true, value: golden('rfq') });
    expect(Object.keys(must(result))).toStrictEqual([...MEMBERS]);
    for (const item of must(result).items) expect(Object.keys(item)).toStrictEqual([...ITEM_MEMBERS]);
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden('rfq');
    const before = JSON.stringify(input);
    const rfq = must(parseRfqDocument(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(rfq).not.toBe(input);
    expect(rfq.items).not.toBe(input.items);
    expect(rfq.items[0]).not.toBe(objectAt(input, ['items', 0]));
    expect(Object.getPrototypeOf(rfq)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(rfq.items[0])).toBe(Object.prototype);
  });

  it('is the rfq object that a message of the protocol carries, and the parser reads the object of the message', () => {
    const message = { schema: RFQ_SCHEMA, sender_did: `did:vector:${'ec'.repeat(32)}`, delegation: 'ab'.repeat(32), rfq: golden('rfq') };
    const read = must(parseRfq(message));
    expect(parseRfqDocument(read.rfq, 'request.rfq')).toStrictEqual({ ok: true, value: golden('rfq') });
    expect(rfqSha256(must(parseRfqDocument(read.rfq)))).toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
  });

  it('holds only ASCII texts, so that no text of an accepted request changes in the NFC form', () => {
    const rfq = goldenRfq();
    for (const text of [rfq.rfq_id, rfq.needed_by, ...rfq.items.map((item) => item.sku)]) {
      expect(text).toMatch(/^[\x20-\x7e]+$/);
      expect(text).toBe(text.normalize('NFC'));
    }
  });
});

describe('parseRfqDocument', () => {
  it('takes 1 item and 20 items, and refuses no item and 21 items', () => {
    expect(MAX_RFQ_ITEMS).toBe(20);
    expect(parseRfqDocument(requestOf(1)).ok).toBe(true);
    expect(parseRfqDocument(requestOf(20)).ok).toBe(true);
    expectRefused(parseRfqDocument(requestOf(0)), 'rfq.items');
    expectRefused(parseRfqDocument(requestOf(21)), 'rfq.items');
  });

  it('refuses the same SKU two times, and names the second item and never the SKU', () => {
    const result = parseRfqDocument(change(requestOf(3), ['items', 2, 'sku'], 'SKU-0'));
    expectRefused(result, 'rfq.items[2].sku');
    expect(!result.ok && result.detail).not.toContain('SKU-0');
    expect(parseRfqDocument(requestOf(3)).ok).toBe(true);
  });

  it('takes two SKUs that differ in the case of a letter: they are two items', () => {
    expect(parseRfqDocument(change(requestOf(2), ['items', 1, 'sku'], 'sku-0')).ok).toBe(true);
  });

  it('takes the same quantity for two SKUs, and a SKU in any order', () => {
    expect(parseRfqDocument(change(requestOf(2), ['items', 1, 'quantity'], 1)).ok).toBe(true);
    const reversed = { ...requestOf(3), items: [...listAt(requestOf(3), ['items'])].reverse() };
    expect(must(parseRfqDocument(reversed)).items.map((item) => item.sku)).toStrictEqual(['SKU-2', 'SKU-1', 'SKU-0']);
  });

  it.each([
    ['0', 0], ['a negative number', -1], ['1,000,001', 1_000_001], ['a fraction', 1.5], ['a text', '10'], ['null', null], ['a list', [10]], ['true', true], ['a number that a number cannot hold exactly', 2 ** 53],
    ['a text with a line break', MARKER],
  ])('refuses the quantity %s, and takes the quantities 1 and 1,000,000', (_what, quantity) => {
    expect(MAX_ITEM_QUANTITY).toBe(1_000_000);
    expectRefused(parseRfqDocument(change(golden('rfq'), ['items', 1, 'quantity'], quantity)), 'rfq.items[1].quantity');
    expect(parseRfqDocument(change(golden('rfq'), ['items', 1, 'quantity'], 1)).ok).toBe(true);
    expect(parseRfqDocument(change(golden('rfq'), ['items', 1, 'quantity'], 1_000_000)).ok).toBe(true);
  });

  it.each([
    ['a day that does not exist', '2026-02-30'], ['a year before 0100', '0099-01-01'], ['the year 0', '0000-01-01'], ['a month of 13', '2026-13-01'], ['a month with one digit', '2026-1-1'],
    ['a time', '2026-12-20T00:00:00Z'], ['a space at the end', '2026-12-20 '], ['a line break at the end', '2026-12-20\n'], ['a number', 20_261_220], ['null', null], ['the empty text', ''],
    ['a text with a line break', MARKER],
  ])('refuses a date of needed_by that is %s, and takes the twins', (_what, day) => {
    expectRefused(parseRfqDocument(change(golden('rfq'), ['needed_by'], day)), 'rfq.needed_by');
    for (const good of ['2026-12-20', '0100-01-01', '2024-02-29', '9999-12-31']) expect(parseRfqDocument(change(golden('rfq'), ['needed_by'], good)).ok, good).toBe(true);
  });

  it.each([
    ['the empty text', ''], ['65 characters', 'A'.repeat(65)], ['a space', 'A B'], ['a slash', 'A/B'], ['a line break at the end', 'A\n'], ['a hyphen at the start', '-A'], ['a dot at the start', '.A'],
    ['a number', 5], ['null', null], ['a list', ['run1']], ['a letter with a mark in the NFD form', 'e\u0301'], ['a letter with a mark in the NFC form', '\u00e9'], ['a text with a line break', MARKER],
  ])('refuses a request id of %s, and takes the twins', (_what, id) => {
    expectRefused(parseRfqDocument(change(golden('rfq'), ['rfq_id'], id)), 'rfq.rfq_id');
    for (const good of ['A', 'a.b_c-d', '9', 'A'.repeat(64)]) expect(parseRfqDocument(change(golden('rfq'), ['rfq_id'], good)).ok, good).toBe(true);
  });

  it.each([
    ['the empty text', ''], ['65 characters', 'A'.repeat(65)], ['a space', 'A B'], ['a slash', 'A/B'], ['a line break at the end', 'A\n'], ['a number', 5], ['null', null],
    ['a letter with a mark in the NFD form', 'e\u0301'], ['a text with a line break', MARKER],
  ])('refuses a SKU of %s, and takes the twins', (_what, sku) => {
    expectRefused(parseRfqDocument(change(golden('rfq'), ['items', 0, 'sku'], sku)), 'rfq.items[0].sku');
    for (const good of ['A', 'a.b_c-d', '9', 'A'.repeat(64)]) expect(parseRfqDocument(change(golden('rfq'), ['items', 0, 'sku'], good)).ok, good).toBe(true);
  });

  it('checks each text as it is written: the Kelvin sign is refused in a request id and in a SKU, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    // The Kelvin sign (U+212A) is not an ASCII letter, and the sourcing record refuses it. The request is held to the same rule.
    for (const text of ['\u212aRFQ-1', 'RFQ-\u212a', 'x\u212ay']) {
      const id = parseRfqDocument(change(golden('rfq'), ['rfq_id'], text));
      expectRefused(id, 'rfq.rfq_id');
      expect(!id.ok && id.detail).not.toContain('\u212a');
      expectRefused(parseRfqDocument(change(golden('rfq'), ['items', 0, 'sku'], text)), 'rfq.items[0].sku');
    }
    expect(must(parseRfqDocument(change(golden('rfq'), ['rfq_id'], 'KRFQ-1'))).rfq_id).toBe('KRFQ-1');
    expect(must(parseRfqDocument(change(golden('rfq'), ['items', 0, 'sku'], 'KSU-1'))).items[0]!.sku).toBe('KSU-1');
  });

  it('refuses the same request id in the NFD form and in the NFC form, because the rule is ASCII', () => {
    expectRefused(parseRfqDocument(change(golden('rfq'), ['rfq_id'], 'caf\u00e9')), 'rfq.rfq_id');
    expectRefused(parseRfqDocument(change(golden('rfq'), ['rfq_id'], 'cafe\u0301')), 'rfq.rfq_id');
    expect(parseRfqDocument(change(golden('rfq'), ['rfq_id'], 'cafe')).ok).toBe(true);
  });

  it.each([
    ['the request', []], ['an item', ['items', 0]],
  ])('refuses a member that is not listed in %s, and the twin without it passes', (_what, path) => {
    expectRefused(parseRfqDocument(change(golden('rfq'), [...path, 'extra'], 1)), 'extra');
    expect(parseRfqDocument(golden('rfq')).ok).toBe(true);
  });

  it.each([
    ['rfq_id', []], ['items', []], ['needed_by', []], ['sku', ['items', 0]], ['quantity', ['items', 2]],
  ])('refuses a request with no member %s', (name, path) => {
    expectRefused(parseRfqDocument(change(golden('rfq'), [...path, name], undefined)), name);
  });

  it.each([
    ['an empty list', []], ['an object', { 0: { sku: 'A', quantity: 1 } }], ['a text', 'items'], ['null', null], ['a number', 1], ['a list that holds a text', ['SKU-1']], ['a list that holds null', [null]],
    ['a list that holds a list', [[]]],
  ])('refuses items that are %s', (_what, items) => {
    expectRefused(parseRfqDocument(change(golden('rfq'), ['items'], items)), 'rfq.items');
  });

  it.each([
    ['a list', []], ['a text', 'x'], ['null', null], ['a number', 5], ['undefined', undefined], ['true', true],
  ])('refuses a request that is %s', (_what, value) => {
    expectRefused(parseRfqDocument(value), 'rfq');
  });

  it('names the field that the caller gives, in the detail of each refusal', () => {
    expectRefused(parseRfqDocument(requestOf(0), 'request.rfq'), 'request.rfq.items');
    expectRefused(parseRfqDocument(change(golden('rfq'), ['items', 1, 'quantity'], 0), 'request.rfq'), 'request.rfq.items[1].quantity');
    expectRefused(parseRfqDocument(change(golden('rfq'), ['needed_by'], 'x'), 'request.rfq'), 'request.rfq.needed_by');
    expectRefused(parseRfqDocument(null, 'request.rfq'), 'request.rfq');
  });

  it('never repeats a value in a detail', () => {
    for (const path of [['rfq_id'], ['needed_by'], ['items', 0, 'sku'], ['items', 0, 'quantity']]) expectRefused(parseRfqDocument(change(golden('rfq'), path, MARKER)), 'rfq');
  });
});

describe('a value that is not plain JSON data', () => {
  const PLACES: ReadonlyArray<readonly [string, readonly (string | number)[], string]> = [
    ['the request', [], 'rfq_id'], ['an item', ['items', 0], 'sku'], ['an item, at its quantity', ['items', 2], 'quantity'],
  ];

  it.each(PLACES)('refuses a member of %s that is an accessor, and never runs the getter', (_place, path, member) => {
    let reads = 0;
    const input = golden('rfq');
    const holder = objectAt(input, path);
    const value = holder[member];
    Object.defineProperty(holder, member, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
    expectRefused(parseRfqDocument(input), member);
    expect(reads).toBe(0);
    expect(parseRfqDocument(golden('rfq')).ok).toBe(true);
  });

  it.each(PLACES)('refuses the key __proto__ in %s, with a value that looks right', (_place, path) => {
    const input = golden('rfq');
    Object.defineProperty(objectAt(input, path), '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expectRefused(parseRfqDocument(input), '__proto__');
  });

  it('refuses the key __proto__ that JSON.parse makes', () => {
    expectRefused(parseRfqDocument(JSON.parse('{"rfq_id":"a","items":[],"needed_by":"2026-12-20","__proto__":{"x":1}}')), '__proto__');
    expectRefused(parseRfqDocument(JSON.parse('{"rfq_id":"a","items":[{"sku":"A","quantity":1,"__proto__":{"x":1}}],"needed_by":"2026-12-20"}')), '__proto__');
  });

  it('refuses a list with a hole, a list with a member that is not an index, and a list of another kind', () => {
    const sparse = golden('rfq');
    delete listAt(sparse, ['items'])[1];
    expectRefused(parseRfqDocument(sparse), 'rfq.items[1]');
    const named = golden('rfq');
    Object.defineProperty(listAt(named, ['items']), 'extra', { value: 1, enumerable: true, configurable: true });
    expectRefused(parseRfqDocument(named), 'rfq.items');
    class Items extends Array<unknown> {}
    const other = golden('rfq');
    other.items = Items.from(listAt(other, ['items']));
    expectRefused(parseRfqDocument(other), 'rfq.items');
    expect(parseRfqDocument(golden('rfq')).ok).toBe(true);
  });

  it('refuses a value that JSON cannot hold, and a key that is not a string or not enumerable', () => {
    expectRefused(parseRfqDocument(change(golden('rfq'), ['items', 0, 'quantity'], Number.NaN)), 'quantity');
    expectRefused(parseRfqDocument(change(golden('rfq'), ['items', 0, 'quantity'], Number.POSITIVE_INFINITY)), 'quantity');
    expectRefused(parseRfqDocument({ ...golden('rfq'), extra: undefined }), 'extra');
    expectRefused(parseRfqDocument({ ...golden('rfq'), extra: () => 1 }), 'extra');
    expectRefused(parseRfqDocument({ ...golden('rfq'), [Symbol('x')]: 1 }), 'rfq');
    const hidden = golden('rfq');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parseRfqDocument(hidden), 'rfq');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    const throws = new Proxy(golden('rfq'), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parseRfqDocument(throws)).not.toThrow();
    expectRefused(parseRfqDocument(throws), 'rfq');
    const { proxy, revoke } = Proxy.revocable(golden('rfq'), {});
    revoke();
    expect(() => parseRfqDocument(proxy)).not.toThrow();
    expectRefused(parseRfqDocument(proxy), 'rfq');
  });

  it('takes an object with no prototype, and refuses an object of a class', () => {
    const bare = Object.assign(Object.create(null) as Json, golden('rfq'));
    expect(parseRfqDocument(bare)).toStrictEqual({ ok: true, value: golden('rfq') });
    class Request {
      rfq_id = 'run1-rfq-1';
      items = golden('rfq').items;
      needed_by = '2026-12-20';
    }
    expectRefused(parseRfqDocument(new Request()), 'rfq');
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parseRfqDocument(golden('rfq'));

  it.each([
    ['a setter for sku on Object.prototype', Object.prototype, 'sku'],
    ['a setter for quantity on Object.prototype', Object.prototype, 'quantity'],
    ['a setter for rfq_id on Object.prototype', Object.prototype, 'rfq_id'],
    ['a setter for the index 0 on Array.prototype', Array.prototype, '0'],
    ['a setter for the index 0 on Object.prototype', Object.prototype, '0'],
  ] as const)('with %s, the result is the result of the plain twin, and no setter runs', (_what, target, key) => {
    let calls = 0;
    const input = golden('rfq');
    const seen = withPrototype(target, { [key]: { set() { calls += 1; } } }, () => parseRfqDocument(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: a request with no own member is refused, and the copy has its own members', () => {
    const inherited = {
      rfq_id: { value: 'run1-rfq-1', writable: true, enumerable: true }, items: { value: golden('rfq').items, writable: true, enumerable: true }, needed_by: { value: '2026-12-20', writable: true, enumerable: true },
    };
    expect(withPrototype(Object.prototype, inherited, () => parseRfqDocument({})).ok).toBe(false);
    const rfq = must(PLAIN);
    expect(Object.hasOwn(rfq, 'items')).toBe(true);
    expect(Object.hasOwn(rfq.items[0]!, 'quantity')).toBe(true);
    expect(Object.hasOwn(rfq.items, 0)).toBe(true);
  });
});

describe('rfqSha256', () => {
  it('is the canonical hash of the golden request, with no salt', () => {
    expect(rfqSha256(goldenRfq())).toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
    expect(canonicalSha256(golden('rfq'))).toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
    expect(canonicalSha256(goldenRfq())).toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
    expect(proposalDigest(SALT, golden('rfq'))).not.toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
  });

  it('has the form of a digest: 64 lower-case hex characters', () => {
    expect(must(rfqSha256(goldenRfq()))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order of the members of the input, and the copy of the parser has the same hash as the input', () => {
    const shuffled: RfqDocument = { needed_by: '2026-12-20', items: goldenRfq().items, rfq_id: 'run1-rfq-1' };
    expect(rfqSha256(shuffled)).toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
    const items = goldenRfq().items.map(({ sku, quantity }) => ({ quantity, sku }));
    expect(rfqSha256({ rfq_id: 'run1-rfq-1', items, needed_by: '2026-12-20' })).toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
  });

  it('gives a hash that is the hash of the text that the other agent would write: the message path and the direct path agree', () => {
    const message = { schema: RFQ_SCHEMA, sender_did: `did:vector:${'ec'.repeat(32)}`, delegation: 'ab'.repeat(32), rfq: golden('rfq') };
    const read = must(parseRfq(message));
    expect(rfqSha256(must(parseRfqDocument(read.rfq)))).toStrictEqual(rfqSha256(goldenRfq()));
  });

  it('gives six hashes for six requests that differ in one member, in the order of the items, or in an item that is added', () => {
    const hashes = new Set(
      [
        golden('rfq'),
        change(golden('rfq'), ['rfq_id'], 'run1-rfq-2'),
        change(golden('rfq'), ['needed_by'], '2026-12-21'),
        change(golden('rfq'), ['items', 0, 'sku'], 'GLV-NIT-L'),
        change(golden('rfq'), ['items', 0, 'quantity'], 101),
        { ...golden('rfq'), items: [...listAt(golden('rfq'), ['items'])].reverse() },
      ].map((request) => must(rfqSha256(must(parseRfqDocument(request))))),
    );
    expect(hashes.size).toBe(6);
  });

  it('refuses a document that the parser refuses, and names the request, and gives the hash of its twin', () => {
    for (const bad of [change(golden('rfq'), ['extra'], 1), change(golden('rfq'), ['items', 0, 'quantity'], 0), requestOf(21), change(golden('rfq'), ['needed_by'], '2026-02-30')]) {
      expectRefused(rfqSha256(bad as unknown as RfqDocument), 'rfq');
    }
    expect(rfqSha256(goldenRfq()).ok).toBe(true);
  });

  it('refuses a value that is not an object, and an accessor, and never runs a getter', () => {
    for (const value of [null, undefined, 'rfq', 5, [], () => 1]) expectRefused(rfqSha256(value as unknown as RfqDocument), 'rfq');
    let reads = 0;
    const input = golden('rfq');
    Object.defineProperty(input, 'rfq_id', { get() { reads += 1; return 'run1-rfq-1'; }, enumerable: true, configurable: true });
    expectRefused(rfqSha256(input as unknown as RfqDocument), 'rfq_id');
    expect(reads).toBe(0);
  });
});
