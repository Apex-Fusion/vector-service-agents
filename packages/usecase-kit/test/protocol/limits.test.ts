// packages/usecase-kit/test/protocol/limits.test.ts: the request limit and the limit of the runtime body. The request limit counts bytes of the wire payload, as the HTTP layer does, and not characters.
// It bounds the wire payload only. The body of the call that a sender makes to the runtime can be longer than the wire payload, so a sender must also keep that body under the limit of the runtime.
import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES, checkRequestSize } from '@vsa/usecase-kit/protocol';

describe('MAX_REQUEST_BYTES', () => {
  it('is 900,000 bytes of wire payload', () => {
    expect(MAX_REQUEST_BYTES).toBe(900_000);
  });
});

describe('RUNTIME_BODY_LIMIT_BYTES', () => {
  it('is 1 MiB, the most that the runtime takes in the body of one call', () => {
    expect(RUNTIME_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(RUNTIME_BODY_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it('is above the request limit, and the request limit does not bound the body of a call', () => {
    expect(MAX_REQUEST_BYTES).toBeLessThan(RUNTIME_BODY_LIMIT_BYTES);
    // A request text of quote marks: the wire payload writes each one as two bytes, and a second JSON object writes each of those two as two bytes again.
    const wirePayload = JSON.stringify([{ content: '"'.repeat(270_000), role: 'user' }]);
    const body = JSON.stringify({ payload: wirePayload });
    expect(checkRequestSize(wirePayload).ok).toBe(true);
    expect(Buffer.byteLength(wirePayload, 'utf8')).toBeLessThan(MAX_REQUEST_BYTES);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(RUNTIME_BODY_LIMIT_BYTES);
  });

  it('is not the limit that checkRequestSize applies', () => {
    expect(checkRequestSize('a'.repeat(RUNTIME_BODY_LIMIT_BYTES - 1))).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(checkRequestSize('a'.repeat(MAX_REQUEST_BYTES))).toStrictEqual({ ok: true, value: MAX_REQUEST_BYTES });
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

  it('refuses a value that cannot be read with bad_shape and does not throw, and takes the bytes themselves', () => {
    const revoked = Proxy.revocable(new Uint8Array(3), {});
    revoked.revoke();
    const hostile: ReadonlyArray<readonly [string, () => Uint8Array]> = [
      ['a Proxy whose prototype trap throws', () => new Proxy(new Uint8Array(3), { getPrototypeOf() { throw new Error('the trap ran'); } })],
      ['a revoked Proxy', () => revoked.proxy],
      ['a Proxy of bytes with no trap, which is not bytes itself', () => new Proxy(new Uint8Array(3), {})],
    ];
    for (const [label, make] of hostile) {
      expect(() => checkRequestSize(make()), label).not.toThrow();
      expect(checkRequestSize(make()), label).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'the request cannot be read' });
    }
    expect(checkRequestSize(new Uint8Array(3))).toStrictEqual({ ok: true, value: 3 });
  });
});
