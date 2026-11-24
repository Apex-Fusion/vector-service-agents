// agents/sourcing-agent/test/scoring/records.test.ts: the records of a sub-delegation. The review question: is a sub-delegation ever left alive with no record, or an id used twice? A scorer that sends its Delegate
// puts its id in the set of the runs in use, and stores an entry in the list of left sub-delegations, both BEFORE the send. The hook refuses an id that the list already holds, it reads the list inside a bound, and
// a damaged file of another id blocks no scorer. The id leaves the set on every path, after the list is up to date. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { DamagedLeftEntriesError } from '@vsa/usecase-kit/janitor';
import { describe, expect, it } from 'vitest';
import { runScoring } from '../../src/scoring/index.ts';
import type { LeftEntry } from '../../src/scoring/index.ts';
import { AGENT_KEY, BASES, GOLDEN_SCORES, NOW, PARENT_ID, SCRIPT, TENANT, expectFailed, scoresOf } from './support.ts';
import { expectRecordedAndEnded, expectSettled, idsOf, janitorOnce, opsOf, sentKinds, world } from './world.ts';
import type { World } from './world.ts';

const RESOURCE = `${BASES.publicBase}/t/${TENANT}/vendors`;
/** The id of the first Delegate of a world: the ledger of the tests takes it from the largest output of the wallet, as the builder of the ledger does. */
const FIRST_ID = createHash('sha256').update(`${'a1'.repeat(32)}#0`).digest('hex');

/** An entry of the list for the id: a Delegate of an earlier run of this key. */
const entryFor = (id: string): LeftEntry => ({
  left: { id, parent: PARENT_ID, action: 'vendor.read', resource: RESOURCE, delegateTxHash: 'cd'.repeat(32), delegateValidTo: NOW, delegateTtlSlot: 1, notAfter: NOW, endTxHash: null },
  signer_key_hash: AGENT_KEY,
});

/** One subject only, so that the first Delegate of the world is the only one. */
const one = (w: World): { input: { subjects: World['input']['subjects'] } } => ({ input: { subjects: w.input.subjects.slice(0, 1) } });

describe('the records of a run that sends its Delegates', () => {
  it('stores the entry of each sub-delegation before its Delegate is sent, with the reference that a janitor needs, and takes the id into use first', async () => {
    const w = world();
    const sentBefore: number[] = [];
    const put = w.sink.put.bind(w.sink);
    w.sink.put = async (entry) => {
      if (entry.left.endTxHash === null && !w.sink.entries.has(entry.left.id)) sentBefore.push(w.chain.submitted.length);
      return put(entry);
    };
    expect((await w.run()).ok).toBe(true);
    expect(sentBefore).toStrictEqual([0, 1, 2]);
    const ids = idsOf(w);
    expect(ids[0]).toBe(FIRST_ID);
    w.chain.builtDelegates.forEach((built, at) => {
      const stored = w.sink.stored.find((entry) => entry.left.id === ids[at])!;
      expect(stored).toStrictEqual({
        left: {
          id: built.id, parent: PARENT_ID, action: 'vendor.read', resource: RESOURCE, delegateTxHash: built.txHash, delegateValidTo: built.validTo,
          delegateTtlSlot: expect.any(Number) as number, notAfter: built.delegation.notAfter, endTxHash: null,
        },
        signer_key_hash: AGENT_KEY,
      });
      expect(opsOf(w, built.id).slice(0, 2)).toStrictEqual(['add', 'put']);
    });
    await expectRecordedAndEnded(w, 3);
  });

  it('keeps the id of each sub-delegation in use until the entry is up to date: the delete comes after the remove', async () => {
    const w = world();
    expect((await w.run()).ok).toBe(true);
    for (const id of idsOf(w)) {
      const ops = opsOf(w, id);
      expect(ops.indexOf('delete')).toBeGreaterThan(ops.indexOf('remove'));
      expect(ops.indexOf('add')).toBeLessThan(ops.indexOf('put'));
    }
    expect(w.live.size).toBe(0);
  });

  it('fails with sub_delegation_journal_failed, sends nothing and takes the id out of use for a scorer whose entry cannot be stored, and the other two are ended', async () => {
    const w = world();
    w.sink.failPutAt.add(2);
    const result = await w.run();
    expectFailed(result, 'sub_delegation_journal_failed', [GOLDEN_SCORES[0]!.decision, GOLDEN_SCORES[2]!.decision]);
    expect(sentKinds(w)).toStrictEqual(['delegate', 'delegate', 'undelegate', 'undelegate']);
    const [, second, third] = idsOf(w);
    // The Delegate of the second scorer was never sent, so the third scorer builds the same id, and its Delegate is the one that is sent with it.
    expect(third).toBe(second);
    expect(opsOf(w, second!)).toStrictEqual(['add', 'put', 'remove', 'delete', 'add', 'put', 'remove', 'delete']);
    expect(await w.chain.readDelegation(second!)).toBeNull();
    expect(w.sink.entries.size).toBe(0);
    expect(w.live.size).toBe(0);
    await expectSettled(w);
  });

  it('records nothing for a run that sends nothing: no id in use and no entry', async () => {
    const w = world();
    w.chain.parent = null;
    expectFailed(await w.run(), 'sub_delegation_parent_not_live');
    expect(w.steps).toStrictEqual([]);
    expect(w.chain.submitted).toStrictEqual([]);
  });

  it('keeps the scores when the set of the runs in use cannot take an id back, writes one line for each scorer, and never the message of the error', async () => {
    const w = world();
    const inFlight = {
      add: (id: string) => w.deps.inFlight.add(id),
      delete: () => {
        throw new Error('the set broke');
      },
    };
    expect(await w.run({ deps: { inFlight } })).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    expect(w.logs).toHaveLength(3);
    expect(w.logs[0]).toContain('Error');
    expect(w.logs.join('\n')).not.toContain('the set broke');
    expect(w.sink.entries.size).toBe(0);
  });

  it('gives each of two scorings at one time the ids, the entries and the ends of its own, and the twelve turns of the one queue never overlap', async () => {
    const w = world();
    const [first, second] = await w.clock.run(Promise.all([runScoring(w.deps, w.input), runScoring(w.deps, w.input)]));
    expect(scoresOf(first)).toStrictEqual(GOLDEN_SCORES);
    expect(scoresOf(second)).toStrictEqual(GOLDEN_SCORES);
    expect(new Set(idsOf(w)).size).toBe(6);
    expect(sentKinds(w).filter((kind) => kind === 'delegate')).toHaveLength(6);
    expect(sentKinds(w).filter((kind) => kind === 'undelegate')).toHaveLength(6);
    expect(w.queue.maxActive).toBe(1);
    expect(w.queue.runs).toBe(12);
    for (const id of idsOf(w)) expect(opsOf(w, id)).toStrictEqual(['add', 'put', 'remove', 'delete']);
    expect(w.sink.entries.size).toBe(0);
    expect(w.live.size).toBe(0);
  });
});

describe('an entry that the list holds with the id of the next Delegate', () => {
  it('stops the scorer before the send with sub_delegation_journal_failed, keeps the entry as it is, adds no id, and writes one line with the id to the log', async () => {
    const w = world();
    const stale = entryFor(FIRST_ID);
    w.sink.entries.set(FIRST_ID, stale);
    const result = await w.run(one(w));
    expectFailed(result, 'sub_delegation_journal_failed');
    expect(w.chain.builtDelegates[0]!.id).toBe(FIRST_ID);
    expect(w.chain.submitted).toStrictEqual([]);
    expect(w.steps).toStrictEqual([]);
    expect(w.sink.entries.get(FIRST_ID)).toBe(stale);
    expect(w.sink.entries.size).toBe(1);
    expect(w.live.size).toBe(0);
    expect(w.tokenRequests).toStrictEqual([]);
    expect(w.scoreCalls).toStrictEqual([]);
    expect(w.logs).toHaveLength(2);
    expect(w.logs[1]).toContain('journal_failed');
    expect(w.logs[0]).toMatch(/holds an entry with this id/);
    expect(w.logs[0]).toContain(FIRST_ID);
  });

  it('goes on when the list holds the entry of another id, and leaves that entry as it is: the twin', async () => {
    const w = world();
    const other = entryFor('ab'.repeat(32));
    w.sink.entries.set(other.left.id, other);
    expect(await w.run(one(w))).toStrictEqual({ ok: true, scores: GOLDEN_SCORES.slice(0, 1) });
    expect(w.sink.entries.get(other.left.id)).toBe(other);
    expect(w.sink.entries.size).toBe(1);
    expect(sentKinds(w)).toStrictEqual(['delegate', 'undelegate']);
    expect(w.logs).toStrictEqual([]);
  });

  it('stops the next scorers, and keeps the entry of the first, when the first Delegate is still on its way and the next scorers build its id', async () => {
    const w = world();
    w.chain.faults.delegateNeverLands = true;
    const result = await w.run();
    expectFailed(result, 'sub_delegation_confirmation_timeout');
    const [built, again, third] = w.chain.builtDelegates;
    expect(again!.id).toBe(built!.id);
    expect(third!.id).toBe(built!.id);
    expect(again!.txHash).not.toBe(built!.txHash);
    expect(sentKinds(w)).toStrictEqual(['delegate']);
    expect(w.steps.map((step) => step.op)).toStrictEqual(['add', 'put', 'put', 'delete']);
    expect(new Set(w.steps.map((step) => step.id))).toStrictEqual(new Set([built!.id]));
    expect(w.sink.entries.get(built!.id)).toMatchObject({ left: { id: built!.id, delegateTxHash: built!.txHash } });
    expect(w.live.size).toBe(0);
    expect(w.logs.filter((line) => /holds an entry with this id/.test(line))).toHaveLength(2);
    expect(w.logs.filter((line) => line.includes(built!.id))).toHaveLength(2);
    expect(w.scoreCalls).toStrictEqual([]);
  });

  it('lets the janitor end the first sub-delegation after the first Delegate lands late, because the entry still names it', async () => {
    const w = world();
    // The node takes the first Delegate and includes it 900 seconds later.
    const submit = w.chain.submit.bind(w.chain);
    let held = false;
    w.chain.submit = async (cbor) => {
      if (held) return submit(cbor);
      held = true;
      const hash = w.chain.builtDelegates.at(-1)!.txHash;
      void w.clock.sleep(900_000).then(() => submit(cbor));
      return hash;
    };
    const result = await w.run(one(w));
    expectFailed(result, 'sub_delegation_confirmation_timeout');
    const first = w.chain.builtDelegates[0]!;
    expect(w.sink.entries.get(first.id)).toMatchObject({ left: { id: first.id, delegateTxHash: first.txHash } });
    await w.clock.advance(900_000);
    expect((await w.chain.readDelegation(first.id))?.txHash).toBe(first.txHash);
    expect((await janitorOnce(w)).entries).toMatchObject([{ id: first.id, state: 'ended' }]);
    expect(await w.chain.readDelegation(first.id)).toBeNull();
    expect(w.sink.entries.size).toBe(0);
  });
});

describe('the read of the list inside the hook', () => {
  it('does not block a scorer for a damaged file of another id, and blocks it for a damaged file that has the name of its own sub-delegation', async () => {
    const w = world();
    const other = entryFor('ab'.repeat(32));
    w.sink.listFailure = () => new DamagedLeftEntriesError([other], [{ file: `${'cd'.repeat(32)}.json`, detail: 'the file is not JSON' }]);
    expect(await w.run(one(w))).toStrictEqual({ ok: true, scores: GOLDEN_SCORES.slice(0, 1) });
    const blocked = world();
    blocked.sink.listFailure = () => new DamagedLeftEntriesError([other], [{ file: `${FIRST_ID}.json`, detail: 'the file is not JSON' }]);
    expectFailed(await blocked.run(one(blocked)), 'sub_delegation_journal_failed');
    expect(blocked.chain.submitted).toStrictEqual([]);
    expect(blocked.steps).toStrictEqual([]);
    expect(blocked.logs).toHaveLength(2);
    expect(blocked.logs[0]).toMatch(/damaged file of the list has the name of this sub-delegation/);
  });

  it('still finds a stale entry among the entries that a damaged list carries', async () => {
    const w = world();
    w.sink.listFailure = () => new DamagedLeftEntriesError([entryFor(FIRST_ID)], [{ file: `${'cd'.repeat(32)}.json`, detail: 'the file is not JSON' }]);
    expectFailed(await w.run(one(w)), 'sub_delegation_journal_failed');
    expect(w.chain.submitted).toStrictEqual([]);
    expect(w.logs[0]).toMatch(/holds an entry with this id/);
  });

  it('blocks a scorer when the list cannot be read, sends nothing, and writes the cause to the log', async () => {
    const w = world();
    w.sink.listFailure = () => new Error('the disk cannot be read');
    expectFailed(await w.run(one(w)), 'sub_delegation_journal_failed');
    expect(w.chain.submitted).toStrictEqual([]);
    expect(w.steps).toStrictEqual([]);
    expect(w.logs).toHaveLength(2);
    expect(w.logs[0]).toMatch(/cannot be read/);
    expect(w.logs.join('\n')).not.toContain('the disk');
  });

  it('blocks a scorer when the list gives no list', async () => {
    const w = world();
    // The port is typed, and a port in JavaScript can give any value.
    const leftSink = { list: async () => undefined as unknown as readonly LeftEntry[], put: (entry: LeftEntry) => w.sink.put(entry), remove: (id: string) => w.sink.remove(id) };
    expectFailed(await w.run({ ...one(w), deps: { leftSink } }), 'sub_delegation_journal_failed');
    expect(w.chain.submitted).toStrictEqual([]);
    expect(w.steps).toStrictEqual([]);
  });

  it('gives the list 20 seconds: an answer after 25 seconds blocks the scorer with nothing sent, and an answer after 19 seconds does not', async () => {
    const slow = world();
    slow.sink.listDelayMs = 25_000;
    expectFailed(await slow.run(one(slow)), 'sub_delegation_journal_failed');
    expect(slow.chain.submitted).toStrictEqual([]);
    expect(slow.steps).toStrictEqual([]);
    expect(slow.logs).toHaveLength(2);
    expect(slow.logs[0]).toMatch(/did not answer within 20000 ms/);
    await slow.clock.advance(60_000);
    expect(slow.steps).toStrictEqual([]);
    expect(slow.sink.entries.size).toBe(0);
    const quick = world();
    quick.sink.listDelayMs = 19_000;
    expect(await quick.run(one(quick))).toStrictEqual({ ok: true, scores: GOLDEN_SCORES.slice(0, 1) });
  });
});

describe('a throw of the code under the scorer', () => {
  it('takes the id out of use when the code of the sub-delegation itself throws, leaves the entry for the janitor, and gives internal with the kind of the error in the log', async () => {
    const w = world();
    let broken = false;
    // The clock of the sub-delegation fails from the moment that the entry is stored, so that the end step cannot even start.
    const clock = {
      now: () => {
        if (broken) throw new Error('the clock broke');
        return w.clock.now();
      },
      sleep: (ms: number, signal?: AbortSignal) => w.clock.sleep(ms, signal),
    };
    const leftSink = {
      put: async (entry: LeftEntry) => {
        await w.sink.put(entry);
        broken = true;
      },
      list: () => w.sink.list(),
      remove: (id: string) => w.sink.remove(id),
    };
    const result = await w.run({ ...one(w), deps: { subDelegation: { chain: w.chain, clock, delegationScript: SCRIPT, bases: BASES }, leftSink } });
    expectFailed(result, 'internal');
    expect(opsOf(w, idsOf(w)[0]!)).toStrictEqual(['add', 'put', 'delete']);
    expect(w.live.size).toBe(0);
    expect(w.sink.entries.size).toBe(1);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain('Error');
    expect(w.logs.join('\n')).not.toContain('the clock broke');
  });
});
