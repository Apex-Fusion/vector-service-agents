// packages/hire-kit/test/stop.test.ts
// The two pieces of the stop of a service that moved from agents/document-pipeline/src/start.ts with the janitor (ruling R61): the janitor stopped with a
// bound, its pass in flight abandoned with a log line once the bound is over, and the line that names the escrows the state directory holds when a stop
// abandons the job that is running. The words are the Pipeline's; agents/document-pipeline/test/start.test.ts holds them through its service too.
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrandedStore, abandonedLine, stopJanitorWithin } from '../src/janitor.ts';
import { T0 } from './stub-suppliers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'hire-kit-stop-')); dirs.push(dir); return dir; };
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('stopJanitorWithin (ruling R61)', () => {
  it('waits for the pass in flight and says nothing when it ends within the bound', async () => {
    const lines: string[] = [];
    let ended = false;
    await stopJanitorWithin({ stop: async () => { await pause(10); ended = true; } }, 5_000, (line) => { lines.push(line); });
    expect(ended).toBe(true);
    expect(lines).toStrictEqual([]);
  });

  it('abandons a pass that has not ended when the bound is over, with the line of the Pipeline, and returns', async () => {
    const lines: string[] = [];
    const began = Date.now();
    await stopJanitorWithin({ stop: () => new Promise<void>(() => undefined) }, 200, (line) => { lines.push(line); });
    expect(Date.now() - began).toBeGreaterThanOrEqual(190);
    expect(lines).toStrictEqual(["stopping: the janitor's pass did not end within 0.2 s and is abandoned; the janitor of the next start reads the state directory again"]);
  });
});

describe('abandonedLine (ruling R61)', () => {
  it('names the escrows the store holds for the janitor of the next start: none, one, or each of several in the order they were added', () => {
    const store = new StrandedStore(stateDir());
    expect(abandonedLine(store, 150)).toBe('stopping: the job that is running did not finish within 150 ms and is abandoned; the state directory holds 0 escrows for the janitor of the next start');
    const first = `${'ab'.repeat(32)}#0`;
    const second = `${'cd'.repeat(32)}#1`;
    store.add({ escrow_ref: first, deliver_by: T0 + 480_000, posted_at: T0, kind: 'llm' });
    expect(abandonedLine(store, 150)).toBe(`stopping: the job that is running did not finish within 150 ms and is abandoned; the state directory holds 1 escrow for the janitor of the next start: ${first}`);
    store.add({ escrow_ref: second, deliver_by: T0 + 480_000, posted_at: T0, kind: 'ocr' });
    expect(abandonedLine(store, 300_000)).toBe(`stopping: the job that is running did not finish within 300000 ms and is abandoned; the state directory holds 2 escrows for the janitor of the next start: ${first}, ${second}`);
  });
});
