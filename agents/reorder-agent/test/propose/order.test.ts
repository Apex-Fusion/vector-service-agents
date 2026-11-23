// agents/reorder-agent/test/propose/order.test.ts: the model decision, the purchase order and the counter in the flow. The model is asked once, after the stock was read and its sub-delegation was ended. A failure of the
// decision is a failed proposal with its code and holds no decision. A failure after the decision keeps the decision in the result. The number of the purchase order is taken after the decision, once, and a
// number that a failed job took is never given again. Each failure has an accepted twin.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePoCounter, MemoryPoCounter, PROPOSE_FAILURES } from '../../src/propose/index.ts';
import type { CounterFs, PoCounter, ReorderAnswer } from '../../src/propose/index.ts';
import { CHOICE, DECISION, NOW, SUB_JOB, TENANT, answerFor, expectFailed, expectRecordedAndEnded, proposed, world } from './support.ts';
import type { JsonValue } from '@vsa/usecase-kit/protocol';

/** An answer of the decision `reorder` that holds a decision. */
type OkAnswer = Extract<ReorderAnswer, { readonly ok: true }>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the model decision', () => {
  it.each(['inference_failed', 'model_output_invalid', 'hire_failed', 'llm_out_of_time', 'store_write_failed'])(
    'is a failed proposal with the code %s of the decision, with no decision in the result, and one question only',
    async (code) => {
      const w = world();
      w.script.reorder = async () => ({ ok: false, code });
      const result = await w.run();
      expectFailed(result, code);
      expect(result.decisions).toStrictEqual([]);
      expect(result.sub_jobs).toStrictEqual([]);
      expect(w.reorderCalls).toHaveLength(1);
      await expectRecordedAndEnded(w);
      expect(await w.counter.next(TENANT)).toBe(1);
    },
  );

  it('does not take the words of the decision as a reason: a code that has the form of words, a throw, and a decision with no sub-job are internal', async () => {
    const words = world();
    words.script.reorder = async () => ({ ok: false, code: 'The model said no, sorry' });
    expectFailed(await words.run(), 'internal');
    const throwing = world();
    throwing.script.reorder = async () => {
      throw new Error('the model hire broke');
    };
    expectFailed(await throwing.run(), 'internal');
    const empty = world();
    empty.script.reorder = async () => ({ ok: true, decision: {} as never, choice: { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' } });
    const result = await empty.run();
    expectFailed(result, 'internal');
    expect(result.decisions).toStrictEqual([]);
    for (const w of [words, throwing, empty]) expect(w.reorderCalls).toHaveLength(1);
    expect(PROPOSE_FAILURES).toContain('internal');
  });

  it('is an internal failure when the decision gives no answer at all, after the sub-delegation was ended', async () => {
    for (const value of [undefined, null, 'a text']) {
      const w = world();
      w.script.reorder = async () => value as never;
      const result = await w.run();
      expectFailed(result, 'internal');
      expect(result.decisions).toStrictEqual([]);
      await expectRecordedAndEnded(w);
      expect(w.reorderCalls).toHaveLength(1);
    }
  });

  it('fails with deadline when the decision gives no answer until the deadline, after the sub-delegation was ended', async () => {
    const w = world();
    w.script.reorder = () => new Promise(() => undefined);
    expectFailed(await w.run(), 'deadline');
    expect(w.clock.now() - NOW).toBe(1_620_000);
    await expectRecordedAndEnded(w);
    expect(PROPOSE_FAILURES).toContain('deadline');
  });

  it('is asked once with the reading and the sizes of the lots, and its decision is in the proposal: the twin', async () => {
    const w = world();
    const result = proposed(await w.run());
    expect(w.reorderCalls).toHaveLength(1);
    expect(result.decisions).toStrictEqual([DECISION]);
  });
});

describe('the purchase order', () => {
  const WRONG: [string, unknown][] = [
    ['a date that does not exist', { lot: 'lot-medium', quantity: 50, needed_by: '2026-02-30' }],
    ['a date that is not a date', { lot: 'lot-medium', quantity: 50, needed_by: 'tomorrow' }],
    ['a quantity of 0', { lot: 'lot-medium', quantity: 0, needed_by: '2026-12-01' }],
    ['a quantity that is a fraction', { lot: 'lot-medium', quantity: 1.5, needed_by: '2026-12-01' }],
    ['a quantity above the limit of the order store', { lot: 'lot-medium', quantity: 1_000_001, needed_by: '2026-12-01' }],
    ['a quantity that is a text', { lot: 'lot-medium', quantity: '50', needed_by: '2026-12-01' }],
    ['a lot that is not a lot name', { lot: 'lot-huge', quantity: 50, needed_by: '2026-12-01' }],
    ['no choice', null],
    ['a choice that is not JSON data', undefined],
    ['a quantity that JSON cannot hold', { lot: 'lot-medium', quantity: Number.NaN, needed_by: '2026-12-01' }],
  ];
  it.each(WRONG)('is a failed proposal with bad_document for a choice with %s, and the decision is kept in the result', async (_name, choice) => {
    const w = world();
    // The decision records the same choice, so the failure is the one of the document, and not a difference between the choice and the decision.
    const decision = { ...DECISION, choice: choice as never };
    w.script.reorder = async () => ({ ok: true, decision, choice: choice as never });
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(result.decisions).toStrictEqual([decision]);
    expect(result.sub_jobs).toStrictEqual([SUB_JOB]);
    await expectRecordedAndEnded(w);
    expect(PROPOSE_FAILURES).toContain('bad_document');
  });

  it('is a failed proposal with bad_document when the advert of the lot is not a reference of an output, and the decision is kept', async () => {
    const w = world();
    w.script.readSupplier = async () => ({ ok: true, value: { adverts: { 'lot-small': { advert_ref: 'one' }, 'lot-medium': { advert_ref: 'two' }, 'lot-large': { advert_ref: 'three' } }, lots: { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 } } });
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(result.decisions).toStrictEqual([DECISION]);
  });

  it('is the proposal of the golden run for a right choice: the twin', async () => {
    const w = world();
    expect(proposed(await w.run()).document).toMatchObject({ lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' });
  });
});

describe('the choice and the decision that records it', () => {
  const RECORDED = { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' };
  /** The answer of a decision that records `recorded`, for the choice `choice`. */
  const answer = (recorded: JsonValue, choice: unknown): OkAnswer => ({ ok: true, decision: { ...DECISION, choice: recorded }, choice: choice as never });
  const DIFFERENT: [string, OkAnswer][] = [
    ['another quantity', answer(RECORDED, { ...RECORDED, quantity: 5000 })],
    ['another lot', answer(RECORDED, { ...RECORDED, lot: 'lot-large' })],
    ['another date', answer(RECORDED, { ...RECORDED, needed_by: '2026-12-02' })],
    ['a quantity that is a text for a quantity that is a number', answer(RECORDED, { ...RECORDED, quantity: '50' })],
    ['a member that the decision does not record', answer(RECORDED, { ...RECORDED, note: 'more' })],
    ['a member that only the decision records', answer({ ...RECORDED, note: 'more' }, RECORDED)],
    ['a decision that records a text', answer('lot-medium', RECORDED)],
    ['a decision that records nothing', answer(null, RECORDED)],
  ];
  it.each(DIFFERENT)('is a failed proposal with decision_mismatch for %s, with the decision kept, no number taken, and the sub-delegation ended', async (_name, given) => {
    const w = world();
    w.script.reorder = async () => given;
    const result = await w.run();
    expectFailed(result, 'decision_mismatch');
    expect(PROPOSE_FAILURES).toContain('decision_mismatch');
    expect(result.decisions).toStrictEqual([given.decision]);
    expect(w.reorderCalls).toHaveLength(1);
    await expectRecordedAndEnded(w);
    expect(await w.counter.next(TENANT)).toBe(1);
  });

  it('builds the order from a choice that equals the recorded choice, also with its members in another order: the twin', async () => {
    const w = world();
    w.script.reorder = async () => answer({ needed_by: '2026-12-01', quantity: 50, lot: 'lot-medium' }, RECORDED);
    const result = proposed(await w.run());
    expect(result.document).toMatchObject(RECORDED);
    expect(result.decisions[0]!.choice).toStrictEqual({ needed_by: '2026-12-01', quantity: 50, lot: 'lot-medium' });
  });
});

describe('the number of the purchase order', () => {
  it('is taken after the decision and once: a failed decision takes none, and the next job gets the first number', async () => {
    const w = world();
    w.script.reorder = async () => ({ ok: false, code: 'inference_failed' });
    expectFailed(await w.run(), 'inference_failed');
    w.script.reorder = async () => ({ ok: true, decision: DECISION, choice: { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' } });
    expect(proposed(await w.run()).document.po_number).toBe('run1-1');
  });

  it('is never given again when the order that took it failed: the next job gets the next number', async () => {
    const w = world();
    w.script.reorder = async () => answerFor({ lot: 'lot-medium', quantity: 0, needed_by: '2026-12-01' });
    expectFailed(await w.run(), 'bad_document');
    w.script.reorder = async () => answerFor(CHOICE);
    expect(proposed(await w.run()).document.po_number).toBe('run1-2');
  });

  it('counts each tenant on its own', async () => {
    const w = world();
    expect(proposed(await w.run()).document.po_number).toBe('run1-1');
    expect(proposed(await w.run({ request: { tenant: 'run2' } })).document.po_number).toBe('run2-1');
    expect(proposed(await w.run()).document.po_number).toBe('run1-2');
  });

  it('is never given to two jobs at one time on one tenant', async () => {
    const counter = new MemoryPoCounter();
    const first = world({ counter });
    const second = world({ counter });
    const [a, b] = await Promise.all([first.run(), second.run()]);
    expect(new Set([proposed(a).document.po_number, proposed(b).document.po_number])).toStrictEqual(new Set(['run1-1', 'run1-2']));
  });

  it('is never given twice across a restart: a new counter on the same file goes on', async () => {
    // The file system is in memory: a real write takes real time, and the clock of the test does not wait for it.
    const dir = mkdtempSync(join(tmpdir(), 'reorder-propose-'));
    dirs.push(dir);
    const path = join(dir, 'po-numbers.json');
    const files = new Map<string, string>();
    const fs: Partial<CounterFs> = {
      readFile: async (file) => {
        const text = files.get(file);
        if (text === undefined) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        return text;
      },
      writeFile: async (file, text) => void files.set(file, text),
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      fsync: async () => undefined,
      unlink: async (file) => void files.delete(file),
    };
    const before = world({ counter: new FilePoCounter(path, { fs }) });
    expect(proposed(await before.run()).document.po_number).toBe('run1-1');
    expect(proposed(await before.run()).document.po_number).toBe('run1-2');
    expect([...files.keys()]).toStrictEqual([path]);
    const after = world({ counter: new FilePoCounter(path, { fs }) });
    expect(proposed(await after.run()).document.po_number).toBe('run1-3');
  });

  it('fails with store_write_failed when the counter cannot store the number, and keeps the decision in the result', async () => {
    const w = world();
    const counter: PoCounter = {
      next: async () => {
        throw new Error('the disk is full');
      },
    };
    const result = await w.run({ deps: { counter } });
    expectFailed(result, 'store_write_failed');
    expect(result.decisions).toStrictEqual([DECISION]);
    expect(PROPOSE_FAILURES).toContain('store_write_failed');
    await expectRecordedAndEnded(w);
  });

  it('fails with deadline when the counter gives no answer until the deadline, and keeps the decision', async () => {
    const w = world();
    const counter: PoCounter = { next: () => new Promise(() => undefined) };
    const result = await w.run({ deps: { counter } });
    expectFailed(result, 'deadline');
    expect(result.decisions).toStrictEqual([DECISION]);
    expect(w.clock.now() - NOW).toBe(1_620_000);
  });

  it.each([Number.NaN, -1, 1.5, '3' as never])('fails with internal when the counter gives %s, which is no number of a purchase order, and keeps the decision', async (value) => {
    const w = world();
    const result = await w.run({ deps: { counter: { next: async () => value } } });
    expectFailed(result, 'internal');
    expect(result.decisions).toStrictEqual([DECISION]);
  });
});
