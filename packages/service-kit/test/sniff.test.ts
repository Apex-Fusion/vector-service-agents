// packages/service-kit/test/sniff.test.ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ascii, sniffBy } from '../src/sniff.ts';
import type { Signature } from '../src/sniff.ts';
import { EXPORT_FROM, IMPORT_LINE } from './support.ts';

// The three signatures of agents/document-pipeline/src/mime.ts, which keeps its own copy (its test pins that module free of imports): the generic form gives
// the answers of the Pipeline's table.
const PIPELINE: Signature[] = [
  { type: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
];
const bytes = (...values: Array<number | string>) => Uint8Array.from(values.flatMap((v) => (typeof v === 'string' ? ascii(v) : [v])));

describe('sniffBy', () => {
  test('the first signature that matches names the type; nothing that matches is null', () => {
    expect(sniffBy(bytes('%PDF-1.4'), PIPELINE)).toBe('application/pdf');
    expect(sniffBy(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a), PIPELINE)).toBe('image/png');
    expect(sniffBy(bytes(0xff, 0xd8, 0xff, 0xe0), PIPELINE)).toBe('image/jpeg');
    for (const no of [bytes(), bytes('%PDF'), bytes('\n%PDF-1.4'), bytes('%pdf-1.4'), bytes(0xff, 0xd8), bytes('GIF89a')]) expect(sniffBy(no, PIPELINE)).toBeNull();
  });
  test('a signature can sit at an offset and compare its bytes under a mask', () => {
    const sigs: Signature[] = [
      { type: 'wav', magic: [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')], mask: [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff] },
      { type: 'mp4', at: 4, magic: ascii('ftyp') },
      { type: 'frame', magic: [0xff, 0xfa], mask: [0xff, 0xfe] },
    ];
    expect(sniffBy(bytes('RIFF', 1, 2, 3, 4, 'WAVE'), sigs)).toBe('wav');
    expect(sniffBy(bytes('RIFF', 1, 2, 3, 4, 'AVI '), sigs)).toBeNull();
    expect(sniffBy(bytes(0, 0, 0, 0x20, 'ftypisom'), sigs)).toBe('mp4');
    expect(sniffBy(bytes(0, 0, 0, 'ftyp'), sigs)).toBeNull();
    expect(sniffBy(bytes(0xff, 0xfb), sigs)).toBe('frame');
    expect(sniffBy(bytes(0xff, 0xf3), sigs)).toBeNull();
  });
  test('the mask is applied to the bytes of the file and not to the magic: a magic byte with a bit outside its mask never matches, so the magic is given masked', () => {
    // 0xfb under the mask 0xfe is 0xfa: a signature that names 0xfb for that byte matches no file, and the one that names 0xfa matches both 0xfa and 0xfb.
    expect(sniffBy(bytes(0xff, 0xfb), [{ type: 'unmasked', magic: [0xff, 0xfb], mask: [0xff, 0xfe] }])).toBeNull();
    expect(sniffBy(bytes(0xff, 0xfb), [{ type: 'masked', magic: [0xff, 0xfa], mask: [0xff, 0xfe] }])).toBe('masked');
    expect(sniffBy(bytes(0xff, 0xfa), [{ type: 'masked', magic: [0xff, 0xfa], mask: [0xff, 0xfe] }])).toBe('masked');
  });
  test('src/sniff.ts has no imports and re-exports nothing', () => {
    const source = readFileSync(new URL('../src/sniff.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(IMPORT_LINE);
    expect(source).not.toMatch(EXPORT_FROM);
  });
});
