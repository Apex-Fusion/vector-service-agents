// agents/prior-authorization-agent/test/evidence/keeping.test.ts: the records of a sub-delegation, for each read. The review question: is a sub-delegation ever left alive? A read that sent its Delegate leaves an
// entry in the list of left sub-delegations from before the send until its end is known, and it keeps the id in the set of the runs in use until the entry is up to date. An end that failed leaves the entry for
// the janitor, which then takes it. The id leaves the set on every path: ended, not made, not ended, and a throw. Each failure has its twin: the same read in which nothing goes wrong.
import { describe, expect, it } from 'vitest';
import type { LeftEntry } from '../../src/evidence/ports.ts';
import { AGENT_KEY, BASES, NOW, PARENT_ID, READS, SCRIPT, expectFailed, expectRecordedAndEnded, failureLine, janitorOnce, janitorPass, opsOf, showing, world } from './support.ts';
import type { World } from './support.ts';

describe.each(READS)('the records of the $name read', (read) => {
  const works = { ok: true, value: read.expected };

  describe('an end that did not work', () => {
    it('leaves the entry with the Undelegate that was tried when the Undelegate never lands, takes the id out of use, still gives the value, and the janitor then takes the entry', async () => {
      const w = world();
      w.chain.faults.undelegateNeverLands = true;
      expect(await read.run(w)).toStrictEqual(works);
      expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'undelegate']);
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
      expect(w.sink.entries.size).toBe(1);
      expect(w.sink.entries.get(w.chain.subId!)).toMatchObject({ signer_key_hash: AGENT_KEY, left: { id: w.chain.subId, endTxHash: w.chain.builtUndelegates[0]!.txHash } });
      expect(w.sink.stored[0]!.left.endTxHash).toBeNull();
      expect(w.live.size).toBe(0);
      expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [w.chain.subId] });
      expect(w.logs).toStrictEqual([]);
    });

    it('leaves the entry when the node refuses the Undelegate, with the hash of the Undelegate that was tried', async () => {
      const w = world();
      w.chain.faults.submitUndelegateThrows = true;
      expect(await read.run(w)).toStrictEqual(works);
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
      expect(w.sink.entries.get(w.chain.subId!)).toMatchObject({ left: { id: w.chain.subId, endTxHash: w.chain.builtUndelegates[0]!.txHash } });
      expect(w.live.size).toBe(0);
      expect(janitorPass(w.sink.entries, w.live).taken).toStrictEqual([w.chain.subId]);
    });

    it('keeps the entry that was stored before the send when its update fails, and the read still gives the value and takes the id out of use', async () => {
      const w = world();
      w.chain.faults.undelegateNeverLands = true;
      w.sink.failPutAt.add(2);
      expect(await read.run(w)).toStrictEqual(works);
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
      expect(w.sink.entries.get(w.chain.subId!)).toMatchObject({ left: { id: w.chain.subId, endTxHash: null } });
      expect(w.live.size).toBe(0);
      expect(janitorPass(w.sink.entries, w.live).taken).toStrictEqual([w.chain.subId]);
    });

    it('keeps the entry when its removal fails after a clean end, and the read still gives the value and takes the id out of use', async () => {
      const w = world();
      w.sink.failRemove = true;
      expect(await read.run(w)).toStrictEqual(works);
      expect(await w.chain.readDelegation(w.chain.subId!)).toBeNull();
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete']);
      expect(w.sink.entries.size).toBe(1);
      expect(w.live.size).toBe(0);
    });

    it('removes the entry after a clean end, and the list and the set are empty: the twin', async () => {
      const w = world();
      expect(await read.run(w)).toStrictEqual(works);
      await expectRecordedAndEnded(w);
    });
  });

  describe('a sub-delegation that was not made', () => {
    it('removes the entry and takes the id out of use when the ledger shows another transaction under the identifier, and builds no Undelegate', async () => {
      const w = world();
      showing(w.chain, () => 'ee'.repeat(32));
      expectFailed(await read.run(w), 'sub_delegation_submit_failed');
      expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate']);
      expect(w.chain.log).not.toContain('buildUndelegate');
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete']);
      expect(w.sink.entries.size).toBe(0);
      expect(w.live.size).toBe(0);
    });

    it('removes the entry and takes the id out of use when the entry cannot be stored, and sends nothing', async () => {
      const w = world();
      w.sink.failPutAt.add(1);
      expectFailed(await read.run(w), 'sub_delegation_journal_failed');
      expect(w.chain.submitted).toStrictEqual([]);
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete']);
      expect(w.sink.entries.size).toBe(0);
      expect(w.live.size).toBe(0);
      expect(w.logs).toStrictEqual([failureLine(read, 'sub_delegation_journal_failed')]);
    });

    it('records nothing for a read that sends nothing: no id in use, no entry', async () => {
      const w = world();
      w.chain.parent = null;
      expectFailed(await read.run(w), 'sub_delegation_parent_not_live');
      expect(w.steps).toStrictEqual([]);
      expect(w.chain.submitted).toStrictEqual([]);
    });
  });

  describe('a throw', () => {
    it('takes the id out of use when the code of the sub-delegation itself throws, and leaves the entry for the janitor: the error is not hidden', async () => {
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
      await expect(read.run(w, { deps: { subDelegation: { chain: w.chain, clock, delegationScript: SCRIPT, bases: BASES }, leftSink } })).rejects.toThrow('the clock broke');
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'delete']);
      expect(w.live.size).toBe(0);
      expect(w.sink.entries.size).toBe(1);
      expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [w.chain.subId] });
    });
  });

  describe('two reads at one time', () => {
    it('each have an id, an entry and an end of their own, and both ids are in use while they wait', async () => {
      const w = world();
      const results = await w.clock.run(Promise.all([read.start(w), read.start(w)]));
      expect(results).toStrictEqual([works, works]);
      const ids = w.chain.builtDelegates.map((built) => built.id);
      expect(new Set(ids).size).toBe(2);
      expect(w.janitorSeen[0]!.taken).toStrictEqual([]);
      expect([...w.janitorSeen[0]!.skipped].sort()).toStrictEqual([...ids].sort());
      expect(w.chain.submitted.map((sent) => sent.kind).sort()).toStrictEqual(['delegate', 'delegate', 'undelegate', 'undelegate']);
      for (const op of ['add', 'put', 'remove', 'delete']) expect(w.steps.filter((step) => step.op === op)).toHaveLength(2);
      expect(w.sink.entries.size).toBe(0);
      expect(w.live.size).toBe(0);
    });
  });

  /**
   * The ledger of these tests builds the id of a sub-delegation from the largest output of the wallet, as the builder of the ledger does. While a Delegate is on its way, the wallet has the same outputs, so the
   * next Delegate of the same key gets the same id: the first Delegate lands later, and it is alive. The entry of the first read must stay, and the second read must send nothing.
   */
  describe('the next read on the same key', () => {
    /** A read whose process dies right after the Delegate was sent: the answer of the node is the last thing that it sees. The read rejects, and its set of runs in use is lost with the process. */
    async function diesAfterSend(w: World): Promise<void> {
      let dead = false;
      const clock = {
        now: () => {
          if (dead) throw new Error('the process died');
          return w.clock.now();
        },
        sleep: (ms: number, signal?: AbortSignal) => {
          if (dead) throw new Error('the process died');
          return w.clock.sleep(ms, signal);
        },
      };
      const submit = w.chain.submit.bind(w.chain);
      w.chain.submit = async (cbor) => {
        const hash = await submit(cbor);
        dead = true;
        return hash;
      };
      await expect(read.run(w, { deps: { subDelegation: { chain: w.chain, clock, delegationScript: SCRIPT, bases: BASES } } })).rejects.toThrow('the process died');
      w.chain.submit = submit;
    }

    it('fails with sub_delegation_journal_failed, sends nothing and keeps the entry of the first read, when the first Delegate is still pending and the next read builds its id', async () => {
      const w = world();
      w.chain.faults.delegateNeverLands = true;
      const results = await w.clock.run(Promise.all([read.start(w), read.start(w)]));
      expect(results.map((result) => (result.ok ? 'value' : result.code)).sort()).toStrictEqual(['sub_delegation_confirmation_timeout', 'sub_delegation_journal_failed']);
      const [one, two] = w.chain.builtDelegates;
      expect(two!.id).toBe(one!.id);
      expect(two!.txHash).not.toBe(one!.txHash);
      expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate']);
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
      expect(w.sink.entries.get(one!.id)).toMatchObject({ left: { id: one!.id, delegateTxHash: one!.txHash } });
      expect(w.live.size).toBe(0);
      expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [one!.id] });
      expect(w.logs).toHaveLength(3);
      expect(w.logs[0]).toMatch(/holds an entry with this id/);
      expect(w.logs[0]).toContain(one!.id);
      expect(w.logs.slice(1)).toStrictEqual([failureLine(read, 'sub_delegation_journal_failed'), failureLine(read, 'sub_delegation_confirmation_timeout')]);
    });

    it('fails the read after a restart that came after the send, because the new process builds the id of the Delegate on its way, and the janitor then ends the first sub-delegation', async () => {
      const w = world();
      await diesAfterSend(w);
      expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate']);
      expect(w.live.size).toBe(0);
      const stepsBefore = w.steps.length;
      expectFailed(await read.run(w), 'sub_delegation_journal_failed');
      const [one, two] = w.chain.builtDelegates;
      expect(two!.id).toBe(one!.id);
      expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate']);
      expect(w.steps.slice(stepsBefore)).toStrictEqual([]);
      expect(w.sink.entries.get(one!.id)).toMatchObject({ left: { id: one!.id, delegateTxHash: one!.txHash } });
      expect(w.logs).toHaveLength(2);
      expect(w.logs[0]).toMatch(/holds an entry with this id/);
      expect(w.logs[0]).toContain(one!.id);
      // The Delegate of the first read lands, and the entry still names it, so the janitor ends it.
      await w.clock.advance(10_000);
      expect((await w.chain.readDelegation(one!.id))?.txHash).toBe(one!.txHash);
      expect((await janitorOnce(w)).entries).toMatchObject([{ id: one!.id, state: 'ended' }]);
      expect(await w.chain.readDelegation(one!.id)).toBeNull();
      expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'undelegate']);
      expect(w.sink.entries.size).toBe(0);
    });

    it('fails the next read when the first Delegate lands 900 seconds later, and the janitor then ends the first sub-delegation', async () => {
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
      expectFailed(await read.run(w), 'sub_delegation_confirmation_timeout');
      const afterFirst = w.sink.entries.size;
      expectFailed(await read.run(w), 'sub_delegation_journal_failed');
      const [one, two] = w.chain.builtDelegates;
      expect(two!.id).toBe(one!.id);
      expect(afterFirst).toBe(1);
      expect(w.sink.entries.get(one!.id)).toMatchObject({ left: { id: one!.id, delegateTxHash: one!.txHash } });
      expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
      expect(w.logs.filter((line) => /holds an entry with this id/.test(line))).toHaveLength(1);
      expect(w.logs.find((line) => /holds an entry with this id/.test(line))).toContain(one!.id);
      await w.clock.advance(500_000);
      expect((await w.chain.readDelegation(one!.id))?.txHash).toBe(one!.txHash);
      expect((await janitorOnce(w)).entries).toMatchObject([{ id: one!.id, state: 'ended' }]);
      expect(await w.chain.readDelegation(one!.id)).toBeNull();
      expect(w.sink.entries.size).toBe(0);
    });

    it('goes on when the list holds the entry of another id, and leaves that entry as it is: the twin', async () => {
      const w = world();
      const other = 'ab'.repeat(32);
      const entry: LeftEntry = {
        left: { id: other, parent: PARENT_ID, action: read.action, resource: read.resource, delegateTxHash: 'cd'.repeat(32), delegateValidTo: NOW, delegateTtlSlot: 1, notAfter: NOW, endTxHash: null },
        signer_key_hash: AGENT_KEY,
      };
      w.sink.entries.set(other, entry);
      expect(await read.run(w)).toStrictEqual(works);
      expect(w.sink.entries.get(other)).toBe(entry);
      expect(w.sink.entries.size).toBe(1);
      expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'undelegate']);
    });
  });
});
