// packages/usecase-kit/test/cosign/layout.test.ts
// The reader of the bytes of a transaction, and the writer of the answer. The reader never throws, never recurses, and gives `undefined` for bytes that it cannot read. The writer copies every byte of
// the input except the head of the witness set and the list of vkey witnesses.
import { describe, expect, it } from 'vitest';
import { addVkeyWitness, bodyBytesOf, itemEnd, readFrame } from '../../src/cosign/layout.ts';
import { DELEG_A, PRINCIPAL, build, signedBy } from './support.ts';
import { CML } from '@lucid-evolution/lucid';

/** The bytes of a text of hex with white space in it. */
const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text.replace(/\s+/g, ''), 'hex'));
const hexOf = (data: Uint8Array): string => Buffer.from(data).toString('hex');
/** A vkey witness of 101 bytes whose key and signature are `n` repeated. */
const witness = (n: number): string => `82 5820 ${n.toString(16).padStart(2, '0').repeat(32)} 5840 ${n.toString(16).padStart(2, '0').repeat(64)}`;
const NEW_KEY = Uint8Array.from({ length: 32 }, () => 0xaa);
const NEW_SIGNATURE = Uint8Array.from({ length: 64 }, () => 0xbb);
const NEW_WITNESS = `82 5820 ${'aa'.repeat(32)} 5840 ${'bb'.repeat(64)}`;

describe('itemEnd', () => {
  it.each([
    ['an integer of 1 byte', '00', 1], ['an integer of 2 bytes', '1864', 2], ['an integer of 3 bytes', '190100', 3], ['an integer of 5 bytes', '1a00000001', 5],
    ['an integer of 9 bytes', '1b0000000000000001', 9], ['a negative integer', '20', 1], ['a negative integer of 2 bytes', '38ff', 2],
    ['a byte string', '43010203', 4], ['a text string', '626162', 3], ['a byte string in chunks', '5f41aa41bbff', 6], ['an empty byte string in chunks', '5fff', 2],
    ['an empty array', '80', 1], ['an array', '820102', 3], ['an array and an empty array in an array', '82810180', 4], ['an array of indefinite length', '9f0102ff', 4], ['an empty map', 'a0', 1],
    ['a map', 'a10102', 3], ['a map of indefinite length', 'bf0102ff', 4], ['a map that holds an array and a map', 'a1018201a0', 5],
    ['a tag and its item', 'd81842abcd', 5], ['the tag 258 and an array', 'd9010280', 4], ['false', 'f4', 1], ['a float of 16 bits', 'f93c00', 3], ['a float of 64 bits', 'fb3ff0000000000000', 9],
  ] as [string, string, number][])('reads %s (%s) as an item of %i bytes', (_name, text, length) => {
    expect(itemEnd(bytes(text), 0)).toBe(length);
  });

  it('reads the first item only, and starts where it is told', () => {
    expect(itemEnd(bytes('00 00'), 0)).toBe(1);
    expect(itemEnd(bytes('00 8201 02 ff'), 1)).toBe(4);
  });

  it.each([
    ['an array that is cut', '8201'], ['a byte string that is cut', '430102'], ['an integer that is cut', '1a0000'], ['chunks with no break', '5f41aa'], ['a map with no break', 'bf0102'],
    ['a break with no container', 'ff'], ['a break in a container of fixed length', '81ff'], ['an integer with the additional information 31', '1f'], ['a reserved additional information', '1c'],
    ['a tag with no item', 'd818'], ['an empty input', ''],
  ])('gives undefined for %s', (_name, text) => {
    expect(itemEnd(bytes(text), 0)).toBeUndefined();
  });

  it('gives undefined at once for a count or a length that the bytes cannot hold, and allocates nothing for it', () => {
    for (const text of ['9bffffffffffffffff', '5bffffffffffffffff', 'bbffffffffffffffff', '9a7fffffff', '5a7fffffff00']) expect(itemEnd(bytes(text), 0)).toBeUndefined();
  });

  it('reads nesting of 200,000 levels with a loop and not with a recursion', () => {
    const levels = 200_000;
    const deep = new Uint8Array(levels + 1).fill(0x81);
    deep[levels] = 0x00;
    expect(itemEnd(deep, 0)).toBe(levels + 1);
    const open = new Uint8Array(levels + 1).fill(0x9f);
    expect(itemEnd(open, 0)).toBeUndefined();
  });
});

describe('readFrame', () => {
  it('reads the frame of a real Delegate: the keys of its body and of its witness set, and the bytes of its body', async () => {
    const { hex } = await build();
    const data = bytes(hex);
    const frame = readFrame(data)!;
    expect(frame.body.entries.map((entry) => entry.key)).toEqual([0, 1, 2, 3, 8, 9, 11, 13, 14, 16, 17, 18]);
    expect(frame.witnesses.entries.map((entry) => entry.key)).toEqual([5]);
    expect([frame.isValid, frame.auxiliaryIsNull]).toEqual([true, true]);
    expect(hexOf(bodyBytesOf(data, frame))).toBe(CML.Transaction.from_cbor_hex(hex).body().to_cbor_hex());
  });

  it('reads the witness set of a transaction that the member signed', async () => {
    const { hex } = await build();
    const frame = readFrame(bytes(signedBy(hex, PRINCIPAL)))!;
    expect(frame.witnesses.entries.map((entry) => entry.key).sort()).toEqual([0, 5]);
  });

  it('reads a body and a witness set of indefinite length', () => {
    const frame = readFrame(bytes('84 bf 00 80 ff bf 05 80 ff f5 f6'))!;
    expect([frame.body.entries.length, frame.body.indefinite, frame.witnesses.indefinite]).toEqual([1, true, true]);
  });

  it('reads auxiliary data that is not null, and says so', () => {
    expect(readFrame(bytes('84 a1 00 80 a0 f5 a0'))!.auxiliaryIsNull).toBe(false);
    expect(readFrame(bytes('84 a1 00 80 a0 f4 f6'))!.isValid).toBe(false);
  });

  it.each([
    ['an item that is not an array', 'a0'], ['an array of three items', '83 a0 a0 f5'], ['an array of five items', '85 a0 a0 f5 f6 00'], ['a body that is not a map', '84 80 a0 f5 f6'],
    ['a witness set that is not a map', '84 a0 80 f5 f6'], ['a key that is text', '84 a1 6161 00 a0 f5 f6'], ['a key that is a negative integer', '84 a1 20 00 a0 f5 f6'],
    ['a key that repeats', '84 a2 00 80 00 80 a0 f5 f6'], ['a key above 2^32', '84 a1 1b0000000100000000 00 a0 f5 f6'], ['a key that repeats in the witness set', '84 a0 a2 05 80 05 80 f5 f6'],
    ['a flag that is a number', '84 a0 a0 00 f6'], ['no flag', '84 a0 a0'], ['bytes after the last item', '84 a0 a0 f5 f6 00'], ['a map that is cut', '84 a1 00'],
    ['no item for the auxiliary data', '84 a0 a0 f5'],
  ])('gives undefined for %s', (_name, text) => {
    expect(readFrame(bytes(text))).toBeUndefined();
  });
});

describe('addVkeyWitness', () => {
  const body = 'a1 00 80';
  const make = (set: string): Uint8Array => bytes(`84 ${body} ${set} f5 f6`);
  const add = (input: Uint8Array): Uint8Array => {
    const frame = readFrame(input)!;
    const out = addVkeyWitness(input, frame, NEW_KEY, NEW_SIGNATURE);
    if (out === undefined) throw new Error('refused');
    // Whatever the form, the answer is a frame, with the same body, and the same tail.
    const answer = readFrame(out)!;
    expect(hexOf(bodyBytesOf(out, answer))).toBe(hexOf(bodyBytesOf(input, frame)));
    expect(hexOf(out.subarray(answer.witnesses.end))).toBe(hexOf(input.subarray(frame.witnesses.end)));
    return out;
  };

  it('adds the list as the first entry of a witness set that has none', () => {
    expect(hexOf(add(make('a0')))).toBe(hexOf(make(`a1 00 d90102 81 ${NEW_WITNESS}`)));
    expect(hexOf(add(make('a1 05 80')))).toBe(hexOf(make(`a2 00 d90102 81 ${NEW_WITNESS} 05 80`)));
  });

  it('adds the witness at the end of a list in the form of the tag 258, and of a plain array', () => {
    expect(hexOf(add(make(`a1 00 d90102 81 ${witness(1)}`)))).toBe(hexOf(make(`a1 00 d90102 82 ${witness(1)} ${NEW_WITNESS}`)));
    expect(hexOf(add(make(`a2 00 82 ${witness(1)} ${witness(2)} 05 80`)))).toBe(hexOf(make(`a2 00 83 ${witness(1)} ${witness(2)} ${NEW_WITNESS} 05 80`)));
  });

  it('adds the witness before the break of a list of indefinite length, and of a witness set of indefinite length', () => {
    expect(hexOf(add(make(`a1 00 9f ${witness(1)} ff`)))).toBe(hexOf(make(`a1 00 9f ${witness(1)} ${NEW_WITNESS} ff`)));
    expect(hexOf(add(make(`a1 00 d90102 9f ff`)))).toBe(hexOf(make(`a1 00 d90102 9f ${NEW_WITNESS} ff`)));
    expect(hexOf(add(make('bf 05 80 ff')))).toBe(hexOf(make(`bf 00 d90102 81 ${NEW_WITNESS} 05 80 ff`)));
  });

  it('grows the head of a list that passes 23 items, and keeps every old witness as it was', () => {
    const old = Array.from({ length: 23 }, (_, i) => witness(i + 1)).join(' ');
    const out = add(make(`a1 00 d90102 97 ${old}`));
    expect(hexOf(out)).toBe(hexOf(make(`a1 00 d90102 9818 ${old} ${NEW_WITNESS}`)));
  });

  it.each([[22, '96', '97'], [23, '97', '9818'], [254, '98fe', '98ff'], [255, '98ff', '990100']] as [number, string, string][])('writes the head of a list of %i witnesses in its shortest form after the add (%s, then %s)', (count, before, after) => {
    const old = Array.from({ length: count }, (_, i) => witness((i % 250) + 1)).join(' ');
    const out = add(make(`a1 00 d90102 ${before} ${old}`));
    expect(hexOf(out)).toBe(hexOf(make(`a1 00 d90102 ${after} ${old} ${NEW_WITNESS}`)));
  });

  it('keeps the entries that are not the vkey witnesses as they are, in their order', () => {
    const entries = 'a3 01 80 04 80 05 80';
    expect(hexOf(add(make(entries)))).toBe(hexOf(make(`a4 00 d90102 81 ${NEW_WITNESS} 01 80 04 80 05 80`)));
  });

  it.each([
    ['a list that is a map', 'a1 00 a0'], ['a list in a tag that is not 258', 'a1 00 d90103 80'], ['a list that is an integer', 'a1 00 01'],
  ])('gives undefined for %s', (_name, set) => {
    const input = make(set);
    expect(addVkeyWitness(input, readFrame(input)!, NEW_KEY, NEW_SIGNATURE)).toBeUndefined();
  });

  it('gives undefined for a key or a signature of the wrong length', () => {
    const input = make('a0');
    const frame = readFrame(input)!;
    expect(addVkeyWitness(input, frame, NEW_KEY.slice(1), NEW_SIGNATURE)).toBeUndefined();
    expect(addVkeyWitness(input, frame, NEW_KEY, NEW_SIGNATURE.slice(1))).toBeUndefined();
    expect(addVkeyWitness(input, frame, NEW_KEY, NEW_SIGNATURE)).toBeDefined();
  });

  it('writes a transaction that the decoder library reads as written, with the list of the input and the new witness at its end', async () => {
    const { hex } = await build();
    for (const input of [hex, signedBy(hex, PRINCIPAL)]) {
      const data = bytes(input);
      const out = hexOf(addVkeyWitness(data, readFrame(data)!, bytes(DELEG_A.publicKey), NEW_SIGNATURE)!);
      const tx = CML.Transaction.from_cbor_hex(out);
      expect(tx.to_cbor_hex()).toBe(out);
      const list = tx.witness_set().vkeywitnesses()!;
      const before = CML.Transaction.from_cbor_hex(input).witness_set().vkeywitnesses()?.len() ?? 0;
      expect(list.len()).toBe(before + 1);
      expect(Buffer.from(list.get(before).ed25519_signature().to_raw_bytes()).toString('hex')).toBe('bb'.repeat(64));
    }
  });
});
