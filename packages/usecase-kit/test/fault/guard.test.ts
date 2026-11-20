// packages/usecase-kit/test/fault/guard.test.ts: the guards of a run script. A clean run refuses when a service that the script can see has a fault value. A fault run names the expected value and
// refuses when another value, or none, is active, and when another service has a fault. A guard never passes by default. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { checkCleanRun, checkFaultRun } from '@vsa/usecase-kit/fault';
import type { SeenService } from '@vsa/usecase-kit/fault';
import type { AgentKind } from '@vsa/usecase-kit/protocol';

/** The environment of a service. `fault` is the value of FAULT_MODE, and it is left out of the environment when it is undefined. */
const env = (fault?: unknown): Record<string, unknown> => ({ PATH: '/usr/bin', LLM_MAX_PRICE_LOVELACE: '200000', ...(fault === undefined ? {} : { FAULT_MODE: fault }) });
const service = (name: string, kind: AgentKind, fault?: unknown): SeenService => ({ service: name, kind, env: env(fault) });

/** The services of use case 1 (inventory reorder), as a script sees them. */
const run = (orderDesk?: unknown, reorder?: unknown): SeenService[] => [service('reorder-agent', 'reorder-agent', reorder), service('order-desk-small', 'order-desk', orderDesk)];

describe('checkCleanRun', () => {
  it('passes when FAULT_MODE is not set, or empty, in every service, and lists the setting of each', () => {
    const expected = { ok: true, value: [{ service: 'reorder-agent', kind: 'reorder-agent', mode: '' }, { service: 'order-desk-small', kind: 'order-desk', mode: '' }] };
    expect(checkCleanRun(run())).toStrictEqual(expected);
    expect(checkCleanRun(run('', ''))).toStrictEqual(expected);
  });

  it('refuses a fault value in a service that the script can see, and names the service', () => {
    expect(checkCleanRun(run('confirm_wrong_lot'))).toStrictEqual({
      ok: false,
      code: 'fault_set',
      detail: 'the service "order-desk-small" has the fault value "confirm_wrong_lot", and this run expects no fault',
    });
  });

  it('refuses a fault value in any one service of the list, also the last one and the first one', () => {
    const services = [service('a', 'reorder-agent'), service('b', 'order-desk'), service('c', 'prior-authorization-agent'), service('d', 'bid-desk')];
    expect(checkCleanRun(services)).toMatchObject({ ok: true });
    for (const index of [0, 1, 2, 3]) {
      const withFault = services.map((item, at) => (at === index ? { ...item, env: env('x') } : item));
      expect(checkCleanRun(withFault), `service ${index}`).toMatchObject({ ok: false, code: 'fault_set' });
    }
  });

  it('refuses every value that is not empty: also an unknown value, a value of another kind, and a space', () => {
    for (const value of ['true', '1', 'off', 'none', ' ', '\n', 'invert_scores', 'alter_after_approval', 'confirm_wrong_lot ', 'CONFIRM_WRONG_LOT']) {
      expect(checkCleanRun(run(value)), JSON.stringify(value)).toMatchObject({ ok: false, code: 'fault_set' });
    }
    expect(checkCleanRun(run('invert_scores', 'confirm_wrong_lot'))).toMatchObject({ ok: false, code: 'fault_set' });
  });

  it('refuses a value that is not a text: it is never read as no fault', () => {
    for (const value of [null, 0, 1, false, true, {}, [], ['']]) {
      expect(checkCleanRun(run(value)), JSON.stringify(value)).toMatchObject({ ok: false, code: 'bad_fault_mode' });
    }
  });

  it('refuses a service whose environment the script could not read, and passes the same service when it can', () => {
    expect(checkCleanRun([service('reorder-agent', 'reorder-agent'), { service: 'order-desk-small', kind: 'order-desk', env: null }])).toStrictEqual({
      ok: false,
      code: 'service_unreadable',
      detail: 'the script could not read the environment of the service "order-desk-small"',
    });
    expect(checkCleanRun(run())).toMatchObject({ ok: true });
    const getter = { get FAULT_MODE(): string { return ''; } };
    expect(checkCleanRun([{ service: 'x', kind: 'order-desk', env: getter }])).toMatchObject({ ok: false, code: 'service_unreadable' });
  });

  it('refuses a list with no service, because a guard that checks nothing must not pass', () => {
    expect(checkCleanRun([])).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkCleanRun(undefined as unknown as SeenService[])).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkCleanRun(null as unknown as SeenService[])).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkCleanRun('order-desk' as unknown as SeenService[])).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkCleanRun(run())).toMatchObject({ ok: true });
  });

  it('refuses a list that is not a list of services: a hole, a name twice, an empty name, a kind that does not exist, a wrong environment', () => {
    const bad: unknown[] = [
      [service('a', 'order-desk'), undefined],
      [service('a', 'order-desk'), service('a', 'bid-desk')],
      [service('', 'order-desk')],
      [service('a', 'nobody' as AgentKind)],
      [{ service: 'a', kind: 'order-desk', env: 'FAULT_MODE=' }],
      [{ service: 'a', kind: 'order-desk', env: [] }],
      [{ service: 'a', kind: 'order-desk' }],
      [{ kind: 'order-desk', env: env() }],
      [{ service: 7, kind: 'order-desk', env: env() }],
      [{ service: 'a', kind: 'order-desk', env: env(), extra: 1 }],
      [null],
    ];
    for (const services of bad) expect(checkCleanRun(services as SeenService[]), JSON.stringify(services)).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkCleanRun([service('a', 'order-desk'), service('b', 'bid-desk')])).toMatchObject({ ok: true });
  });

  it('reads only the variable FAULT_MODE of the environment, with its exact name', () => {
    const others = { fault_mode: 'x', FAULT_MODES: 'x', FAULT_MODE_FILE: 'x', MY_FAULT_MODE: 'x' };
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: others }])).toMatchObject({ ok: true });
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: { ...others, FAULT_MODE: 'x' } }])).toMatchObject({ ok: false, code: 'fault_set' });
  });

  it('reads the real environment of a process, as a script passes it', () => {
    const saved = process.env.FAULT_MODE;
    try {
      delete process.env.FAULT_MODE;
      expect(checkCleanRun([{ service: 'this-process', kind: 'order-desk', env: process.env }])).toMatchObject({ ok: true });
      process.env.FAULT_MODE = 'confirm_wrong_lot';
      expect(checkCleanRun([{ service: 'this-process', kind: 'order-desk', env: process.env }])).toMatchObject({ ok: false, code: 'fault_set' });
      expect(checkFaultRun([{ service: 'this-process', kind: 'order-desk', env: process.env }], { service: 'this-process', value: 'confirm_wrong_lot' })).toMatchObject({ ok: true });
    } finally {
      if (saved === undefined) delete process.env.FAULT_MODE;
      else process.env.FAULT_MODE = saved;
    }
  });

  it('refuses a FAULT_MODE that the environment inherits from a prototype, because it cannot tell the effective value as data', () => {
    for (const inherited of ['', 'confirm_wrong_lot']) {
      const layered = Object.create({ FAULT_MODE: inherited }) as Record<string, unknown>;
      expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: layered }]), inherited).toMatchObject({ ok: false, code: 'service_unreadable' });
    }
  });

  it('takes an environment with a prototype that has no FAULT_MODE, and reads its own FAULT_MODE: the twins', () => {
    const base = { PATH: '/usr/bin' };
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: Object.create(base) as Record<string, unknown> }])).toMatchObject({ ok: true });
    const own = Object.assign(Object.create(base) as Record<string, unknown>, { FAULT_MODE: 'confirm_wrong_lot' });
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: own }])).toMatchObject({ ok: false, code: 'fault_set' });
  });

  it('refuses an environment that cannot be read, and takes a FAULT_MODE that is set to undefined as not set', () => {
    const proxy = new Proxy({}, { has: () => { throw new Error('no'); } });
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: proxy }])).toMatchObject({ ok: false, code: 'service_unreadable' });
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: { FAULT_MODE: undefined } }])).toMatchObject({ ok: true });
  });

  it('never repeats a long value or a value that looks like a key, and cuts the name of a service', () => {
    const key = 'ab'.repeat(32);
    const result = checkCleanRun(run(key));
    expect(result).toMatchObject({ ok: false, code: 'fault_set' });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).toContain('64 characters');
    const odd = checkCleanRun([{ service: `x\n${'n'.repeat(500)}`, kind: 'order-desk', env: env('x') }]);
    expect(JSON.stringify(odd)).not.toContain('\\n');
    expect(odd).toStrictEqual({ ok: false, code: 'fault_set', detail: `the service "x?${'n'.repeat(58)}" has the fault value "x", and this run expects no fault` });
  });
});

describe('checkFaultRun', () => {
  const expected = { service: 'order-desk-small', value: 'confirm_wrong_lot' };

  it('passes when the named service has the expected value and no other service has a fault, and lists the settings', () => {
    expect(checkFaultRun(run('confirm_wrong_lot'), expected)).toStrictEqual({
      ok: true,
      value: [{ service: 'reorder-agent', kind: 'reorder-agent', mode: '' }, { service: 'order-desk-small', kind: 'order-desk', mode: 'confirm_wrong_lot' }],
    });
  });

  it('refuses when the named service has no fault: not set, and empty', () => {
    const missing = { ok: false, code: 'fault_missing', detail: 'the service "order-desk-small" has no fault value, and this run expects "confirm_wrong_lot"' };
    expect(checkFaultRun(run(), expected)).toStrictEqual(missing);
    expect(checkFaultRun(run(''), expected)).toStrictEqual(missing);
  });

  it('refuses when the named service has another value: a value of another kind, an unknown value, and a value with a space', () => {
    for (const value of ['alter_after_approval', 'invert_scores', 'true', 'confirm_wrong_lot ', ' confirm_wrong_lot', 'CONFIRM_WRONG_LOT', ' ']) {
      expect(checkFaultRun(run(value), expected), JSON.stringify(value)).toMatchObject({ ok: false, code: 'fault_differs' });
    }
    expect(checkFaultRun(run('alter_after_approval'), expected)).toStrictEqual({
      ok: false,
      code: 'fault_differs',
      detail: 'the service "order-desk-small" has the fault value "alter_after_approval", and this run expects "confirm_wrong_lot"',
    });
  });

  it('refuses when another service has a fault value, also when the named service is right', () => {
    expect(checkFaultRun(run('confirm_wrong_lot', 'invert_scores'), expected)).toStrictEqual({
      ok: false,
      code: 'fault_set',
      detail: 'the service "reorder-agent" has the fault value "invert_scores", and this run expects no fault',
    });
    expect(checkFaultRun(run('confirm_wrong_lot', ''), expected)).toMatchObject({ ok: true });
  });

  it('refuses a value that is not a text in the named service, and in another service', () => {
    expect(checkFaultRun(run(null), expected)).toMatchObject({ ok: false, code: 'bad_fault_mode' });
    expect(checkFaultRun(run('confirm_wrong_lot', false), expected)).toMatchObject({ ok: false, code: 'bad_fault_mode' });
  });

  it('refuses when the environment of a service could not be read, the named one or another', () => {
    expect(checkFaultRun([service('reorder-agent', 'reorder-agent'), { service: 'order-desk-small', kind: 'order-desk', env: null }], expected)).toMatchObject({ ok: false, code: 'service_unreadable' });
    expect(checkFaultRun([{ service: 'reorder-agent', kind: 'reorder-agent', env: null }, service('order-desk-small', 'order-desk', 'confirm_wrong_lot')], expected)).toMatchObject({
      ok: false,
      code: 'service_unreadable',
    });
  });

  it('refuses an expectation that the script cannot mean: a service that was not given, an empty value, a value that the kind does not list', () => {
    expect(checkFaultRun(run('confirm_wrong_lot'), { service: 'order-desk-large', value: 'confirm_wrong_lot' })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run('confirm_wrong_lot'), { service: 'order-desk-small', value: '' })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run('invert_scores'), { service: 'order-desk-small', value: 'invert_scores' })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run(), { service: 'reorder-agent', value: 'confirm_wrong_lot' })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run('confirm_wrong_lot'), { service: 'order-desk-small', value: 7 as unknown as string })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run('confirm_wrong_lot'), null as unknown as typeof expected)).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run(), undefined as unknown as typeof expected)).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run('confirm_wrong_lot'), { ...expected, note: 'extra' } as typeof expected)).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run('confirm_wrong_lot'), { service: 'order-desk-small' } as typeof expected)).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkFaultRun(run('confirm_wrong_lot'), expected)).toMatchObject({ ok: true });
  });

  it('refuses a list with no service', () => {
    expect(checkFaultRun([], expected)).toMatchObject({ ok: false, code: 'bad_input' });
  });

  it('accepts the fault value of each kind in the service of that kind', () => {
    const pairs: [AgentKind, string][] = [['order-desk', 'confirm_wrong_lot'], ['prior-authorization-agent', 'alter_after_approval'], ['sourcing-agent', 'invert_scores'], ['bid-desk', 'quote_off_price_list']];
    for (const [kind, value] of pairs) {
      expect(checkFaultRun([service('one', kind, value), service('two', 'insurer-intake-agent')], { service: 'one', value }), `${kind} ${value}`).toMatchObject({ ok: true });
      expect(checkFaultRun([service('one', kind), service('two', 'insurer-intake-agent')], { service: 'one', value }), `${kind} ${value}`).toMatchObject({ ok: false, code: 'fault_missing' });
    }
  });

  it('refuses the clean run and the fault run for the same services with a different code, so a script cannot mix them up', () => {
    const services = run('confirm_wrong_lot');
    expect(checkCleanRun(services)).toMatchObject({ ok: false, code: 'fault_set' });
    expect(checkFaultRun(services, expected)).toMatchObject({ ok: true });
    expect(checkFaultRun(run(), expected)).toMatchObject({ ok: false, code: 'fault_missing' });
    expect(checkCleanRun(run())).toMatchObject({ ok: true });
  });
});
