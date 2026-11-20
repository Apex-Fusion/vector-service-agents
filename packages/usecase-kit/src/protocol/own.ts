// packages/usecase-kit/src/protocol/own.ts
// How a parser makes a copy and reads a member of it, so that no prototype takes part. It is not part of the public surface: the index of the protocol does not export this file.
//   - A copy is made with defineProperty. An assignment, and an array method such as `push`, call a setter that a prototype has for the key, and they fail for a member that a prototype holds as
//     read-only. defineProperty does neither, so the copy always gets the member as an own member.
//   - The descriptor has no prototype. A `get` or a `set` on Object.prototype does not turn the member into an accessor.
//   - A member of a copy is read as an own member only, so a value that a prototype holds for the name is never read.

/** Makes `key` an own data member of `target`, with `value`. For an array, `key` is the next index. */
export function defineMember(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { __proto__: null, value, enumerable: true, writable: true, configurable: true } as PropertyDescriptor);
}

/** The own member `name` of `record`, or `undefined` when `record` has no own member of that name. */
export function ownMember(record: object, name: string): unknown {
  return Object.hasOwn(record, name) ? (record as Record<string, unknown>)[name] : undefined;
}
