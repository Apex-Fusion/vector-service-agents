// packages/usecase-kit/test/protocol/prototype.test.ts: a prototype that was changed. A parser makes each member of its copy with defineProperty, and it reads a member only as an own member. So a
// prototype that has a setter, a getter, a read-only member, a `get`, a `set` or a `value` never changes a copy, never gives a parser a value, and never runs. Each test sets the prototype inside the
// test and removes it in a `finally`, so that no other test sees it. The code under test runs while the prototype is changed, and the assertions run after it is restored. Each probe has a plain twin.
import { describe, expect, it } from 'vitest';
import {
  accepted, canonicalJson, canonicalSha256, makeProposal, parseDocument, parseHandoff, parseJsonValue, parseProposal, parseRequest, parseRfq, proposalDigest, readMembers,
} from '@vsa/usecase-kit/protocol';
import type { ProposeFieldsParser } from '@vsa/usecase-kit/protocol';
import { APPROVAL, AUTHORITY, DELEGATION, DID_A, SALT, TENANT } from './support.ts';

/** A document with the key `lot` in three objects, and with arrays of objects, of arrays and of texts, so that the index 0 is used at each level. */
const DOC = { lot: 'lot-medium', quantity: 50, lines: [{ lot: 'lot-small', sku: 'SKU-1' }, ['a', 'b'], 'c'], total: { lot: 'x', items: [1, 2, 3] } };

const keepFields: ProposeFieldsParser<Record<string, unknown>> = (fields) => accepted({ ...fields });

const made = makeProposal(DOC, SALT);
if (!made.ok) throw new Error('the sample proposal must be valid');
const PROPOSAL = made.value;

/** Defines the members on `target`, runs `body`, and removes the members in a `finally`. */
function withPrototype<T>(target: object, members: Readonly<Record<string, PropertyDescriptor>>, body: () => T): T {
  const names = Object.keys(members);
  try {
    for (const name of names) Object.defineProperty(target, name, { ...members[name], configurable: true });
    return body();
  } finally {
    for (const name of names) Reflect.deleteProperty(target, name);
  }
}

/** What each function that makes or reads a copy gives for a document, and not the digest functions. An error that one of them throws is data here, so that the test shows it after the restore. */
function observeCopies(document: unknown): Record<string, unknown> {
  try {
    return {
      value: parseJsonValue(document),
      parsed: parseDocument(document),
      text: canonicalJson(document),
      members: readMembers(document, 'document'),
      handoff: parseHandoff({ schema: 'vector.usecase.handoff.v1', use_case: 'inventory-reorder', sender_did: DID_A, delegation: DELEGATION, document, salt: SALT, approval: APPROVAL }),
      rfq: parseRfq({ schema: 'vector.usecase.rfq.v1', sender_did: DID_A, delegation: DELEGATION, rfq: document }),
      request: parseRequest({ op: 'propose', authority: AUTHORITY, tenant: TENANT, ...(document as object) }, keepFields),
    };
  } catch (error) {
    return { thrown: String(error) };
  }
}

/** What each function of the protocol gives for a document: the copies, and the digests. */
function observe(document: unknown): Record<string, unknown> {
  try {
    return {
      copies: observeCopies(document),
      sha: canonicalSha256(document),
      digest: proposalDigest(SALT, document),
      proposal: makeProposal(document, SALT),
      checked: parseProposal({ document, salt: SALT, proposal_digest: PROPOSAL.proposal_digest }),
    };
  } catch (error) {
    return { thrown: String(error) };
  }
}

const TWIN = observe(DOC);

describe('the plain twin', () => {
  it('has a result for each function, and no error', () => {
    expect(TWIN.thrown).toBeUndefined();
    expect(Object.keys(TWIN).sort()).toStrictEqual(['checked', 'copies', 'digest', 'proposal', 'sha']);
    expect(TWIN.copies).toMatchObject({ value: { ok: true, value: DOC }, parsed: { ok: true, value: DOC }, members: { ok: true }, handoff: { ok: true }, rfq: { ok: true }, request: { ok: true } });
    expect(TWIN.digest).toStrictEqual({ ok: true, value: PROPOSAL.proposal_digest });
  });
});

type Calls = { count: number };

/** The key that a prototype changes: the key `lot` that three objects of the document have, and the index 0 that three arrays of the document have. */
const KEYS: ReadonlyArray<readonly [string, object, string]> = [
  ['Object.prototype has the key lot', Object.prototype, 'lot'],
  ['Array.prototype has the index 0', Array.prototype, '0'],
  ['Object.prototype has the index 0', Object.prototype, '0'],
];

/** The member that the prototype has for the key. The first four are accessors; a setter counts its calls. */
const SHAPES: ReadonlyArray<readonly [string, (calls: Calls) => PropertyDescriptor]> = [
  ['a setter', (calls) => ({ set() { calls.count += 1; } })],
  ['a setter with a getter', (calls) => ({ get: () => 'from the prototype', set() { calls.count += 1; } })],
  ['a setter that throws', (calls) => ({ set() { calls.count += 1; throw new Error('the setter ran'); } })],
  ['a getter with no setter', () => ({ get: () => 'from the prototype' })],
  ['a read-only member', () => ({ value: 'from the prototype', writable: false })],
];

describe.each(KEYS)('%s', (_label, target, key) => {
  it.each(SHAPES)('as %s: each function gives what it gives for the plain twin, none throws, and no setter runs', (_shape, make) => {
    const calls: Calls = { count: 0 };
    const seen = withPrototype(target, { [key]: make(calls) }, () => observe(DOC));
    expect(seen.thrown).toBeUndefined();
    expect(seen).toStrictEqual(TWIN);
    expect(calls.count).toBe(0);
  });
});

describe('a copy has an own member for each key and each index', () => {
  it('has the member lot of each object, and each index of each array, when Object.prototype has a setter for the key lot', () => {
    const calls: Calls = { count: 0 };
    const seen = withPrototype(Object.prototype, { lot: { set() { calls.count += 1; } } }, () => parseJsonValue(DOC));
    expect(seen).toStrictEqual({ ok: true, value: DOC });
    const copy = (seen.ok ? seen.value : {}) as typeof DOC;
    expect([Object.hasOwn(copy, 'lot'), Object.hasOwn(copy.lines[0] as object, 'lot'), Object.hasOwn(copy.total, 'lot')]).toStrictEqual([true, true, true]);
    expect(calls.count).toBe(0);
  });

  it('has each index of each array, when Array.prototype has a setter for the index 0', () => {
    const calls: Calls = { count: 0 };
    const seen = withPrototype(Array.prototype, { 0: { set() { calls.count += 1; } } }, () => ({ value: parseJsonValue(DOC), digest: proposalDigest(SALT, DOC) }));
    expect(seen.value).toStrictEqual({ ok: true, value: DOC });
    expect(seen.digest).toStrictEqual({ ok: true, value: PROPOSAL.proposal_digest });
    const copy = (seen.value.ok ? seen.value.value : {}) as typeof DOC;
    expect([Object.hasOwn(copy.lines, 0), Object.hasOwn(copy.lines[1] as object, 0), Object.hasOwn(copy.total.items, 0), copy.total.items.length]).toStrictEqual([true, true, true, 3]);
    expect(calls.count).toBe(0);
  });
});

describe('Object.prototype has a member that a descriptor would read', () => {
  /** An object and an array whose member is a getter. The getter counts its reads. */
  function accessors(): { object: object; array: unknown[]; reads: () => number } {
    let reads = 0;
    const get = (): number => {
      reads += 1;
      return 1;
    };
    const object = Object.defineProperty({}, 'a', { get, enumerable: true, configurable: true });
    const array = Object.defineProperty([1], 0, { get, enumerable: true, configurable: true });
    return { object, array, reads: () => reads };
  }

  const FROM_PROTOTYPE = (): string => 'from the prototype';

  it('refuses an accessor member of an object, of an array and of the members of a message, and never runs the getter, when it has a value', () => {
    const probe = accessors();
    const seen = withPrototype(Object.prototype, { value: { value: FROM_PROTOTYPE, writable: true, enumerable: true } }, () => ({
      object: parseJsonValue(probe.object),
      array: parseJsonValue(probe.array),
      members: readMembers(probe.object, 'thing'),
    }));
    expect(seen.object).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'value.a is an accessor, which is not allowed' });
    expect(seen.array).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'value[0] is an accessor, which is not allowed' });
    expect(seen.members).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'thing.a is an accessor, which is not allowed' });
    expect(probe.reads()).toBe(0);
  });

  it.each(['get', 'set', 'value', 'writable', 'enumerable', 'configurable'])('still makes the copy that the plain twin has, when it has a member %s', (name) => {
    const seen = withPrototype(Object.prototype, { [name]: { value: FROM_PROTOTYPE, writable: true, enumerable: true } }, () => observeCopies(DOC));
    expect(seen.thrown).toBeUndefined();
    expect(seen).toStrictEqual(TWIN.copies);
  });
});

describe('parseRequest', () => {
  /** The members that Object.prototype has for a request: it has them all, and each of them is a good value. */
  const INHERITED: Readonly<Record<string, PropertyDescriptor>> = {
    op: { value: 'propose', writable: true, enumerable: true },
    authority: { value: AUTHORITY, writable: true, enumerable: true },
    tenant: { value: 'inherited', writable: true, enumerable: true },
    proposal: { value: PROPOSAL, writable: true, enumerable: true },
    approval: { value: APPROVAL, writable: true, enumerable: true },
  };

  it.each([
    ['no member', {}],
    ['the operation propose and nothing else', { op: 'propose' }],
    ['the operation propose and the authority', { op: 'propose', authority: AUTHORITY }],
    ['the operation execute and nothing else', { op: 'execute' }],
    ['the operation execute and no proposal', { op: 'execute', authority: AUTHORITY, tenant: TENANT, approval: null }],
    ['the operation execute and no approval', { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: PROPOSAL }],
  ])('refuses a request with %s, as it does when Object.prototype has none of the members', (_name, request) => {
    const plain = parseRequest(request);
    expect(plain.ok).toBe(false);
    const inherited = withPrototype(Object.prototype, INHERITED, () => parseRequest(request));
    expect(inherited).toStrictEqual(plain);
  });

  it('takes a request with its own members, and the result holds them and not the inherited ones', () => {
    const propose = { op: 'propose', authority: AUTHORITY, tenant: TENANT, lot: 'x' };
    const execute = { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: PROPOSAL, approval: null };
    for (const request of [propose, execute]) {
      const plain = parseRequest(request, keepFields);
      expect(plain.ok).toBe(true);
      const inherited = withPrototype(Object.prototype, INHERITED, () => parseRequest(request, keepFields));
      expect(inherited).toStrictEqual(plain);
      expect(inherited.ok && inherited.value.tenant).toBe(TENANT);
    }
  });
});
