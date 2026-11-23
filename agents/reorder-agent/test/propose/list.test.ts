// agents/reorder-agent/test/propose/list.test.ts: the read of the list of left sub-delegations inside the hook before the send. The read has a bound of its own, inside the bound of the hook of the access folder,
// so a read that answers late never finds a run that already ended: it adds no id to the set of the runs in use, it stores no entry, and the next job on the key is not blocked. A damaged file of another id does
// not block a job, and a damaged file with the name of this sub-delegation does. Each job that this read stops writes one line with the cause to its log, with no key and no token. Each stop has its twin.
import { DamagedLeftEntriesError } from '@vsa/usecase-kit/janitor';
import { describe, expect, it } from 'vitest';
import type { LeftEntry } from '../../src/propose/index.ts';
import { AGENT_KEY, ERP_RESOURCE, NOW, PARENT_ID, SUBAGENT_KEY, expectFailed, proposed, world } from './support.ts';
import type { World } from './support.ts';

/** The entry of a left sub-delegation with this id. */
const entryFor = (id: string): LeftEntry => ({
  left: { id, parent: PARENT_ID, action: 'erp.stock.read', resource: ERP_RESOURCE, delegateTxHash: 'cd'.repeat(32), delegateValidTo: NOW, delegateTtlSlot: 1, notAfter: NOW, endTxHash: null },
  signer_key_hash: AGENT_KEY,
});

/** The job wrote one line with the cause, and the line holds no key and no token. */
function expectOneLine(w: World, cause: RegExp): void {
  expect(w.logs).toHaveLength(1);
  expect(w.logs[0]).toMatch(cause);
  for (const secret of [AGENT_KEY, SUBAGENT_KEY, w.keys.authentication.keyHash, w.keys.delegation.keyHash, 'aaaaaaaaaaaa']) expect(w.logs[0]).not.toContain(secret);
}

/** Nothing was sent to the chain, nothing was recorded, and nothing was asked of the gateway, the ERP or the model. */
function expectNothingSent(w: World): void {
  expect(w.chain.submitted).toStrictEqual([]);
  expect(w.steps).toStrictEqual([]);
  expect(w.tokenRequests).toStrictEqual([]);
  expect(w.fetched).toStrictEqual([]);
  expect(w.reorderCalls).toStrictEqual([]);
}

/** The id of the Delegate that the builder made last: the hook is called after the build, so the id is known when the list is read. */
const idBuilt = (w: World): string => w.chain.builtDelegates.at(-1)!.id;

describe('the bound of the read of the list', () => {
  it('stops the job at 20 seconds when the list answers after 61, so that the late answer adds no id to the set and stores no entry, and the next job on the key is not blocked', async () => {
    const w = world();
    w.sink.listDelayMs = 61_000;
    expectFailed(await w.run(), 'sub_delegation_journal_failed');
    expect(w.clock.now() - NOW).toBe(20_000);
    expectOneLine(w, /did not answer within 20000 ms/);
    expectNothingSent(w);
    await w.clock.advance(100_000);
    expect(w.steps).toStrictEqual([]);
    expect(w.live.size).toBe(0);
    expect(w.sink.entries.size).toBe(0);
    expect(w.chain.submitted).toStrictEqual([]);
    w.sink.listDelayMs = 0;
    proposed(await w.run());
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'undelegate']);
  });

  it('goes on when the list answers one millisecond before the bound, and stops when it answers at the bound: the twin', async () => {
    for (const [delay, outcome] of [[19_999, 'proposed'], [20_000, 'failed']] as const) {
      const w = world();
      w.sink.listDelayMs = delay;
      expect((await w.run()).outcome, `${delay}`).toBe(outcome);
    }
  });
});

describe('a list that cannot be read', () => {
  const FAILURES: [string, (w: World) => void][] = [
    ['the read fails', (w) => void (w.sink.listFailure = () => new Error('the disk cannot be read'))],
    ['the read gives no list', (w) => void (w.sink.list = async () => undefined as never)],
    ['the read gives a text', (w) => void (w.sink.list = async () => 'a text' as never)],
  ];
  it.each(FAILURES)('stops the job with sub_delegation_journal_failed when %s, sends nothing, and logs the cause', async (_name, setup) => {
    const w = world();
    setup(w);
    expectFailed(await w.run(), 'sub_delegation_journal_failed');
    expectNothingSent(w);
    expectOneLine(w, /the list of left sub-delegations cannot be read/);
  });

  it('gives the same result when the log itself throws: a log changes no result', async () => {
    const w = world();
    w.sink.listFailure = () => new Error('the disk cannot be read');
    expectFailed(
      await w.run({
        deps: {
          log: () => {
            throw new Error('the log broke');
          },
        },
      }),
      'sub_delegation_journal_failed',
    );
    expectNothingSent(w);
  });

  it('writes nothing to the log in a clean run: the twin', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.logs).toStrictEqual([]);
  });
});

describe('a damaged file in the list', () => {
  const OTHER = `${'ab'.repeat(32)}.json`;
  const damaged = (file: string): { file: string; detail: string }[] => [{ file, detail: 'the file is not JSON' }];

  it('goes on with the entries that it could read when the damaged file is named for another id, and logs nothing: one damaged file does not block every job', async () => {
    const w = world();
    w.sink.listFailure = () => new DamagedLeftEntriesError([], damaged(OTHER));
    proposed(await w.run());
    expect(w.logs).toStrictEqual([]);
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'undelegate']);
  });

  it('still stops for an entry with the id of this sub-delegation among the entries that it could read', async () => {
    const w = world();
    w.sink.listFailure = () => new DamagedLeftEntriesError([entryFor(idBuilt(w))], damaged(OTHER));
    expectFailed(await w.run(), 'sub_delegation_journal_failed');
    expectNothingSent(w);
    expectOneLine(w, /holds an entry with this id/);
  });

  it('stops when a damaged file is named for this sub-delegation, because it may hold the entry of an earlier Delegate, and logs the cause', async () => {
    const w = world();
    w.sink.listFailure = () => new DamagedLeftEntriesError([], damaged(`${idBuilt(w)}.json`));
    expectFailed(await w.run(), 'sub_delegation_journal_failed');
    expectNothingSent(w);
    expectOneLine(w, /a damaged file of the list has the name of this sub-delegation/);
  });

  it('stops at once for a damaged file that is named for this sub-delegation, also when other damaged files are named for other ids', async () => {
    const w = world();
    w.sink.listFailure = () => new DamagedLeftEntriesError([], [...damaged(OTHER), ...damaged(`${idBuilt(w)}.json`)]);
    expectFailed(await w.run(), 'sub_delegation_journal_failed');
    expectNothingSent(w);
  });
});
