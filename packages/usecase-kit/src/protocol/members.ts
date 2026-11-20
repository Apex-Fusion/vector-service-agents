// packages/usecase-kit/src/protocol/members.ts
// The rule "an object with these members and no other", and the safe read of the members of an object. A message of the protocol has exactly the members that it names. A member that is missing is
// a refusal, and so is a member that the message does not have. A parser of the fields of a use case uses these rules for its own members.
import { isPlainObject } from './json.ts';
import { accepted, refused, type ProtocolResult, type Refused } from './result.ts';
import { shown } from './text.ts';

/**
 * A refusal when `record` lacks a member of `required`, or has a member that is in neither `required` nor `optional`. It is null when the members are right. A missing member is named before a member that
 * is not allowed. A member is an own member: one that the object only inherits is not there. The key `__proto__` that JSON.parse made is an own member, and it is refused as a member that is not allowed.
 * The name of a member that is not allowed comes from outside, so the detail shows it cut and in printable form. A record that cannot be read (a Proxy that throws) gives a refusal and never an exception.
 */
export function checkMembers(record: Readonly<Record<string, unknown>>, field: string, required: readonly string[], optional: readonly string[] = []): Refused | null {
  try {
    for (const name of required) {
      if (!Object.hasOwn(record, name)) return refused('bad_shape', `${field} has no member ${JSON.stringify(name)}`);
    }
    for (const name of Object.keys(record)) {
      if (!required.includes(name) && !optional.includes(name)) return refused('bad_shape', `${field} has the member ${JSON.stringify(shown(name))}, which is not allowed`);
    }
    return null;
  } catch {
    return refused('bad_shape', `${field} cannot be read`);
  }
}

/**
 * The own members of a plain object, each read one time as data, in a NEW plain object. A parser reads the members from this copy, so a getter or a Proxy cannot give it another value at a second read.
 * It refuses a value that is not a plain object, an accessor member, a key that is a symbol, and a member that is not enumerable. The values of the members stay as they are: they are not copied here.
 * The key `__proto__` stays an own member of the copy, so `checkMembers` can refuse it. It never throws.
 */
export function readMembers(value: unknown, field: string): ProtocolResult<Record<string, unknown>> {
  if (!isPlainObject(value)) return refused('bad_shape', `${field} must be a JSON object`);
  try {
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return refused('bad_shape', `${field} has a key that JSON cannot hold`);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true) return refused('bad_shape', `${field} has a key that JSON cannot hold`);
      if (!('value' in descriptor)) return refused('bad_shape', `${field}.${shown(key)} is an accessor, which is not allowed`);
      Object.defineProperty(out, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
    }
    return accepted(out);
  } catch {
    return refused('bad_shape', `${field} cannot be read`);
  }
}
