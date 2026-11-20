// packages/usecase-kit/test/fault/result-data.test.ts: the result of a job is JSON data. `withFaultMode` copies it with the JSON walk of the protocol, so job code cannot keep the field out of the JSON
// that leaves the service, cannot write another value there, and cannot make an `async` function give the caller something else. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { checkFaultMode, readFaultSwitch, withFaultMode, withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';

const faulty = readFaultSwitch('order-desk', 'confirm_wrong_lot');
const clean = readFaultSwitch('order-desk', '');
const base = { schema: 'vector.usecase.order-confirmation.v1', outcome: 'done', po_number: 'po-1' };

/** What leaves the service: the JSON text of the value that a handler returns, read back. */
const wire = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));

/** An object with this many levels of objects, the outer one included. */
function nested(levels: number): object {
  let value: object = { leaf: 1 };
  for (let level = 1; level < levels; level += 1) value = { next: value };
  return value;
}

describe('a result that can change what leaves the service', () => {
  it('refuses a toJSON that leaves fault_mode out of the JSON, and takes the same result without it', () => {
    const dropping = { ...base, toJSON(this: Record<string, unknown>) { const { fault_mode: _field, toJSON: _self, ...rest } = this; return rest; } };
    expect(() => withFaultMode(faulty, dropping)).toThrow(TypeError);
    expect(() => withFaultMode(faulty, dropping)).toThrow('result.toJSON is not JSON data');
    expect(wire(withFaultMode(faulty, base)).fault_mode).toBe('confirm_wrong_lot');
  });

  it('refuses a toJSON that writes the empty text while a fault is on, so a clean-run check cannot pass the JSON', async () => {
    const rewriting = { ...base, toJSON(this: Record<string, unknown>) { const { toJSON: _self, ...rest } = this; return { ...rest, fault_mode: '' }; } };
    await expect(withFaultModeJob(faulty, () => rewriting)()).rejects.toThrow('result.toJSON is not JSON data');
    const sent = wire(await withFaultModeJob(faulty, () => base)());
    expect(checkFaultMode('order-desk', '', sent)).toMatchObject({ ok: false, code: 'fault_set' });
    expect(checkFaultMode('order-desk', 'confirm_wrong_lot', sent)).toStrictEqual({ ok: true, value: 'confirm_wrong_lot' });
  });

  it('refuses a then that is a function, because an async handler would give the caller the value of then, and takes a then that is data', async () => {
    const thenable = { ...base, then(resolve: (value: unknown) => void) { resolve({ ...base }); } };
    expect(() => withFaultMode(faulty, thenable)).toThrow('result.then is not JSON data');
    const handler = async () => withFaultMode(faulty, { ...base, then: 'later', toJSON: 'data' });
    const got = await handler();
    expect(Object.hasOwn(got, 'fault_mode')).toBe(true);
    expect(got.fault_mode).toBe('confirm_wrong_lot');
    expect(wire(got)).toStrictEqual({ ...base, then: 'later', toJSON: 'data', fault_mode: 'confirm_wrong_lot' });
  });

  it('refuses a then that is a getter, also in a wrapped job: the walk reads the descriptor and runs no getter', async () => {
    let reads = 0;
    const result = { ...base, get then() { reads += 1; return reads === 1 ? undefined : (resolve: (value: unknown) => void) => resolve({ ...base, fault_mode: '' }); } };
    await expect(withFaultModeJob(faulty, () => result)()).rejects.toThrow('result.then is an accessor, which is not allowed');
    // The await of the job reads `then` one time, as it does for any value. The walk reads none.
    expect(reads).toBe(1);
  });
});

describe('a result that is not plain JSON data', () => {
  const NOT_DATA: [string, () => object][] = [
    ['an accessor fault_mode', () => Object.defineProperty({ ...base }, 'fault_mode', { get: () => '', enumerable: true })],
    ['a fault_mode that is not enumerable', () => Object.defineProperty({ ...base }, 'fault_mode', { value: '', enumerable: false })],
    ['a member with the value undefined', () => ({ ...base, reason: undefined })],
    ['a number that is not finite', () => ({ ...base, quantity: Number.NaN })],
    ['a bigint', () => ({ ...base, quantity: 5n })],
    ['a date', () => ({ ...base, at: new Date(0) })],
    ['a function', () => ({ ...base, run: () => 1 })],
    ['a getter inside a member', () => ({ ...base, lines: [{ get sku() { return 'x'; } }] })],
    ['a key that is a symbol', () => ({ ...base, [Symbol('key')]: 1 })],
    ['a key that is a whole number', () => ({ ...base, 7: 'seven' })],
    ['a member named __proto__', () => JSON.parse('{"__proto__":{"polluted":true},"outcome":"failed"}')],
    ['a member nested deeper than 32 levels', () => nested(33)],
    ['an object of a class', () => new (class Box { value = 1; })()],
  ];

  it.each(NOT_DATA)('refuses %s, and the wrapped job fails: no result leaves without the field', async (_name, make) => {
    expect(() => withFaultMode(faulty, make()), _name).toThrow(TypeError);
    await expect(withFaultModeJob(faulty, make)(), _name).rejects.toThrow(TypeError);
  });

  it('refuses a promise that is given to withFaultMode, and the wrapped job awaits a promise of a result: the twin', async () => {
    expect(() => withFaultMode(faulty, Promise.resolve(base))).toThrow(TypeError);
    expect((await withFaultModeJob(faulty, () => Promise.resolve(base))()).fault_mode).toBe('confirm_wrong_lot');
  });

  it('takes the same kinds of result as plain data: a null, a boolean, a number, a text, arrays and objects, and an object with no prototype', () => {
    const data = { ...base, reason: null, flag: true, quantity: 3.5, lines: [{ sku: 'SKU-1', n: 1 }, []], then: 'later', toJSON: 'data', fault_mode: 'invert_scores' };
    expect(wire(withFaultMode(faulty, data))).toStrictEqual({ ...data, fault_mode: 'confirm_wrong_lot' });
    expect(withFaultMode(faulty, nested(32))).toMatchObject({ fault_mode: 'confirm_wrong_lot' });
    expect(withFaultMode(faulty, Object.assign(Object.create(null) as Record<string, unknown>, base)).fault_mode).toBe('confirm_wrong_lot');
  });

  it('copies the result: the output shares no object with the input, and a change of the input after the call does not change the output', () => {
    const input = { ...base, lines: [{ sku: 'SKU-1' }] };
    const out = withFaultMode(faulty, input);
    input.lines[0].sku = 'SKU-2';
    input.lines.push({ sku: 'SKU-3' });
    expect(wire(out).lines).toStrictEqual([{ sku: 'SKU-1' }]);
    expect(out).not.toBe(input);
  });
});

// A small deterministic generator, so that the test is the same on every run.
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLAIN_KEYS = ['outcome', 'reason', 'item', 'a', 'é', 'fault_mode', 'note'];
const ODD_KEYS = ['toJSON', 'then', '__proto__', '7', 'e\u0301', 'valueOf', 'constructor'];

function plainValue(next: () => number, depth: number): unknown {
  const roll = Math.floor(next() * 8);
  if (roll === 0) return null;
  if (roll === 1) return true;
  if (roll === 2) return Math.floor(next() * 1000) / 8;
  if (roll === 3) return 'text';
  if (roll === 4) return 'confirm_wrong_lot';
  if (roll === 5) return '';
  if (roll === 6) return depth < 3 ? randomResult(next, depth + 1) : null;
  return depth < 3 ? [plainValue(next, depth + 1), plainValue(next, depth + 1)] : [];
}

function oddValue(next: () => number): unknown {
  const odd: unknown[] = [undefined, () => 'x', 5n, new Date(0), Symbol('s'), new Map(), Promise.resolve(1), { get g() { return 1; } }, Object.create(null), new (class Box { value = 1; })(), Number.NaN, Number.POSITIVE_INFINITY];
  return odd[Math.floor(next() * odd.length)];
}

/** A result of 1 to 5 members. Most members are plain. Some keys, values and kinds of member are the ones that a hostile or careless job can use. */
function randomResult(next: () => number, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const count = 1 + Math.floor(next() * 5);
  for (let index = 0; index < count; index += 1) {
    const keys = next() < 0.8 ? PLAIN_KEYS : ODD_KEYS;
    const key = keys[Math.floor(next() * keys.length)];
    const value = next() < 0.8 ? plainValue(next, depth) : oddValue(next);
    const kind = next();
    if (kind < 0.06) Object.defineProperty(out, key, { get: () => value, enumerable: true, configurable: true });
    else if (kind < 0.12) Object.defineProperty(out, key, { value, enumerable: false, configurable: true, writable: true });
    else Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

describe('the invariant, over many results', () => {
  it('gives, for every result that withFaultMode returns, a JSON text whose fault_mode is the mode of the switch, as the last member, also after an async return', async () => {
    const next = generator(20261120);
    const switches: FaultSwitch[] = [clean, faulty, readFaultSwitch('bid-desk', 'quote_off_price_list'), readFaultSwitch('reorder-agent', '')];
    let returned = 0;
    let refused = 0;
    for (let count = 0; count < 800; count += 1) {
      const input = randomResult(next);
      for (const fault of switches) {
        let out: Record<string, unknown> & { fault_mode: unknown };
        try {
          out = withFaultMode(fault, input);
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          refused += 1;
          continue;
        }
        returned += 1;
        const text = JSON.stringify(out);
        expect(JSON.parse(text).fault_mode, text).toBe(fault.mode);
        expect(Object.keys(out).at(-1), text).toBe('fault_mode');
        expect(Object.getPrototypeOf(out), text).toBe(Object.prototype);
        expect((await (async () => out)()).fault_mode, text).toBe(fault.mode);
      }
    }
    // The generator makes both: results that pass and results that the walk refuses.
    expect(returned).toBeGreaterThan(200);
    expect(refused).toBeGreaterThan(200);
  });
});
