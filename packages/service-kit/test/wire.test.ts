// packages/service-kit/test/wire.test.ts
import { describe, test, expect } from 'vitest';
import { MAX_BODY, WireError, parseWire } from '../src/wire.ts';

const message = (content: unknown, role: unknown = 'user') => JSON.stringify([{ content, role }]);

describe('parseWire', () => {
  test('gives the content of the one message, exactly as a string', () => {
    expect(parseWire(message('{"say":"hi"}'))).toBe('{"say":"hi"}');
    expect(parseWire(message(''))).toBe('');
  });
  test('anything but the one-element message array is bad_wire, with the shape in the message', () => {
    const SHAPE = 'the body must be the one-element message array [{"content": "<request JSON as a string>", "role": "user"}]';
    for (const body of ['x', '{}', '[]', JSON.stringify([{ content: 'a', role: 'user' }, { content: 'b', role: 'user' }]), JSON.stringify([{ content: 7, role: 'user' }])]) {
      expect(() => parseWire(body), body).toThrow(WireError);
      try { parseWire(body); } catch (e) { expect((e as WireError).code).toBe('bad_wire'); expect((e as Error).message).toContain(SHAPE); }
    }
    expect(() => parseWire(message('{}', 'assistant'))).toThrow("the message role must be 'user'");
  });
  test('the size is counted in bytes: MAX_BODY passes the size check, one byte more is request_too_large', () => {
    expect(MAX_BODY).toBe(1_000_000);
    const frame = (bytes: number) => message('x'.repeat(bytes - message('').length));
    expect(() => parseWire(frame(MAX_BODY))).not.toThrow();
    expect(() => parseWire(frame(MAX_BODY + 1))).toThrow(expect.objectContaining({ code: 'request_too_large', status: 400 }));
    const wide = '\u00e9'.repeat(MAX_BODY / 2);
    expect(() => parseWire(message(wide))).toThrow(expect.objectContaining({ code: 'request_too_large' }));
  });
});
