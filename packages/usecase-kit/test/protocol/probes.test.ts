// packages/usecase-kit/test/protocol/probes.test.ts: objects that a program makes. A parser reads each member of the input one time, builds a copy while it checks, and works on that copy. A getter,
// a Proxy and an array of another kind cannot give the parser a second value, and cannot make it throw. Each probe has a plain twin that is accepted.
import { describe, expect, it } from 'vitest';
import {
  accepted, canonicalJson, canonicalSha256, checkMembers, isPlainObject, makeProposal, parseApprovalRef, parseAuthority, parseDocument, parseHandoff, parseJsonValue, parseProposal, parseRequest,
  parseRfq, proposalDigest, readMembers,
} from '@vsa/usecase-kit/protocol';
import type { ProposeFieldsParser } from '@vsa/usecase-kit/protocol';
import { APPROVAL, AUTHORITY, DELEGATION, DID_A, DOCUMENT, SALT } from './support.ts';

const HANDOFF = { schema: 'vector.usecase.handoff.v1', use_case: 'inventory-reorder', sender_did: DID_A, delegation: DELEGATION, document: DOCUMENT, salt: SALT, approval: APPROVAL };
const RFQ = { schema: 'vector.usecase.rfq.v1', sender_did: DID_A, delegation: DELEGATION, rfq: { rfq_id: 'rfq-1', items: [{ sku: 'SKU-100', quantity: 100 }], needed_by: '2026-12-20' } };
const made = makeProposal(DOCUMENT, SALT);
if (!made.ok) throw new Error('the sample proposal must be valid');
const PROPOSAL = made.value;
const EXECUTE = { op: 'execute', authority: AUTHORITY, tenant: 'run1', proposal: PROPOSAL, approval: APPROVAL };
const PROPOSE = { op: 'propose', authority: AUTHORITY, tenant: 'run1' };

const keepFields: ProposeFieldsParser<Record<string, unknown>> = (fields) => accepted({ ...fields });
const PLAIN = { a: [1, { b: 'two' }], c: 'x' };

/** The digest of a document, or a filler when the document is refused: a probe is refused before the digest is compared. */
const digestOf = (document: unknown): string => {
  const result = proposalDigest(SALT, document);
  return result.ok ? result.value : '00'.repeat(32);
};

/** An object whose member `a` is a getter. The getter counts its reads. At the first read it gives `first`, and after that it gives `second`. */
function flipping(first: unknown, second: unknown): { object: Record<string, unknown>; reads: () => number } {
  let reads = 0;
  const object = Object.defineProperty({}, 'a', {
    get() {
      reads += 1;
      return reads === 1 ? first : second;
    },
    enumerable: true,
    configurable: true,
  }) as Record<string, unknown>;
  return { object, reads: () => reads };
}

function throwing(): { object: Record<string, unknown>; reads: () => number } {
  let reads = 0;
  const object = Object.defineProperty({}, 'a', {
    get() {
      reads += 1;
      throw new Error('the getter ran');
    },
    enumerable: true,
    configurable: true,
  }) as Record<string, unknown>;
  return { object, reads: () => reads };
}

/**
 * A Proxy of the array `[1, 2]` that reports `length` as its length. Its descriptor trap gives a data member for every index, and it counts the calls. It throws at the 1,001st call, so that a walk that
 * trusts the length ends.
 */
function reporting(length: unknown): { proxy: unknown[]; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy([1, 2], {
    get: (target, key, receiver) => (key === 'length' ? length : Reflect.get(target, key, receiver)),
    getOwnPropertyDescriptor(target, key) {
      reads += 1;
      if (reads > 1_000) throw new Error('the walk reads on');
      return Reflect.getOwnPropertyDescriptor(target, key) ?? { value: 0, enumerable: true, configurable: true, writable: true };
    },
  });
  return { proxy, reads: () => reads };
}

function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** An array of a kind that throws when it is asked for the class of a new array. */
class SpeciesArray extends Array<unknown> {}
Object.defineProperty(SpeciesArray, Symbol.species, {
  get() {
    throw new Error('species was asked');
  },
  configurable: true,
});

function tricky(): unknown[] {
  const array = [1, 2];
  Object.defineProperty(array, 'constructor', {
    value: {
      get [Symbol.species]() {
        throw new Error('species was asked');
      },
    },
    enumerable: false,
  });
  return array;
}

type Parse = (document: unknown) => { readonly ok: boolean; readonly detail?: string };

/** Every entry of the protocol that takes a document, a proposal, a request for quotation or the fields of a request. */
const ENTRY_POINTS: ReadonlyArray<readonly [string, Parse]> = [
  ['parseJsonValue', (d) => parseJsonValue(d)],
  ['parseDocument', (d) => parseDocument(d)],
  ['canonicalJson', (d) => canonicalJson(d)],
  ['canonicalSha256', (d) => canonicalSha256(d)],
  ['proposalDigest', (d) => proposalDigest(SALT, d)],
  ['makeProposal', (d) => makeProposal(d, SALT)],
  ['parseProposal', (d) => parseProposal({ document: d, salt: SALT, proposal_digest: digestOf(d) })],
  ['parseHandoff', (d) => parseHandoff({ ...HANDOFF, document: d })],
  ['parseRfq', (d) => parseRfq({ ...RFQ, rfq: d })],
  ['parseRequest (a field of propose)', (d) => parseRequest({ ...PROPOSE, extra: d }, keepFields)],
];

describe.each(ENTRY_POINTS)('%s', (_name, parse) => {
  it('takes a plain document', () => {
    expect(parse(PLAIN).ok).toBe(true);
  });

  it.each([
    ['a getter that gives another value at the second read', () => flipping('first', 'second')],
    ['a getter that gives undefined at the second read', () => flipping('first', undefined)],
    ['a getter that throws', () => throwing()],
  ])('refuses %s, as the document and as a member of it, and never runs the getter', (_label, make) => {
    const top = make();
    const topResult = parse(top.object);
    expect(topResult.ok).toBe(false);
    expect(topResult.detail).toContain('accessor');
    expect(top.reads()).toBe(0);
    const nested = make();
    expect(parse({ b: [nested.object] }).ok).toBe(false);
    expect(nested.reads()).toBe(0);
  });

  it('refuses a revoked Proxy, as the document and as a member of it, and does not throw', () => {
    expect(() => parse(revoked())).not.toThrow();
    expect(parse(revoked()).ok).toBe(false);
    expect(parse({ a: revoked() }).ok).toBe(false);
    expect(parse({ a: [revoked()] }).ok).toBe(false);
  });

  it.each(['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'] as const)('refuses a Proxy whose %s trap throws, and does not throw', (trap) => {
    const make = (): object =>
      new Proxy({ a: 1 }, {
        [trap]() {
          throw new Error(`the ${trap} trap ran`);
        },
      } as ProxyHandler<object>);
    expect(() => parse(make())).not.toThrow();
    expect(parse(make()).ok).toBe(false);
    expect(parse({ a: make() }).ok).toBe(false);
  });

  it('takes a Proxy that has no trap, as the plain object that it stands for, and does not run its get trap', () => {
    expect(parse(new Proxy({ ...PLAIN }, {})).ok).toBe(true);
    expect(parse(new Proxy({ ...PLAIN }, { get() { throw new Error('the get trap ran'); } })).ok).toBe(true);
  });

  it('refuses a Proxy of an array whose get trap throws, because the length of the array is read with it, and does not throw', () => {
    const make = (): object => new Proxy([1], { get() { throw new Error('the get trap ran'); } });
    expect(() => parse({ a: make() })).not.toThrow();
    expect(parse({ a: make() }).ok).toBe(false);
  });

  it('refuses an array of another kind, and an array with its own key that is not an index, and does not throw', () => {
    expect(() => parse({ a: SpeciesArray.from([1, 2]) })).not.toThrow();
    expect(parse({ a: SpeciesArray.from([1, 2]) }).ok).toBe(false);
    expect(() => parse({ a: tricky() })).not.toThrow();
    expect(parse({ a: tricky() }).ok).toBe(false);
    expect(parse({ a: Object.assign([1, 2], { extra: true }) }).ok).toBe(false);
    expect(parse({ a: [1, 2] }).ok).toBe(true);
  });

  it('refuses an array with an accessor element, without running it', () => {
    let reads = 0;
    const array = [1];
    Object.defineProperty(array, 0, { get() { reads += 1; return 1; }, enumerable: true, configurable: true });
    expect(parse({ a: array }).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it.each([3, 1, 50_000_000, 2 ** 32 - 1])('refuses an array that reports a length of %d that its keys do not have, before it reads an index, and takes the plain twin', (length) => {
    const { proxy, reads } = reporting(length);
    expect(() => parse({ a: proxy })).not.toThrow();
    expect(parse({ a: proxy }).ok).toBe(false);
    expect(reads()).toBe(0);
    // The twins: a plain array of the same small length, and the same Proxy with the length that its keys have. A walk reads the indexes of the second one.
    expect(parse({ a: [1, 2, 3] }).ok).toBe(true);
    const honest = reporting(2);
    expect(parse({ a: honest.proxy }).ok).toBe(true);
    expect(honest.reads()).toBeGreaterThan(0);
  });

  it('refuses an array whose length is not a number, and does not ask the length for a number', () => {
    let asked = 0;
    const { proxy, reads } = reporting({ valueOf() { asked += 1; return 2; } });
    expect(parse({ a: proxy }).ok).toBe(false);
    expect([asked, reads()]).toStrictEqual([0, 0]);
  });
});

describe('the length of an array', () => {
  it.each([
    ['a length above the keys', 50_000_000, 'document.a[2] is a hole in an array'],
    ['the largest length of an array', 2 ** 32 - 1, 'document.a[2] is a hole in an array'],
    ['a length under the keys', 1, 'document.a has a key that JSON cannot hold'],
    ['a length that is a text', '2', 'document.a has a length that is not a number'],
  ])('refuses %s before it reads an index, and names the refusal', (_name, length, detail) => {
    const { proxy, reads } = reporting(length);
    expect(parseJsonValue({ a: proxy }, 'document')).toStrictEqual({ ok: false, code: 'bad_shape', detail });
    expect(reads()).toBe(0);
  });

  it('refuses an array of the largest length that has no index, at its first index, as before', () => {
    const sparse: unknown[] = [];
    sparse.length = 2 ** 32 - 1;
    expect(parseJsonValue({ a: sparse }, 'document')).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'document.a[0] is a hole in an array' });
    expect(parseJsonValue({ a: [] }, 'document')).toStrictEqual({ ok: true, value: { a: [] } });
  });
});

describe('the copy', () => {
  it('has the members of the input at the time of the walk, and shares no object with it', () => {
    const source = { a: [1, { b: 2 }], c: 'x' };
    const result = parseJsonValue(source);
    expect(result).toEqual({ ok: true, value: { a: [1, { b: 2 }], c: 'x' } });
    expect(result.ok && result.value).not.toBe(source);
    source.a.push(3);
    (source.a[1] as { b: number }).b = 9;
    expect(result.ok && result.value).toEqual({ a: [1, { b: 2 }], c: 'x' });
  });

  it('is a plain object and plain arrays, whatever the input was', () => {
    const result = parseJsonValue(Object.assign(Object.create(null) as object, { list: [1] }));
    expect(result.ok && Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(result.ok && Object.getPrototypeOf((result.value as { list: unknown[] }).list)).toBe(Array.prototype);
    const proxied = parseJsonValue(new Proxy({ a: 1 }, {}));
    expect(proxied.ok && Object.getPrototypeOf(proxied.value)).toBe(Object.prototype);
  });

  it.each([
    ['parseDocument', (s: Record<string, unknown>) => { const r = parseDocument(s); return r.ok ? r.value : null; }],
    ['makeProposal', (s: Record<string, unknown>) => { const r = makeProposal(s, SALT); return r.ok ? r.value.document : null; }],
    ['parseProposal', (s: Record<string, unknown>) => { const r = parseProposal({ document: s, salt: SALT, proposal_digest: digestOf(s) }); return r.ok ? r.value.document : null; }],
    ['parseHandoff', (s: Record<string, unknown>) => { const r = parseHandoff({ ...HANDOFF, document: s }); return r.ok ? r.value.document : null; }],
    ['parseRfq', (s: Record<string, unknown>) => { const r = parseRfq({ ...RFQ, rfq: s }); return r.ok ? r.value.rfq : null; }],
    ['parseRequest (a field of propose)', (s: Record<string, unknown>) => { const r = parseRequest({ ...PROPOSE, extra: s }, keepFields); return r.ok ? Reflect.get(r.value, 'extra') : null; }],
  ])('%s returns a copy of the document, and not the document', (_name, extract) => {
    const source = { a: [1, { b: 2 }], c: 'x' };
    const value = extract(source);
    expect(value).toEqual({ a: [1, { b: 2 }], c: 'x' });
    expect(value).not.toBe(source);
    source.a.push(3);
    expect(value).toEqual({ a: [1, { b: 2 }], c: 'x' });
  });
});

describe('one read of each member', () => {
  /** A Proxy that counts its traps. Its descriptor trap gives a new value at each call, and its get trap gives 99. */
  function counting(): { proxy: object; calls: { ownKeys: number; descriptor: number } } {
    const calls = { ownKeys: 0, descriptor: 0 };
    const proxy = new Proxy({ a: 1, b: 2 }, {
      ownKeys(target) {
        calls.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor() {
        calls.descriptor += 1;
        return { value: calls.descriptor, enumerable: true, configurable: true, writable: true };
      },
      get() {
        return 99;
      },
    });
    return { proxy, calls };
  }

  it('reads the keys one time and each member one time, and keeps the value of that read', () => {
    const { proxy, calls } = counting();
    expect(parseJsonValue(proxy)).toEqual({ ok: true, value: { a: 1, b: 2 } });
    expect(calls).toStrictEqual({ ownKeys: 1, descriptor: 2 });
  });

  it('makes the digest of the value that it returns, and not of a second read', () => {
    const { proxy, calls } = counting();
    const result = makeProposal(proxy, SALT);
    expect(result.ok && result.value.document).toEqual({ a: 1, b: 2 });
    expect(result.ok && result.value.proposal_digest).toBe(digestOf({ a: 1, b: 2 }));
    expect(calls.ownKeys).toBe(1);
    expect(calls.descriptor).toBe(2);
  });

  it('writes the canonical text from the value that it read', () => {
    const { proxy } = counting();
    expect(canonicalJson(proxy)).toEqual({ ok: true, value: '{"a":1,"b":2}' });
  });
});

describe('isPlainObject', () => {
  it('does not throw, and is false for a revoked Proxy and for a Proxy whose prototype trap throws', () => {
    expect(isPlainObject(revoked())).toBe(false);
    expect(isPlainObject(new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } }))).toBe(false);
  });

  it('is true for a Proxy that has no trap, as for the plain object that it stands for', () => {
    expect(isPlainObject(new Proxy({ a: 1 }, {}))).toBe(true);
  });
});

describe('readMembers', () => {
  it('reads a plain object into a new plain object', () => {
    const source = { a: 1, b: [2] };
    const result = readMembers(source, 'thing');
    expect(result).toEqual({ ok: true, value: { a: 1, b: [2] } });
    expect(result.ok && result.value).not.toBe(source);
    expect(result.ok && Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(result.ok && result.value.b).toBe(source.b);
  });

  it('keeps the key __proto__ as an own member, and does not change the prototype of the copy', () => {
    const result = readMembers(JSON.parse('{"__proto__":1,"a":2}'), 'thing');
    expect(result.ok && Object.keys(result.value)).toStrictEqual(['__proto__', 'a']);
    expect(result.ok && Object.getPrototypeOf(result.value)).toBe(Object.prototype);
  });

  it.each([
    ['an accessor member', () => flipping(1, 2).object, 'thing.a is an accessor, which is not allowed'],
    ['a key that is a symbol', () => ({ a: 1, [Symbol('k')]: 2 }), 'thing has a key that JSON cannot hold'],
    ['a member that is not enumerable', () => Object.defineProperty({ a: 1 }, 'b', { value: 2, enumerable: false }), 'thing has a key that JSON cannot hold'],
    ['an array', () => [1], 'thing must be a JSON object'],
    ['null', () => null, 'thing must be a JSON object'],
    ['a revoked Proxy', () => revoked(), 'thing must be a JSON object'],
    ['a Proxy whose ownKeys trap throws', () => new Proxy({}, { ownKeys() { throw new Error('trap'); } }), 'thing cannot be read'],
  ])('refuses %s', (_name, make, detail) => {
    expect(readMembers(make(), 'thing')).toStrictEqual({ ok: false, code: 'bad_shape', detail });
  });

  it('never runs a getter', () => {
    const probe = flipping(1, 2);
    readMembers(probe.object, 'thing');
    expect(probe.reads()).toBe(0);
  });
});

describe('checkMembers', () => {
  it('gives a refusal and not an exception for a record that cannot be read, and takes the plain twin', () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('trap'); } }) as Record<string, unknown>;
    expect(checkMembers(hostile, 'thing', [])).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'thing cannot be read' });
    expect(checkMembers({ a: 1 }, 'thing', ['a'])).toBeNull();
  });
});

describe('the parsers of a message', () => {
  const MESSAGES: ReadonlyArray<readonly [string, Record<string, unknown>, (input: unknown) => { readonly ok: boolean }]> = [
    ['parseAuthority', { ...AUTHORITY }, (input) => parseAuthority(input)],
    ['parseApprovalRef', { ...APPROVAL }, (input) => parseApprovalRef(input)],
    ['parseProposal', { ...PROPOSAL }, (input) => parseProposal(input)],
    ['parseRequest (propose)', { ...PROPOSE }, (input) => parseRequest(input)],
    ['parseRequest (execute)', { ...EXECUTE }, (input) => parseRequest(input)],
    ['parseHandoff', { ...HANDOFF }, (input) => parseHandoff(input)],
    ['parseRfq', { ...RFQ }, (input) => parseRfq(input)],
  ];

  it.each(MESSAGES)('%s refuses a member that is a getter without running it, a revoked Proxy and a Proxy that throws, and takes the plain twin', (_name, plain, parse) => {
    expect(parse(plain).ok).toBe(true);
    for (const name of Object.keys(plain)) {
      let reads = 0;
      const withGetter = Object.defineProperty({ ...plain }, name, { get() { reads += 1; throw new Error('the getter ran'); }, enumerable: true, configurable: true });
      expect(() => parse(withGetter)).not.toThrow();
      expect(parse(withGetter).ok).toBe(false);
      expect(reads).toBe(0);
    }
    expect(parse(revoked()).ok).toBe(false);
    expect(parse(new Proxy({ ...plain }, { ownKeys() { throw new Error('trap'); } })).ok).toBe(false);
    expect(parse(new Proxy({ ...plain }, {})).ok).toBe(true);
  });

  it('refuse a nested object whose getter would give another value, in the authority, the approval and the proposal', () => {
    const getter = flipping('x', 'y').object;
    expect(parseRequest({ ...EXECUTE, authority: getter }).ok).toBe(false);
    expect(parseRequest({ ...EXECUTE, approval: getter }).ok).toBe(false);
    expect(parseRequest({ ...EXECUTE, proposal: getter }).ok).toBe(false);
    expect(parseHandoff({ ...HANDOFF, approval: getter }).ok).toBe(false);
    expect(parseRequest({ ...EXECUTE }).ok).toBe(true);
  });
});

describe('no parser throws on a hostile value', () => {
  const HOSTILE: ReadonlyArray<readonly [string, () => unknown]> = [
    ['a revoked Proxy', () => revoked()],
    ['a Proxy whose ownKeys trap throws', () => new Proxy({}, { ownKeys() { throw new Error('trap'); } })],
    ['a Proxy whose descriptor trap throws', () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new Error('trap'); } })],
    ['a Proxy of an array whose get trap throws', () => new Proxy([], { get() { throw new Error('trap'); } })],
    ['a getter that throws', () => throwing().object],
    ['an array of another kind', () => SpeciesArray.from([1])],
    ['an array that is not plain', () => tricky()],
    ['an object that holds itself', () => { const o: Record<string, unknown> = {}; o.self = o; return o; }],
  ];
  const PARSERS: ReadonlyArray<readonly [string, (value: unknown) => unknown]> = [
    ['isPlainObject', (v) => isPlainObject(v)],
    ['parseJsonValue', (v) => parseJsonValue(v)],
    ['parseDocument', (v) => parseDocument(v)],
    ['canonicalJson', (v) => canonicalJson(v)],
    ['canonicalSha256', (v) => canonicalSha256(v)],
    ['proposalDigest', (v) => proposalDigest(SALT, v)],
    ['makeProposal', (v) => makeProposal(v, SALT)],
    ['readMembers', (v) => readMembers(v, 'thing')],
    ['parseAuthority', (v) => parseAuthority(v)],
    ['parseApprovalRef', (v) => parseApprovalRef(v)],
    ['parseProposal', (v) => parseProposal(v)],
    ['parseRequest', (v) => parseRequest(v)],
    ['parseHandoff', (v) => parseHandoff(v)],
    ['parseRfq', (v) => parseRfq(v)],
  ];

  it.each(PARSERS)('%s gives a result for each of them', (_name, parse) => {
    for (const [label, make] of HOSTILE) expect(() => parse(make()), label).not.toThrow();
  });

  it('refuses each of them as a document', () => {
    for (const [label, make] of HOSTILE) expect(parseDocument(make()).ok, label).toBe(false);
  });
});
