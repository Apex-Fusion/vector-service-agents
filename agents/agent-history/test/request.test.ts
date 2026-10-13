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
});
