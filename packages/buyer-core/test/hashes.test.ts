// packages/buyer-core/test/hashes.test.ts
import { describe, it, expect } from 'vitest';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { sha256BytesHex } from '../src/hashes.ts';

describe('sha256BytesHex (the datum module addition after 94b8f41, for the vendored transport)', () => {
  it('hashes bytes as they are, in lower-case hex', () => {
    expect(sha256BytesHex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256BytesHex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is not the hash of the decoded text when the bytes are not valid UTF-8', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61]);
    expect(sha256BytesHex(bytes)).not.toBe(sha256Utf8Hex(new TextDecoder().decode(bytes)));
  });
});
