// packages/usecase-kit/test/protocol/walk-messages.test.ts: the refusals of the walk name the member that they refuse, and the digest functions use the copy that the walk built. Each refusal has an
// accepted twin in the tests of the probes and of the JSON values.
import { describe, expect, it } from 'vitest';
import { canonicalSha256, parseJsonValue, proposalDigest } from '@vsa/usecase-kit/protocol';
import { SALT } from './support.ts';

class SpeciesArray extends Array<unknown> {}

function accessorObject(): Record<string, unknown> {
  return Object.defineProperty({}, 'a', { get: () => 1, enumerable: true, configurable: true }) as Record<string, unknown>;
}

function accessorArray(): unknown[] {
  return Object.defineProperty([1], 0, { get: () => 1, enumerable: true, configurable: true });
}

function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function nested(levels: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < levels; level += 1) value = { k: value };
  return value;
}

describe('the refusals of the walk', () => {
  it.each([
    ['a hole in an array', { a: [1, , 3] }, 'document.a[1] is a hole in an array'],
    ['an accessor member of an object', { a: accessorObject() }, 'document.a.a is an accessor, which is not allowed'],
    ['an accessor element of an array', { a: accessorArray() }, 'document.a[0] is an accessor, which is not allowed'],
    ['an array of another kind', { a: SpeciesArray.from([1]) }, 'document.a is an array of a kind that JSON does not have'],
    ['an array with a key that is not an index', { a: Object.assign([1], { extra: 1 }) }, 'document.a has a key that JSON cannot hold'],
    ['a member that is not enumerable', { a: Object.defineProperty({}, 'b', { value: 1, enumerable: false }) }, 'document.a has a key that JSON cannot hold'],
    ['a key that is a symbol', { a: { [Symbol('k')]: 1 } }, 'document.a has a key that JSON cannot hold'],
    ['a revoked Proxy', { a: revoked() }, 'document cannot be read as JSON data'],
    ['a Proxy whose descriptor trap throws', { a: new Proxy({ b: 1 }, { getOwnPropertyDescriptor() { throw new Error('trap'); } }) }, 'document cannot be read as JSON data'],
    ['a Proxy whose prototype trap throws', { a: new Proxy({ b: 1 }, { getPrototypeOf() { throw new Error('trap'); } }) }, 'document.a is not a plain object'],
    ['a function', { a: () => 1 }, 'document.a is not JSON data'],
    ['a number that is not finite', { a: Number.NaN }, 'document.a is not a finite number'],
    ['a date', { a: new Date(0) }, 'document.a is not a plain object'],
    ['the key __proto__', JSON.parse('{"a":{"__proto__":1}}'), 'document.a.__proto__ is the key __proto__, which is not allowed'],
    ['a key that is a whole number', JSON.parse('{"a":{"7":1}}'), 'document.a.7 is a key that is a whole number, which is not allowed'],
    ['a key that is not in the NFC form, shown in printable form', JSON.parse('{"a":{"e\\u0301":1}}'), 'document.a.e? is a key that is not in the NFC form, which is not allowed'],
    ['a document that is too deep', nested(33), 'document.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k.k is nested deeper than 32 levels'],
  ])('names %s', (_name, value, detail) => {
    const result = parseJsonValue(value, 'document');
    expect(result).toStrictEqual({ ok: false, code: 'bad_shape', detail });
  });
});

describe('the digest functions use the copy of the walk', () => {
  /** A Proxy whose descriptor trap gives a new value at each call, and whose get trap gives 99. A function that reads again, or that reads with get, writes another text. */
  function counting(): object {
    let calls = 0;
    return new Proxy({ a: 1, b: 2 }, {
      getOwnPropertyDescriptor() {
        calls += 1;
        return { value: calls, enumerable: true, configurable: true, writable: true };
      },
      get() {
        return 99;
      },
    });
  }

  it('proposalDigest hashes the value of the one read', () => {
    expect(proposalDigest(SALT, counting())).toStrictEqual(proposalDigest(SALT, { a: 1, b: 2 }));
  });

  it('canonicalSha256 hashes the value of the one read', () => {
    expect(canonicalSha256(counting())).toStrictEqual(canonicalSha256({ a: 1, b: 2 }));
  });
});
