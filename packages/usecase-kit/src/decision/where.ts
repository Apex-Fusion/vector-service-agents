// packages/usecase-kit/src/decision/where.ts
// Where a value is not JSON data, said with no key and no value. A value that comes from outside (the answer of a model, the input of a decision, the receipt of a supplier) can hold a key that
// repeats secret text, so no detail of this folder repeats a key. The protocol names the member that it refuses by its path, and the path holds the keys. So a detail here says what kind of fault it
// is and where by POSITION: the depth of the data in which the protocol finds a value or a key that it does not allow. The root is depth 1, and a member of the root is at depth 2.
// The position comes from the protocol itself. A walk from the root asks the protocol about each node, and it reports the first node that the protocol refuses when it takes every member of the node.
// So this file holds no rule of the protocol, and a rule that the protocol adds shows here with no change.
import { MAX_DOCUMENT_DEPTH, parseJsonValue } from '../protocol/index.ts';

interface Place {
  readonly depth: number;
  readonly tooDeep: boolean;
}

/** The members of an array or an object, read as data: no getter runs. A value that cannot be read (a Proxy that throws) has no members. */
function membersOf(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return [];
  const members: unknown[] = [];
  try {
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(node, key);
      if (descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')) members.push(descriptor.value);
    }
  } catch {
    return [];
  }
  return members;
}

/**
 * The first node, in a walk that goes deep before it goes wide, that the protocol refuses while it takes every member of the node. A node at a depth above the limit is refused for its depth alone.
 * A node that has a member that is refused is not the place: the member is. So the place is a value that is not JSON data, or an object that has a key that the protocol does not allow. The depth
 * of the recursion stops at the limit of the protocol, so a value that holds itself ends the walk.
 */
function find(node: unknown, depth: number): Place | null {
  if (typeof node === 'object' && node !== null && depth > MAX_DOCUMENT_DEPTH) return { depth, tooDeep: true };
  for (const member of membersOf(node)) {
    const inner = find(member, depth + 1);
    if (inner !== null) return inner;
  }
  return parseJsonValue(node).ok ? null : { depth, tooDeep: false };
}

/**
 * What is wrong with a value that the protocol refuses as JSON data, as the end of a sentence about that value: where, and never which key or which value. It never throws. A value that the
 * protocol takes has no place, and the sentence is then the plain one.
 */
export function whereNotJson(value: unknown): string {
  const place = find(value, 1);
  if (place === null) return 'is not JSON data';
  return place.tooDeep ? `is nested deeper than ${MAX_DOCUMENT_DEPTH} levels` : `holds, at depth ${place.depth}, a value or a key that JSON data does not allow`;
}
