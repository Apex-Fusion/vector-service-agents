// packages/usecase-kit/src/cosign/layout.ts
// The layout of a transaction, read from its bytes with no decoder library. The route reads the layout first and gives the bytes to the decoder only when the layout is the one of a Delegate. So a part
// that a Delegate does not have (a certificate, a withdrawal, a vote) is never decoded.
//
// A transaction is an array of four items: the body (a map), the witness set (a map), the validity flag, and the auxiliary data. The reader goes over the bytes with a loop and a list, never with a
// recursion, so its time is linear in the size of the input. It does not allocate for a length that the bytes declare. It never throws: bytes that it cannot read give `undefined`.
//
// The route also writes with this layout. `addVkeyWitness` makes the answer: the bytes of the transaction with one vkey witness added to the witness set. It copies every other byte as it is.

/** The bytes `start` up to `end` of the transaction. */
export interface Range {
  readonly start: number;
  readonly end: number;
}

/** One entry of a map whose keys are unsigned integers: the key, the bytes of the whole entry, and the bytes of its value. */
export interface MapEntry {
  readonly key: number;
  readonly entry: Range;
  readonly value: Range;
}

/** A map: the bytes of its header (the head that gives the count), its entries in the order of the bytes, and where it ends. A key that the bytes repeat makes the map unreadable. */
export interface MapLayout {
  readonly head: Range;
  readonly entries: readonly MapEntry[];
  readonly end: number;
  readonly indefinite: boolean;
}

/** What the bytes of a transaction say about its frame. */
export interface Frame {
  readonly body: MapLayout;
  readonly witnesses: MapLayout;
  /** The validity flag. */
  readonly isValid: boolean;
  /** True when the auxiliary data is null. */
  readonly auxiliaryIsNull: boolean;
}

const INDEFINITE = -1;
const BREAK = 0xff;

interface Head {
  readonly major: number;
  readonly info: number;
  readonly arg: number;
  readonly next: number;
}

/** The head of the item at `pos`: its major type, its argument (the count or the length), and where the next byte is. An argument above 2^53 is approximate, and no input can satisfy it. */
function readHead(bytes: Uint8Array, pos: number): Head | undefined {
  if (pos >= bytes.length) return undefined;
  const first = bytes[pos];
  const major = first >> 5;
  const info = first & 31;
  if (info < 24) return { major, info, arg: info, next: pos + 1 };
  if (info === 31) return major === 7 || (major >= 2 && major <= 5) ? { major, info, arg: INDEFINITE, next: pos + 1 } : undefined;
  if (info > 27) return undefined;
  const size = 1 << (info - 24);
  if (pos + 1 + size > bytes.length) return undefined;
  let arg = 0;
  for (let i = 0; i < size; i++) arg = arg * 256 + bytes[pos + 1 + i];
  return { major, info, arg, next: pos + 1 + size };
}

/**
 * Where the item that starts at `start` ends, or undefined when the bytes are not whole CBOR. `open` holds, for each container that is open, the items that it still needs, or INDEFINITE for a
 * container that ends with a break.
 */
export function itemEnd(bytes: Uint8Array, start: number): number | undefined {
  const open: number[] = [];
  let pos = start;
  for (;;) {
    const head = readHead(bytes, pos);
    if (head === undefined) return undefined;
    pos = head.next;
    let opens = false;
    if (head.major === 7 && head.info === 31) {
      if (open.pop() !== INDEFINITE) return undefined;
    } else if (head.major === 2 || head.major === 3) {
      if (head.arg === INDEFINITE) {
        open.push(INDEFINITE);
        opens = true;
      } else {
        pos += head.arg;
        if (pos > bytes.length) return undefined;
      }
    } else if (head.major === 4 || head.major === 5) {
      if (head.arg === INDEFINITE) {
        open.push(INDEFINITE);
        opens = true;
      } else if (head.arg > 0) {
        open.push(head.major === 5 ? 2 * head.arg : head.arg);
        opens = true;
      }
    } else if (head.major === 6) {
      open.push(1);
      opens = true;
    }
    if (opens) continue;
    // An item is whole. It completes each definite container that waits for it, and it counts for the container around that one.
    for (;;) {
      const top = open.length - 1;
      if (top < 0) return pos;
      if (open[top] === INDEFINITE) break;
      open[top] -= 1;
      if (open[top] > 0) break;
      open.pop();
    }
  }
}

/** The map at `pos`, when every key is an unsigned integer below 2^32 and no key repeats. */
function readMap(bytes: Uint8Array, pos: number): MapLayout | undefined {
  const head = readHead(bytes, pos);
  if (head === undefined || head.major !== 5) return undefined;
  const entries: MapEntry[] = [];
  const seen = new Set<number>();
  let at = head.next;
  let left = head.arg;
  for (;;) {
    if (head.arg === INDEFINITE) {
      if (at >= bytes.length) return undefined;
      if (bytes[at] === BREAK) {
        at += 1;
        break;
      }
    } else {
      if (left === 0) break;
      left -= 1;
    }
    const key = readHead(bytes, at);
    if (key === undefined || key.major !== 0 || key.arg > 0xffff_ffff || seen.has(key.arg)) return undefined;
    seen.add(key.arg);
    const valueEnd = itemEnd(bytes, key.next);
    if (valueEnd === undefined) return undefined;
    entries.push({ key: key.arg, entry: { start: at, end: valueEnd }, value: { start: key.next, end: valueEnd } });
    at = valueEnd;
  }
  return { head: { start: pos, end: head.next }, entries, end: at, indefinite: head.arg === INDEFINITE };
}

/**
 * The frame of the transaction `bytes`, or undefined when the bytes are not a transaction of this form: an array of four items, a body map and a witness map with unsigned integer keys that do not
 * repeat, a validity flag, auxiliary data, and no byte after them.
 */
export function readFrame(bytes: Uint8Array): Frame | undefined {
  const top = readHead(bytes, 0);
  if (top === undefined || top.major !== 4 || top.arg !== 4) return undefined;
  const body = readMap(bytes, top.next);
  if (body === undefined) return undefined;
  const witnesses = readMap(bytes, body.end);
  if (witnesses === undefined) return undefined;
  const flag = bytes[witnesses.end];
  if (flag !== 0xf4 && flag !== 0xf5) return undefined;
  const auxiliaryIsNull = bytes[witnesses.end + 1] === 0xf6;
  const end = auxiliaryIsNull ? witnesses.end + 2 : itemEnd(bytes, witnesses.end + 1);
  if (end !== bytes.length) return undefined;
  return { body, witnesses, isValid: flag === 0xf5, auxiliaryIsNull };
}

/** The bytes of the body: the bytes that every signature of the transaction covers. */
export const bodyBytesOf = (bytes: Uint8Array, frame: Frame): Uint8Array => bytes.subarray(frame.body.head.start, frame.body.end);

/** The head of an item of major type `major` with the count `count`, in the shortest form. */
function encodeHead(major: number, count: number): number[] {
  const type = major << 5;
  if (count < 24) return [type | count];
  if (count < 0x100) return [type | 24, count];
  if (count < 0x10000) return [type | 25, count >> 8, count & 0xff];
  return [type | 26, (count >>> 24) & 0xff, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff];
}

const concat = (parts: readonly (Uint8Array | readonly number[])[]): Uint8Array => Buffer.concat(parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part))));

/** The set of vkey witnesses (an array, or the tag 258 and an array) with `item` added at its end. Undefined for any other form. */
function withItemAppended(bytes: Uint8Array, value: Range, item: Uint8Array): Uint8Array | undefined {
  const first = readHead(bytes, value.start);
  if (first === undefined) return undefined;
  let innerStart = value.start;
  if (first.major === 6) {
    if (first.arg !== 258) return undefined;
    innerStart = first.next;
  }
  const inner = readHead(bytes, innerStart);
  if (inner === undefined || inner.major !== 4) return undefined;
  const prefix = bytes.subarray(value.start, innerStart);
  if (inner.arg === INDEFINITE) {
    if (bytes[value.end - 1] !== BREAK) return undefined;
    return concat([prefix, bytes.subarray(innerStart, value.end - 1), item, [BREAK]]);
  }
  return concat([prefix, encodeHead(4, inner.arg + 1), bytes.subarray(inner.next, value.end), item]);
}

/**
 * The transaction `bytes` with the vkey witness of `vkey` (32 bytes) and `signature` (64 bytes) added at the end of the list of vkey witnesses. When the witness set has no list, it gets one, with the one
 * witness, as its first entry. Every other byte is copied as it is: the body, the other witnesses, the other entries of the witness set, the validity flag and the auxiliary data. Only the head that
 * counts the entries of the witness set, or the head that counts the witnesses, can change. Undefined when the key or the signature has the wrong length, or when the list has a form that the reader
 * does not know.
 */
export function addVkeyWitness(bytes: Uint8Array, frame: Frame, vkey: Uint8Array, signature: Uint8Array): Uint8Array | undefined {
  if (vkey.length !== 32 || signature.length !== 64) return undefined;
  const item = concat([[0x82, 0x58, 0x20], vkey, [0x58, 0x40], signature]);
  const { witnesses } = frame;
  const list = witnesses.entries.find((entry) => entry.key === 0);
  if (list === undefined) {
    const header = witnesses.indefinite ? bytes.subarray(witnesses.head.start, witnesses.head.end) : Uint8Array.from(encodeHead(5, witnesses.entries.length + 1));
    const entry = concat([[0x00, 0xd9, 0x01, 0x02, 0x81], item]);
    return concat([bytes.subarray(0, witnesses.head.start), header, entry, bytes.subarray(witnesses.head.end)]);
  }
  const appended = withItemAppended(bytes, list.value, item);
  return appended === undefined ? undefined : concat([bytes.subarray(0, list.value.start), appended, bytes.subarray(list.value.end)]);
}
