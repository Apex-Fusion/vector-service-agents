// packages/usecase-kit/test/fault/switch-origin.test.ts: a function that takes a switch accepts only a switch that `readFaultSwitch` made. A hand-made object is refused, also a frozen one with the
// right members, because an object of another origin can have a getter that gives another value at the next read. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { readFaultSwitch, withFaultMode, withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';

const real = readFaultSwitch('order-desk', 'confirm_wrong_lot');
const result = { outcome: 'done' };

let getterReads = 0;
const withGetter = { kind: 'order-desk', get mode() { getterReads += 1; return getterReads === 1 ? 'confirm_wrong_lot' : ''; } };

const MADE_BY_HAND: [string, unknown][] = [
  ['a frozen object with the right members', Object.freeze({ kind: 'order-desk', mode: 'confirm_wrong_lot' })],
  ['an object with the right members that is not frozen', { kind: 'order-desk', mode: 'confirm_wrong_lot' }],
  ['a copy of a real switch', { ...real }],
  ['a frozen copy of a real switch', Object.freeze({ ...real })],
  ['a clone of a real switch', structuredClone(real)],
  ['an object that inherits from a real switch', Object.create(real)],
  ['a Proxy of a real switch', new Proxy(real, {})],
  ['an object with a getter for mode that gives another value at the second read', withGetter],
  ['an object with the right members and the right prototype chain, made with Object.create', Object.create(null, { kind: { value: 'order-desk', enumerable: true }, mode: { value: '', enumerable: true } })],
];

describe('a switch that readFaultSwitch did not make', () => {
  it.each(MADE_BY_HAND)('is refused by withFaultMode and by withFaultModeJob: %s', (_name, value) => {
    expect(() => withFaultMode(value as FaultSwitch, result), _name).toThrow('the fault switch is not a switch that readFaultSwitch made');
    expect(() => withFaultModeJob(value as FaultSwitch, () => result), _name).toThrow(TypeError);
  });

  it('is refused without a read of its members: no getter of it runs', () => {
    getterReads = 0;
    expect(() => withFaultMode(withGetter as unknown as FaultSwitch, result)).toThrow(TypeError);
    expect(() => withFaultModeJob(withGetter as unknown as FaultSwitch, () => result)).toThrow(TypeError);
    expect(getterReads).toBe(0);
  });

  it('is never changed into a real switch by what it says: the value of a copy does not matter', () => {
    const copy = { ...readFaultSwitch('order-desk', '') };
    expect(() => withFaultMode(copy as unknown as FaultSwitch, result)).toThrow(TypeError);
    expect(withFaultMode(readFaultSwitch('order-desk', ''), result).fault_mode).toBe('');
  });
});

describe('a switch that readFaultSwitch made', () => {
  it('is accepted by withFaultMode and by withFaultModeJob, each time it is used', async () => {
    expect(withFaultMode(real, result).fault_mode).toBe('confirm_wrong_lot');
    expect(withFaultMode(real, result).fault_mode).toBe('confirm_wrong_lot');
    const job = withFaultModeJob(real, () => result);
    expect((await job()).fault_mode).toBe('confirm_wrong_lot');
    expect((await job()).fault_mode).toBe('confirm_wrong_lot');
  });

  it('is a different switch for each call, and each one is accepted on its own', () => {
    const one = readFaultSwitch('bid-desk', 'quote_off_price_list');
    const other = readFaultSwitch('bid-desk', 'quote_off_price_list');
    expect(one).not.toBe(other);
    expect(withFaultMode(one, result).fault_mode).toBe('quote_off_price_list');
    expect(withFaultMode(other, result).fault_mode).toBe('quote_off_price_list');
  });
});
