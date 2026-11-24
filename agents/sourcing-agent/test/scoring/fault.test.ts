// The sourcing fault changes only the first score when the switch selects `invert_scores`. It reads the switch once.
import type { ScoreChoice } from '@vsa/usecase-kit/bids';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { describe, expect, it } from 'vitest';
import { scoreFaultOf } from '../../src/scoring/fault.ts';

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
