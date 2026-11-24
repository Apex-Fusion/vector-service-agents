// agents/insurer-intake-agent/test/checks/stores.test.ts: the hook over the real stores of the package. The folder of the hook does not import the folder of the stores. It takes the book and the sink as the plain
// shapes of ports.ts, and the wiring of the service joins them. These tests show that the classes of the stores fit the shapes, and that the hook answers over them as it does over the scripted book and sink.
// The question: does a number that the real book holds, or a real book that cannot be read, ever give a go?
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PrecheckAnswer } from '@vsa/service-kit';
import { canonicalSha256 } from '@vsa/usecase-kit/protocol';
import { createPrecheck } from '../../src/checks/index.ts';
import type { BookReader, PassedSink } from '../../src/checks/index.ts';
import { FileIntakeBook, INTAKE_BOOK_LIMIT, MemoryIntakeBook, PassedChecks } from '../../src/store/index.ts';
import { SELF } from './samples.ts';
import { T, makeWorld } from './support.ts';
import type { World } from './support.ts';

/** The hook over a world, with the book and the sink that the test gives. The dispute is never asked: no test here refuses for a digest mismatch. */
function hookOver(world: World, book: BookReader, passed: PassedSink): () => Promise<PrecheckAnswer> {
  const hook = createPrecheck({
    ports: world.ports, book, self: SELF, passed, dispute: { challengeApproval: () => Promise.reject(new Error('no challenge is expected')) }, schedule: (task) => { void task(); }, log: () => undefined,
  });
  return () => hook(world.handoff, world.context);
}

/** A folder for the file of a book, and its removal after the test. */
async function inFolder(test: (file: string) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'insurer-intake-hook-'));
  try {
    await test(join(folder, 'requests.json'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('the classes of the stores as the shapes of the hook', () => {
  it('fit: the books are readers, and the record of passed checks is a sink', async () => {
    await inFolder(async (file) => {
      const readers: BookReader[] = [new MemoryIntakeBook(), new FileIntakeBook(file)];
      const sink: PassedSink = new PassedChecks();
      for (const reader of readers) expect(await reader.has('run1', 'run1-1')).toBe(false);
      expect(typeof sink.put).toBe('function');
    });
  });

  it('give a go for a request that is new, and the job takes the record with the hash of the request that the hook checked', async () => {
    const world = makeWorld();
    const passed = new PassedChecks();
    expect(await hookOver(world, new MemoryIntakeBook(), passed)()).toEqual({ go: true });
    const hash = canonicalSha256(world.handoff);
    if (!hash.ok) throw new Error(hash.detail);
    const entry = passed.take(world.context.escrowRef, T);
    expect(entry?.request_sha256).toBe(hash.value);
    expect(Object.keys(entry?.record.checks ?? {})).toHaveLength(15);
    expect(passed.take(world.context.escrowRef, T)).toBeNull();
  });

  it('refuse a number that the book holds, in any case, with 403 duplicate_request, and leave no record', async () => {
    for (const written of ['run1-1', 'RUN1-1', 'Run1-1']) {
      const world = makeWorld();
      const book = new MemoryIntakeBook();
      const passed = new PassedChecks();
      await book.record('run1', written, 'INT-0001');
      expect(await hookOver(world, book, passed)(), written).toMatchObject({ go: false, status: 403, error: 'duplicate_request' });
      expect(passed.take(world.context.escrowRef, T), written).toBeNull();
    }
    // The twin: the number of another tenant is a new number.
    const other = new MemoryIntakeBook();
    await other.record('run2', 'run1-1', 'INT-0001');
    expect(await hookOver(makeWorld(), other, new PassedChecks())()).toEqual({ go: true });
  });

  it('answer 503 check_unavailable when the file of the book is deleted after the start, and a number that was recorded is never a go', async () => {
    await inFolder(async (file) => {
      const book = new FileIntakeBook(file);
      await book.record('run1', 'RUN1-1', 'INT-0001');
      // The twin: the book with its file refuses the number that it holds.
      expect(await hookOver(makeWorld(), book, new PassedChecks())()).toMatchObject({ go: false, status: 403, error: 'duplicate_request' });
      rmSync(file);
      const world = makeWorld();
      const passed = new PassedChecks();
      expect(await hookOver(world, book, passed)()).toEqual({ go: false, status: 503, error: 'check_unavailable', message: 'the intake book could not be read' });
      expect(world.faults.map(([source]) => source)).toEqual(['intake book']);
      expect(passed.take(world.context.escrowRef, T)).toBeNull();
    });
  });

  it('answer 503 check_unavailable when the real book holds its limit of entries and has none for the number, in memory and in a file, and the escrow stays open', async () => {
    await inFolder(async (file) => {
      // The entries of a full book. With `holding`, the first entry has the request number of the world. Without it, no entry has that number.
      const entries = (holding: boolean): Array<{ tenant: string; request_number: string; intake_id: string }> =>
        Array.from({ length: INTAKE_BOOK_LIMIT }, (_, n) => ({ tenant: 'run1', request_number: holding && n === 0 ? 'RUN1-1' : `run1-x${n}`, intake_id: `INT-${n}` }));
      const forms: Array<[string, (holding: boolean) => Promise<BookReader>]> = [
        ['memory, filled through record', async (holding) => {
          const book = new MemoryIntakeBook();
          for (const entry of entries(holding)) await book.record(entry.tenant, entry.request_number, entry.intake_id);
          return book;
        }],
        // One write for each entry is too slow, so the file is written whole.
        ['file, written whole', async (holding) => {
          writeFileSync(file, JSON.stringify({ schema: 'insurer-intake-agent.requests.v1', requests: entries(holding) }));
          return new FileIntakeBook(file);
        }],
      ];
      for (const [form, make] of forms) {
        // The twin: a full book that holds the number refuses it with 403, and not with 503.
        expect(await hookOver(makeWorld(), await make(true), new PassedChecks())(), form).toMatchObject({ go: false, status: 403, error: 'duplicate_request' });
        const world = makeWorld();
        const passed = new PassedChecks();
        expect(await hookOver(world, await make(false), passed)(), form).toEqual({ go: false, status: 503, error: 'check_unavailable', message: 'the intake book could not be read' });
        expect(world.faults, form).toEqual([['intake book', expect.any(RangeError)]]);
        expect(passed.take(world.context.escrowRef, T), form).toBeNull();
      }
    });
  });

  it('answer 503 check_unavailable when the file of the book is damaged, and never repeat what the file holds', async () => {
    await inFolder(async (file) => {
      const book = new FileIntakeBook(file);
      writeFileSync(file, 'not json: key=secret-token-123');
      const world = makeWorld();
      const answer = await hookOver(world, book, new PassedChecks())();
      expect(answer).toEqual({ go: false, status: 503, error: 'check_unavailable', message: 'the intake book could not be read' });
      expect(JSON.stringify(answer)).not.toContain('secret-token');
      expect(JSON.stringify(world.faults.map(([, cause]) => String(cause)))).not.toContain('secret-token');
    });
  });
});
