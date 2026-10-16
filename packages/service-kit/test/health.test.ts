// packages/service-kit/test/health.test.ts
import { describe, test, expect } from 'vitest';
import { HealthMonitor } from '../src/health.ts';
import { pause, until } from './support.ts';

describe('HealthMonitor', () => {
  test('healthy until a check has answered; a failing check makes it unhealthy and says so once; passing again says so once', async () => {
    let now = 0;
    let failing = true;
    let checks = 0;
    const changes: Array<[boolean, string | null]> = [];
    const m = new HealthMonitor({ check: async () => { checks += 1; if (failing) throw new Error('the disk\nis full'); }, reason: 'low_disk', clock: () => now, ttlMs: 60_000, timeoutMs: 1000, onChange: (h, f) => { changes.push([h, f]); } });
    expect(m.healthy).toBe(true);
    expect(m.reason).toBe('low_disk');
    m.poke();
    await until(() => !m.healthy, 'the first check has answered');
    m.poke(); // within the TTL: no new check
    now += 59_999;
    m.poke();
    expect(checks).toBe(1);
    now += 1;
    m.poke(); // the TTL is over: a second check, which fails again and is not logged again
    await until(() => checks === 2, 'the second check ran');
    await pause(20); // its answer is in
    failing = false;
    now += 60_000;
    m.poke();
    await until(() => m.healthy, 'the third check passed');
    expect(changes).toStrictEqual([[false, 'the disk is full'], [true, null]]);
  });
  test('one check at a time, however many pokes; a check that does not answer in time counts as failed', async () => {
    let checks = 0;
    const failures: Array<string | null> = [];
    const m = new HealthMonitor({ check: () => { checks += 1; return new Promise(() => undefined); }, reason: 'low_disk', clock: Date.now, ttlMs: 60_000, timeoutMs: 50, onChange: (_h, f) => { failures.push(f); } });
    for (let i = 0; i < 5; i++) m.poke();
    expect(checks).toBe(1);
    await until(() => !m.healthy, 'the check timed out');
    expect(failures).toStrictEqual(['no answer within 50 ms']);
  });
});
