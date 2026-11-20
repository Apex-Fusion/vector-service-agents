// packages/usecase-kit/test/fault/setting.test.ts: the fault setting that a service reads one time at its start. Each refusal has an accepted twin.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { FAULT_MODE_VARIABLE, parseFaultSetting, readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { AGENT_KINDS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import type { AgentKind } from '@vsa/usecase-kit/protocol';

const WITH_VALUES = AGENT_KINDS.filter((kind) => FAULT_MODES[kind].length > 0);
const WITHOUT_VALUES = AGENT_KINDS.filter((kind) => FAULT_MODES[kind].length === 0);
const ALL_VALUES: readonly string[] = AGENT_KINDS.flatMap((kind) => [...FAULT_MODES[kind]]);

function startError(kind: AgentKind, value: unknown): string {
  try {
    readFaultSwitch(kind, value);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`${kind} started with ${JSON.stringify(value)}`);
}

describe('the setting', () => {
  it('is named FAULT_MODE', () => {
    expect(FAULT_MODE_VARIABLE).toBe('FAULT_MODE');
  });
});

describe('readFaultSwitch: no fault', () => {
  it.each(AGENT_KINDS)('reads a setting that is not set, and the empty setting, as no fault for %s', (kind) => {
    expect(readFaultSwitch(kind, undefined).mode).toBe('');
    expect(readFaultSwitch(kind, '').mode).toBe('');
    expect(readFaultSwitch(kind, undefined).kind).toBe(kind);
  });

  it('reads a value that is not empty as a fault: the twin of the empty setting', () => {
    for (const kind of WITH_VALUES) for (const value of FAULT_MODES[kind]) expect(readFaultSwitch(kind, value).mode).toBe(value);
  });
});

describe('readFaultSwitch: a value that stops the start', () => {
  it.each(['true', 'false', '1', '0', 'none', 'off', 'null', 'confirm_wrong_lott', 'constructor', '__proto__', 'toString'])('stops every kind for the unknown value %j', (value) => {
    for (const kind of AGENT_KINDS) expect(() => readFaultSwitch(kind, value), `${kind} ${value}`).toThrow(/FAULT_MODE/);
  });

  it('stops each kind for the fault value of every other kind', () => {
    for (const kind of AGENT_KINDS) {
      const own = FAULT_MODES[kind] as readonly string[];
      for (const value of ALL_VALUES.filter((name) => !own.includes(name))) expect(() => readFaultSwitch(kind, value), `${kind} ${value}`).toThrow(/FAULT_MODE/);
    }
  });

  it('names the variable and the allowed values in the error', () => {
    expect(startError('order-desk', 'alter_after_approval')).toBe('environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk, got "alter_after_approval"');
    expect(startError('bid-desk', 'confirm_wrong_lot')).toBe('environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got "confirm_wrong_lot"');
  });

  it('says that a kind with no fault value allows the empty setting only', () => {
    for (const kind of WITHOUT_VALUES) {
      expect(startError(kind, 'invert_scores')).toBe(`environment variable FAULT_MODE must be empty (${kind} has no fault value) for ${kind}, got "invert_scores"`);
    }
  });

  it.each([' ', ' confirm_wrong_lot', 'confirm_wrong_lot ', 'confirm_wrong_lot\n', '\tconfirm_wrong_lot', 'CONFIRM_WRONG_LOT', 'Confirm_Wrong_Lot', 'confirm-wrong-lot'])(
    'stops for %j: a fault value is read exactly, and a space around it is not removed',
    (value) => {
      expect(() => readFaultSwitch('order-desk', value)).toThrow(/FAULT_MODE/);
    },
  );

  it.each([null, 0, 1, false, true, {}, [], ['confirm_wrong_lot'], 12n, Symbol('x')])('stops for the value %s that is not a text: it is never read as no fault', (value) => {
    expect(() => readFaultSwitch('order-desk', value)).toThrow(/FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk, got a value of type/);
    expect(() => readFaultSwitch('reorder-agent', value)).toThrow(/FAULT_MODE/);
  });

  it('shows a short plain value, so that an operator finds the typing error', () => {
    expect(startError('order-desk', 'confirm_wrong_lott')).toContain('got "confirm_wrong_lott"');
  });

  it('never repeats a long value or a value that looks like a key', () => {
    const key = 'ab'.repeat(32);
    const long = `confirm_wrong_lot_${'x'.repeat(40)}`;
    // The last value is short, and it still has a run of 20 hex characters: a short key must not be shown either.
    for (const value of [key, long, `x${key}`, 'ab'.repeat(10), `x${'0'.repeat(20)}`]) {
      const message = startError('order-desk', value);
      expect(message, value).not.toContain(value);
      expect(message, value).not.toContain(key);
      expect(message, value).toContain(`got ${value.length} characters`);
    }
  });

  it('shows a short value with a run of 19 hex characters: the twin of the key-like values', () => {
    expect(startError('order-desk', 'abcdef0123456789abc')).toContain('got "abcdef0123456789abc"');
  });

  it('stops for a kind that is not a kind of agent, also with the empty setting', () => {
    for (const kind of ['', 'order_desk', 'constructor', '__proto__', 'toString', undefined, 7]) {
      expect(() => readFaultSwitch(kind as unknown as AgentKind, ''), String(kind)).toThrow(/kind of agent/);
      expect(() => readFaultSwitch(kind as unknown as AgentKind, 'confirm_wrong_lot'), String(kind)).toThrow(/kind of agent/);
    }
  });
});

describe('the switch', () => {
  it('is frozen: its value cannot change in the life of the process', () => {
    const fault = readFaultSwitch('order-desk', 'confirm_wrong_lot');
    expect(Object.isFrozen(fault)).toBe(true);
    expect(Reflect.set(fault, 'mode', '')).toBe(false);
    expect(Reflect.set(fault, 'kind', 'bid-desk')).toBe(false);
    expect(Reflect.deleteProperty(fault, 'mode')).toBe(false);
    expect(Reflect.defineProperty(fault, 'mode', { value: '' })).toBe(false);
    expect(fault).toStrictEqual({ kind: 'order-desk', mode: 'confirm_wrong_lot' });
  });

  it('keeps the value of the start when the environment changes later', () => {
    const env: Record<string, string | undefined> = { FAULT_MODE: 'confirm_wrong_lot' };
    const fault = readFaultSwitch('order-desk', env.FAULT_MODE);
    env.FAULT_MODE = '';
    expect(fault.mode).toBe('confirm_wrong_lot');
    const clean = readFaultSwitch('order-desk', env.FAULT_MODE);
    env.FAULT_MODE = 'confirm_wrong_lot';
    expect(clean.mode).toBe('');
  });

  it('has the type of its kind', () => {
    const orderDesk = readFaultSwitch('order-desk', '');
    const reorder = readFaultSwitch('reorder-agent', '');
    expectTypeOf(orderDesk.mode).toEqualTypeOf<'' | 'confirm_wrong_lot'>();
    expectTypeOf(reorder.mode).toEqualTypeOf<''>();
    expectTypeOf(orderDesk).toExtend<FaultSwitch>();
    // @ts-expect-error the mode of an order desk is never the fault value of another kind
    const wrong: boolean = orderDesk.mode === 'invert_scores';
    // @ts-expect-error an agent with no fault value has no value to compare with
    const none: boolean = reorder.mode === 'confirm_wrong_lot';
    expect(orderDesk.mode === 'confirm_wrong_lot').toBe(false);
    expect([wrong, none]).toHaveLength(2);
  });

  it('is not an object that a caller writes by hand', () => {
    // @ts-expect-error only readFaultSwitch makes a switch
    const byHand: FaultSwitch<'order-desk'> = { kind: 'order-desk', mode: 'confirm_wrong_lot' };
    expect(byHand.mode).toBe('confirm_wrong_lot');
  });
});

describe('parseFaultSetting', () => {
  it('gives a typed result and never throws', () => {
    expect(parseFaultSetting('order-desk', undefined)).toStrictEqual({ ok: true, value: '' });
    expect(parseFaultSetting('order-desk', '')).toStrictEqual({ ok: true, value: '' });
    expect(parseFaultSetting('order-desk', 'confirm_wrong_lot')).toStrictEqual({ ok: true, value: 'confirm_wrong_lot' });
    const refused = parseFaultSetting('order-desk', 'invert_scores');
    expect(refused).toStrictEqual({
      ok: false,
      code: 'bad_fault_mode',
      detail: 'environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk, got "invert_scores"',
    });
    expect(parseFaultSetting('nobody' as AgentKind, '')).toMatchObject({ ok: false, code: 'bad_input' });
  });
});
