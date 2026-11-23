// packages/usecase-kit/test/inventory/order.test.ts: the purchase order of use case 1 (inventory reorder). It is the document of a proposal, so its digest is the digest of the protocol. The golden file is the
// example that the Reorder Agent proposes and the Order Desk reads. The parser takes what the purchase order store of the mock service takes, and no more. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_SCHEMAS, canonicalSha256, makeProposal, parseHandoff, proposalDigest } from '@vsa/usecase-kit/protocol';
import { LOT_NAMES, PO_SCHEMA, parsePurchaseOrder, poNumberOf } from '@vsa/usecase-kit/inventory';
import { MARKER, change, expectRefused, golden, goldenText, must, withPrototype } from './support.ts';
import type { Json } from './support.ts';

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = '5a698609794acf45622dfb32201f1b5dbdd832c6bc08a730ce880ffec25a6577';
/** The SHA-256 of the canonical text of the golden purchase order: the `po_sha256` of a confirmation. */
const GOLDEN_CANONICAL_SHA256 = '6ad717a507e8f397b573ea5d674298beaccdcd7cc69c90948009adf178a5a039';
/** The digest of the proposal of the golden purchase order with the salt below. */
const GOLDEN_DIGEST = 'a0d3f2f8debbe75dbfca364c11ab6a9359a4a908185c2bbd9bd2418f53af2a19';
const SALT = '33'.repeat(32);

const MEMBERS = ['schema', 'po_number', 'tenant', 'sku', 'lot', 'quantity', 'needed_by', 'supplier_did', 'advert_ref', 'stock_reading_sha256'] as const;
const HEX = 'ab'.repeat(32);

describe('the golden purchase order', () => {
  it('is the file that the hash names, and it holds the members of the page in their order', () => {
    expect(createHash('sha256').update(goldenText('po')).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    expect(Object.keys(golden('po'))).toStrictEqual([...MEMBERS]);
  });

  it('passes the parser, and the copy holds the same members in the same order', () => {
    const result = parsePurchaseOrder(golden('po'));
    expect(result).toStrictEqual({ ok: true, value: golden('po') });
    expect(Object.keys(must(result))).toStrictEqual([...MEMBERS]);
  });

  it('has the schema that the protocol names for use case 1', () => {
    expect(PO_SCHEMA).toBe('vector.usecase.po.v1');
    expect(PO_SCHEMA).toBe(DOCUMENT_SCHEMAS['inventory-reorder']);
    expect(golden('po').schema).toBe(PO_SCHEMA);
  });

  it('has the digest of a proposal, and the canonical hash that a confirmation names', () => {
    const order = must(parsePurchaseOrder(golden('po')));
    expect(proposalDigest(SALT, order)).toStrictEqual({ ok: true, value: GOLDEN_DIGEST });
    expect(must(makeProposal(order, SALT)).proposal_digest).toBe(GOLDEN_DIGEST);
    expect(canonicalSha256(order)).toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
  });

  it('is the document that a handoff carries, and the parser reads the document of the handoff', () => {
    const handoff = { schema: 'vector.usecase.handoff.v1', use_case: 'inventory-reorder', sender_did: `did:vector:${'ec'.repeat(32)}`, delegation: HEX, document: golden('po'), salt: SALT, approval: null };
    const document = must(parseHandoff(handoff)).document;
    expect(parsePurchaseOrder(document)).toStrictEqual({ ok: true, value: golden('po') });
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden('po');
    const before = JSON.stringify(input);
    const order = must(parsePurchaseOrder(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(order).not.toBe(input);
    expect(Object.getPrototypeOf(order)).toBe(Object.prototype);
  });

  it('is used with the name that the caller gives in the detail of a refusal', () => {
    expectRefused(parsePurchaseOrder(change(golden('po'), ['sku'], 5), 'handoff.document'), 'handoff.document.sku');
    expectRefused(parsePurchaseOrder(change(golden('po'), ['sku'], 5)), 'purchase order.sku');
  });
});

describe('a member that is missing or is not listed', () => {
  it.each(MEMBERS)('refuses a purchase order with no member %s', (name) => {
    expectRefused(parsePurchaseOrder(change(golden('po'), [name], undefined)), name);
  });

  it('refuses a member that is not listed, in any place of the order of the members', () => {
    expectRefused(parsePurchaseOrder({ extra: 1, ...golden('po') }), 'extra');
    expectRefused(parsePurchaseOrder({ ...golden('po'), extra: 1 }), 'extra');
    expectRefused(parsePurchaseOrder({ ...golden('po'), extra: null }), 'extra');
    expect(parsePurchaseOrder({ ...golden('po'), [MARKER]: 1 }).ok).toBe(false);
    expect(parsePurchaseOrder(golden('po')).ok).toBe(true);
  });

  it.each(['po_sha256', 'confirmation', 'salt', 'proposal_digest', 'buyer_pkh', 'lots', 'vault'])('refuses the member %s, which belongs to another document', (name) => {
    expectRefused(parsePurchaseOrder({ ...golden('po'), [name]: HEX }), name);
  });
});

describe('a member of the wrong type or in the wrong form', () => {
  const NOT_TEXT = [1, 0, true, null, {}, [], ['a']];
  const FORMS: ReadonlyArray<readonly [string, readonly unknown[], readonly unknown[]]> = [
    ['schema', ['vector.usecase.po.v2', 'VECTOR.USECASE.PO.V1', 'vector.usecase.po.v1 ', 'vector.usecase.po.v1\n', '', MARKER, 'vector.usecase.proposal.v1', ...NOT_TEXT], [PO_SCHEMA]],
    ['po_number', ['', 'a'.repeat(65), '-1', '.1', '_1', 'a b', 'a/b', 'a#b', 'a\n', 'a\u00e9', MARKER, ...NOT_TEXT], ['a', 'run1-1', 'A.b_c-d', '9', 'a'.repeat(64)]],
    ['tenant', ['', 'a'.repeat(49), 'Run1', 'run_1', 'run.1', '-run', 'run 1', 'run\n', 'run1/x', MARKER, ...NOT_TEXT], ['a', 'run1', '1run', 'run-1', 'a'.repeat(48), 'a-b-c']],
    ['sku', ['', 'A'.repeat(65), 'A B', 'A/B', 'A#B', 'A\n', '-A', '.A', '_A', 'e\u0301', MARKER, ...NOT_TEXT], ['A', 'GLV-NIT-M', 'a.b_c-d', '9', 'A'.repeat(64)]],
    ['lot', ['lot-huge', 'LOT-SMALL', 'lot-small ', 'lot-small\n', 'small', 'lot', '', 'constructor', '__proto__', MARKER, ...NOT_TEXT], [...LOT_NAMES]],
    ['quantity', [0, -1, 1_000_001, 2 ** 31, Number.MAX_SAFE_INTEGER, 1.5, 0.5, '50', '1', null, true, [], {}, [50], MARKER], [1, 2, 50, 999_999, 1_000_000]],
    ['needed_by', [
      '2026-02-30', '2026-02-29', '2026-13-01', '2026-00-10', '2026-12-00', '2026-12-32', '2026-04-31', '2026-1-1', '20261201', '2026/12/01', '2026-12-01T00:00:00Z', ' 2026-12-01', '2026-12-01 ',
      '2026-12-01\n', '0000-01-01', '0099-12-31', 'tomorrow', '', MARKER, 20261201, ...NOT_TEXT,
    ], ['2026-12-01', '2026-02-28', '2028-02-29', '2000-02-29', '0100-01-01', '9999-12-31', '2026-04-30']],
    ['supplier_did', [
      `did:vector:${HEX.slice(2)}`, `did:vector:${HEX}ab`, `did:vector:${HEX.toUpperCase()}`, `DID:VECTOR:${HEX}`, `did:other:${HEX}`, `${HEX}`, `did:vector:${HEX}\n`, ` did:vector:${HEX}`, 'did:vector:',
      '', MARKER, ...NOT_TEXT,
    ], [`did:vector:${HEX}`]],
    ['advert_ref', [
      HEX, `${HEX}#`, `${HEX}#-1`, `${HEX}#01`, `${HEX}#1.5`, `${HEX}#1000000`, `${HEX}#12345678`, `${HEX.slice(2)}#0`, `${HEX}ab#0`, `${HEX.toUpperCase()}#0`, `${HEX}#0\n`, `${HEX}0`, `#0`, '', MARKER, ...NOT_TEXT,
    ], [`${HEX}#0`, `${HEX}#1`, `${HEX}#10`, `${HEX}#999999`]],
    ['stock_reading_sha256', [HEX.slice(2), `${HEX}ab`, HEX.toUpperCase(), `${HEX}\n`, ` ${HEX}`, `${'g'.repeat(64)}`, '', MARKER, ...NOT_TEXT], [HEX, '0'.repeat(64), 'f'.repeat(64)]],
  ];

  it.each(FORMS)('%s: refuses each value that is not in its form, and takes the values that are', (name, bad, good) => {
    for (const value of bad) {
      const result = parsePurchaseOrder(change(golden('po'), [name], value));
      expect(result.ok, `${name} ${JSON.stringify(value)}`).toBe(false);
      expectRefused(result, `purchase order.${name}`);
    }
    for (const value of good) expect(parsePurchaseOrder(change(golden('po'), [name], value)).ok, `${name} ${JSON.stringify(value)}`).toBe(true);
  });

  it('refuses a number that JSON cannot hold', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expectRefused(parsePurchaseOrder(change(golden('po'), ['quantity'], value)), 'quantity');
  });

  it('takes a quantity that is written as a whole number with a fraction part of zero, because JSON has one kind of number', () => {
    expect(must(parsePurchaseOrder(JSON.parse('{"schema":"vector.usecase.po.v1","po_number":"a","tenant":"a","sku":"a","lot":"lot-small","quantity":50.0,"needed_by":"2026-12-01","supplier_did":"did:vector:' + HEX + '","advert_ref":"' + HEX + '#0","stock_reading_sha256":"' + HEX + '"}'))).quantity).toBe(50);
  });

  it('refuses the tenant of 49 characters, and takes the tenant of 48: the store of the mock service takes 48, and the protocol takes 64 for a request', () => {
    const order = (tenant: string): Json => change(golden('po'), ['tenant'], tenant);
    expectRefused(parsePurchaseOrder(order('t'.repeat(49))), 'tenant');
    expect(parsePurchaseOrder(order('t'.repeat(48))).ok).toBe(true);
  });

  it('refuses a value that is not an object, and an object of another kind', () => {
    class Order { schema = PO_SCHEMA; }
    for (const value of [undefined, null, 1, 'order', true, [], [golden('po')], new Order(), new Date(0), new Map(), () => golden('po')]) expectRefused(parsePurchaseOrder(value), 'purchase order');
  });
});

describe('the Unicode form of a text', () => {
  it('writes each text in the NFC form: a text that is not in this form is copied in it, and the digest is the digest of the NFC document', () => {
    // The Kelvin sign (U+212A) is not in the NFC form: NFC replaces it by the letter K. It is the one such character that the form of an identifier then takes.
    const sample = (sku: string): Json => change(golden('po'), ['sku'], sku);
    const order = must(parsePurchaseOrder(sample('\u212ALV-NIT-M')));
    expect(order.sku).toBe('KLV-NIT-M');
    expect(order).toStrictEqual(must(parsePurchaseOrder(sample('KLV-NIT-M'))));
    expect(proposalDigest(SALT, order)).toStrictEqual(proposalDigest(SALT, sample('KLV-NIT-M')));
    expect(proposalDigest(SALT, order)).toStrictEqual(proposalDigest(SALT, sample('\u212ALV-NIT-M')));
    expect(must(makeProposal(sample('\u212ALV-NIT-M'), SALT)).document).toStrictEqual(order);
    expect(canonicalSha256(order)).toStrictEqual(canonicalSha256(sample('\u212ALV-NIT-M')));
  });

  it('refuses a letter with a mark in any form, because an identifier has letters, digits and three signs, and the refusal does not repeat the text', () => {
    for (const sku of ['e\u0301-1', '\u00e9-1', 'a\u030a', '\u00e5']) {
      const result = parsePurchaseOrder(change(golden('po'), ['sku'], sku));
      expectRefused(result, 'purchase order.sku');
      expect(!result.ok && result.detail).not.toContain('\u0301');
    }
  });

  it('takes the order of the protocol in its own copy: the same order has the same digest, whatever the form of its texts', () => {
    const plain = must(parsePurchaseOrder(golden('po')));
    expect(proposalDigest(SALT, plain)).toStrictEqual({ ok: true, value: GOLDEN_DIGEST });
  });
});

describe('a value that is not plain JSON data', () => {
  it('refuses a member that is an accessor, and never runs the getter, for each member', () => {
    for (const name of MEMBERS) {
      let reads = 0;
      const input = golden('po');
      const value = input[name];
      Object.defineProperty(input, name, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
      expectRefused(parsePurchaseOrder(input), name);
      expect(reads, name).toBe(0);
    }
  });

  it('refuses a getter that gives a good value the first time and a bad value the second time, and never reads it', () => {
    let reads = 0;
    const input = golden('po');
    Object.defineProperty(input, 'quantity', { get() { reads += 1; return reads === 1 ? 50 : 0; }, enumerable: true, configurable: true });
    expectRefused(parsePurchaseOrder(input), 'quantity');
    expect(reads).toBe(0);
  });

  it('refuses the key __proto__ with a value that looks right, and the key that JSON.parse makes', () => {
    const input = golden('po');
    Object.defineProperty(input, '__proto__', { value: golden('po'), enumerable: true, configurable: true, writable: true });
    expectRefused(parsePurchaseOrder(input), '__proto__');
    const parsed = JSON.parse(`{"__proto__":{"sku":"X-1"},${goldenText('po').trim().slice(1)}`);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expectRefused(parsePurchaseOrder(parsed), '__proto__');
  });

  it('refuses a key that is not a string, a key that is not enumerable, and a value that JSON cannot hold', () => {
    expectRefused(parsePurchaseOrder({ ...golden('po'), [Symbol('x')]: 1 }), 'purchase order');
    const hidden = golden('po');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parsePurchaseOrder(hidden), 'purchase order');
    expectRefused(parsePurchaseOrder({ ...golden('po'), quantity: undefined }), 'quantity');
    expectRefused(parsePurchaseOrder({ ...golden('po'), quantity: 10n }), 'quantity');
    expectRefused(parsePurchaseOrder({ ...golden('po'), sku: () => 'A' }), 'sku');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    // A parser reads a member from its descriptor and never with a get, so a Proxy that throws in `get` has no effect, and a Proxy that throws in another trap is refused.
    const handlers: ReadonlyArray<readonly [string, ProxyHandler<Json>, boolean]> = [
      ['ownKeys', { ownKeys() { throw new Error('the Proxy refuses'); } }, false],
      ['getOwnPropertyDescriptor', { getOwnPropertyDescriptor() { throw new Error('the Proxy refuses'); } }, false],
      ['get', { get() { throw new Error('the Proxy refuses'); } }, true],
    ];
    for (const [trap, handler, passes] of handlers) {
      const proxy = new Proxy(golden('po'), handler);
      expect(() => parsePurchaseOrder(proxy), trap).not.toThrow();
      expect(parsePurchaseOrder(proxy).ok, trap).toBe(passes);
    }
    const { proxy, revoke } = Proxy.revocable(golden('po'), {});
    revoke();
    expect(() => parsePurchaseOrder(proxy)).not.toThrow();
    expectRefused(parsePurchaseOrder(proxy), 'purchase order');
  });

  it('takes an object with no prototype, and it gives a plain object', () => {
    const bare = Object.assign(Object.create(null) as Json, golden('po'));
    const order = must(parsePurchaseOrder(bare));
    expect(order).toStrictEqual(golden('po'));
    expect(Object.getPrototypeOf(order)).toBe(Object.prototype);
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parsePurchaseOrder(golden('po'));

  it.each(['lot', 'sku', 'quantity', 'schema', 'tenant'])('with a setter for %s on Object.prototype, the result is the result of the plain twin, and no setter runs', (key) => {
    let calls = 0;
    const input = golden('po');
    const seen = withPrototype(Object.prototype, { [key]: { set() { calls += 1; } } }, () => parsePurchaseOrder(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it.each([
    ['a getter', { get: () => 'from the prototype' }],
    ['a read-only member', { value: 'from the prototype', writable: false }],
    ['a setter that throws', { set() { throw new Error('the setter ran'); } }],
  ])('with %s for lot on Object.prototype, the result is the result of the plain twin', (_what, member) => {
    const input = golden('po');
    expect(withPrototype(Object.prototype, { lot: member }, () => parsePurchaseOrder(input))).toStrictEqual(PLAIN);
  });

  it('reads no member that a prototype holds: an order with no own member is refused, although the prototype holds every member', () => {
    const inherited = Object.fromEntries(Object.entries(golden('po')).map(([name, value]) => [name, { value, writable: true, enumerable: true }]));
    const input = change(golden('po'), ['sku'], undefined);
    expect(withPrototype(Object.prototype, inherited, () => parsePurchaseOrder({})).ok).toBe(false);
    const holdsOne = withPrototype(Object.prototype, { sku: inherited.sku! }, () => parsePurchaseOrder(input));
    expectRefused(holdsOne, 'sku');
  });
});

describe('poNumberOf', () => {
  it('gives the tenant, a hyphen and the counter, with no padding', () => {
    expect(poNumberOf('run1', 1)).toBe('run1-1');
    expect(poNumberOf('run1', 12)).toBe('run1-12');
    expect(poNumberOf('acme-test', 1000)).toBe('acme-test-1000');
    expect(poNumberOf('a', 0)).toBe('a-0');
  });

  it('gives the number of the golden purchase order', () => {
    expect(poNumberOf(String(golden('po').tenant), 1)).toBe(golden('po').po_number);
  });

  it('gives a number that the parser takes, for the longest tenant and the largest counter that fit', () => {
    const tenant = 't'.repeat(48);
    for (const counter of [0, 1, 9, 10, 99_999_999, 999_999_999_999_999]) {
      const number = poNumberOf(tenant, counter);
      expect(number).toBe(`${tenant}-${counter}`);
      expect(number.length).toBeLessThanOrEqual(64);
      expect(parsePurchaseOrder(change(golden('po'), ['po_number'], number)).ok, number).toBe(true);
    }
  });

  it.each([
    ['a tenant in capital letters', 'Run1', 1], ['an empty tenant', '', 1], ['a tenant of 49 characters', 't'.repeat(49), 1], ['a tenant with an underscore', 'run_1', 1], ['a tenant with a dot', 'run.1', 1],
    ['a tenant that starts with a hyphen', '-run', 1], ['a tenant with a slash', 'run/1', 1], ['a tenant with a line break', 'run1\n', 1],
    ['a counter below 0', 'run1', -1], ['a fraction', 'run1', 1.5], ['NaN', 'run1', Number.NaN], ['infinity', 'run1', Number.POSITIVE_INFINITY],
    ['a counter that is not a safe integer', 'run1', Number.MAX_SAFE_INTEGER + 1], ['a counter that is a text', 'run1', '1' as unknown as number], ['a counter that is a bigint', 'run1', 1n as unknown as number],
    ['a tenant that is not a text', 7 as unknown as string, 1], ['no tenant', undefined as unknown as string, 1], ['a number of more than 64 characters', 't'.repeat(48), Number.MAX_SAFE_INTEGER],
  ])('throws a TypeError for %s', (_what, tenant, counter) => {
    expect(() => poNumberOf(tenant, counter)).toThrow(TypeError);
  });

  it('throws a message that never repeats the tenant or the counter that it refuses', () => {
    for (const [tenant, counter] of [[MARKER, 1], ['run1', Number(`1${'0'.repeat(30)}`)], ['T'.repeat(30), 1]] as const) {
      let message = '';
      try {
        poNumberOf(tenant, counter);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('zq9');
      expect(message).not.toContain('TTTT');
      expect(message).not.toContain('1000000');
    }
  });
});
