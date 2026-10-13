import { describe, test, expect } from 'vitest';
import { parseWire } from '../src/request.ts';
const wrap = (s: string) => JSON.stringify([{ content: s, role: 'user' }]);
describe('parseWire', () => {
  test('accepts a DID subject and defaults include', () => {
    expect(parseWire(wrap('{"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:' + 'ab'.repeat(32) + '"}')))
      .toEqual({ subject: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:' + 'ab'.repeat(32), include: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] });
  });
  test('rejects a missing subject with 400', () => {
    expect(() => parseWire(wrap('{}'))).toThrowError(expect.objectContaining({ status: 400 }));
  });
  test('rejects a body that is not the message array', () => {
    expect(() => parseWire('{"subject":"x"}')).toThrowError(/message array/);
  });
  test('rejects an unknown include value and an oversized body', () => {
    expect(() => parseWire(wrap('{"subject":"' + 'ab'.repeat(28) + '","include":["nope"]}'))).toThrowError(/include/);
    expect(() => parseWire('x'.repeat(70_000))).toThrowError(/too large/);
  });
  test('measures the body in bytes, not UTF-16 code units', () => {
    const body = 'é'.repeat(33_000); // 33,000 code units but 66,000 bytes on the wire
    expect(body.length).toBeLessThan(64 * 1024);
    expect(() => parseWire(body)).toThrowError(/request too large \(66000 bytes, max 65536\)/);
  });
  test('requires the single wire message to have role user', () => {
    const msg = (role: unknown) => JSON.stringify([{ content: '{"subject":"' + 'ab'.repeat(28) + '"}', role }]);
    expect(() => parseWire(msg('assistant'))).toThrowError(expect.objectContaining({ status: 400, message: expect.stringMatching(/role/) }));
    expect(() => parseWire(msg(undefined))).toThrowError(expect.objectContaining({ status: 400, message: expect.stringMatching(/role/) }));
    expect(parseWire(msg('user')).subject).toBe('ab'.repeat(28));
  });
});
