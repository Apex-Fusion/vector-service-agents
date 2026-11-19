import { describe, expect, it } from 'vitest';
import { duration, iso, jsonSafe, units } from '../lib/format.ts';

describe('units', () => {
  it('writes lovelace as units with six decimals', () => {
    expect(units(0n)).toBe('0.000000 units');
    expect(units(1n)).toBe('0.000001 units');
    expect(units(1_500_000n)).toBe('1.500000 units');
    expect(units(123_456_789_012n)).toBe('123456.789012 units');
  });
  it('writes a negative amount with its sign', () => {
    expect(units(-2_000_001n)).toBe('-2.000001 units');
  });
});

describe('duration', () => {
  it('writes the biggest parts first', () => {
    expect(duration(0)).toBe('0 s');
    expect(duration(59_000)).toBe('59 s');
    expect(duration(61_000)).toBe('1 min 1 s');
    expect(duration(3_600_000)).toBe('1 h');
    expect(duration(3_725_000)).toBe('1 h 2 min 5 s');
    expect(duration(90 * 86_400_000)).toBe('90 days');
  });
  it('rounds a part of a second up, so that a wait is never too short', () => {
    expect(duration(1)).toBe('1 s');
    expect(duration(1_001)).toBe('2 s');
  });
});

describe('iso', () => {
  it('writes POSIX milliseconds as a UTC time with a Z', () => {
    expect(iso(Date.UTC(2026, 10, 19, 12, 0, 0))).toBe('2026-11-19T12:00:00.000Z');
  });
  it('gives the number back for a time that no date can show', () => {
    expect(iso(8.64e15 + 1)).toBe(String(8.64e15 + 1));
  });
});

describe('jsonSafe', () => {
  it('turns a bigint into its decimal text, at any depth, and leaves the rest', () => {
    expect(jsonSafe({ a: 1n, b: [2n, { c: 3n }], d: 'x', e: null, f: 4 })).toEqual({ a: '1', b: ['2', { c: '3' }], d: 'x', e: null, f: 4 });
  });
  it('drops a member that is undefined', () => {
    expect(JSON.stringify(jsonSafe({ a: undefined, b: 1 }))).toBe('{"b":1}');
  });
  it('can be written as JSON', () => {
    expect(() => JSON.stringify(jsonSafe({ a: 10n ** 30n }))).not.toThrow();
  });
});
