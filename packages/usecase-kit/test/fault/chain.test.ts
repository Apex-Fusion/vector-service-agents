// packages/usecase-kit/test/fault/chain.test.ts: the calls that a service, a run script and the evidence writer make, in order. The guard looks at the environment before the run, and the field
// `fault_mode` of each result shows what the running process did. A fault in a clean run, and a result with no field, are caught by one of the two.
import { describe, expect, it } from 'vitest';
import { checkCleanRun, checkFaultMode, checkFaultRun, readFaultSwitch, withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { SeenService } from '@vsa/usecase-kit/fault';

type Env = Record<string, string | undefined>;

/** A service of the kind order desk. It reads the setting one time when it starts, and it wraps its job one time. */
function startOrderDesk(env: Env) {
  const fault = readFaultSwitch('order-desk', env.FAULT_MODE);
  return withFaultModeJob(fault, (po: string) => (po === '' ? { outcome: 'failed', reason: 'bad_shape' } : { outcome: 'completed', reason: null, po }));
}

const seen = (env: Env): SeenService[] => [{ service: 'order-desk-small', kind: 'order-desk', env }];

describe('a clean run', () => {
  it('passes the guard, and every result of the job names the empty setting, also the result of a job that failed', async () => {
    const guard = checkCleanRun(seen({}));
    expect(guard).toStrictEqual({ ok: true, value: [{ service: 'order-desk-small', kind: 'order-desk', mode: '' }] });
    const job = startOrderDesk({});
    for (const po of ['po-1', '']) {
      const result = await job(po);
      expect(checkFaultMode('order-desk', '', result), po).toStrictEqual({ ok: true, value: '' });
    }
  });

  it('is refused by the guard when the service has a fault value, and the service starts with that value', async () => {
    const env = { FAULT_MODE: 'confirm_wrong_lot' };
    expect(checkCleanRun(seen(env))).toMatchObject({ ok: false, code: 'fault_set' });
    expect((await startOrderDesk(env)('po-1')).fault_mode).toBe('confirm_wrong_lot');
  });

  it('is caught by the results when a service restarts with a fault after the guard looked: the evidence writer refuses the result', async () => {
    expect(checkCleanRun(seen({}))).toMatchObject({ ok: true });
    const restarted = startOrderDesk({ FAULT_MODE: 'confirm_wrong_lot' });
    expect(checkFaultMode('order-desk', '', await restarted('po-1'))).toMatchObject({ ok: false, code: 'fault_set' });
  });
});

describe('a fault run', () => {
  const expected = { service: 'order-desk-small', value: 'confirm_wrong_lot' };

  it('passes the guard, and every result names the fault that the guard found', async () => {
    const env = { FAULT_MODE: 'confirm_wrong_lot' };
    const guard = checkFaultRun(seen(env), expected);
    if (!guard.ok) throw new Error(guard.detail);
    const job = startOrderDesk(env);
    for (const po of ['po-1', '']) {
      for (const found of guard.value) expect(checkFaultMode(found.kind, found.mode, await job(po)), po).toStrictEqual({ ok: true, value: 'confirm_wrong_lot' });
    }
  });

  it('is refused by the guard when the service has no fault, and by the results when the service ran with none', async () => {
    expect(checkFaultRun(seen({}), expected)).toMatchObject({ ok: false, code: 'fault_missing' });
    expect(checkFaultMode('order-desk', 'confirm_wrong_lot', await startOrderDesk({})('po-1'))).toMatchObject({ ok: false, code: 'fault_missing' });
  });
});

describe('a service that starts', () => {
  it('stops with a value that it does not know, so it never runs and never gives a result', () => {
    for (const value of ['confirm_wrong_lott', 'true', 'alter_after_approval']) expect(() => startOrderDesk({ FAULT_MODE: value }), value).toThrow(/FAULT_MODE/);
    expect(() => startOrderDesk({ FAULT_MODE: '' })).not.toThrow();
    expect(() => startOrderDesk({})).not.toThrow();
  });
});
