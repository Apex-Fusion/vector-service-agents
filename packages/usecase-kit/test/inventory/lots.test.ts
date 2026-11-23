// packages/usecase-kit/test/inventory/lots.test.ts: the lot names, and the lots file that the Order Desk serves. The golden file is the example. The file is hashed as its bytes, and not in a canonical
// form, because the manifest holds the hash of the bytes that the Order Desk serves. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LOTS_SCHEMA, LOT_NAMES, isLotName, lotSizeOf, lotsFileSha256, parseLotsFile } from '@vsa/usecase-kit/inventory';
import type { LotsFile } from '@vsa/usecase-kit/inventory';
import { MARKER, change, expectRefused, golden, goldenText, listAt, must, objectAt, withPrototype } from './support.ts';
import type { Json } from './support.ts';

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = 'b6879bc6de9226b8d4c56cfe53a8a956ff8c064038ff3ce2885d8bba28523fea';

/** A lots file with `count` items: the SKUs SKU-0, SKU-1 and so on. */
const fileOf = (count: number): Json => ({
  schema: LOTS_SCHEMA,
  items: Array.from({ length: count }, (_, index) => ({ sku: `SKU-${index}`, lots: { 'lot-small': 1, 'lot-medium': 2, 'lot-large': 3 } })),
});

describe('the lot names', () => {
  it('are the three lots, from the smallest to the largest', () => {
    expect(LOT_NAMES).toStrictEqual(['lot-small', 'lot-medium', 'lot-large']);
  });

  it.each(LOT_NAMES)('takes %s', (name) => {
    expect(isLotName(name)).toBe(true);
  });

  it.each([
    ['another lot', 'lot-huge'], ['a name in capital letters', 'LOT-SMALL'], ['a name with a space', 'lot-small '], ['a name with a line break', 'lot-small\n'], ['the empty text', ''],
    ['a name of the prototype', 'constructor'], ['the key __proto__', '__proto__'], ['a number', 1], ['null', null], ['undefined', undefined], ['a list', ['lot-small']],
    ['a String object', new String('lot-small')], ['an object', { lot: 'lot-small' }],
  ])('refuses %s', (_what, value) => {
    expect(isLotName(value)).toBe(false);
  });
});

describe('the golden lots file', () => {
  it('is the file that the hash names', () => {
    expect(createHash('sha256').update(goldenText('lots')).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    expect(lotsFileSha256(goldenText('lots'))).toBe(GOLDEN_FILE_SHA256);
  });

  it('passes the parser, and the copy holds the members of the file', () => {
    const result = parseLotsFile(golden('lots'));
    expect(result).toStrictEqual({ ok: true, value: golden('lots') });
    expect(parseLotsFile(JSON.parse(goldenText('lots')))).toStrictEqual(result);
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden('lots');
    const before = JSON.stringify(input);
    const file = must(parseLotsFile(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(file).not.toBe(input);
    expect(file.items).not.toBe(input.items);
    expect(file.items[0]).not.toBe(objectAt(input, ['items', 0]));
    expect(file.items[0]!.lots).not.toBe(objectAt(input, ['items', 0, 'lots']));
  });

  it('names the members of each item in the order of the file, and the lots in the order of the lot names', () => {
    const file = must(parseLotsFile(golden('lots')));
    expect(Object.keys(file)).toStrictEqual(['schema', 'items']);
    for (const item of file.items) {
      expect(Object.keys(item)).toStrictEqual(['sku', 'lots']);
      expect(Object.keys(item.lots)).toStrictEqual([...LOT_NAMES]);
    }
  });
});

describe('parseLotsFile', () => {
  it('takes 1 item and 200 items, and refuses no item and 201 items', () => {
    expect(parseLotsFile(fileOf(1)).ok).toBe(true);
    expect(parseLotsFile(fileOf(200)).ok).toBe(true);
    expectRefused(parseLotsFile(fileOf(0)), 'lots file.items');
    expectRefused(parseLotsFile(fileOf(201)), 'lots file.items');
  });

  it('refuses the same SKU two times, and names the second item and never the SKU', () => {
    const result = parseLotsFile(change(fileOf(3), ['items', 2, 'sku'], 'SKU-0'));
    expectRefused(result, 'lots file.items[2].sku');
    expect(!result.ok && result.detail).not.toContain('SKU-0');
    expect(parseLotsFile(fileOf(3)).ok).toBe(true);
  });

  it('takes two SKUs that differ in the case of a letter: they are two items', () => {
    expect(parseLotsFile(change(fileOf(2), ['items', 1, 'sku'], 'sku-0')).ok).toBe(true);
  });

  it.each([
    ['0', 0], ['a negative size', -1], ['1,000,001', 1_000_001], ['a fraction', 1.5], ['a text', '10'], ['null', null], ['a list', [10]], ['true', true], ['a text with a line break', MARKER],
  ])('refuses the size %s, and takes the sizes 1 and 1,000,000', (_what, size) => {
    for (const lot of LOT_NAMES) {
      expectRefused(parseLotsFile(change(golden('lots'), ['items', 0, 'lots', lot], size)), `lots file.items[0].lots.${lot}`);
      expect(parseLotsFile(change(golden('lots'), ['items', 0, 'lots', lot], 1)).ok).toBe(true);
      expect(parseLotsFile(change(golden('lots'), ['items', 0, 'lots', lot], 1_000_000)).ok).toBe(true);
    }
  });

  it.each(LOT_NAMES)('refuses an item with no lot %s', (lot) => {
    expectRefused(parseLotsFile(change(golden('lots'), ['items', 1, 'lots', lot], undefined)), lot);
  });

  it('refuses a lot that is not a lot name, beside the three and in the place of one of them', () => {
    expectRefused(parseLotsFile(change(golden('lots'), ['items', 0, 'lots', 'lot-huge'], 5)), 'lot-huge');
    const lots = change(golden('lots'), ['items', 0, 'lots', 'lot-large'], undefined);
    expectRefused(parseLotsFile(change(lots, ['items', 0, 'lots', 'lot-huge'], 200)), 'lot-large');
  });

  it.each([
    ['the file', []], ['an item', ['items', 0]], ['the lots of an item', ['items', 0, 'lots']],
  ])('refuses a member that is not listed in %s, and the twin without it passes', (_what, path) => {
    expectRefused(parseLotsFile(change(golden('lots'), [...path, 'extra'], 1)), 'extra');
    expect(parseLotsFile(golden('lots')).ok).toBe(true);
  });

  it.each([
    ['schema', []], ['items', []], ['sku', ['items', 0]], ['lots', ['items', 0]],
  ])('refuses a file with no member %s', (name, path) => {
    expectRefused(parseLotsFile(change(golden('lots'), [...path, name], undefined)), name);
  });

  it.each([
    ['another version', 'vector.usecase.lots.v2'], ['capital letters', 'VECTOR.USECASE.LOTS.V1'], ['the schema of the order', 'vector.usecase.po.v1'], ['a number', 1], ['null', null],
    ['a text with a line break', MARKER],
  ])('refuses a schema that is %s', (_what, schema) => {
    expectRefused(parseLotsFile(change(golden('lots'), ['schema'], schema)), 'lots file.schema');
  });

  it.each([
    ['the empty text', ''], ['65 characters', 'A'.repeat(65)], ['a space', 'A B'], ['a slash', 'A/B'], ['a line break at the end', 'A\n'], ['a hyphen at the start', '-A'], ['a dot at the start', '.A'],
    ['a number', 5], ['null', null], ['a letter with a mark', 'e\u0301'], ['a text with a line break', MARKER],
  ])('refuses a SKU of %s, and takes the twins', (_what, sku) => {
    expectRefused(parseLotsFile(change(golden('lots'), ['items', 0, 'sku'], sku)), 'lots file.items[0].sku');
    for (const good of ['A', 'a.b_c-d', '9', 'A'.repeat(64)]) expect(parseLotsFile(change(golden('lots'), ['items', 0, 'sku'], good)).ok, good).toBe(true);
  });

  it.each([
    ['an empty list', []], ['an object', { 0: {} }], ['a text', 'items'], ['null', null], ['a list that holds a text', ['SKU-1']], ['a list that holds null', [null]], ['a list that holds a list', [[]]],
  ])('refuses items that are %s', (_what, items) => {
    expectRefused(parseLotsFile(change(golden('lots'), ['items'], items)), 'lots file.items');
  });

  it.each([
    ['a list', []], ['a text', 'lot-small'], ['null', null], ['a number', 1],
  ])('refuses the lots of an item that are %s', (_what, lots) => {
    expectRefused(parseLotsFile(change(golden('lots'), ['items', 0, 'lots'], lots)), 'lots file.items[0].lots');
  });

  it.each([
    ['a list', []], ['a text', 'x'], ['null', null], ['a number', 5], ['undefined', undefined],
  ])('refuses a file that is %s', (_what, value) => {
    expectRefused(parseLotsFile(value), 'lots file');
  });

  it('checks each text as it is written: the Kelvin sign is refused in a SKU, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    // The Kelvin sign (U+212A) is not an ASCII letter, and the store refuses it. The lots file is held to the same rule.
    for (const sku of ['\u212ASU-1', 'SKU-\u212A', 'x\u212Ay']) {
      const result = parseLotsFile(change(golden('lots'), ['items', 0, 'sku'], sku));
      expectRefused(result, 'lots file.items[0].sku');
      expect(!result.ok && result.detail).not.toContain('\u212A');
    }
    expect(must(parseLotsFile(change(golden('lots'), ['items', 0, 'sku'], 'KSU-1'))).items[0]!.sku).toBe('KSU-1');
  });

  it('holds only ASCII texts in the copy of a file, so that no text of an accepted file changes in the NFC form', () => {
    for (const item of must(parseLotsFile(golden('lots'))).items) {
      expect(item.sku).toMatch(/^[\x20-\x7e]+$/);
      expect(item.sku).toBe(item.sku.normalize('NFC'));
    }
  });
});

describe('a value that is not plain JSON data', () => {
  const PLACES: ReadonlyArray<readonly [string, readonly (string | number)[], string]> = [
    ['the file', [], 'schema'], ['an item', ['items', 0], 'sku'], ['the lots of an item', ['items', 0, 'lots'], 'lot-small'],
  ];

  it.each(PLACES)('refuses a member of %s that is an accessor, and never runs the getter', (_place, path, member) => {
    let reads = 0;
    const input = golden('lots');
    const holder = objectAt(input, path);
    const value = holder[member];
    Object.defineProperty(holder, member, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
    expectRefused(parseLotsFile(input), member);
    expect(reads).toBe(0);
    expect(parseLotsFile(golden('lots')).ok).toBe(true);
  });

  it.each(PLACES)('refuses the key __proto__ in %s, with a value that looks right', (_place, path) => {
    const input = golden('lots');
    Object.defineProperty(objectAt(input, path), '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expectRefused(parseLotsFile(input), '__proto__');
  });

  it('refuses the key __proto__ that JSON.parse makes', () => {
    expectRefused(parseLotsFile(JSON.parse('{"schema":"vector.usecase.lots.v1","items":[],"__proto__":{"x":1}}')), '__proto__');
  });

  it('refuses a list with a hole, a list with a member that is not an index, and a list of another kind', () => {
    const sparse = golden('lots');
    delete listAt(sparse, ['items'])[1];
    expectRefused(parseLotsFile(sparse), 'lots file.items[1]');
    const named = golden('lots');
    Object.defineProperty(listAt(named, ['items']), 'extra', { value: 1, enumerable: true, configurable: true });
    expectRefused(parseLotsFile(named), 'lots file.items');
    class Items extends Array<unknown> {}
    const other = golden('lots');
    other.items = Items.from(listAt(other, ['items']));
    expectRefused(parseLotsFile(other), 'lots file.items');
    expect(parseLotsFile(golden('lots')).ok).toBe(true);
  });

  it('refuses a value that JSON cannot hold, and a key that is not a string or not enumerable', () => {
    expectRefused(parseLotsFile(change(golden('lots'), ['items', 0, 'lots', 'lot-small'], Number.NaN)), 'lot-small');
    expectRefused(parseLotsFile(change(golden('lots'), ['items', 0, 'lots', 'lot-small'], Number.POSITIVE_INFINITY)), 'lot-small');
    expectRefused(parseLotsFile({ ...golden('lots'), extra: undefined }), 'extra');
    expectRefused(parseLotsFile({ ...golden('lots'), extra: () => 1 }), 'extra');
    expectRefused(parseLotsFile({ ...golden('lots'), [Symbol('x')]: 1 }), 'lots file');
    const hidden = golden('lots');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parseLotsFile(hidden), 'lots file');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    const throws = new Proxy(golden('lots'), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parseLotsFile(throws)).not.toThrow();
    expectRefused(parseLotsFile(throws), 'lots file');
    const { proxy, revoke } = Proxy.revocable(golden('lots'), {});
    revoke();
    expect(() => parseLotsFile(proxy)).not.toThrow();
    expectRefused(parseLotsFile(proxy), 'lots file');
  });

  it('takes an object with no prototype, and refuses an object of a class', () => {
    const bare = Object.assign(Object.create(null) as Json, golden('lots'));
    expect(parseLotsFile(bare)).toStrictEqual({ ok: true, value: golden('lots') });
    class Lots {
      schema = LOTS_SCHEMA;
      items = golden('lots').items;
    }
    expectRefused(parseLotsFile(new Lots()), 'lots file');
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parseLotsFile(golden('lots'));

  it.each([
    ['a setter for lot-small on Object.prototype', Object.prototype, 'lot-small'],
    ['a setter for sku on Object.prototype', Object.prototype, 'sku'],
    ['a setter for the index 0 on Array.prototype', Array.prototype, '0'],
    ['a setter for the index 0 on Object.prototype', Object.prototype, '0'],
  ] as const)('with %s, the result is the result of the plain twin, and no setter runs', (_what, target, key) => {
    let calls = 0;
    const input = golden('lots');
    const seen = withPrototype(target, { [key]: { set() { calls += 1; } } }, () => parseLotsFile(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: a file with no own member is refused, and the copy has its own members', () => {
    const inherited = { items: { value: golden('lots').items, writable: true, enumerable: true }, schema: { value: LOTS_SCHEMA, writable: true, enumerable: true } };
    expect(withPrototype(Object.prototype, inherited, () => parseLotsFile({})).ok).toBe(false);
    const file = must(PLAIN);
    expect(Object.hasOwn(file, 'items')).toBe(true);
    expect(Object.hasOwn(file.items[0]!.lots, 'lot-large')).toBe(true);
    expect(Object.hasOwn(file.items, 0)).toBe(true);
  });
});

describe('lotSizeOf', () => {
  const file: LotsFile = must(parseLotsFile(golden('lots')));

  it.each([
    ['GLV-NIT-M', 'lot-small', 10], ['GLV-NIT-M', 'lot-medium', 50], ['GLV-NIT-M', 'lot-large', 200], ['SYR-10ML', 'lot-medium', 100], ['MSK-N95', 'lot-large', 400],
  ] as const)('gives the size of %s in %s: %s', (sku, lot, size) => {
    expect(lotSizeOf(file, sku, lot)).toBe(size);
  });

  it.each([
    ['an SKU that the file does not list', 'GLV-NIT-L'], ['an SKU in another case', 'glv-nit-m'], ['an SKU with a space', 'GLV-NIT-M '], ['the empty text', ''], ['a name of the prototype', 'constructor'],
    ['the key __proto__', '__proto__'],
  ])('gives null for %s', (_what, sku) => {
    for (const lot of LOT_NAMES) expect(lotSizeOf(file, sku, lot)).toBeNull();
  });

  it('gives null for a lot that is not a lot name, so that no size is read from a name of the prototype', () => {
    for (const lot of ['lot-huge', 'constructor', '__proto__', 'LOT-SMALL', '', 'toString']) expect(lotSizeOf(file, 'GLV-NIT-M', lot as 'lot-small')).toBeNull();
  });

  describe('on a file that was built by hand', () => {
    // A file of this kind never comes from the parser. The tests give a wrong shape on purpose, with the lots of one item.
    const byHand = (lots: unknown): LotsFile => ({ schema: LOTS_SCHEMA, items: [{ sku: 'A-1', lots }] }) as unknown as LotsFile;

    it('gives the size of a lot that the item holds, and null, and never undefined, for a lot that it does not hold', () => {
      expect(lotSizeOf(byHand({ 'lot-small': 5 }), 'A-1', 'lot-small')).toBe(5);
      expect(lotSizeOf(byHand({ 'lot-small': 5 }), 'A-1', 'lot-large')).toBeNull();
    });

    it('gives no size for a lot that is not a lot name, although the item holds a member with that name', () => {
      const file = byHand({ 'lot-small': 5, 'lot-huge': 7 });
      expect(lotSizeOf(file, 'A-1', 'lot-huge' as 'lot-small')).toBeNull();
      expect(lotSizeOf(file, 'A-1', 'lot-small')).toBe(5);
    });

    it('gives no size that a prototype holds, and the own size of the twin', () => {
      const inherited = { 'lot-large': { value: 9, writable: true, enumerable: true } };
      expect(withPrototype(Object.prototype, inherited, () => lotSizeOf(byHand({ 'lot-small': 5 }), 'A-1', 'lot-large'))).toBeNull();
      expect(withPrototype(Object.prototype, inherited, () => lotSizeOf(byHand({ 'lot-small': 5, 'lot-large': 6 }), 'A-1', 'lot-large'))).toBe(6);
    });

    it.each([['a text', '5'], ['null', null], ['true', true], ['a list', [5]], ['an object', { size: 5 }], ['undefined', undefined]])('gives no size for %s', (_what, size) => {
      expect(lotSizeOf(byHand({ 'lot-small': size }), 'A-1', 'lot-small')).toBeNull();
    });
  });

  it('changes nothing of the file', () => {
    const before = JSON.stringify(file);
    lotSizeOf(file, 'GLV-NIT-M', 'lot-small');
    expect(JSON.stringify(file)).toBe(before);
  });
});

describe('lotsFileSha256', () => {
  it('is the SHA-256 of the bytes of the text, as a Node hash makes it', () => {
    for (const text of ['', 'a', goldenText('lots'), '{"schema":"vector.usecase.lots.v1","items":[]}', 'caf\u00e9', 'cafe\u0301', '\ud83d\ude00', '\r\n']) {
      expect(lotsFileSha256(text), JSON.stringify(text)).toBe(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
    }
  });

  it('has the form of a digest: 64 lower-case hex characters', () => {
    expect(lotsFileSha256(goldenText('lots'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives two hashes for two texts that differ by a space, a line break or the layout of a member', () => {
    const text = goldenText('lots');
    const hashes = new Set([
      lotsFileSha256(text), lotsFileSha256(`${text} `), lotsFileSha256(` ${text}`), lotsFileSha256(text.trimEnd()), lotsFileSha256(text.split('{ "sku"').join('{  "sku"')),
      lotsFileSha256(text.split('\n').join('\r\n')),
    ]);
    expect(hashes.size).toBe(6);
  });

  it('hashes the text and not the value: the same value in another layout has another hash', () => {
    const compact = JSON.stringify(golden('lots'));
    expect(JSON.parse(compact)).toStrictEqual(golden('lots'));
    expect(lotsFileSha256(compact)).not.toBe(lotsFileSha256(goldenText('lots')));
  });

  it('keeps the NFC and the NFD form of a text apart: the bytes differ', () => {
    expect(lotsFileSha256('caf\u00e9')).not.toBe(lotsFileSha256('cafe\u0301'));
  });

  it('refuses a value that is not a text, so that bytes of another kind are not hashed by mistake', () => {
    for (const value of [undefined, null, 1, {}, [], Buffer.from('a'), new Uint8Array(1)]) expect(() => lotsFileSha256(value as unknown as string)).toThrow(TypeError);
  });
});
