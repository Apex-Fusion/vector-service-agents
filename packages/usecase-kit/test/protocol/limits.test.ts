// packages/usecase-kit/test/protocol/limits.test.ts: the request limit. The limit counts bytes of the wire payload, as the HTTP layer does, and not characters.
import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES, checkRequestSize } from '@vsa/usecase-kit/protocol';

describe('MAX_REQUEST_BYTES', () => {
  it('is 900,000 bytes, which is under the 1 MiB that the runtime takes', () => {
    expect(MAX_REQUEST_BYTES).toBe(900_000);
    expect(MAX_REQUEST_BYTES).toBeLessThan(1024 * 1024);
  });
});

describe('checkRequestSize', () => {
  it('takes a payload of exactly the limit, as text and as bytes, and returns its size', () => {
    expect(checkRequestSize('a'.repeat(MAX_REQUEST_BYTES))).toStrictEqual({ ok: true, value: MAX_REQUEST_BYTES });
    expect(checkRequestSize(new Uint8Array(MAX_REQUEST_BYTES))).toStrictEqual({ ok: true, value: MAX_REQUEST_BYTES });
    expect(checkRequestSize(Buffer.alloc(MAX_REQUEST_BYTES))).toStrictEqual({ ok: true, value: MAX_REQUEST_BYTES });
  });

  it('takes an empty payload and a short payload', () => {
    expect(checkRequestSize('')).toStrictEqual({ ok: true, value: 0 });
    expect(checkRequestSize('[{"content":"{}","role":"user"}]')).toStrictEqual({ ok: true, value: 32 });
  });

  it('refuses a payload of one byte more than the limit with request_too_large, as text and as bytes', () => {
    for (const payload of ['a'.repeat(MAX_REQUEST_BYTES + 1), new Uint8Array(MAX_REQUEST_BYTES + 1)]) {
      const result = checkRequestSize(payload);
      expect(result).toMatchObject({ ok: false, code: 'request_too_large' });
      expect(!result.ok && result.detail).toContain(String(MAX_REQUEST_BYTES + 1));
      expect(!result.ok && result.detail).toContain(String(MAX_REQUEST_BYTES));
    }
  });

  it('counts the bytes of the text and not its characters', () => {
    // 450,001 characters of two bytes each are 900,002 bytes: the count of characters is under the limit and the count of bytes is over it.
    const text = '\u00e9'.repeat(450_001);
    expect(text.length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(checkRequestSize(text)).toMatchObject({ ok: false, code: 'request_too_large' });
    // 300,000 characters of three bytes each are exactly 900,000 bytes.
    expect(checkRequestSize('\u20ac'.repeat(300_000))).toStrictEqual({ ok: true, value: 900_000 });
    // A character outside the basic plane is four bytes and two UTF-16 code units.
    expect(checkRequestSize('\u{1f600}'.repeat(225_000))).toStrictEqual({ ok: true, value: 900_000 });
    expect(checkRequestSize('\u{1f600}'.repeat(225_001))).toMatchObject({ ok: false, code: 'request_too_large' });
  });

  it.each([undefined, null, 0, {}, [], ['a'], true, 10n, Symbol('s')])('refuses a value that is not text or bytes: %s', (value) => {
    const result = checkRequestSize(value as never);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
  });
});
