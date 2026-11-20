// packages/usecase-kit/test/fault/stamp.test.ts: the field `fault_mode` of every result. A helper adds it, so that no job code can leave it out or write another value. The evidence writer reads it
// back, and a result with no field is never read as a clean result. Each refusal has an accepted twin.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { checkFaultMode, readFaultMode, readFaultSwitch, withFaultMode, withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { AgentKind, ExecuteResult, FailedResult } from '@vsa/usecase-kit/protocol';

const clean = readFaultSwitch('order-desk', '');
const faulty = readFaultSwitch('order-desk', 'confirm_wrong_lot');

const failed = {
  schema: 'vector.usecase.result.v1',
  use_case: 'inventory-reorder',
  proposal_digest: 'ab'.repeat(32),
  handoff: null,
  writes: [],
  decisions: [],
  outcome: 'failed',
  reason: 'deadline',
  challenge: null,
  exit_state: 'Failed',
} as const;
const completed = { ...failed, outcome: 'completed', reason: null, exit_state: 'Completed' } as const;

describe('withFaultMode', () => {
  it('adds the active value to a result, and the empty value in a clean run', () => {
    expect(withFaultMode(faulty, completed).fault_mode).toBe('confirm_wrong_lot');
    expect(withFaultMode(clean, completed).fault_mode).toBe('');
  });

  it('adds the field to a result of a job that failed, as it does to any other result', () => {
    expect(withFaultMode(faulty, failed)).toStrictEqual({ ...failed, fault_mode: 'confirm_wrong_lot' });
    expect(withFaultMode(clean, failed)).toStrictEqual({ ...failed, fault_mode: '' });
  });

  it('drops a value that the job wrote: job code can neither hide a fault that is on nor show one that is off', () => {
    expect(withFaultMode(faulty, { ...completed, fault_mode: '' }).fault_mode).toBe('confirm_wrong_lot');
    expect(withFaultMode(clean, { ...completed, fault_mode: 'confirm_wrong_lot' }).fault_mode).toBe('');
    expect(withFaultMode(clean, { ...completed, fault_mode: 'anything' }).fault_mode).toBe('');
  });

  it('keeps every other member as it was, and puts fault_mode last', () => {
    const out = withFaultMode(faulty, { fault_mode: '', ...completed });
    expect(Object.keys(out)).toStrictEqual([...Object.keys(completed), 'fault_mode']);
    expect(JSON.stringify(out)).toBe(JSON.stringify({ ...completed, fault_mode: 'confirm_wrong_lot' }));
  });

  it('returns a new object and leaves the result of the job as it was', () => {
    const own = Object.freeze({ ...completed });
    const out = withFaultMode(faulty, own);
    expect(out).not.toBe(own);
    expect('fault_mode' in own).toBe(false);
  });

  it('refuses a result that is not a JSON object, and takes an object with no prototype: the twin', () => {
    for (const value of [null, undefined, [], [{ outcome: 'failed' }], 'text', 42, true, new Map(), new (class Result {})()]) {
      expect(() => withFaultMode(faulty, value as unknown as object), String(value)).toThrow(TypeError);
    }
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, completed);
    expect(withFaultMode(faulty, bare).fault_mode).toBe('confirm_wrong_lot');
  });

  it('refuses a switch that readFaultSwitch did not make well, so that a result never gets a missing or wrong value', () => {
    for (const bad of [undefined, null, {}, { kind: 'order-desk' }, { kind: 'order-desk', mode: 'invert_scores' }, { kind: 'nobody', mode: '' }, { mode: '' }, 'order-desk']) {
      expect(() => withFaultMode(bad as unknown as FaultSwitch, completed), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(withFaultMode(clean, completed).fault_mode).toBe('');
  });

  it('keeps a member named __proto__ as a member, and never changes the prototype of the result', () => {
    const parsed: object = JSON.parse('{"__proto__":{"polluted":true},"outcome":"failed"}');
    const out = withFaultMode(faulty, parsed);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toStrictEqual(['__proto__', 'outcome', 'fault_mode']);
    expect(Reflect.get(out, 'polluted')).toBeUndefined();
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
  });

  it('gives a type that the result types of the protocol take', () => {
    const typed: FailedResult = withFaultMode(faulty, failed);
    const result: ExecuteResult = withFaultMode(clean, completed);
    expectTypeOf(withFaultMode(faulty, failed).fault_mode).toEqualTypeOf<'' | 'confirm_wrong_lot'>();
    expectTypeOf(withFaultMode(readFaultSwitch('reorder-agent', ''), failed).fault_mode).toEqualTypeOf<''>();
    expect([typed.outcome, result.outcome]).toStrictEqual(['failed', 'completed']);
  });
});

describe('withFaultModeJob', () => {
  it('gives each result of the job the field, for a job that is sync and for a job that is async', async () => {
    const sync = withFaultModeJob(faulty, (): typeof completed => completed);
    const later = withFaultModeJob(faulty, (): Promise<typeof completed> => Promise.resolve(completed));
    expect((await sync()).fault_mode).toBe('confirm_wrong_lot');
    expect((await later()).fault_mode).toBe('confirm_wrong_lot');
    expect((await withFaultModeJob(clean, () => completed)()).fault_mode).toBe('');
  });

  it('passes the arguments of the call to the job', async () => {
    const seen: unknown[] = [];
    const job = withFaultModeJob(faulty, (op: string, n: number) => {
      seen.push(op, n);
      return { ...completed, op };
    });
    expect(await job('execute', 2)).toStrictEqual({ ...completed, op: 'execute', fault_mode: 'confirm_wrong_lot' });
    expect(seen).toStrictEqual(['execute', 2]);
  });

  it('gives the field to a result that ends in failure, on every return path of the job', async () => {
    const job = withFaultModeJob(faulty, (op: 'ok' | 'fail') => (op === 'ok' ? completed : failed));
    expect((await job('ok')).fault_mode).toBe('confirm_wrong_lot');
    expect((await job('fail')).fault_mode).toBe('confirm_wrong_lot');
    expect((await job('fail')).outcome).toBe('failed');
  });

  it('gives no result when the job throws, so no result lacks the field', async () => {
    const error = new Error('the job broke');
    await expect(withFaultModeJob(faulty, () => { throw error; })()).rejects.toBe(error);
    await expect(withFaultModeJob(faulty, () => Promise.reject(error))()).rejects.toBe(error);
  });

  it('refuses a job result that is not a JSON object', async () => {
    await expect(withFaultModeJob(faulty, () => 'done' as unknown as object)()).rejects.toThrow(TypeError);
  });

  it('refuses a switch that is not well formed when the job is wrapped, before any job runs', () => {
    let ran = false;
    expect(() => withFaultModeJob({} as unknown as FaultSwitch, () => { ran = true; return completed; })).toThrow(TypeError);
    expect(ran).toBe(false);
  });
});

describe('readFaultMode', () => {
  it('reads the empty value and the fault value of the kind from a result', () => {
    expect(readFaultMode('order-desk', { ...completed, fault_mode: '' })).toStrictEqual({ ok: true, value: '' });
    expect(readFaultMode('order-desk', { ...completed, fault_mode: 'confirm_wrong_lot' })).toStrictEqual({ ok: true, value: 'confirm_wrong_lot' });
    expect(readFaultMode('reorder-agent', { fault_mode: '' })).toStrictEqual({ ok: true, value: '' });
  });

  it('refuses a result with no fault_mode, and never reads it as no fault', () => {
    const missing = readFaultMode('order-desk', completed);
    expect(missing).toMatchObject({ ok: false, code: 'fault_mode_missing' });
    expect(readFaultMode('order-desk', withFaultMode(clean, completed))).toStrictEqual({ ok: true, value: '' });
  });

  it('refuses a value that the kind does not list, among them the fault value of another kind', () => {
    for (const value of ['invert_scores', 'alter_after_approval', 'quote_off_price_list', 'none', ' ', 'confirm_wrong_lot ']) {
      expect(readFaultMode('order-desk', { fault_mode: value }), value).toMatchObject({ ok: false, code: 'bad_fault_mode' });
    }
    expect(readFaultMode('reorder-agent', { fault_mode: 'confirm_wrong_lot' })).toMatchObject({ ok: false, code: 'bad_fault_mode' });
  });

  it('refuses a value that is not a text', () => {
    for (const value of [null, undefined, 0, false, true, {}, [], ['confirm_wrong_lot']]) {
      expect(readFaultMode('order-desk', { fault_mode: value }), String(value)).toMatchObject({ ok: false, code: 'bad_fault_mode' });
    }
  });

  it('refuses a result that is not a JSON object, the JSON text of a result, and an accessor member', () => {
    for (const value of [null, undefined, [], 'text', JSON.stringify({ fault_mode: '' }), 42]) {
      expect(readFaultMode('order-desk', value), String(value)).toMatchObject({ ok: false, code: 'bad_input' });
    }
    const getter = { get fault_mode(): string { return ''; } };
    expect(readFaultMode('order-desk', getter)).toMatchObject({ ok: false, code: 'bad_input' });
  });

  it('refuses a kind that is not a kind of agent', () => {
    expect(readFaultMode('nobody' as AgentKind, { fault_mode: '' })).toMatchObject({ ok: false, code: 'bad_input' });
  });

  it('never repeats a value that looks like a key', () => {
    const key = 'ab'.repeat(32);
    const result = readFaultMode('order-desk', { fault_mode: key });
    expect(result).toMatchObject({ ok: false, code: 'bad_fault_mode' });
    expect(JSON.stringify(result)).not.toContain(key);
  });
});

describe('checkFaultMode', () => {
  it('passes a clean result in a clean run, and a result with the expected fault in a fault run', () => {
    expect(checkFaultMode('order-desk', '', withFaultMode(clean, completed))).toStrictEqual({ ok: true, value: '' });
    expect(checkFaultMode('order-desk', 'confirm_wrong_lot', withFaultMode(faulty, completed))).toStrictEqual({ ok: true, value: 'confirm_wrong_lot' });
  });

  it('refuses a fault in a clean run', () => {
    const result = checkFaultMode('order-desk', '', withFaultMode(faulty, completed));
    expect(result).toStrictEqual({ ok: false, code: 'fault_set', detail: 'result has the fault value "confirm_wrong_lot", and this run expects no fault' });
  });

  it('refuses a result with no fault in a fault run', () => {
    const result = checkFaultMode('order-desk', 'confirm_wrong_lot', withFaultMode(clean, completed));
    expect(result).toStrictEqual({ ok: false, code: 'fault_missing', detail: 'result has no fault value, and this run expects "confirm_wrong_lot"' });
  });

  it('refuses the fault value of another kind in a fault run', () => {
    expect(checkFaultMode('order-desk', 'confirm_wrong_lot', { fault_mode: 'invert_scores' })).toMatchObject({ ok: false, code: 'bad_fault_mode' });
  });

  it('refuses a result with no field, in a clean run as well as in a fault run', () => {
    expect(checkFaultMode('order-desk', '', completed)).toMatchObject({ ok: false, code: 'fault_mode_missing' });
    expect(checkFaultMode('order-desk', 'confirm_wrong_lot', completed)).toMatchObject({ ok: false, code: 'fault_mode_missing' });
  });

  it('refuses an expected value that the kind does not list, and a kind that does not exist', () => {
    expect(checkFaultMode('order-desk', 'invert_scores' as never, withFaultMode(clean, completed))).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultMode('reorder-agent', 'confirm_wrong_lot' as never, withFaultMode(clean, completed))).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultMode('nobody' as AgentKind, '', { fault_mode: '' })).toMatchObject({ ok: false, code: 'bad_input' });
  });
});
