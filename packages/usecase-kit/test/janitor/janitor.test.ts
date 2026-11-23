// packages/usecase-kit/test/janitor/janitor.test.ts: the janitor of left sub-delegations. The ledger is the fake of the access tests, the clock is moved by the test, and a left sub-delegation comes from the real
// `withSubDelegation` with an end that fails (support.ts). The review question: can the janitor end a delegation that is not a left sub-delegation of this agent, drop an entry whose Delegate can still land, or
// read a throw as "not shown"? Each refusal has its twin: the same pass in which nothing goes wrong, or the same failure at a point where it is harmless.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HireLane } from '@vsa/hire-kit';
import { DEFAULT_END_POLL_MS, DEFAULT_ENTRY_TIMEOUT_MS, DEFAULT_STOP_WAIT_MS, DamagedLeftEntriesError, FileLeftStore, JANITOR_STATES, MemoryLeftStore, runJanitorOnce, startJanitor } from '../../src/janitor/index.ts';
import type { JanitorDeps, JanitorEntryReport, JanitorReport, LeftEntry, LeftStore } from '../../src/janitor/index.ts';
import type { Clock } from '../../src/access/index.ts';
import { DAY, OTHER_KEY, SCRIPT, STRANGER, parentDatum } from '../access/support.ts';
import { AGENT_KEY, WALLET, answer, hangs, kindsOf, leave, settle, throws, world } from './support.ts';
import type { FakeClock, Tip, World } from './support.ts';

/** One pass, with the clock moved from wait to wait until it ends. A wait with no end fails the test. */
const go = (w: World, deps: JanitorDeps = w.deps): Promise<JanitorReport> => w.clock.run(runJanitorOnce(deps));
/** The one item of a report. */
function one(report: JanitorReport): JanitorEntryReport {
  expect(report.entries).toHaveLength(1);
  return report.entries[0]!;
}
/** A delegation as the ledger shows it, made by the transaction `txHash`. */
const shown = (entry: LeftEntry, txHash: string, id = entry.left.id): unknown => ({ id, delegation: parentDatum(), txHash });
const OTHER_TX = 'ee'.repeat(32);
/** Nothing was sent: the node got the Delegate only, and the janitor asked for no Undelegate and signed nothing. */
function expectNothingSent(w: World): void {
  expect(kindsOf(w)).toStrictEqual(['delegate']);
  expect(w.chain.builds).toStrictEqual([]);
  expect(w.chain.submits).toStrictEqual([]);
  expect(w.signed.calls).toBe(0);
}
/** The Undelegate was asked for and built, and no key signed it and nothing was sent. */
function expectNotSigned(w: World): void {
  expect(kindsOf(w)).toStrictEqual(['delegate']);
  expect(w.chain.builds).toHaveLength(1);
  expect(w.chain.submits).toStrictEqual([]);
  expect(w.signed.calls).toBe(0);
}

describe('a live delegation of the run', () => {
  it('is ended: the Undelegate is built for its id, signed by the agent key and sent in the queue of the key, and the entry is removed', async () => {
    const w = world();
    const entry = await leave(w);
    const report = await go(w);
    expect(report).toStrictEqual({ entries: [{ id: entry.left.id, state: 'ended', detail: expect.any(String), endTxHash: w.fake.builtUndelegates[0]!.txHash }], damaged: [], failure: null });
    expect(kindsOf(w)).toStrictEqual(['delegate', 'undelegate']);
    expect(w.chain.builds).toStrictEqual([{ changeAddress: WALLET, nowMs: expect.any(Number), id: entry.left.id, signer: AGENT_KEY }]);
    expect(w.fake.submitted[1]!.cbor).toBe(`${w.fake.builtUndelegates[0]!.txCbor}+${AGENT_KEY.slice(0, 4)}`);
    expect(w.signed.calls).toBe(1);
    expect(w.lane.runs).toBe(1);
    expect(await w.store.list()).toStrictEqual([]);
    expect(await w.fake.readDelegation(entry.left.id)).toBeNull();
  });

  it('is ended with no read of the slot of the tip: the tip decides only what the ledger does not show', async () => {
    const w = world();
    await leave(w);
    w.tip.error = new Error('the node is down');
    expect(one(await go(w)).state).toBe('ended');
    expect(w.tip.calls).toBe(0);
  });

  it('makes one transaction at most for an entry in one pass, and a pass ends within the bound of the entry: an Undelegate that never lands is kept with its hash', async () => {
    const w = world();
    const entry = await leave(w);
    w.fake.faults.undelegateNeverLands = true;
    const started = w.clock.now();
    const item = one(await go(w));
    expect(item).toMatchObject({ state: 'kept_end_pending', endTxHash: w.fake.builtUndelegates[0]!.txHash });
    expect(kindsOf(w)).toStrictEqual(['delegate', 'undelegate']);
    expect(w.chain.submits).toHaveLength(1);
    expect(w.clock.now() - started).toBeLessThanOrEqual(DEFAULT_ENTRY_TIMEOUT_MS);
    expect(w.chain.reads.length).toBeGreaterThanOrEqual(10);
    expect(w.chain.reads.length).toBeLessThanOrEqual(14);
    expect(await w.store.list()).toStrictEqual([{ ...entry, left: { ...entry.left, endTxHash: item.endTxHash } }]);
    expect(w.clock.waiting).toBe(0);
  });

  it('makes one more transaction in the next pass, and the node refuses it while the first one is pending', async () => {
    const w = world();
    await leave(w);
    w.fake.faults.undelegateNeverLands = true;
    await go(w);
    const item = one(await go(w));
    expect(item.state).toBe('kept_end_failed');
    expect(item.detail).toContain('BadInputsUTxO');
    expect(w.chain.submits).toHaveLength(2);
  });

  it('is cut by the number of reads when the clock does not move: the wait after the send ends, with one transaction', async () => {
    const w = world();
    await leave(w);
    w.fake.faults.undelegateNeverLands = true;
    const now = w.clock.now();
    const frozen: Clock = { now: () => now, sleep: (ms) => (ms === DEFAULT_END_POLL_MS ? Promise.resolve() : new Promise<void>(() => undefined)) };
    const item = one(await runJanitorOnce({ ...w.deps, clock: frozen }));
    expect(item.state).toBe('kept_end_pending');
    expect(w.chain.submits).toHaveLength(1);
    expect(w.chain.reads).toHaveLength(1 + Math.ceil(DEFAULT_ENTRY_TIMEOUT_MS / DEFAULT_END_POLL_MS) + 1);
  });

  it('is kept with the ledger read after the send when the ledger cannot be read then: the Undelegate may have landed', async () => {
    const w = world();
    const entry = await leave(w);
    w.chain.submitHook = async (signed) => {
      const hash = await w.fake.submit(signed);
      w.chain.script.push(...Array.from({ length: 30 }, () => throws(new Error('the ledger cannot be read'))));
      return hash;
    };
    const item = one(await go(w));
    expect(item.state).toBe('kept_end_pending');
    expect(item.detail).toContain('could not be read');
    expect(await w.store.list()).toStrictEqual([{ ...entry, left: { ...entry.left, endTxHash: item.endTxHash } }]);
  });

  describe('an end that cannot be sent', () => {
    it('keeps the entry and sends nothing when the build throws, and ends it in the pass after the builder works again: the twin', async () => {
      const w = world();
      const entry = await leave(w);
      w.fake.faults.buildUndelegateThrows = true;
      const item = one(await go(w));
      expect(item.state).toBe('kept_end_failed');
      expect(item.detail).toContain('could not be built');
      expect(item.endTxHash).toBeNull();
      expect(w.chain.submits).toStrictEqual([]);
      expect(await w.store.list()).toStrictEqual([entry]);
      w.fake.faults.buildUndelegateThrows = false;
      expect(one(await go(w)).state).toBe('ended');
    });

    it('keeps the entry and sends nothing when the build gives no answer within the bound of the entry', async () => {
      const w = world();
      const entry = await leave(w);
      w.chain.buildHook = () => new Promise(() => undefined);
      const started = w.clock.now();
      const item = one(await go(w));
      expect(item.state).toBe('kept_end_failed');
      expect(item.detail).toContain('did not answer');
      expect(w.clock.now() - started).toBeLessThanOrEqual(DEFAULT_ENTRY_TIMEOUT_MS);
      expect(w.chain.submits).toStrictEqual([]);
      expect(await w.store.list()).toStrictEqual([entry]);
    });

    const TAMPERS: [string, (w: World) => void, RegExp][] = [
      ['the report of the build names another delegation', (w) => { w.chain.buildHook = async (params) => ({ ...(await w.fake.buildUndelegate(params)), id: OTHER_TX }); }, /another delegation/],
      ['the bytes burn the token of another delegation', (w) => { w.fake.txTamper = (spec, kind) => (kind === 'undelegate' ? { ...spec, mint: [{ policy: SCRIPT.hash, name: OTHER_TX, quantity: -1n }] } : spec); }, /does not burn exactly/],
      ['an output goes to an address that is not the wallet of the agent', (w) => { w.fake.txTamper = (spec, kind) => (kind === 'undelegate' ? { ...spec, outputs: [{ ...spec.outputs[0]!, address: STRANGER }] } : spec); }, /not the wallet of the agent/],
      ['the bytes have a certificate', (w) => { w.fake.txTamper = (spec, kind) => (kind === 'undelegate' ? { ...spec, certs: true } : spec); }, /certificates/],
      ['the bytes name a required signer that is not the key of the agent', (w) => { w.fake.txTamper = (spec, kind) => (kind === 'undelegate' ? { ...spec, signers: [AGENT_KEY, OTHER_KEY] } : spec); }, /required signers/],
      ['the fee is above the limit', (w) => { w.fake.txTamper = (spec, kind) => (kind === 'undelegate' ? { ...spec, fee: 3_000_000n } : spec); }, /fee/],
      ['the hash of the report is not the hash of the bytes', (w) => { w.fake.reportHash = OTHER_TX; }, /hash that the builder reports/],
    ];
    it.each(TAMPERS)('is not signed or sent when %s', async (_what, tamper, why) => {
      const w = world();
      const entry = await leave(w);
      tamper(w);
      const item = one(await go(w));
      expect(item.state).toBe('kept_end_failed');
      expect(item.detail).toMatch(why);
      expectNotSigned(w);
      expect(await w.store.list()).toStrictEqual([entry]);
    });

    it('keeps the entry when the key cannot sign, and the detail has the name of the error and never its text', async () => {
      const w = world();
      await leave(w);
      const deps: JanitorDeps = { ...w.deps, signerOf: () => ({ keyHash: AGENT_KEY, address: WALLET, sign: () => { throw new RangeError('SECRET-KEY-TEXT'); } }) };
      const item = one(await go(w, deps));
      expect(item.state).toBe('kept_end_failed');
      expect(item.detail).toContain('RangeError');
      expect(`${item.detail} ${w.logs.join('\n')}`).not.toContain('SECRET-KEY-TEXT');
      expect(w.chain.submits).toStrictEqual([]);
    });

    it('keeps the entry with the hash of the Undelegate when the node refuses it: the transaction may have reached the node', async () => {
      const w = world();
      const entry = await leave(w);
      w.fake.faults.submitUndelegateThrows = true;
      const item = one(await go(w));
      expect(item).toMatchObject({ state: 'kept_end_failed', endTxHash: w.fake.builtUndelegates[0]!.txHash });
      expect(item.detail).toContain('not accepted by the node');
      expect(w.chain.submits).toHaveLength(1);
      expect(await w.store.list()).toStrictEqual([{ ...entry, left: { ...entry.left, endTxHash: item.endTxHash } }]);
    });

    it('keeps the entry as pending when the send gives no answer: the Undelegate may have reached the node', async () => {
      const w = world();
      await leave(w);
      w.chain.submitHook = () => new Promise(() => undefined);
      const started = w.clock.now();
      const item = one(await go(w));
      expect(item).toMatchObject({ state: 'kept_end_pending', endTxHash: w.fake.builtUndelegates[0]!.txHash });
      expect(w.clock.now() - started).toBeLessThanOrEqual(DEFAULT_ENTRY_TIMEOUT_MS);
    });

    it('keeps the entry, with the reason, when the store cannot write the hash of the Undelegate: the state is the state of the end', async () => {
      const w = world();
      const entry = await leave(w);
      w.fake.faults.submitUndelegateThrows = true;
      const failing: LeftStore = { list: () => w.store.list(), remove: (id) => w.store.remove(id), put: async () => { throw new Error('the disk is full'); } };
      const item = one(await go(w, { ...w.deps, store: failing }));
      expect(item.state).toBe('kept_end_failed');
      expect(item.detail).toContain('could not write the hash');
      expect(await w.store.list()).toStrictEqual([entry]);
    });
  });
});

describe('a delegation that the ledger does not show', () => {
  it('is kept while the tip is before the TTL slot of its Delegate, and the clock decides nothing: it is far past the end of the Delegate and of the sub-delegation', async () => {
    const w = world();
    const entry = await leave(w, 'never_lands');
    await w.clock.advance(10 * DAY);
    expect(w.clock.now()).toBeGreaterThan(entry.left.notAfter);
    expect(w.clock.now()).toBeGreaterThan(entry.left.delegateValidTo);
    w.tip.slot = entry.left.delegateTtlSlot - 1;
    const item = one(await go(w));
    expect(item.state).toBe('kept_waiting');
    expect(await w.store.list()).toStrictEqual([entry]);
    expect(w.chain.reads).toHaveLength(1);
    expect(w.tip.calls).toBe(1);
    expect(w.chain.builds).toStrictEqual([]);
  });

  it.each([0, 1, 1_000])('is dropped when the tip is %i slots past the TTL slot, at the TTL included, and no transaction is made', async (past) => {
    const w = world();
    const entry = await leave(w, 'never_lands');
    w.tip.slot = entry.left.delegateTtlSlot + past;
    const item = one(await go(w));
    expect(item.state).toBe('dropped_not_made');
    expect(await w.store.list()).toStrictEqual([]);
    expect(w.chain.builds).toStrictEqual([]);
    expect(w.chain.submits).toStrictEqual([]);
    expect(w.chain.reads).toHaveLength(2);
  });

  it('is not dropped when the Delegate lands between the first read and the read of the tip: the second read shows it, and the pass ends it', async () => {
    const w = world();
    const entry = await leave(w);
    w.tip.slot = entry.left.delegateTtlSlot + 5;
    w.chain.script.push(answer(null));
    const item = one(await go(w));
    expect(item.state).toBe('ended');
    expect(kindsOf(w)).toStrictEqual(['delegate', 'undelegate']);
    expect(await w.store.list()).toStrictEqual([]);
  });

  it('is dropped when the second read shows nothing too: the twin', async () => {
    const w = world();
    const entry = await leave(w);
    w.tip.slot = entry.left.delegateTtlSlot;
    w.chain.script.push(answer(null), answer(null));
    expect(one(await go(w)).state).toBe('dropped_not_made');
    expect(await w.store.list()).toStrictEqual([]);
    expect(w.chain.builds).toStrictEqual([]);
  });

  it('is kept when the second read throws, and when it shows a delegation with a hash that is not in the form of a hash', async () => {
    const w = world();
    const entry = await leave(w, 'never_lands');
    w.tip.slot = entry.left.delegateTtlSlot;
    w.chain.script.push(answer(null), throws(new Error('the ledger is down')));
    expect(one(await go(w)).state).toBe('kept_unreadable');
    w.chain.script.push(answer(null), answer(shown(entry, 'EE')));
    expect(one(await go(w)).state).toBe('kept_unreadable');
    expect(await w.store.list()).toStrictEqual([entry]);
  });

  describe('a tip that cannot be read', () => {
    const BAD_TIPS: [string, (tip: Tip) => void][] = [
      ['throws', (tip) => { tip.error = new Error('the node is down'); }],
      ['is NaN', (tip) => { tip.slot = Number.NaN; }],
      ['is below 0', (tip) => { tip.slot = -1; }],
      ['is not a whole number', (tip) => { tip.slot = 1.5; }],
      ['is a number as text', (tip) => { tip.slot = '33000000'; }],
      ['is nothing', (tip) => { tip.slot = undefined; }],
    ];
    it.each(BAD_TIPS)('keeps the entry when the tip %s, also when the TTL slot is long past', async (_what, spoil) => {
      const w = world();
      const entry = await leave(w, 'never_lands');
      spoil(w.tip);
      const item = one(await go(w));
      expect(item.state).toBe('kept_unreadable');
      expect(item.detail).toContain('tip');
      expect(await w.store.list()).toStrictEqual([entry]);
      expect(w.chain.reads).toHaveLength(1);
      w.tip.error = null;
      w.tip.slot = entry.left.delegateTtlSlot;
      expect(one(await go(w)).state).toBe('dropped_not_made');
    });

    it('keeps the entry when the node gives no slot at all, and the pass ends at the bound of the entry', async () => {
      const w = world();
      const entry = await leave(w, 'never_lands');
      w.tip.hangs = true;
      const started = w.clock.now();
      expect(one(await go(w)).state).toBe('kept_unreadable');
      expect(w.clock.now() - started).toBeLessThanOrEqual(DEFAULT_ENTRY_TIMEOUT_MS);
      expect(await w.store.list()).toStrictEqual([entry]);
    });
  });
});

describe('a delegation that another transaction made', () => {
  it('is not the delegation of this run: the entry is removed with a line in the log, and no transaction is made', async () => {
    const w = world();
    const entry = await leave(w);
    w.chain.script.push(answer(shown(entry, OTHER_TX)));
    const item = one(await go(w));
    expect(item.state).toBe('dropped_other');
    expect(await w.store.list()).toStrictEqual([]);
    expectNothingSent(w);
    expect(w.tip.calls).toBe(0);
    expect(w.logs.filter((line) => line.includes(entry.left.id) && line.includes('dropped_other'))).toHaveLength(1);
  });

  it('is the delegation of this run when the hash is the hash of its Delegate: the twin, and it is ended', async () => {
    const w = world();
    const entry = await leave(w);
    w.chain.script.push(answer(shown(entry, entry.left.delegateTxHash)));
    expect(one(await go(w)).state).toBe('ended');
  });

  it.each([
    ['in upper case', (hash: string) => hash.toUpperCase()],
    ['too short', () => 'ee'],
    ['text that is not a hash', () => 'a transaction'],
    ['a number', () => 7],
    ['nothing', () => undefined],
  ])('is not taken as the delegation of another transaction when its hash is %s: it is unreadable, and the entry stays', async (_what, form) => {
    const w = world();
    const entry = await leave(w);
    w.chain.script.push(answer({ id: entry.left.id, delegation: parentDatum(), txHash: form(entry.left.delegateTxHash) }));
    const item = one(await go(w));
    expect(item.state).toBe('kept_unreadable');
    expect(await w.store.list()).toStrictEqual([entry]);
    expectNothingSent(w);
  });

  it('is not the delegation of the entry when the ledger answers for another id: the entry stays and nothing is ended; the answer for the right id is the twin', async () => {
    const w = world();
    const entry = await leave(w);
    w.chain.script.push(answer(shown(entry, entry.left.delegateTxHash, OTHER_TX)));
    expect(one(await go(w)).state).toBe('kept_unreadable');
    expectNothingSent(w);
    w.chain.script.push(answer(shown(entry, entry.left.delegateTxHash)));
    expect(one(await go(w)).state).toBe('ended');
  });
});

describe('a read of the ledger that fails', () => {
  it('keeps the entry, makes no transaction and asks no slot when it throws, also when the tip is long past the TTL slot; the twin ends the entry', async () => {
    const w = world();
    const entry = await leave(w);
    w.tip.slot = entry.left.delegateTtlSlot + 100;
    w.fake.faults.readThrows = true;
    const item = one(await go(w));
    expect(item.state).toBe('kept_unreadable');
    expect(item.detail).toContain('could not be read');
    expect(await w.store.list()).toStrictEqual([entry]);
    expectNothingSent(w);
    expect(w.tip.calls).toBe(0);
    w.fake.faults.readThrows = false;
    expect(one(await go(w)).state).toBe('ended');
  });

  it('keeps the entry when the ledger gives no answer, and the pass ends at the bound of the entry', async () => {
    const w = world();
    const entry = await leave(w);
    w.tip.slot = entry.left.delegateTtlSlot + 100;
    w.chain.script.push(hangs);
    const started = w.clock.now();
    expect(one(await go(w)).state).toBe('kept_unreadable');
    expect(w.clock.now() - started).toBeLessThanOrEqual(DEFAULT_ENTRY_TIMEOUT_MS);
    expect(await w.store.list()).toStrictEqual([entry]);
    expectNothingSent(w);
  });

  it.each([
    ['nothing', undefined],
    ['an empty object', {}],
    ['text', 'live'],
    ['a number', 42],
    ['an object with the id and no hash', { id: 'x' }],
  ])('keeps the entry when the ledger gives %s: it is not "not shown", and not a delegation', async (_what, value) => {
    const w = world();
    const entry = await leave(w);
    w.tip.slot = entry.left.delegateTtlSlot + 100;
    w.chain.script.push(answer(value));
    expect(one(await go(w)).state).toBe('kept_unreadable');
    expect(await w.store.list()).toStrictEqual([entry]);
    expectNothingSent(w);
    expect(w.tip.calls).toBe(0);
  });
});

describe('a signer that is not there', () => {
  const NO_SIGNER: [string, JanitorDeps['signerOf']][] = [
    ['none for the key', () => null],
    ['a signer for another key', () => ({ keyHash: OTHER_KEY, address: WALLET, sign: (cbor) => cbor })],
    ['a signer with no address of a wallet', () => ({ keyHash: AGENT_KEY, address: 'not an address', sign: (cbor) => cbor })],
    ['a signer with no sign function', () => ({ keyHash: AGENT_KEY, address: WALLET }) as unknown as ReturnType<JanitorDeps['signerOf']>],
    ['a call that throws', () => { throw new Error('the key store is locked'); }],
  ];
  it.each(NO_SIGNER)('keeps the entry with a line in the log, and makes no transaction, for %s', async (_what, signerOf) => {
    const w = world();
    const entry = await leave(w);
    const item = one(await go(w, { ...w.deps, signerOf }));
    expect(item.state).toBe('kept_no_signer');
    expect(await w.store.list()).toStrictEqual([entry]);
    expectNothingSent(w);
    expect(w.lane.runs).toBe(0);
    expect(w.logs.filter((line) => line.includes(entry.left.id) && line.includes('kept_no_signer'))).toHaveLength(1);
  });

  it('asks for the signer by the key hash of the entry, and ends the entry when there is one: the twin', async () => {
    const w = world();
    await leave(w);
    const asked: string[] = [];
    const deps: JanitorDeps = { ...w.deps, signerOf: (keyHash) => (asked.push(keyHash), w.deps.signerOf(keyHash)) };
    expect(one(await go(w, deps)).state).toBe('ended');
    expect(asked).toStrictEqual([AGENT_KEY]);
  });
});

describe('the queue of the key', () => {
  it('is not used while it is busy: the entry is kept and no transaction is made; the twin is a free queue', async () => {
    const w = world();
    const entry = await leave(w);
    w.lane.busy = true;
    const item = one(await go(w));
    expect(item.state).toBe('kept_busy');
    expect(w.lane.runs).toBe(0);
    expect(await w.store.list()).toStrictEqual([entry]);
    expectNothingSent(w);
    w.lane.busy = false;
    expect(one(await go(w)).state).toBe('ended');
    expect(w.lane.runs).toBe(1);
  });

  it('asks the queue of the key of the entry', async () => {
    const w = world();
    await leave(w);
    const asked: string[] = [];
    await go(w, { ...w.deps, queueOf: (keyHash) => (asked.push(keyHash), w.lane) });
    expect(asked).toStrictEqual([AGENT_KEY]);
  });

  it('is the lane of the hire kit: an entry waits while a hire holds the lane, and it is ended after the hire', async () => {
    const w = world();
    await leave(w);
    const lane = new HireLane();
    let release: () => void = () => undefined;
    const held = lane.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const deps: JanitorDeps = { ...w.deps, queueOf: () => lane };
    expect(lane.busy).toBe(true);
    expect(one(await go(w, deps)).state).toBe('kept_busy');
    expectNothingSent(w);
    release();
    await held;
    await settle();
    expect(lane.busy).toBe(false);
    expect(one(await go(w, deps)).state).toBe('ended');
    await settle();
    expect(lane.busy).toBe(false);
  });

  it('gives up the turn at the bound of the entry and leaves no transaction behind, when a job of another caller is ahead in a queue that says it is free', async () => {
    const w = world();
    const entry = await leave(w);
    let open: () => void = () => undefined;
    const ahead = new Promise<void>((resolve) => { open = resolve; });
    const queue = { busy: false, run: <T>(job: () => Promise<T>): Promise<T> => ahead.then(job) };
    const started = w.clock.now();
    const item = one(await go(w, { ...w.deps, queueOf: () => queue }));
    expect(item.state).toBe('kept_busy');
    expect(w.clock.now() - started).toBeLessThanOrEqual(DEFAULT_ENTRY_TIMEOUT_MS);
    open();
    await settle();
    expectNothingSent(w);
    expect(await w.store.list()).toStrictEqual([entry]);
  });

  const RUN = <T>(job: () => Promise<T>): Promise<T> => job();
  const BAD_QUEUES: [string, JanitorDeps['queueOf'], string][] = [
    ['a queue that does not say whether it is busy', () => ({ run: RUN }) as unknown as ReturnType<JanitorDeps['queueOf']>, 'kept_busy'],
    ['a queue whose busy is text', () => ({ busy: 'no', run: RUN }) as unknown as ReturnType<JanitorDeps['queueOf']>, 'kept_busy'],
    ['a queue with no run function', () => ({ busy: false }) as unknown as ReturnType<JanitorDeps['queueOf']>, 'kept_end_failed'],
    ['a call that throws', () => { throw new Error('no queue'); }, 'kept_end_failed'],
    ['no queue', () => null as unknown as ReturnType<JanitorDeps['queueOf']>, 'kept_end_failed'],
  ];
  it.each(BAD_QUEUES)('is never read as free: %s keeps the entry and sends nothing', async (_what, queueOf, state) => {
    const w = world();
    const entry = await leave(w);
    expect(one(await go(w, { ...w.deps, queueOf })).state).toBe(state);
    expect(await w.store.list()).toStrictEqual([entry]);
    expectNothingSent(w);
  });
});

describe('a sub-delegation that a run of this process still uses', () => {
  it('is left alone: no read, no transaction, and the entry stays; the twin is a run that has ended', async () => {
    const w = world();
    const entry = await leave(w);
    const deps: JanitorDeps = { ...w.deps, inFlight: (id) => id === entry.left.id };
    const item = one(await go(w, deps));
    expect(item.state).toBe('kept_busy');
    expect(item.detail).toContain('run');
    expect(w.chain.reads).toStrictEqual([]);
    expect(w.tip.calls).toBe(0);
    expect(await w.store.list()).toStrictEqual([entry]);
    expectNothingSent(w);
    expect(one(await go(w, { ...w.deps, inFlight: () => false })).state).toBe('ended');
  });

  it('is left alone when the question cannot be answered: a throw and an answer that is not true or false are never "free"', async () => {
    const w = world();
    const entry = await leave(w);
    const throwing: JanitorDeps = { ...w.deps, inFlight: () => { throw new Error('no registry'); } };
    expect(one(await go(w, throwing)).state).toBe('kept_busy');
    const unsure: JanitorDeps = { ...w.deps, inFlight: () => undefined as unknown as boolean };
    expect(one(await go(w, unsure)).state).toBe('kept_busy');
    expect(w.chain.reads).toStrictEqual([]);
    expect(await w.store.list()).toStrictEqual([entry]);
  });
});

describe('the list of the store', () => {
  it('is empty: the pass asks nothing of the ledger, the node, the signer and the queue', async () => {
    const w = world();
    const asked: string[] = [];
    const deps: JanitorDeps = { ...w.deps, signerOf: (k) => (asked.push('signer'), w.deps.signerOf(k)), queueOf: (k) => (asked.push('queue'), w.deps.queueOf(k)) };
    expect(await go(w, deps)).toStrictEqual({ entries: [], damaged: [], failure: null });
    expect(asked).toStrictEqual([]);
    expect(w.chain.reads).toStrictEqual([]);
    expect(w.tip.calls).toBe(0);
  });

  it('is the only source of what the pass ends: a live sub-delegation that the store does not hold is never read, and one that it holds is ended', async () => {
    const w = world();
    const first = await leave(w);
    const second = await leave(w);
    expect(second.left.id).not.toBe(first.left.id);
    await w.store.remove(first.left.id);
    expect(await w.fake.readDelegation(first.left.id)).not.toBeNull();
    const report = await go(w);
    expect(report.entries.map((item) => [item.id, item.state])).toStrictEqual([[second.left.id, 'ended']]);
    expect(new Set(w.chain.reads)).toStrictEqual(new Set([second.left.id]));
    expect(w.chain.builds.map((params) => params.id)).toStrictEqual([second.left.id]);
    expect(await w.fake.readDelegation(first.left.id)).not.toBeNull();
    expect(await w.fake.readDelegation(second.left.id)).toBeNull();
  });

  it('handles each entry in order, and one entry that fails does not stop the others', async () => {
    const w = world();
    const first = await leave(w);
    const second = await leave(w);
    w.chain.script.push(throws(new Error('the ledger blinked')));
    const report = await go(w);
    expect(report.entries.map((item) => item.state)).toStrictEqual(['kept_unreadable', 'ended']);
    expect(report.entries.map((item) => item.id)).toStrictEqual([first.left.id, second.left.id]);
  });

  it('handles an id one time when the store lists it twice, and says so in the log', async () => {
    const w = world();
    const entry = await leave(w);
    const twice: LeftStore = { list: async () => [entry, entry], put: (e) => w.store.put(e), remove: (id) => w.store.remove(id) };
    const report = await go(w, { ...w.deps, store: twice });
    expect(report.entries.map((item) => item.state)).toStrictEqual(['ended']);
    expect(w.chain.submits).toHaveLength(1);
    expect(w.logs.some((line) => line.includes(entry.left.id) && line.includes('twice'))).toBe(true);
  });

  it('is handled for the entries that are in the form, and logged and kept for a value that is not an entry', async () => {
    const w = world();
    const entry = await leave(w);
    const garbage: LeftStore = { list: async () => [{ left: 1 } as unknown as LeftEntry, entry], put: (e) => w.store.put(e), remove: (id) => w.store.remove(id) };
    const report = await go(w, { ...w.deps, store: garbage });
    expect(report.entries.map((item) => item.state)).toStrictEqual(['ended']);
    expect(report.damaged).toHaveLength(1);
    expect(report.damaged[0]!.file).toBe('entry 0');
    expect(w.logs.some((line) => line.includes('damaged') && line.includes('entry 0'))).toBe(true);
  });

  it('is damaged in a file: the pass logs it, keeps it, and goes on with the entries that it can read', async () => {
    const w = world();
    const entry = await leave(w);
    const damaged = [{ file: `${'f0'.repeat(32)}.json`, detail: 'the file is not JSON' }];
    const store: LeftStore = { list: async () => { throw new DamagedLeftEntriesError([entry], damaged); }, put: (e) => w.store.put(e), remove: (id) => w.store.remove(id) };
    const report = await go(w, { ...w.deps, store });
    expect(report.damaged).toStrictEqual(damaged);
    expect(report.entries.map((item) => item.state)).toStrictEqual(['ended']);
    expect(report.failure).toBeNull();
    expect(w.logs.filter((line) => line.includes('damaged') && line.includes(damaged[0]!.file) && line.includes('not JSON'))).toHaveLength(1);
  });

  it('cannot be listed: the report says why, nothing is asked of the ledger, and the pass does not throw; the twin lists', async () => {
    const w = world();
    await leave(w);
    const broken: LeftStore = { list: async () => { throw new Error('the disk fails'); }, put: (e) => w.store.put(e), remove: (id) => w.store.remove(id) };
    const report = await go(w, { ...w.deps, store: broken });
    expect(report.entries).toStrictEqual([]);
    expect(report.failure).toContain('could not be listed');
    expect(w.chain.reads).toStrictEqual([]);
    expect(w.logs.some((line) => line.includes('could not be listed'))).toBe(true);
    expect((await go(w)).failure).toBeNull();
  });

  it('cannot be listed in time: the pass ends at the bound, with the reason; and a list that is not a list is the same', async () => {
    const w = world();
    const hanging: LeftStore = { list: () => new Promise(() => undefined), put: (e) => w.store.put(e), remove: (id) => w.store.remove(id) };
    const started = w.clock.now();
    expect((await go(w, { ...w.deps, store: hanging })).failure).toContain('could not be listed');
    expect(w.clock.now() - started).toBeLessThanOrEqual(DEFAULT_ENTRY_TIMEOUT_MS);
    const notAList: LeftStore = { list: async () => 'entries' as unknown as readonly LeftEntry[], put: (e) => w.store.put(e), remove: (id) => w.store.remove(id) };
    expect((await go(w, { ...w.deps, store: notAList })).failure).toContain('not a list');
  });

  it('keeps an entry that it ended when the store cannot remove it, and says so: kept_store_failed, with the hash of the Undelegate', async () => {
    const w = world();
    const entry = await leave(w);
    const stuck: LeftStore = { list: () => w.store.list(), put: (e) => w.store.put(e), remove: async () => { throw new Error('the disk is read only'); } };
    const item = one(await go(w, { ...w.deps, store: stuck }));
    expect(item).toMatchObject({ state: 'kept_store_failed', endTxHash: w.fake.builtUndelegates[0]!.txHash });
    expect(item.detail).toContain('could not remove');
    expect(await w.store.list()).toStrictEqual([entry]);
    expect(one(await go(w)).state).not.toBe('ended');
  });

  it('keeps an entry that it meant to drop when the store cannot remove it: kept_store_failed, in the two drop cases', async () => {
    const w = world();
    const stuck: LeftStore = { list: () => w.store.list(), put: (e) => w.store.put(e), remove: async () => { throw new Error('the disk is read only'); } };
    const gone = await leave(w, 'never_lands');
    w.tip.slot = gone.left.delegateTtlSlot;
    expect(one(await go(w, { ...w.deps, store: stuck })).state).toBe('kept_store_failed');
    expect(await w.store.list()).toStrictEqual([gone]);
    w.chain.script.push(answer(shown(gone, OTHER_TX)));
    expect(one(await go(w, { ...w.deps, store: stuck })).state).toBe('kept_store_failed');
  });
});

describe('a folder on disk', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'left-janitor-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Moves the fake clock in small steps while the disk works in real time, until `work` ends. The disk answers in a few milliseconds, so no wait of the pass ends before it. */
  async function drive<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
    let done = false;
    work.then(() => (done = true), () => (done = true));
    for (let step = 0; !done; step += 1) {
      if (step > 4_000) throw new Error('the work did not end');
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      if (!done) await clock.advance(250);
    }
    return work;
  }

  it('is read after a restart: the reference that the run wrote is ended by the janitor of the next start', async () => {
    const w = world();
    const entry = await leave(w);
    await new FileLeftStore(dir).put(entry);
    expect(readdirSync(dir)).toStrictEqual([`${entry.left.id}.json`]);
    const restarted = new FileLeftStore(dir);
    const report = await drive(w.clock, runJanitorOnce({ ...w.deps, store: restarted }));
    expect(report.entries.map((item) => item.state)).toStrictEqual(['ended']);
    expect(readdirSync(dir)).toStrictEqual([]);
    expect(kindsOf(w)).toStrictEqual(['delegate', 'undelegate']);
  });

  it('has a damaged file: the pass logs it, keeps the file, ends the other entry, and reports the file again in the next pass', async () => {
    const w = world();
    const entry = await leave(w);
    await new FileLeftStore(dir).put(entry);
    const damagedName = `${'f0'.repeat(32)}.json`;
    writeFileSync(join(dir, damagedName), '{ not json');
    const report = await drive(w.clock, runJanitorOnce({ ...w.deps, store: new FileLeftStore(dir) }));
    expect(report.entries.map((item) => item.state)).toStrictEqual(['ended']);
    expect(report.damaged).toStrictEqual([{ file: damagedName, detail: expect.any(String) }]);
    expect(w.logs.some((line) => line.includes('damaged') && line.includes(damagedName))).toBe(true);
    expect(readdirSync(dir)).toStrictEqual([damagedName]);
    expect(existsSync(join(dir, `${entry.left.id}.json`))).toBe(false);
    const next = await drive(w.clock, runJanitorOnce({ ...w.deps, store: new FileLeftStore(dir) }));
    expect(next.entries).toStrictEqual([]);
    expect(next.damaged).toHaveLength(1);
  });
});

describe('the log', () => {
  it('has one line for each entry that needs a person, and none for an entry that only waits or is busy', async () => {
    const w = world();
    const waiting = await leave(w);
    const ending = await leave(w);
    w.tip.slot = waiting.left.delegateTtlSlot - 1;
    w.lane.busy = true;
    w.chain.script.push(answer(null));
    await go(w);
    expect(w.logs).toStrictEqual([]);
    w.lane.busy = false;
    w.chain.script.push(answer(null));
    const report = await go(w);
    expect(report.entries.map((item) => item.state)).toStrictEqual(['kept_waiting', 'ended']);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain(ending.left.id);
    expect(w.logs[0]).toContain('ended');
    expect(w.logs[0]).not.toContain(waiting.left.id);
  });

  it('does not stop the pass when the log throws, and does not throw itself', async () => {
    const w = world();
    await leave(w);
    const deps: JanitorDeps = { ...w.deps, log: () => { throw new Error('the log is closed'); } };
    expect(one(await go(w, deps)).state).toBe('ended');
  });
});

describe('the deps', () => {
  const BAD: [string, (w: World) => Partial<JanitorDeps>][] = [
    ['an entry bound of 0', () => ({ entryTimeoutMs: 0 })],
    ['an entry bound below 0', () => ({ entryTimeoutMs: -5 })],
    ['an entry bound that is not a whole number', () => ({ entryTimeoutMs: 1.5 })],
    ['an entry bound that is infinite', () => ({ entryTimeoutMs: Number.POSITIVE_INFINITY })],
    ['an entry bound that is text', () => ({ entryTimeoutMs: '60000' as unknown as number })],
    ['an entry bound above one day', () => ({ entryTimeoutMs: 86_400_001 })],
    ['a poll time of 0', () => ({ pollMs: 0 })],
    ['a stop wait of 0', () => ({ stopWaitMs: 0 })],
    ['no delegation script', () => ({ delegationScript: undefined as unknown as JanitorDeps['delegationScript'] })],
    ['a delegation script that is not one', () => ({ delegationScript: { hash: 'zz', address: 'x' } })],
    ['no signerOf', () => ({ signerOf: undefined as unknown as JanitorDeps['signerOf'] })],
    ['no queueOf', () => ({ queueOf: undefined as unknown as JanitorDeps['queueOf'] })],
    ['no tipSlot', () => ({ tipSlot: undefined as unknown as JanitorDeps['tipSlot'] })],
    ['no store', () => ({ store: undefined as unknown as LeftStore })],
    ['an inFlight that is not a function', () => ({ inFlight: true as unknown as JanitorDeps['inFlight'] })],
  ];

  it.each(BAD)('refuses %s: the pass says why and asks nothing, and startJanitor throws', async (_what, spoil) => {
    const w = world();
    await leave(w);
    const deps = { ...w.deps, ...spoil(w) };
    const report = await runJanitorOnce(deps);
    expect(report).toMatchObject({ entries: [], damaged: [], failure: expect.any(String) });
    expect(w.chain.reads).toStrictEqual([]);
    expect(() => startJanitor(deps, 1_000)).toThrow();
    expect(w.chain.reads).toStrictEqual([]);
  });

  it('takes the least and the greatest bounds, and the defaults when a bound is not given: the twin', async () => {
    const w = world({ entryTimeoutMs: 1, pollMs: 1, stopWaitMs: 1 });
    await leave(w);
    expect((await go(w)).failure).toBeNull();
    const longest = world({ entryTimeoutMs: 86_400_000, pollMs: 86_400_000, stopWaitMs: 86_400_000 });
    await leave(longest);
    expect((await go(longest)).failure).toBeNull();
    expect([DEFAULT_ENTRY_TIMEOUT_MS, DEFAULT_END_POLL_MS, DEFAULT_STOP_WAIT_MS]).toStrictEqual([60_000, 5_000, 30_000]);
  });

  it('names the report states in one list', () => {
    expect([...JANITOR_STATES]).toStrictEqual([
      'ended', 'dropped_not_made', 'dropped_other', 'kept_waiting', 'kept_busy', 'kept_unreadable', 'kept_no_signer', 'kept_end_pending', 'kept_end_failed', 'kept_store_failed',
    ]);
  });
});

describe('startJanitor', () => {
  const INTERVAL = 10_000;

  /** A world with an entry that only waits: each pass reads the tip one time. */
  async function waiting(limits: Parameters<typeof world>[0] = {}): Promise<World> {
    const w = world(limits);
    const entry = await leave(w, 'never_lands');
    w.tip.slot = entry.left.delegateTtlSlot - 1;
    return w;
  }

  it('runs a pass at once and one after each interval, and the pass count is the tip reads', async () => {
    const w = await waiting();
    const janitor = startJanitor(w.deps, INTERVAL);
    await settle();
    expect(w.tip.calls).toBe(1);
    await w.clock.advance(INTERVAL - 1);
    expect(w.tip.calls).toBe(1);
    await w.clock.advance(1);
    expect(w.tip.calls).toBe(2);
    await w.clock.advance(3 * INTERVAL);
    expect(w.tip.calls).toBe(5);
    await janitor.stop();
  });

  it('never runs two passes at one time: while a pass waits for the ledger, no other pass starts, and the next one starts after it ends', async () => {
    const w = await waiting();
    w.chain.script.push(hangs);
    const janitor = startJanitor(w.deps, INTERVAL);
    await settle();
    expect(w.chain.reads).toHaveLength(1);
    await w.clock.advance(DEFAULT_ENTRY_TIMEOUT_MS - 1);
    expect(w.chain.reads).toHaveLength(1);
    await w.clock.advance(1);
    expect(w.chain.reads).toHaveLength(1);
    await w.clock.advance(INTERVAL);
    expect(w.chain.reads).toHaveLength(2);
    await janitor.stop();
  });

  it('stops: it waits for the pass in flight, and no pass starts after it, and no timer is left', async () => {
    const w = world();
    await leave(w);
    let open: () => void = () => undefined;
    w.chain.gate = new Promise<void>((resolve) => { open = resolve; });
    const janitor = startJanitor(w.deps, INTERVAL);
    await settle();
    expect(w.chain.reads).toHaveLength(1);
    let stopped = false;
    const stopping = janitor.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    open();
    await w.clock.run(stopping);
    expect(stopped).toBe(true);
    expect(kindsOf(w)).toStrictEqual(['delegate', 'undelegate']);
    expect(await w.store.list()).toStrictEqual([]);
    const reads = w.chain.reads.length;
    await w.clock.advance(10 * INTERVAL);
    expect(w.chain.reads).toHaveLength(reads);
    expect(w.tip.calls).toBe(0);
    expect(w.clock.waiting).toBe(0);
  });

  it('starts no entry after stop was called: the rest of the pass in flight is left for the next start', async () => {
    const w = world();
    await leave(w);
    const second = await leave(w);
    let open: () => void = () => undefined;
    w.chain.gate = new Promise<void>((resolve) => { open = resolve; });
    const janitor = startJanitor(w.deps, INTERVAL);
    await settle();
    const stopping = janitor.stop();
    open();
    await w.clock.run(stopping);
    expect(w.chain.builds.map((params) => params.id)).not.toContain(second.left.id);
    expect((await w.store.list()).map((entry) => entry.left.id)).toStrictEqual([second.left.id]);
  });

  it('stops within the stop wait when the pass in flight does not end: it logs that the pass is abandoned', async () => {
    const w = world({ entryTimeoutMs: DAY });
    await leave(w);
    w.chain.script.push(hangs);
    const janitor = startJanitor(w.deps, INTERVAL);
    await settle();
    let stopped = false;
    const stopping = janitor.stop().then(() => { stopped = true; });
    await w.clock.advance(DEFAULT_STOP_WAIT_MS - 1);
    expect(stopped).toBe(false);
    await w.clock.advance(1);
    await stopping;
    expect(stopped).toBe(true);
    expect(w.logs.filter((line) => line.includes('abandoned'))).toHaveLength(1);
  });

  it('can be stopped twice, and before its first pass has ended', async () => {
    const w = await waiting();
    const janitor = startJanitor(w.deps, INTERVAL);
    const first = janitor.stop();
    const second = janitor.stop();
    await w.clock.run(Promise.all([first, second]));
    expect(w.clock.waiting).toBe(0);
  });

  it('goes on after a pass that cannot read the store: the next pass handles the entry', async () => {
    const w = world();
    await leave(w);
    let calls = 0;
    const flaky: LeftStore = { list: async () => (calls++ === 0 ? Promise.reject(new Error('the disk fails')) : w.store.list()), put: (e) => w.store.put(e), remove: (id) => w.store.remove(id) };
    const janitor = startJanitor({ ...w.deps, store: flaky }, INTERVAL);
    await settle();
    expect(kindsOf(w)).toStrictEqual(['delegate']);
    expect(w.logs.some((line) => line.includes('could not be listed'))).toBe(true);
    await w.clock.advance(INTERVAL);
    expect(kindsOf(w)).toStrictEqual(['delegate', 'undelegate']);
    await w.clock.run(janitor.stop());
    expect(await w.store.list()).toStrictEqual([]);
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [86_400_001], ['1000' as unknown as number]])('refuses the interval %s with a RangeError, and starts no pass', (interval) => {
    const w = world();
    expect(() => startJanitor(w.deps, interval)).toThrow(RangeError);
    expect(w.tip.calls).toBe(0);
    expect(w.chain.reads).toStrictEqual([]);
  });

  it('takes the least and the greatest interval: the twin', async () => {
    for (const interval of [1, 86_400_000]) {
      const janitor = startJanitor(world().deps, interval);
      await janitor.stop();
    }
  });
});
