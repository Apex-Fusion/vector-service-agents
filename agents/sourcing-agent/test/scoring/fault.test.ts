// agents/sourcing-agent/test/scoring/fault.test.ts: the fault `invert_scores`. The review question: is the fault ever on with an empty setting, with another text, or for a scorer that is not the first, and is the
// switch read more than one time? The reversal is made on the decimal text of a number, so the evidence of a failure run shows exact decimals.
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { describe, expect, it } from 'vitest';
import { reversedChoice, reversedOf, scoreFaultOf } from '../../src/scoring/fault.ts';
import type { ScoreChoice } from '../../src/scoring/ports.ts';

const CHOICE: ScoreChoice = { components: { price: 87.5, lead_time: 82.5, reliability: 85, compliance: 100 }, score: 88.5 };
const REVERSED: ScoreChoice = { components: { price: 12.5, lead_time: 17.5, reliability: 15, compliance: 0 }, score: 11.5 };

/** A switch that a caller made by hand, with a getter that counts the reads of `mode`. The kit makes the real ones, and a test of the reads needs one that counts. */
function counting(mode: string): { fault: FaultSwitch<'sourcing-agent'>; reads: () => number } {
  let reads = 0;
  const fault = {
    kind: 'sourcing-agent',
    get mode() {
      reads += 1;
      return mode;
    },
  } as unknown as FaultSwitch<'sourcing-agent'>;
  return { fault, reads: () => reads };
}

describe('the reversal of a score', () => {
  it('is exact in decimals where a subtraction of floats is not: 80.2 gives 19.8', () => {
    expect(100 - 80.2).toBe(19.799999999999997);
    expect(reversedOf(80.2)).toBe(19.8);
    expect(JSON.stringify(reversedOf(80.2))).toBe('19.8');
  });

  it.each([
    [0, 100],
    [100, 0],
    [50, 50],
    [7, 93],
    [87.5, 12.5],
    [0.1, 99.9],
    [0.01, 99.99],
    [99.99, 0.01],
    [99.9, 0.1],
    [33.33, 66.67],
    [12.345, 87.655],
    [70.1, 29.9],
    [61.7, 38.3],
    [0.07, 99.93],
    [1e-7, 99.9999999],
    [1.5e-7, 99.99999985],
    [0.30000000000000004, 99.7],
  ])('gives 100 minus %s as %s', (value, expected) => {
    expect(reversedOf(value)).toBe(expected);
    expect(JSON.stringify(reversedOf(value))).toBe(JSON.stringify(expected));
  });

  it('is exact for every score with up to 4 decimals that a sample of 4,000 numbers holds, and it is its own inverse', () => {
    for (let at = 0; at < 4_000; at += 1) {
      const units = (at * 7_919) % 1_000_001;
      const value = units / 10_000;
      expect(reversedOf(value)).toBe((1_000_000 - units) / 10_000);
      expect(reversedOf(reversedOf(value))).toBe(value);
    }
  });

  it('reads the number minus zero as 0', () => {
    expect(reversedOf(-0)).toBe(100);
  });

  it.each([-1, -0.0001, 100.0001, 101, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null, undefined, 5n])('refuses %s: a caller reverses a score that it checked', (value) => {
    expect(() => reversedOf(value as number)).toThrow(RangeError);
  });

  it('reverses the four components and the score of a choice, and changes nothing of the choice that it was given', () => {
    const given = Object.freeze({ components: Object.freeze({ ...CHOICE.components }), score: CHOICE.score });
    const reversed = reversedChoice(given);
    expect(reversed).toStrictEqual(REVERSED);
    expect(reversed).not.toBe(given);
    expect(reversed.components).not.toBe(given.components);
    expect(given).toStrictEqual(CHOICE);
    const decimals = reversedChoice({ components: { price: 80.2, lead_time: 70.1, reliability: 99.9, compliance: 0.3 }, score: 61.7 });
    expect(decimals).toStrictEqual({ components: { price: 19.8, lead_time: 29.9, reliability: 0.1, compliance: 99.7 }, score: 38.3 });
  });
});

describe('the fault of a scoring', () => {
  it('reverses exactly the four components and the score of the first subject, and nothing of the second and the third', () => {
    const apply = scoreFaultOf(readFaultSwitch('sourcing-agent', 'invert_scores'));
    const first = apply(0, CHOICE);
    expect(first).toStrictEqual(REVERSED);
    expect(Object.keys(first)).toStrictEqual(['components', 'score']);
    expect(Object.keys(first.components)).toStrictEqual(['price', 'lead_time', 'reliability', 'compliance']);
    for (const member of ['price', 'lead_time', 'reliability', 'compliance'] as const) expect(first.components[member]).not.toBe(CHOICE.components[member]);
    expect(first.score).not.toBe(CHOICE.score);
    expect(apply(1, CHOICE)).toBe(CHOICE);
    expect(apply(2, CHOICE)).toBe(CHOICE);
  });

  it('changes nothing with the empty setting, for each subject: the twin', () => {
    const apply = scoreFaultOf(readFaultSwitch('sourcing-agent', ''));
    for (const index of [0, 1, 2]) expect(apply(index, CHOICE)).toBe(CHOICE);
    const unset = scoreFaultOf(readFaultSwitch('sourcing-agent', undefined));
    expect(unset(0, CHOICE)).toBe(CHOICE);
  });

  it.each(['invert', 'INVERT_SCORES', ' invert_scores', 'invert_scores ', 'invert_scores\n', 'confirm_wrong_lot', 'true', '1', 'invert-scores'])('changes nothing for the setting %j, which is not the value', (mode) => {
    const apply = scoreFaultOf(counting(mode).fault);
    for (const index of [0, 1, 2]) expect(apply(index, CHOICE)).toBe(CHOICE);
  });

  it('turns on for the value of a switch that a caller made by hand, and for no setting that is not a text', () => {
    expect(scoreFaultOf(counting('invert_scores').fault)(0, CHOICE)).toStrictEqual(REVERSED);
    for (const mode of [true, 1, null, undefined, ['invert_scores'], { toString: () => 'invert_scores' }]) {
      const fault = { kind: 'sourcing-agent', mode } as unknown as FaultSwitch<'sourcing-agent'>;
      expect(scoreFaultOf(fault)(0, CHOICE)).toBe(CHOICE);
    }
  });

  it('reads the switch one time, however many answers the fault is applied to', () => {
    const switchWithCount = counting('invert_scores');
    const apply = scoreFaultOf(switchWithCount.fault);
    expect(switchWithCount.reads()).toBe(1);
    for (let round = 0; round < 5; round += 1) for (const index of [0, 1, 2]) apply(index, CHOICE);
    expect(switchWithCount.reads()).toBe(1);
  });

  it('keeps the value that it read when the switch changes later', () => {
    let mode = 'invert_scores';
    const fault = {
      kind: 'sourcing-agent',
      get mode() {
        return mode;
      },
    } as unknown as FaultSwitch<'sourcing-agent'>;
    const apply = scoreFaultOf(fault);
    mode = '';
    expect(apply(0, CHOICE)).toStrictEqual(REVERSED);
    const clean = scoreFaultOf(fault);
    mode = 'invert_scores';
    expect(clean(0, CHOICE)).toBe(CHOICE);
  });
});
