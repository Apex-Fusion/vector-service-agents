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
      [{ service: 'a', kind: 'order-desk', env: undefined }],
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

  it('refuses an environment that is not a record of variables, because the variables in it are in a form that a guard does not read', () => {
    // Each of them holds FAULT_MODE=confirm_wrong_lot.
    const holders: [string, unknown][] = [
      ['a Buffer of an environ file', Buffer.from('PATH=/usr/bin\0FAULT_MODE=confirm_wrong_lot\0')],
      ['a Map', new Map([['FAULT_MODE', 'confirm_wrong_lot']])],
      ['a String object', new String('FAULT_MODE=confirm_wrong_lot')],
      ['a URLSearchParams', new URLSearchParams('FAULT_MODE=confirm_wrong_lot')],
      ['an object of a class', new (class Env { vars = { FAULT_MODE: 'confirm_wrong_lot' }; })()],
      ['an array of lines', ['FAULT_MODE=confirm_wrong_lot']],
      ['a text', 'FAULT_MODE=confirm_wrong_lot'],
      ['a number', 7],
      ['a Date', new Date(0)],
      ['an object that inherits FAULT_MODE from another object', Object.create({ FAULT_MODE: 'confirm_wrong_lot' })],
    ];
    for (const [name, value] of holders) {
      const seenAs = [{ service: 'svc', kind: 'order-desk', env: value }] as SeenService[];
      expect(checkCleanRun(seenAs), name).toMatchObject({ ok: false, code: 'bad_input' });
      expect(checkFaultRun(seenAs, { service: 'svc', value: 'confirm_wrong_lot' }), name).toMatchObject({ ok: false, code: 'bad_input' });
    }
  });

  it('takes a record of variables: a plain object, an object with no prototype, an object with the prototype of process.env, and process.env itself: the twins', () => {
    const noPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { PATH: '/usr/bin' });
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: { PATH: '/usr/bin' } }])).toMatchObject({ ok: true });
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: noPrototype }])).toMatchObject({ ok: true });
    noPrototype.FAULT_MODE = 'confirm_wrong_lot';
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: noPrototype }])).toMatchObject({ ok: false, code: 'fault_set' });
    const shaped = Object.create(Object.getPrototypeOf(process.env)) as Record<string, unknown>;
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: shaped }])).toMatchObject({ ok: true });
    shaped.FAULT_MODE = 'confirm_wrong_lot';
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: shaped }])).toMatchObject({ ok: false, code: 'fault_set' });
  });

  it('refuses a FAULT_MODE that is not a text in a record, also undefined: the variable is deleted to say that it is not set', () => {
    for (const value of [undefined, null, 0, false, {}, []]) {
      expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: { FAULT_MODE: value } }]), String(value)).toMatchObject({ ok: false, code: 'bad_fault_mode' });
    }
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: {} }])).toMatchObject({ ok: true });
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: { FAULT_MODE: '' } }])).toMatchObject({ ok: true });
  });

  it('refuses a Proxy as the environment, because its traps can answer the guard in one way and a reader of the object in another: the two cases of the review, and the twins', () => {
    const parsed: Record<string, string> = { FAULT_MODE: 'confirm_wrong_lot' };
    // A get trap that gives the variable, and a target that has none: the prototype test and the `in` test see an empty record.
    const getOnly = new Proxy({}, { get: (_target, name) => parsed[String(name)] });
    // A target that has the variable, and a has trap that says that it has not.
    const hasLies = new Proxy({ FAULT_MODE: 'confirm_wrong_lot' }, { has: () => false });
    const seenAs = (env: unknown) => [{ service: 'svc', kind: 'order-desk', env }] as SeenService[];
    for (const [name, env] of [['a get trap', getOnly], ['a has trap that says no', hasLies]] as const) {
      expect(checkCleanRun(seenAs(env)), name).toMatchObject({ ok: false, code: 'bad_input' });
      expect(checkFaultRun(seenAs(env), { service: 'svc', value: 'confirm_wrong_lot' }), name).toMatchObject({ ok: false, code: 'bad_input' });
    }
    // The twins: the same records with no Proxy are read, and the fault in them is found.
    expect(checkCleanRun(seenAs({ ...parsed }))).toMatchObject({ ok: false, code: 'fault_set' });
    expect(checkCleanRun(seenAs({ FAULT_MODE: 'confirm_wrong_lot' }))).toMatchObject({ ok: false, code: 'fault_set' });
    expect(checkFaultRun(seenAs({ ...parsed }), { service: 'svc', value: 'confirm_wrong_lot' })).toMatchObject({ ok: true });
  });

  it('refuses every other Proxy too: a Proxy with no trap, a Proxy of process.env, a Proxy that throws, and a revoked Proxy', () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const proxies: [string, unknown][] = [
      ['a Proxy with no trap', new Proxy({}, {})],
      ['a Proxy of a record with a fault', new Proxy({ FAULT_MODE: 'confirm_wrong_lot' }, {})],
      ['a Proxy of process.env', new Proxy(process.env, {})],
      ['a Proxy that throws when it is read', new Proxy({}, { has: () => { throw new Error('no'); } })],
      ['a Proxy whose prototype cannot be read', new Proxy({}, { getPrototypeOf: () => { throw new Error('no'); } })],
      ['a revoked Proxy', revocable.proxy],
    ];
    for (const [name, env] of proxies) expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env }] as SeenService[]), name).toMatchObject({ ok: false, code: 'bad_input' });
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: {} }])).toMatchObject({ ok: true });
  });

  it('refuses a FAULT_MODE that comes from Object.prototype: it is not a variable of the environment, so the guard cannot read it as one', () => {
    Object.defineProperty(Object.prototype, 'FAULT_MODE', { value: 'confirm_wrong_lot', configurable: true, writable: true, enumerable: false });
    try {
      expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: {} }])).toMatchObject({ ok: false, code: 'service_unreadable' });
      expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: { FAULT_MODE: '' } }])).toMatchObject({ ok: true });
    } finally {
      Reflect.deleteProperty(Object.prototype, 'FAULT_MODE');
    }
    expect(checkCleanRun([{ service: 'a', kind: 'order-desk', env: {} }])).toMatchObject({ ok: true });
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
