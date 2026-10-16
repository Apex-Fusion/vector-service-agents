// packages/service-kit/test/lifecycle.test.ts
import { describe, test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { SHUTDOWN_WAIT_MS, lifecycle, listen, stopOnSignals } from '../src/lifecycle.ts';
import { createJobServer } from '../src/server.ts';
import { JobSlot } from '../src/slot.ts';
import { TOKEN, pause, until, wire } from './support.ts';

/** A server whose job waits at a gate until `release` is called, on a port the system picks. */
async function gated(logs: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slot = new JobSlot();
  const server = createJobServer<{ say: string }, { said: string }>({
    manifestText: '{}', authHeader: TOKEN, clock: Date.now, log: (line) => { logs.push(line); }, slot,
    parse: (json) => JSON.parse(json) as { say: string }, run: async (r) => { await gate; return { said: r.say }; }, refusalOf: () => null,
  });
  await listen(server, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, slot, release, base };
}

describe('lifecycle', () => {
  test('an idle service shuts down at once and says finished; a second call gives the same promise', async () => {
    const logs: string[] = [];
    const { server, slot, base } = await gated(logs);
    const { shutdown } = lifecycle({ server, slot, log: (l) => { logs.push(l); } });
    expect(SHUTDOWN_WAIT_MS).toBe(300_000);
    const first = shutdown(30_000);
    expect(shutdown(30_000)).toBe(first);
    expect(await first).toBe('finished');
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    expect(logs).toStrictEqual([]);
  });

  test('shutdown waits for the job that holds the slot, takes no new job meanwhile, and says finished once the job has its answer', async () => {
    const logs: string[] = [];
    const { server, slot, release, base } = await gated(logs);
    const { shutdown } = lifecycle({ server, slot, log: (l) => { logs.push(l); } });
    const job = fetch(`${base}/`, { method: 'POST', headers: { authorization: TOKEN }, body: wire({ say: 'held' }) }).then((r) => r.json());
    await until(() => slot.busy, 'the job holds the slot');
    let ended = false;
    const done = shutdown(30_000).then((outcome) => { ended = true; return outcome; });
    await pause(250);
    expect(ended).toBe(false);
    expect(slot.take()).toBe('draining'); // no new job, whatever arrives
    release();
    expect(await job).toStrictEqual({ said: 'held' });
    expect(await done).toBe('finished');
    expect(logs).toContain('stopping: waiting up to 30000 ms for the job that is running');
  });

  test('past its wait a shutdown abandons the job, logs the line the service gives, and says abandoned', async () => {
    const logs: string[] = [];
    const { server, slot, release, base } = await gated(logs);
    const { shutdown } = lifecycle({ server, slot, log: (l) => { logs.push(l); }, abandonedLine: (ms) => `abandoned after ${ms} ms, and nothing is kept` });
    const job = fetch(`${base}/`, { method: 'POST', headers: { authorization: TOKEN }, body: wire({ say: 'held' }) });
    job.catch(() => undefined); // its connection is cut
    await until(() => slot.busy, 'the job holds the slot');
    expect(await shutdown(100)).toBe('abandoned');
    expect(logs).toContain('abandoned after 100 ms, and nothing is kept');
    release();
  });

  test('without a line of its own, an abandoned job is logged with the default line', async () => {
    const logs: string[] = [];
    const { server, slot, release, base } = await gated(logs);
    const job = fetch(`${base}/`, { method: 'POST', headers: { authorization: TOKEN }, body: wire({ say: 'held' }) });
    job.catch(() => undefined);
    await until(() => slot.busy, 'the job holds the slot');
    expect(await lifecycle({ server, slot, log: (l) => { logs.push(l); } }).shutdown(50)).toBe('abandoned');
    expect(logs).toContain('stopping: the job that is running did not finish within 50 ms and is abandoned');
    release();
  });

  test('stopWork runs once and first, and stop and shutdown both wait for it', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    const { server, slot } = await gated(logs);
    const { stop, shutdown } = lifecycle({ server, slot, log: (l) => { logs.push(l); }, stopWork: async () => { order.push('work stopping'); await pause(50); order.push('work stopped'); } });
    const both = await Promise.all([shutdown(10_000), stop()]);
    order.push('stopped');
    expect(both[0]).toBe('finished');
    expect(order).toStrictEqual(['work stopping', 'work stopped', 'stopped']);
  });

  test('stopOnSignals: SIGTERM or SIGINT logs, shuts down with the wait, exits 0 or 1 when the job was abandoned, and takes both handlers off', async () => {
    for (const [signal, outcome, code] of [['SIGTERM', 'finished', 0], ['SIGINT', 'abandoned', 1]] as const) {
      const target = new EventEmitter();
      const exits: number[] = [];
      const waits: Array<number | undefined> = [];
      const lines: string[] = [];
      stopOnSignals({ shutdown: async (ms) => { waits.push(ms); return outcome; } }, { target, exit: (c) => { exits.push(c); }, log: (l) => { lines.push(l); }, waitMs: 2000 });
      expect([target.listenerCount('SIGTERM'), target.listenerCount('SIGINT')]).toStrictEqual([1, 1]);
      target.emit(signal);
      await until(() => exits.length === 1, 'the exit');
      expect([exits, waits, lines]).toStrictEqual([[code], [2000], [`${signal}: stopping; no new job, and up to 2 s for the one that is running`]]);
      expect([target.listenerCount('SIGTERM'), target.listenerCount('SIGINT')]).toStrictEqual([0, 0]);
    }
    const target = new EventEmitter();
    const exits: number[] = [];
    const lines: string[] = [];
    stopOnSignals({ shutdown: async () => { throw new Error('the close failed'); } }, { target, exit: (c) => { exits.push(c); }, log: (l) => { lines.push(l); } });
    target.emit('SIGTERM');
    await until(() => exits.length === 1, 'the exit');
    expect([exits, lines.at(-1)]).toStrictEqual([[1], 'stopping failed: the close failed']);
  });
});
