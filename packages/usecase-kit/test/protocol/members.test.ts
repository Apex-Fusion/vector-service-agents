// packages/usecase-kit/test/protocol/members.test.ts: the rule "an object with these members and no other". A message of the protocol has exactly the members that it names.
import { describe, expect, it } from 'vitest';
import { checkMembers } from '@vsa/usecase-kit/protocol';

describe('checkMembers', () => {
  it('takes an object with the required members and no other', () => {
    expect(checkMembers({ a: 1, b: 2 }, 'thing', ['a', 'b'])).toBeNull();
    expect(checkMembers({ b: 2, a: 1 }, 'thing', ['a', 'b'])).toBeNull();
    expect(checkMembers({}, 'thing', [])).toBeNull();
  });

  it('takes a member that is optional, when it is there and when it is not', () => {
    expect(checkMembers({ a: 1 }, 'thing', ['a'], ['c'])).toBeNull();
    expect(checkMembers({ a: 1, c: 3 }, 'thing', ['a'], ['c'])).toBeNull();
  });

  it('takes a member that is undefined as a member that is there', () => {
    expect(checkMembers({ a: undefined }, 'thing', ['a'])).toBeNull();
  });

  it('refuses a member that is missing, and names the field and the member', () => {
    const result = checkMembers({ a: 1 }, 'authority', ['a', 'delegation']);
    expect(result).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'authority has no member "delegation"' });
  });

  it('refuses a member that is not allowed, and names the field and the member', () => {
    const result = checkMembers({ a: 1, vault: 'x' }, 'authority', ['a']);
    expect(result).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'authority has the member "vault", which is not allowed' });
  });

  it('names a missing member before a member that is not allowed', () => {
    const result = checkMembers({ b: 1 }, 'thing', ['a']);
    expect(result).toMatchObject({ ok: false, detail: 'thing has no member "a"' });
  });

  it('refuses an optional member that is not in the optional list', () => {
    expect(checkMembers({ a: 1, c: 3 }, 'thing', ['a'])).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(checkMembers({ a: 1, d: 3 }, 'thing', ['a'], ['c'])).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('does not take a member that the object only inherits', () => {
    expect(checkMembers({}, 'thing', ['toString'])).toMatchObject({ ok: false, detail: 'thing has no member "toString"' });
    expect(checkMembers({}, 'thing', ['constructor'])).toMatchObject({ ok: false });
  });

  it('refuses the key __proto__ when JSON.parse made it, as a member that is not allowed', () => {
    const parsed = JSON.parse('{"a":1,"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(checkMembers(parsed, 'thing', ['a'])).toMatchObject({ ok: false, detail: 'thing has the member "__proto__", which is not allowed' });
  });

  it('reads an object that has no prototype', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(checkMembers(bare, 'thing', ['a'])).toBeNull();
    expect(checkMembers(bare, 'thing', ['a', 'b'])).toMatchObject({ ok: false });
  });

  it('cuts a long name from outside and shows only printable characters, so the detail stays short', () => {
    const result = checkMembers({ a: 1, [`${'x'.repeat(5_000)}\n\u0000\u00e9`]: 1 }, 'thing', ['a']);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(result !== null && result.detail.length).toBeLessThan(200);
    expect(result !== null && /^[\x20-\x7e]*$/.test(result.detail)).toBe(true);
    const control = checkMembers({ a: 1, 'b\nc\u00e9': 1 }, 'thing', ['a']);
    expect(control).toMatchObject({ ok: false, detail: 'thing has the member "b?c?", which is not allowed' });
  });
});
