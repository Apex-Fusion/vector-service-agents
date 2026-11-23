// agents/reorder-agent/test/propose/records.test.ts: the records of a sub-delegation. The review question: is a sub-delegation ever left alive? A run that sent its Delegate leaves an entry in the list of left
// sub-delegations from before the send until its end is known, and it keeps the id in the set of the runs in use until the entry is up to date. An end that failed leaves the entry for the janitor, which then
// takes it. The id leaves the set on every path: ended, not made, not ended, and a throw. Each failure has its twin: the same run in which nothing goes wrong.
import { describe, expect, it } from 'vitest';
import { PROPOSE_FAILURES, runPropose } from '../../src/propose/index.ts';
import type { LeftEntry } from '../../src/propose/index.ts';
import {
  AGENT_KEY, BASES, NOW, REQUEST, SCRIPT, TENANT, expectFailed, expectRecordedAndEnded, janitorPass, markSigner, opsOf, parentDatum, proposed, showing, world,
} from './support.ts';
import type { World } from './support.ts';

describe('an end that did not work', () => {
  it('leaves the entry with the Undelegate that was tried when the Undelegate never lands, takes the id out of use, still gives the proposal, and the janitor then takes the entry', async () => {
    const w = world();
    w.chain.faults.undelegateNeverLands = true;
    const result = proposed(await w.run());
    expect(result.document.po_number).toBe('run1-1');
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'undelegate']);
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
    expect(w.sink.entries.size).toBe(1);
    expect(w.sink.entries.get(w.chain.subId!)).toMatchObject({ signer_key_hash: AGENT_KEY, left: { id: w.chain.subId, endTxHash: w.chain.builtUndelegates[0]!.txHash } });
    expect(w.sink.stored[0]!.left.endTxHash).toBeNull();
    expect(w.live.size).toBe(0);
    expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [w.chain.subId] });
  });

  it('leaves the entry when the node refuses the Undelegate, with the hash of the Undelegate that was tried', async () => {
    const w = world();
    w.chain.faults.submitUndelegateThrows = true;
    proposed(await w.run());
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
    expect(w.sink.entries.get(w.chain.subId!)).toMatchObject({ left: { id: w.chain.subId, endTxHash: w.chain.builtUndelegates[0]!.txHash } });
    expect(w.live.size).toBe(0);
    expect(janitorPass(w.sink.entries, w.live).taken).toStrictEqual([w.chain.subId]);
  });

  it('keeps the entry that was stored before the send when its update fails, and the run still gives the proposal and takes the id out of use', async () => {
    const w = world();
    w.chain.faults.undelegateNeverLands = true;
    w.sink.failPutAt.add(2);
    proposed(await w.run());
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
    expect(w.sink.entries.get(w.chain.subId!)).toMatchObject({ left: { id: w.chain.subId, endTxHash: null } });
    expect(w.live.size).toBe(0);
    expect(janitorPass(w.sink.entries, w.live).taken).toStrictEqual([w.chain.subId]);
  });

  it('keeps the entry when its removal fails after a clean end, and the run still gives the proposal and takes the id out of use', async () => {
    const w = world();
    w.sink.failRemove = true;
    proposed(await w.run());
    expect(await w.chain.readDelegation(w.chain.subId!)).toBeNull();
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete']);
    expect(w.sink.entries.size).toBe(1);
    expect(w.live.size).toBe(0);
  });

  it('removes the entry after a clean end, and the list and the set are empty: the twin', async () => {
    const w = world();
    proposed(await w.run());
    await expectRecordedAndEnded(w);
  });
});

describe('a sub-delegation that was not made', () => {
  it('removes the entry and takes the id out of use when the ledger shows another transaction under the identifier, and builds no Undelegate', async () => {
    const w = world();
    showing(w.chain, () => 'ee'.repeat(32));
    const result = await w.run();
    expectFailed(result, 'sub_delegation_submit_failed');
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate']);
    expect(w.chain.log).not.toContain('buildUndelegate');
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete']);
    expect(w.sink.entries.size).toBe(0);
    expect(w.live.size).toBe(0);
  });

  it('removes the entry and takes the id out of use when the entry cannot be stored, and sends nothing', async () => {
    const w = world();
    w.sink.failPutAt.add(1);
    expectFailed(await w.run(), 'sub_delegation_journal_failed');
    expect(w.chain.submitted).toStrictEqual([]);
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete']);
    expect(w.sink.entries.size).toBe(0);
    expect(w.live.size).toBe(0);
  });

  it('records nothing for a run that sends nothing: no id in use, no entry', async () => {
    const w = world();
    w.chain.parent = null;
    expectFailed(await w.run(), 'sub_delegation_parent_not_live');
    expect(w.steps).toStrictEqual([]);
    expect(w.chain.submitted).toStrictEqual([]);
  });

  /** A failure of the sub-delegation: how the world is set up, the reason, and whether the Delegate was sent. */
  const FAILURES: [string, (w: World) => void, string, boolean][] = [
    ['the parent delegation is not live', (w) => void (w.chain.parent = null), 'sub_delegation_parent_not_live', false],
    ['the parent delegation allows no further hop', (w) => void (w.chain.parent = parentDatum({ remaining: 0 })), 'sub_delegation_parent_exhausted', false],
    ['the Delegate cannot be built', (w) => void (w.chain.faults.buildDelegateThrows = true), 'sub_delegation_build_refused', false],
    [
      'the address of the wallet is not an address',
      (w) => void (w.script.findKey = (hash) => ({ signer: markSigner(hash), walletAddress: 'not an address', queue: w.queue })),
      'sub_delegation_bad_request',
      false,
    ],
    ['the 30 confirmations do not come in time', (w) => void (w.chain.faults.neverConfirm = true), 'sub_delegation_confirmation_timeout', true],
    ['the chain is not usable for the subagent', (w) => void (w.chain.faults.unusable = true), 'sub_delegation_sub_delegation_unusable', true],
    [
      'the node refuses the Delegate and the Delegate lands',
      (w) => {
        w.chain.faults.submitDelegateThrows = true;
        w.chain.faults.delegateLandsAnyway = true;
      },
      'sub_delegation_submit_failed',
      true,
    ],
  ];
  it.each(FAILURES)('is a failed proposal for a sub-delegation that fails because %s, with no job run and the model never asked', async (_name, setup, reason, sent) => {
    const w = world();
    setup(w);
    expectFailed(await w.run(), reason);
    expect(PROPOSE_FAILURES).toContain(reason);
    expect(w.tokenRequests).toStrictEqual([]);
    expect(w.fetched).toStrictEqual([]);
    expect(w.reorderCalls).toStrictEqual([]);
    expect(await w.counter.next(TENANT)).toBe(1);
    if (sent) await expectRecordedAndEnded(w);
    else {
      expect(w.chain.submitted).toStrictEqual([]);
      expect(w.steps).toStrictEqual([]);
    }
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
      remove: (id: string) => w.sink.remove(id),
    };
    await expect(w.run({ deps: { subDelegation: { chain: w.chain, clock, delegationScript: SCRIPT, bases: BASES }, leftSink } })).rejects.toThrow('the clock broke');
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'delete']);
    expect(w.live.size).toBe(0);
    expect(w.sink.entries.size).toBe(1);
    expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [w.chain.subId] });
  });
});

describe('two jobs at one time', () => {
  it('each have an id, an entry and an end of their own, and both ids are in use while they wait', async () => {
    const w = world();
    const [first, second] = await w.clock.run(Promise.all([runPropose(w.deps, REQUEST, NOW), runPropose(w.deps, REQUEST, NOW)]));
    expect(new Set([proposed(first).document.po_number, proposed(second).document.po_number])).toStrictEqual(new Set(['run1-1', 'run1-2']));
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
